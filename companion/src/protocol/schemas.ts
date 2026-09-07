import { z } from "zod";

export const protocolVersionSchema = z.literal(1);
export const stableIdSchema = z.string().min(1).max(96).regex(/^[A-Za-z0-9._~:-]+$/);
export const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const cursorSchema = z.string().min(1).max(160).nullable();

export const transcodeProfileSchema = z.enum(["compact", "balanced", "high"]);

export const pairRequestSchema = z.strictObject({
  code: z.string().regex(/^[0-9]{6}$/),
  deviceId: stableIdSchema,
  deviceName: z.string().min(1).max(48),
  appVersion: z.string().min(1).max(24),
  protocolVersion: protocolVersionSchema
});

export const pairResponseSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  deviceToken: z.string().min(32).max(160),
  companionId: stableIdSchema,
  manifestRevision: revisionSchema
});

export const watchConfigSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  manifestRevision: revisionSchema,
  transcodeProfile: transcodeProfileSchema,
  pageSize: z.literal(10),
  serverTime: z.iso.datetime()
});

export const playlistSchema = z.strictObject({
  id: stableIdSchema,
  name: z.string().min(1).max(80),
  revision: revisionSchema,
  trackCount: z.number().int().min(0).max(10_000),
  durationSeconds: z.number().int().min(0).max(10_000_000),
  tracksPath: z.string().min(1).max(180).startsWith("/api/v1/watch/")
});

const artworkLocationSchema = z.string().max(320).refine((value) => {
  if (value.startsWith("/api/v1/watch/a/")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === ""
      && url.pathname.startsWith("/api/v1/watch/a/");
  } catch {
    return false;
  }
}, "must be a relative artwork capability path or an absolute HTTPS artwork capability URL");

export const trackSchema = z.strictObject({
  id: stableIdSchema,
  contentFingerprint: revisionSchema,
  title: z.string().max(80),
  artist: z.string().max(80),
  album: z.string().max(80),
  durationSeconds: z.number().int().min(0).max(86_400),
  downloadPath: z.string().min(1).max(180).startsWith("/api/v1/watch/"),
  artworkId: z.string().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/).nullable(),
  artworkPath: artworkLocationSchema.nullable()
}).refine((track) => (track.artworkId === null) === (track.artworkPath === null), {
  message: "Artwork id and path must either both be present or both be null"
});

export const playlistPageSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  items: z.array(playlistSchema).max(10),
  nextCursor: cursorSchema
});

export const trackPageSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  playlistId: stableIdSchema,
  items: z.array(trackSchema).max(10),
  nextCursor: cursorSchema
});

export const errorCodeSchema = z.enum([
  "AUTH_REQUIRED",
  "DEVICE_REVOKED",
  "PAIRING_CODE_INVALID",
  "PAIRING_CODE_EXPIRED",
  "PROTOCOL_UNSUPPORTED",
  "PLEX_UNAVAILABLE",
  "PLEX_TOKEN_INVALID",
  "PLAYLIST_NOT_FOUND",
  "TRACK_NOT_FOUND",
  "TRANSCODE_FAILED",
  "STORAGE_INSUFFICIENT",
  "RATE_LIMITED",
  "INVALID_REQUEST",
  "INTERNAL_ERROR"
]);

export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string().min(1).max(160),
    retryable: z.boolean(),
    requestId: z.string().min(8).max(32)
  })
});

export const syncTimingsSchema = z.strictObject({
  launchMs: z.number().int().min(0).max(86_400_000).optional(),
  totalMs: z.number().int().min(0).max(86_400_000),
  configMs: z.number().int().min(0).max(86_400_000).optional(),
  metadataMs: z.number().int().min(0).max(86_400_000),
  audioTotalMs: z.number().int().min(0).max(86_400_000),
  audioStartupMs: z.number().int().min(0).max(86_400_000),
  audioTransferMs: z.number().int().min(0).max(86_400_000),
  audioFinalizeMs: z.number().int().min(0).max(86_400_000),
  artworkMs: z.number().int().min(0).max(86_400_000),
  audioBytes: z.number().int().min(0).max(2_000_000_000),
  audioProgressCallbacks: z.number().int().min(0).max(1_000_000),
  audioCount: z.number().int().min(0).max(10_000),
  artworkCount: z.number().int().min(0).max(10_000)
});

export const syncResultRequestSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  revision: revisionSchema,
  status: z.enum(["applied", "partial", "cancelled"]),
  counts: z.strictObject({
    downloaded: z.number().int().min(0).max(10_000),
    reused: z.number().int().min(0).max(10_000),
    deleted: z.number().int().min(0).max(10_000),
    failed: z.number().int().min(0).max(10_000)
  }),
  errorCodes: z.array(errorCodeSchema).max(10).refine((items) => new Set(items).size === items.length),
  timings: syncTimingsSchema.optional()
});

export const syncResultResponseSchema = z.strictObject({ recorded: z.literal(true) });

export type WatchConfig = z.infer<typeof watchConfigSchema>;
export type PairRequest = z.infer<typeof pairRequestSchema>;
export type PairResponse = z.infer<typeof pairResponseSchema>;
export type PlaylistPage = z.infer<typeof playlistPageSchema>;
export type TrackPage = z.infer<typeof trackPageSchema>;
export type WatchError = z.infer<typeof errorResponseSchema>;
export type SyncResultRequest = z.infer<typeof syncResultRequestSchema>;
export type SyncTimings = z.infer<typeof syncTimingsSchema>;
