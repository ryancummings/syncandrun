export type Profile = "compact" | "balanced" | "high";
export type SyncStatusValue = "applied" | "partial" | "cancelled";

export interface Settings {
  plexConfigured: boolean;
  /** Origin the watch must be pointed at; entered by hand in the watch app settings. */
  companionUrl: string;
  transcodeProfile: Profile;
  selectedPlaylistCount: number;
  manifestRevision: string;
  updatedAt: string;
  version: string;
}

export interface Playlist {
  id: string;
  title: string;
  trackCount: number;
  durationSeconds: number;
  selected: boolean;
  selectable: boolean;
  unavailableReason: string | null;
}

export interface SyncTimings {
  launchMs?: number;
  totalMs: number;
  configMs?: number;
  metadataMs: number;
  audioTotalMs: number;
  audioStartupMs: number;
  audioTransferMs: number;
  audioFinalizeMs: number;
  artworkMs: number;
  audioBytes: number;
  audioProgressCallbacks: number;
  audioCount: number;
  artworkCount: number;
}

export interface Device {
  id: string;
  displayName: string;
  reportedName: string;
  customName: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  appliedRevision: string | null;
  lastSyncStatus: SyncStatusValue | null;
  lastSyncAt: string | null;
  lastSyncTimings: SyncTimings | null;
  lastSyncIsCheckpoint: boolean;
  measuredThroughputBps: number | null;
  measuredPerTrackOverheadMs: number | null;
}

export interface SyncHistoryEntry {
  id: number;
  revision: string;
  status: SyncStatusValue;
  downloaded: number;
  reused: number;
  deleted: number;
  failed: number;
  errorCodes: string[];
  observedBytes: number;
  transferMs: number;
  throughputBps: number | null;
  startedAt: string;
  finishedAt: string;
}

export type LiveSyncPhase = "metadata" | "audio" | "artwork" | "reporting" | "finished";

export interface LiveSyncSnapshot {
  deviceId: string;
  startedAt: string;
  updatedAt: string;
  phase: LiveSyncPhase;
  revision: string | null;
  counts: { downloaded: number; reused: number; deleted: number; failed: number } | null;
  errorCodes: string[];
  completedTracks: number;
  observedBytes: number;
  transferMs: number;
  throughputBps: number | null;
  currentTrack: {
    id: string;
    title: string;
    artist: string;
    transferredBytes: number;
    expectedBytes: number | null;
    elapsedMs: number;
  } | null;
  /** Retained after a transfer ends, so the track name does not blink out. */
  lastTrack: { id: string; title: string; artist: string } | null;
  finishedStatus: SyncStatusValue | null;
  stalled: boolean;
}

export interface SyncPlan {
  profile: Profile;
  bitrateKbps: number;
  playlistCount: number;
  trackCount: number;
  durationSeconds: number;
  estimatedBytes: number;
  manifestRevision: string;
}

export interface TransferEstimate {
  throughputBps: number;
  perTrackOverheadMs: number;
  source: "measured" | "session" | "default";
  remainingTracks: number;
  remainingBytes: number;
  remainingMs: number | null;
}

export interface DeviceSyncStatus {
  deviceId: string;
  live: LiveSyncSnapshot | null;
  estimate: TransferEstimate;
  upToDate: boolean;
}

export interface SyncStatus {
  plan: SyncPlan;
  devices: DeviceSyncStatus[];
  generatedAt: string;
}

export interface PlexConnection {
  uri: string;
  relay: boolean;
}

export interface PlexServer {
  id: string;
  name: string;
  connections: PlexConnection[];
}

export interface PlexLibrary {
  id: string;
  title: string;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  csrf?: string | null;
  body?: unknown;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.csrf) headers.set("X-CSRF-Token", options.csrf);
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    signal: options.signal,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const body = response.status === 204 ? null : ((await response.json().catch(() => null)) as unknown);
  if (!response.ok) {
    const error = typeof body === "object" && body !== null && "error" in body
      ? (body as { error?: { message?: string; code?: string } }).error
      : undefined;
    throw new ApiError(
      error?.message ?? "The companion could not complete that request.",
      response.status,
      error?.code ?? null
    );
  }
  return body as T;
}

export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}
