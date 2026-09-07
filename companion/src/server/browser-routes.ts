import { OwnerAuthorizationError } from "../persistence/owner-repository.js";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault
} from "fastify";
import { z } from "zod";
import type { RuntimeConfig } from "../config.js";
import { BrowserManagementService } from "../persistence/browser-management-service.js";
import {
  BrowserSessionRepository,
  type AuthenticatedBrowserSession
} from "../persistence/browser-session-repository.js";
import { normalizeDeviceName } from "../persistence/device-repository.js";
import { PlexSetupService } from "../plex/setup-service.js";
import { PlexLibraryService } from "../plex/library-service.js";
import { PlexPlaylistTooLargeError } from "../plex/media.js";
import { PairingRateLimit } from "./pairing-rate-limit.js";
import { stableIdSchema } from "../protocol/index.js";
import type { LiveSyncTracker } from "../sync/live-sync-tracker.js";
import type { SyncPlanService } from "../sync/sync-plan.js";
import { buildSyncStatus, type SyncStatus } from "../sync/sync-status.js";

const setupSessionIdSchema = z.uuid();
const selectionSchema = z.strictObject({
  serverId: z.string().min(1).max(128),
  connectionUri: z.url().refine((value) => new URL(value).protocol === "https:")
});
const completionSchema = selectionSchema.extend({ librarySectionId: z.string().min(1).max(64) });
const sessionCookieName = "syncandrun_session";

export interface BrowserRouteDependencies {
  plexSetup: PlexSetupService;
  plexLibrary: PlexLibraryService;
  browserSessions: BrowserSessionRepository;
  management: BrowserManagementService;
  syncPlan: SyncPlanService;
  liveSync: LiveSyncTracker;
}

/** `null` restores the name the watch reported at pairing. */
const deviceNameSchema = z.strictObject({
  displayName: z
    .string()
    .max(200)
    .nullable()
    .refine((value) => value === null || normalizeDeviceName(value).length > 0)
});
const liveStreamHeartbeatMs = 20_000;
/** Coalesces byte-level progress into at most one browser frame per interval. */
const liveStreamMinIntervalMs = 500;

export function registerBrowserRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  config: RuntimeConfig,
  dependencies: BrowserRouteDependencies
): void {
  const startRateLimit = new PairingRateLimit();

  app.post("/api/v1/setup/plex/pin", async (request, reply) => {
    if (!startRateLimit.allows(request.ip)) return sendBrowserError(request, reply, 429, "RATE_LIMITED", "Wait before trying again.");
    try {
      const forwardUrl = new URL("/setup/plex/callback", config.baseUrl);
      const body = z.strictObject({ invitation: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional() }).safeParse(request.body ?? {});
      if (!body.success) return sendBrowserError(request, reply, 400, "INVALID_REQUEST", "Use a valid setup link.");
      const started = await dependencies.plexSetup.start(forwardUrl, new Date(), body.data.invitation);
      reply.header("Cache-Control", "no-store");
      return started;
    } catch (error) {
      if (error instanceof OwnerAuthorizationError) return sendBrowserError(request, reply, 403, "OWNER_REQUIRED", error.message);
      request.log.error({ err: error }, "Plex setup start failed");
      return sendBrowserError(request, reply, 503, "PLEX_UNAVAILABLE", "Plex authentication is unavailable.");
    }
  });

  app.get<{ Params: { sessionId: string } }>("/api/v1/setup/plex/pin/:sessionId", async (request, reply) => {
    const parsed = setupSessionIdSchema.safeParse(request.params.sessionId);
    if (!parsed.success) return sendBrowserError(request, reply, 404, "SETUP_NOT_FOUND", "This setup session was not found.");
    try {
      const status = await dependencies.plexSetup.getStatus(parsed.data);
      reply.header("Cache-Control", "no-store");
      if (status.status !== "claimed" && status.status !== "completed") return status;
      const session = dependencies.browserSessions.create(parsed.data);
      setSessionCookie(reply, session.token, session.expiresAt);
      return { ...status, csrfToken: session.csrfToken };
    } catch (error) {
      if (error instanceof OwnerAuthorizationError) return sendBrowserError(request, reply, 403, "OWNER_REQUIRED", error.message);
      request.log.error({ err: error }, "Plex setup status failed");
      return sendBrowserError(request, reply, 503, "PLEX_UNAVAILABLE", "Plex authentication is unavailable.");
    }
  });

  app.get("/api/v1/session", async (request, reply) => {
    const session = authenticateBrowser(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    reply.header("Cache-Control", "no-store");
    return { authenticated: true, csrfToken: session.csrfToken };
  });

  app.get("/api/v1/setup/plex/servers", async (request, reply) => {
    const session = authenticateBrowser(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    try {
      reply.header("Cache-Control", "no-store");
      return { servers: await dependencies.plexSetup.listServers(session.plexAuthSessionId) };
    } catch (error) {
      request.log.error({ err: error }, "Plex server discovery failed");
      return sendBrowserError(request, reply, 503, "PLEX_UNAVAILABLE", "Plex server discovery failed.");
    }
  });

  app.post("/api/v1/setup/plex/libraries", async (request, reply) => {
    const session = authenticateMutation(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    const body = selectionSchema.safeParse(request.body);
    if (!body.success) return sendBrowserError(request, reply, 400, "INVALID_REQUEST", "Choose a valid Plex server connection.");
    try {
      const libraries = await dependencies.plexSetup.listMusicLibraries(
        session.plexAuthSessionId,
        body.data.serverId,
        body.data.connectionUri
      );
      reply.header("Cache-Control", "no-store");
      return { libraries };
    } catch (error) {
      request.log.error({ err: error }, "Plex library discovery failed");
      return sendBrowserError(request, reply, 503, "PLEX_UNAVAILABLE", "Plex library discovery failed.");
    }
  });

  app.post("/api/v1/setup/plex/complete", async (request, reply) => {
    const session = authenticateMutation(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    const body = completionSchema.safeParse(request.body);
    if (!body.success) return sendBrowserError(request, reply, 400, "INVALID_REQUEST", "Choose a valid Plex music library.");
    try {
      await dependencies.plexSetup.complete(
        session.plexAuthSessionId,
        body.data.serverId,
        body.data.connectionUri,
        body.data.librarySectionId
      );
      return { configured: true };
    } catch (error) {
      request.log.error({ err: error }, "Plex setup completion failed");
      return sendBrowserError(request, reply, 503, "PLEX_UNAVAILABLE", "Plex setup could not be completed.");
    }
  });

  app.post("/api/v1/session/logout", async (request, reply) => {
    const session = authenticateMutation(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    dependencies.browserSessions.revoke(session.id);
    clearSessionCookie(reply);
    return { loggedOut: true };
  });

  app.get("/api/v1/playlists", async (request, reply) => {
    const session = authenticateBrowser(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    try {
      return { playlists: await dependencies.plexLibrary.listPlaylists() };
    } catch (error) {
      request.log.error({ err: error }, "Plex playlist listing failed");
      return sendBrowserError(request, reply, 503, "PLEX_UNAVAILABLE", "Plex playlists could not be loaded.");
    }
  });

  app.post("/api/v1/playlists/selection", async (request, reply) => {
    const session = authenticateMutation(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    const body = z
      .strictObject({
        selectedPlaylistIds: z
          .array(z.string().regex(/^plex:playlist:[A-Za-z0-9._~-]+$/))
          .max(500)
          .refine((items) => new Set(items).size === items.length)
      })
      .safeParse(request.body);
    if (!body.success) return sendBrowserError(request, reply, 400, "INVALID_REQUEST", "Choose valid Plex playlists.");
    try {
      const manifestRevision = await dependencies.plexLibrary.selectPlaylists(body.data.selectedPlaylistIds);
      return { selectedPlaylistIds: body.data.selectedPlaylistIds, manifestRevision };
    } catch (error) {
      request.log.error({ err: error }, "Plex playlist selection failed");
      if (error instanceof PlexPlaylistTooLargeError) {
        return sendBrowserError(
          request,
          reply,
          422,
          "PLAYLIST_TOO_LARGE",
          "Choose a playlist with no more than 10,000 tracks."
        );
      }
      return sendBrowserError(request, reply, 503, "PLEX_UNAVAILABLE", "Plex playlists could not be refreshed.");
    }
  });

  app.post("/api/v1/playlists/refresh", async (request, reply) => {
    const session = authenticateMutation(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    try {
      return { manifestRevision: await dependencies.plexLibrary.refreshSelected() };
    } catch (error) {
      request.log.error({ err: error }, "Plex playlist refresh failed");
      if (error instanceof PlexPlaylistTooLargeError) {
        return sendBrowserError(
          request,
          reply,
          422,
          "PLAYLIST_TOO_LARGE",
          "A selected playlist now exceeds the 10,000-track safety limit. Remove it before refreshing."
        );
      }
      return sendBrowserError(request, reply, 503, "PLEX_UNAVAILABLE", "Plex playlists could not be refreshed.");
    }
  });

  app.post("/api/v1/settings/profile", async (request, reply) => {
    const session = authenticateMutation(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    const body = z.strictObject({ profile: z.enum(["compact", "balanced", "high"]) }).safeParse(request.body);
    if (!body.success) return sendBrowserError(request, reply, 400, "INVALID_REQUEST", "Choose a valid transcode profile.");
    try {
      return {
        profile: body.data.profile,
        manifestRevision: dependencies.plexLibrary.setTranscodeProfile(body.data.profile)
      };
    } catch (error) {
      request.log.error({ err: error }, "Transcode profile update failed");
      return sendBrowserError(request, reply, 500, "INTERNAL_ERROR", "The transcode profile could not be updated.");
    }
  });

  app.get("/api/v1/settings", async (request, reply) => {
    const session = authenticateBrowser(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    reply.header("Cache-Control", "no-store");
    // The watch's companion_url app setting has to be typed in by hand, so the
    // browser has to be able to show the origin this companion answers on.
    return { ...dependencies.management.getSettings(), companionUrl: config.baseUrl.href };
  });

  app.get("/api/v1/devices", async (request, reply) => {
    const session = authenticateBrowser(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    reply.header("Cache-Control", "no-store");
    return { devices: dependencies.management.listDevices() };
  });

  app.post("/api/v1/devices/pairing-code", async (request, reply) => {
    const session = authenticateMutation(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    return dependencies.management.createPairingCode();
  });

  app.delete<{ Params: { deviceId: string } }>("/api/v1/devices/:deviceId", async (request, reply) => {
    const session = authenticateMutation(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    const deviceId = stableIdSchema.safeParse(request.params.deviceId);
    if (!deviceId.success) return sendBrowserError(request, reply, 400, "INVALID_REQUEST", "Choose a valid watch.");
    if (!dependencies.management.revokeDevice(deviceId.data)) {
      return sendBrowserError(request, reply, 404, "DEVICE_NOT_FOUND", "This watch is not paired.");
    }
    dependencies.liveSync.clear(deviceId.data);
    return { revoked: true };
  });

  app.patch<{ Params: { deviceId: string } }>("/api/v1/devices/:deviceId", async (request, reply) => {
    const session = authenticateMutation(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    const deviceId = stableIdSchema.safeParse(request.params.deviceId);
    const body = deviceNameSchema.safeParse(request.body);
    if (!deviceId.success || !body.success) {
      return sendBrowserError(request, reply, 400, "INVALID_REQUEST", "Choose a valid watch name.");
    }
    if (!dependencies.management.renameDevice(deviceId.data, body.data.displayName)) {
      return sendBrowserError(request, reply, 404, "DEVICE_NOT_FOUND", "This watch is not paired.");
    }
    const device = dependencies.management.listDevices().find((item) => item.id === deviceId.data);
    reply.header("Cache-Control", "no-store");
    return { device };
  });

  app.post<{ Params: { deviceId: string } }>("/api/v1/devices/:deviceId/forget", async (request, reply) => {
    const session = authenticateMutation(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    const deviceId = stableIdSchema.safeParse(request.params.deviceId);
    if (!deviceId.success) return sendBrowserError(request, reply, 400, "INVALID_REQUEST", "Choose a valid watch.");
    if (!dependencies.management.forgetDevice(deviceId.data)) {
      return sendBrowserError(
        request,
        reply,
        409,
        "DEVICE_ACTIVE",
        "Remove this watch before deleting its record."
      );
    }
    dependencies.liveSync.clear(deviceId.data);
    return { forgotten: true };
  });

  app.get<{ Params: { deviceId: string } }>("/api/v1/devices/:deviceId/history", async (request, reply) => {
    const session = authenticateBrowser(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    const deviceId = stableIdSchema.safeParse(request.params.deviceId);
    if (!deviceId.success) return sendBrowserError(request, reply, 400, "INVALID_REQUEST", "Choose a valid watch.");
    reply.header("Cache-Control", "no-store");
    return { history: dependencies.management.listSyncHistory(deviceId.data) };
  });

  const currentStatus = (): SyncStatus =>
    buildSyncStatus(
      dependencies.syncPlan.get(),
      dependencies.management.listDevices(),
      dependencies.liveSync.snapshots()
    );

  app.get("/api/v1/sync/status", async (request, reply) => {
    const session = authenticateBrowser(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    reply.header("Cache-Control", "no-store");
    return currentStatus();
  });

  // Server-sent events: the browser cannot set a CSRF header on EventSource,
  // so this stays a read-only GET authenticated by the session cookie.
  app.get("/api/v1/sync/live", async (request, reply) => {
    const session = authenticateBrowser(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    let closed = false;
    let pending = false;
    let lastSentAt = 0;
    let coalesceTimer: NodeJS.Timeout | undefined;

    const write = () => {
      if (closed) return;
      if (dependencies.browserSessions.authenticate(session.rawToken) === undefined) { stop(); return; }
      lastSentAt = Date.now();
      pending = false;
      try {
        raw.write(`event: status\ndata: ${JSON.stringify(currentStatus())}\n\n`);
      } catch (error) {
        request.log.debug({ err: error }, "Live sync stream write failed");
        stop();
      }
    };
    const schedule = () => {
      if (closed || pending) return;
      const wait = Math.max(liveStreamMinIntervalMs - (Date.now() - lastSentAt), 0);
      if (wait === 0) {
        write();
        return;
      }
      pending = true;
      coalesceTimer = setTimeout(write, wait);
      coalesceTimer.unref();
    };
    // The heartbeat carries a full frame: pairing, renames and playlist edits
    // change the status without producing any tracker event.
    const heartbeat = setInterval(() => {
      if (!closed) write();
    }, liveStreamHeartbeatMs);
    heartbeat.unref();
    const unsubscribe = dependencies.liveSync.subscribe(schedule);
    function stop(): void {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      if (coalesceTimer !== undefined) clearTimeout(coalesceTimer);
      unsubscribe();
      raw.end();
    }
    raw.on("close", stop);
    raw.on("error", stop);
    write();
  });

  app.post("/api/v1/settings/plex/disconnect", async (request, reply) => {
    const session = authenticateMutation(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    dependencies.management.disconnectPlex();
    dependencies.liveSync.clearAll();
    clearSessionCookie(reply);
    return { disconnected: true };
  });

  app.delete("/api/v1/settings/data", async (request, reply) => {
    const session = authenticateMutation(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    dependencies.management.deleteUserData();
    dependencies.liveSync.clearAll();
    clearSessionCookie(reply);
    return { deleted: true };
  });
}

function authenticateBrowser(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: BrowserSessionRepository
): AuthenticatedBrowserSession | undefined {
  const token = parseCookies(request.headers.cookie)[sessionCookieName];
  if (token === undefined) {
    sendBrowserError(request, reply, 401, "AUTH_REQUIRED", "Sign in with Plex to continue.");
    return undefined;
  }
  const session = sessions.authenticate(token);
  if (session === undefined) {
    clearSessionCookie(reply);
    sendBrowserError(request, reply, 401, "AUTH_REQUIRED", "Sign in with Plex to continue.");
  }
  return session;
}

function authenticateMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: BrowserSessionRepository
): AuthenticatedBrowserSession | undefined {
  const session = authenticateBrowser(request, reply, sessions);
  if (session === undefined) return undefined;
  const csrf = request.headers["x-csrf-token"];
  if (typeof csrf !== "string" || !sessions.verifyCsrf(session, csrf)) {
    sendBrowserError(request, reply, 403, "CSRF_INVALID", "Refresh the page and try again.");
    return undefined;
  }
  return session;
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (header === undefined) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name.length > 0) cookies[name] = value;
  }
  return cookies;
}

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: string): void {
  reply.header(
    "Set-Cookie",
    `${sessionCookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`
  );
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header(
    "Set-Cookie",
    `${sessionCookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
  );
}

function sendBrowserError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string
) {
  reply.header("Cache-Control", "no-store");
  return reply.code(statusCode).send({ error: { code, message, requestId: request.id } });
}
