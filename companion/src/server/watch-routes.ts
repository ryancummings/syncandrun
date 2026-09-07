import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault
} from "fastify";
import {
  DeviceRepository,
  type DeviceAuthentication,
  type PairingClaim
} from "../persistence/device-repository.js";
import { WatchConfigurationRepository } from "../persistence/watch-configuration-repository.js";
import { WatchManifestRepository } from "../persistence/watch-manifest-repository.js";
import {
  PlexArtworkNotFoundError,
  PlexMediaNotFoundError,
  PlexMediaProxy,
  PlexProxyUnavailableError,
  PlexTranscodeBusyError,
  PlexTranscodeFailedError
} from "../plex/media-proxy.js";
import {
  cursorSchema,
  pairRequestSchema,
  pairResponseSchema,
  stableIdSchema,
  syncResultRequestSchema,
  syncResultResponseSchema
} from "../protocol/index.js";
import { PairingRateLimit } from "./pairing-rate-limit.js";
import { sendWatchError } from "./watch-errors.js";
import type { LiveSyncTracker } from "../sync/live-sync-tracker.js";
import { estimateBytes, profileBitrateKbps } from "../sync/sync-plan.js";

export function registerWatchRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  devices: DeviceRepository,
  configuration: WatchConfigurationRepository,
  manifest: WatchManifestRepository,
  mediaProxy: PlexMediaProxy,
  liveSync?: LiveSyncTracker
): void {
  const pairingRateLimit = new PairingRateLimit();

  app.post("/api/v1/watch/pair", async (request, reply) => {
    if (!pairingRateLimit.allows(request.ip)) return sendWatchError(request, reply, "RATE_LIMITED");

    const body = request.body;
    if (
      body !== null &&
      typeof body === "object" &&
      "protocolVersion" in body &&
      (body as { protocolVersion?: unknown }).protocolVersion !== 1
    ) {
      return sendWatchError(request, reply, "PROTOCOL_UNSUPPORTED");
    }

    const parsed = pairRequestSchema.safeParse(body);
    if (!parsed.success) return sendWatchError(request, reply, "PAIRING_CODE_INVALID");

    let claim: PairingClaim;
    try {
      claim = await devices.claimPairingCode(parsed.data.code, {
        deviceId: parsed.data.deviceId,
        deviceName: parsed.data.deviceName
      });
    } catch (error) {
      request.log.error({ err: error }, "Watch pairing failed");
      return sendWatchError(request, reply, "INTERNAL_ERROR");
    }
    if (claim.status === "invalid") return sendWatchError(request, reply, "PAIRING_CODE_INVALID");
    if (claim.status === "expired") return sendWatchError(request, reply, "PAIRING_CODE_EXPIRED");

    return pairResponseSchema.parse({
      protocolVersion: 1,
      deviceToken: claim.deviceToken,
      companionId: claim.companionId,
      manifestRevision: claim.manifestRevision
    });
  });

  app.get("/api/v1/watch/config", async (request, reply) => {
    const authentication = authenticateWatch(request, reply, devices);
    if (authentication === undefined) return;

    try {
      liveSync?.noteMetadata(authentication.deviceId, false);
      const config = configuration.getConfig();
      const etag = `"${config.manifestRevision}"`;
      reply.header("ETag", etag);
      if (request.headers["if-none-match"] === etag) return reply.code(304).send();
      return config;
    } catch (error) {
      request.log.error({ err: error }, "Watch configuration failed");
      return sendWatchError(request, reply, "INTERNAL_ERROR");
    }
  });

  app.get<{ Querystring: { cursor?: string } }>("/api/v1/watch/playlists", async (request, reply) => {
    const authentication = authenticateWatch(request, reply, devices);
    if (authentication === undefined) return;
    const cursor = request.query.cursor;
    if (cursor !== undefined && !cursorSchema.safeParse(cursor).success) {
      return sendWatchError(request, reply, "INVALID_REQUEST");
    }
    try {
      liveSync?.noteMetadata(authentication.deviceId);
      return manifest.listPlaylists(cursor);
    } catch (error) {
      request.log.error({ err: error }, "Watch playlist page failed");
      return sendWatchError(request, reply, error instanceof Error && error.message === "Invalid watch cursor" ? "INVALID_REQUEST" : "INTERNAL_ERROR");
    }
  });

  app.get<{ Params: { playlistId: string }; Querystring: { cursor?: string } }>(
    "/api/v1/watch/playlists/:playlistId/tracks",
    async (request, reply) => {
      const authentication = authenticateWatch(request, reply, devices);
      if (authentication === undefined) return;
      const playlistId = stableIdSchema.safeParse(request.params.playlistId);
      const cursor = request.query.cursor;
      if (!playlistId.success || (cursor !== undefined && !cursorSchema.safeParse(cursor).success)) {
        return sendWatchError(request, reply, "INVALID_REQUEST");
      }
      try {
        liveSync?.noteMetadata(authentication.deviceId);
        const page = manifest.listTracks(playlistId.data, cursor);
        return page === undefined ? sendWatchError(request, reply, "PLAYLIST_NOT_FOUND") : page;
      } catch (error) {
        request.log.error({ err: error }, "Watch track page failed");
        return sendWatchError(request, reply, error instanceof Error && error.message === "Invalid watch cursor" ? "INVALID_REQUEST" : "INTERNAL_ERROR");
      }
    }
  );

  app.post("/api/v1/watch/sync-result", async (request, reply) => {
    const authentication = authenticateWatch(request, reply, devices);
    if (authentication === undefined) return;
    const body = request.body;
    if (
      body !== null &&
      typeof body === "object" &&
      "protocolVersion" in body &&
      (body as { protocolVersion?: unknown }).protocolVersion !== 1
    ) {
      return sendWatchError(request, reply, "PROTOCOL_UNSUPPORTED");
    }
    const parsed = syncResultRequestSchema.safeParse(body);
    if (!parsed.success) return sendWatchError(request, reply, "INVALID_REQUEST");
    try {
      const current = manifest.recordSyncResult(authentication.deviceId, parsed.data);
      if (current) {
        const completed = liveSync?.noteSyncResult(authentication.deviceId, parsed.data);
        if (completed !== undefined && completed !== null) devices.recordSyncHistory(completed);
      }
      return syncResultResponseSchema.parse({ recorded: true });
    } catch (error) {
      request.log.error({ err: error }, "Watch sync result failed");
      return sendWatchError(request, reply, "INTERNAL_ERROR");
    }
  });

  app.get<{ Params: { trackId: string } }>("/api/v1/watch/tracks/:trackId/audio", async (request, reply) => {
    const authentication = authenticateWatch(request, reply, devices);
    if (authentication === undefined) return;
    const trackId = stableIdSchema.safeParse(request.params.trackId);
    if (!trackId.success) return sendWatchError(request, reply, "INVALID_REQUEST");
    const disconnected = new AbortController();
    reply.raw.once("close", () => disconnected.abort());
    try {
      const stream = await mediaProxy.openAudio(trackId.data, authentication.deviceId, disconnected.signal);
      reply.type("audio/mpeg");
      reply.header("Cache-Control", "no-store");
      if (stream.contentLength !== undefined) reply.header("Content-Length", String(stream.contentLength));
      if (liveSync === undefined) return reply.send(stream.body);

      const deviceId = authentication.deviceId;
      const track = manifest.describeTrack(trackId.data);
      const observed = liveSync.observeAudio(deviceId, {
        id: trackId.data,
        title: track?.title ?? "Unknown track",
        artist: track?.artist ?? "Unknown artist",
        expectedBytes: stream.contentLength ?? expectedTrackBytes(configuration, track?.durationSeconds)
      }, stream.body);
      return reply.send(observed);
    } catch (error) {
      if (error instanceof PlexMediaNotFoundError) return sendWatchError(request, reply, "TRACK_NOT_FOUND");
      if (error instanceof PlexTranscodeBusyError) return sendWatchError(request, reply, "RATE_LIMITED");
      if (error instanceof PlexTranscodeFailedError) return sendWatchError(request, reply, "TRANSCODE_FAILED");
      if (error instanceof PlexProxyUnavailableError) return sendWatchError(request, reply, "PLEX_UNAVAILABLE");
      request.log.error({ err: error }, "Watch audio proxy failed");
      return sendWatchError(request, reply, "INTERNAL_ERROR");
    }
  });

  app.get<{ Params: { artworkId: string; expires: string; signature: string; trackId: string } }>(
    "/api/v1/watch/a/:artworkId/:expires/:signature/:trackId",
    async (request, reply) => {
      const trackId = stableIdSchema.safeParse(request.params.trackId);
      if (
        !trackId.success ||
        !manifest.authorizeArtwork(
          trackId.data,
          request.params.artworkId,
          request.params.expires,
          request.params.signature
        )
      ) {
        return sendWatchError(request, reply, "TRACK_NOT_FOUND");
      }
      const disconnected = new AbortController();
      reply.raw.once("close", () => disconnected.abort());
      try {
        // Artwork requests carry a signed capability instead of a bearer token
        // (Garmin's image loader cannot set headers), so they can only be
        // attributed when exactly one sync is running.
        liveSync?.noteArtworkActivity();
        const stream = await mediaProxy.openArtwork(trackId.data, disconnected.signal);
        reply.type("image/jpeg");
        reply.header("Cache-Control", "no-store");
        if (stream.contentLength !== undefined) reply.header("Content-Length", String(stream.contentLength));
        return reply.send(stream.body);
      } catch (error) {
        if (error instanceof PlexMediaNotFoundError || error instanceof PlexArtworkNotFoundError) {
          return sendWatchError(request, reply, "TRACK_NOT_FOUND");
        }
        if (error instanceof PlexProxyUnavailableError) return sendWatchError(request, reply, "PLEX_UNAVAILABLE");
        request.log.error({ err: error }, "Watch artwork proxy failed");
        return sendWatchError(request, reply, "INTERNAL_ERROR");
      }
    }
  );
}

/**
 * Plex sends transcodes without a Content-Length, so the live view falls back
 * to the profile bitrate to size the in-flight track.
 */
function expectedTrackBytes(
  configuration: WatchConfigurationRepository,
  durationSeconds: number | undefined
): number | null {
  if (durationSeconds === undefined || durationSeconds <= 0) return null;
  try {
    return estimateBytes(durationSeconds, profileBitrateKbps[configuration.getConfig().transcodeProfile]);
  } catch {
    return null;
  }
}

function authenticateWatch(
  request: FastifyRequest,
  reply: FastifyReply,
  devices: DeviceRepository
): Extract<DeviceAuthentication, { status: "authenticated" }> | undefined {
  const authorization = request.headers.authorization;
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,160})$/i);
  if (match === undefined || match === null) {
    sendWatchError(request, reply, "AUTH_REQUIRED");
    return undefined;
  }
  let authentication: DeviceAuthentication;
  try {
    authentication = devices.authenticateDevice(match[1]!);
  } catch (error) {
    request.log.error({ err: error }, "Watch authentication failed");
    sendWatchError(request, reply, "INTERNAL_ERROR");
    return undefined;
  }
  if (authentication.status === "invalid") {
    sendWatchError(request, reply, "AUTH_REQUIRED");
    return undefined;
  }
  if (authentication.status === "revoked") {
    sendWatchError(request, reply, "DEVICE_REVOKED");
    return undefined;
  }
  return authentication;
}
