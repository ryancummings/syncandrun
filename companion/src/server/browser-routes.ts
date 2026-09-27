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
import { PlexSetupService } from "../plex/setup-service.js";
import { PlexLibraryService } from "../plex/library-service.js";
import { PlexPlaylistTooLargeError } from "../plex/media.js";
import { PairingRateLimit } from "./pairing-rate-limit.js";

const setupSessionIdSchema = z.uuid();
const selectionSchema = z.strictObject({
  serverId: z.string().min(1).max(128),
  connectionUri: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol))
});
const completionSchema = selectionSchema.extend({ librarySectionId: z.string().min(1).max(64) });
const sessionCookieName = "syncandrun_session";

export interface BrowserRouteDependencies {
  plexSetup: PlexSetupService;
  plexLibrary: PlexLibraryService;
  browserSessions: BrowserSessionRepository;
  management: BrowserManagementService;
}

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
      const forwardUrl = new URL("/setup/plex/callback", companionOrigin(request, config));
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
      setSessionCookie(reply, session.token, session.expiresAt, companionOrigin(request, config).protocol === "https:");
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
      await dependencies.plexLibrary.selectPlaylists(body.data.selectedPlaylistIds);
      return { selectedPlaylistIds: body.data.selectedPlaylistIds };
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
      await dependencies.plexLibrary.refreshSelected();
      return { refreshed: true };
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

  app.get("/api/v1/settings", async (request, reply) => {
    const session = authenticateBrowser(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    reply.header("Cache-Control", "no-store");
    return dependencies.management.getSettings();
  });

  app.post("/api/v1/settings/plex/disconnect", async (request, reply) => {
    const session = authenticateMutation(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    dependencies.management.disconnectPlex();
    clearSessionCookie(reply);
    return { disconnected: true };
  });

  app.delete("/api/v1/settings/data", async (request, reply) => {
    const session = authenticateMutation(request, reply, dependencies.browserSessions);
    if (session === undefined) return;
    dependencies.management.deleteUserData();
    clearSessionCookie(reply);
    return { deleted: true };
  });
}

/** The configured origin, or the one this request reached the companion on. */
function companionOrigin(request: FastifyRequest, config: RuntimeConfig): URL {
  return config.baseUrl ?? new URL(`${request.protocol}://${request.host}`);
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

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: string, secure: boolean): void {
  reply.header(
    "Set-Cookie",
    `${sessionCookieName}=${token}; Path=/; HttpOnly${secure ? "; Secure" : ""}; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`
  );
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header(
    "Set-Cookie",
    `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
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
