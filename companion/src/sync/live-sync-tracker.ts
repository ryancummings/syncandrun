import { Transform, type Readable } from "node:stream";
import type { SyncHistoryRecord } from "../persistence/device-repository.js";
import type { SyncResultRequest } from "../protocol/schemas.js";

export type LiveSyncPhase = "metadata" | "audio" | "artwork" | "reporting" | "finished";

export interface LiveTrackSnapshot {
  id: string;
  title: string;
  artist: string;
  transferredBytes: number;
  expectedBytes: number | null;
  elapsedMs: number;
}

export interface TrackIdentity {
  id: string;
  title: string;
  artist: string;
}

export interface LiveSyncSnapshot {
  deviceId: string;
  startedAt: string;
  updatedAt: string;
  phase: LiveSyncPhase;
  revision: string | null;
  counts: { downloaded: number; reused: number; deleted: number; failed: number } | null;
  errorCodes: string[];
  /** Audio transfers this companion has served to completion this session. */
  completedTracks: number;
  observedBytes: number;
  transferMs: number;
  /** Measured this session only; null until a track finishes with bytes. */
  throughputBps: number | null;
  currentTrack: LiveTrackSnapshot | null;
  /**
   * The most recent track this session transferred, retained after the transfer
   * ends. Garmin finalizes its encrypted cache between downloads, so
   * `currentTrack` is null for a meaningful part of a sync and the operator
   * would otherwise watch the track name blink in and out.
   */
  lastTrack: TrackIdentity | null;
  finishedStatus: "applied" | "partial" | "cancelled" | null;
  stalled: boolean;
}

export interface LiveSyncTrackerOptions {
  now?: () => number;
  /** No watch traffic for this long means the sync is no longer progressing. */
  stallAfterMs?: number;
  /** How long a finished or abandoned session stays visible to the browser. */
  retainFinishedMs?: number;
  retainStalledMs?: number;
}

interface TrackState {
  id: string;
  title: string;
  artist: string;
  expectedBytes: number | null;
  transferredBytes: number;
  startedAt: number;
}

interface SessionState {
  deviceId: string;
  startedAt: number;
  startedAtIso: string;
  updatedAt: number;
  phase: LiveSyncPhase;
  revision: string | null;
  counts: { downloaded: number; reused: number; deleted: number; failed: number } | null;
  errorCodes: string[];
  completedTracks: number;
  observedBytes: number;
  transferMs: number;
  current: TrackState | null;
  lastTrack: TrackIdentity | null;
  finishedStatus: "applied" | "partial" | "cancelled" | null;
  finishedAt: number | null;
}

export interface TrackDescription {
  id: string;
  title: string;
  artist: string;
  expectedBytes: number | null;
}

const defaultStallAfterMs = 45_000;
const defaultRetainFinishedMs = 5 * 60 * 1000;
const defaultRetainStalledMs = 15 * 60 * 1000;

/**
 * Live sync state derived entirely from the traffic the watch already makes:
 * manifest reads, proxied audio bytes, and the checkpoint reports the
 * reconciler posts every few tracks. Nothing here requires a watch change, and
 * nothing is persisted until a sync ends.
 */
export class LiveSyncTracker {
  readonly #sessions = new Map<string, SessionState>();
  readonly #listeners = new Set<(snapshots: LiveSyncSnapshot[]) => void>();
  readonly #now: () => number;
  readonly #stallAfterMs: number;
  readonly #retainFinishedMs: number;
  readonly #retainStalledMs: number;

  constructor(options: LiveSyncTrackerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#stallAfterMs = options.stallAfterMs ?? defaultStallAfterMs;
    this.#retainFinishedMs = options.retainFinishedMs ?? defaultRetainFinishedMs;
    this.#retainStalledMs = options.retainStalledMs ?? defaultRetainStalledMs;
  }

  subscribe(listener: (snapshots: LiveSyncSnapshot[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * `opensSession` separates a manifest traversal (only a sync does that) from
   * a bare configuration poll, which the watch also performs on app open and
   * must not be mistaken for a sync in progress.
   */
  noteMetadata(deviceId: string, opensSession = true): void {
    this.#expire();
    const existing = this.#sessions.get(deviceId);
    if (!opensSession) {
      if (existing === undefined || existing.finishedStatus !== null) return;
      existing.updatedAt = this.#now();
      this.#publish();
      return;
    }
    // A manifest traversal after a finished sync is the start of the next one.
    if (existing !== undefined && existing.finishedStatus !== null) this.#sessions.delete(deviceId);
    const session = this.#session(deviceId);
    if (session.current === null) session.phase = "metadata";
    session.updatedAt = this.#now();
    this.#publish();
  }

  /** Observes a byte stream while preserving backpressure, errors and cancellation. */
  observeAudio(deviceId: string, track: TrackDescription, source: Readable): Readable {
    const session = this.#reopen(deviceId);
    const current: TrackState = { ...track, transferredBytes: 0, startedAt: this.#now() };
    session.phase = "audio";
    session.current = current;
    session.lastTrack = { id: track.id, title: track.title, artist: track.artist };
    session.updatedAt = this.#now();
    this.#publish();

    // Late events from an older download must not update a replacement track
    // or a session recreated after revocation, expiry or a final sync report.
    const isCurrent = () => this.#sessions.get(deviceId) === session && session.current === current;
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      if (!isCurrent()) return;
      const now = this.#now();
      if (current.transferredBytes > 0) session.transferMs += Math.max(now - current.startedAt, 1);
      if (completed) session.completedTracks += 1;
      session.current = null;
      session.phase = "reporting";
      session.updatedAt = now;
      this.#publish();
    };
    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        if (isCurrent()) {
          current.transferredBytes += chunk.length;
          session.observedBytes += chunk.length;
          session.updatedAt = this.#now();
          this.#publish();
        }
        callback(null, chunk);
      }
    });
    const sourceError = (cause: Error) => counter.destroy(cause);
    const sourceClosed = () => {
      source.off("error", sourceError);
      if (!source.readableEnded && !counter.destroyed) {
        counter.destroy(new Error("Audio source closed before completion"));
      }
    };
    source.once("error", sourceError);
    source.once("close", sourceClosed);
    counter.once("end", () => finish(true));
    counter.once("error", () => finish(false));
    counter.once("close", () => {
      finish(false);
      source.unpipe(counter);
      // Destroying the observed stream cancels Plex as well. Keep the source
      // error listener until close to receive any already scheduled error.
      if (!source.destroyed) source.destroy();
    });
    return source.pipe(counter);
  }

  /**
   * Artwork transfers are authorized by a signed capability rather than a
   * device token, so they are attributed only when a single sync is running.
   */
  noteArtworkActivity(): void {
    this.#expire();
    const running = [...this.#sessions.values()].filter((session) => session.finishedStatus === null);
    const session = running.length === 1 ? running[0] : undefined;
    if (session === undefined) return;
    if (session.current === null) session.phase = "artwork";
    session.updatedAt = this.#now();
    this.#publish();
  }

  /**
   * Checkpoints and final reports share a shape. A `partial` report is treated
   * as final but does not close the session: if the watch keeps downloading,
   * the next transfer reopens it.
   */
  noteSyncResult(deviceId: string, result: SyncResultRequest): SyncHistoryRecord | null {
    const session = this.#reopen(deviceId);
    const now = this.#now();
    session.revision = result.revision;
    session.counts = { ...result.counts };
    session.errorCodes = [...result.errorCodes];
    session.updatedAt = now;

    const checkpoint = isCheckpoint(result);
    if (checkpoint) {
      session.phase = session.current === null ? "reporting" : "audio";
      this.#publish();
      return null;
    }

    session.phase = "finished";
    session.finishedStatus = result.status;
    session.finishedAt = now;
    session.current = null;
    this.#publish();
    return {
      deviceId,
      revision: result.revision,
      status: result.status,
      downloaded: result.counts.downloaded,
      reused: result.counts.reused,
      deleted: result.counts.deleted,
      failed: result.counts.failed,
      errorCodes: [...result.errorCodes],
      observedBytes: session.observedBytes,
      transferMs: session.transferMs,
      startedAt: session.startedAtIso,
      finishedAt: new Date(now).toISOString()
    };
  }

  /** Drops a device's session outright — used when a watch is revoked or forgotten. */
  clear(deviceId: string): void {
    if (this.#sessions.delete(deviceId)) this.#publish();
  }

  clearAll(): void {
    if (this.#sessions.size === 0) return;
    this.#sessions.clear();
    this.#publish();
  }

  snapshots(): LiveSyncSnapshot[] {
    this.#expire();
    return [...this.#sessions.values()]
      .map((session) => this.#toSnapshot(session))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  #session(deviceId: string): SessionState {
    this.#expire();
    const existing = this.#sessions.get(deviceId);
    if (existing !== undefined) return existing;
    const now = this.#now();
    const created: SessionState = {
      deviceId,
      startedAt: now,
      startedAtIso: new Date(now).toISOString(),
      updatedAt: now,
      phase: "metadata",
      revision: null,
      counts: null,
      errorCodes: [],
      completedTracks: 0,
      observedBytes: 0,
      transferMs: 0,
      current: null,
      lastTrack: null,
      finishedStatus: null,
      finishedAt: null
    };
    this.#sessions.set(deviceId, created);
    return created;
  }

  /** Activity after a `partial` report means the watch is still working. */
  #reopen(deviceId: string): SessionState {
    const session = this.#session(deviceId);
    if (session.finishedStatus === "partial") {
      session.finishedStatus = null;
      session.finishedAt = null;
      session.phase = "audio";
    }
    return session;
  }

  #expire(): void {
    const now = this.#now();
    for (const [deviceId, session] of this.#sessions) {
      const finishedFor = session.finishedAt === null ? 0 : now - session.finishedAt;
      const idleFor = now - session.updatedAt;
      if (session.finishedAt !== null && finishedFor > this.#retainFinishedMs) this.#sessions.delete(deviceId);
      else if (session.finishedAt === null && idleFor > this.#retainStalledMs) this.#sessions.delete(deviceId);
    }
  }

  #toSnapshot(session: SessionState): LiveSyncSnapshot {
    const now = this.#now();
    const throughputBps =
      session.transferMs > 0 && session.observedBytes > 0
        ? Math.round((session.observedBytes * 8000) / session.transferMs)
        : null;
    return {
      deviceId: session.deviceId,
      startedAt: session.startedAtIso,
      updatedAt: new Date(session.updatedAt).toISOString(),
      phase: session.phase,
      revision: session.revision,
      counts: session.counts === null ? null : { ...session.counts },
      errorCodes: [...session.errorCodes],
      completedTracks: session.completedTracks,
      observedBytes: session.observedBytes,
      transferMs: session.transferMs,
      throughputBps,
      currentTrack:
        session.current === null
          ? null
          : {
              id: session.current.id,
              title: session.current.title,
              artist: session.current.artist,
              transferredBytes: session.current.transferredBytes,
              expectedBytes: session.current.expectedBytes,
              elapsedMs: Math.max(now - session.current.startedAt, 0)
            },
      lastTrack: session.lastTrack === null ? null : { ...session.lastTrack },
      finishedStatus: session.finishedStatus,
      stalled: session.finishedStatus === null && now - session.updatedAt > this.#stallAfterMs
    };
  }

  #publish(): void {
    if (this.#listeners.size === 0) return;
    const snapshots = this.snapshots();
    for (const listener of this.#listeners) listener(snapshots);
  }
}

/**
 * The reconciler posts an interim `partial` every few completed downloads. A
 * genuine partial outcome carries failures or an empty-progress report, so the
 * interim form is a clean `partial` that still carries timings.
 */
function isCheckpoint(result: SyncResultRequest): boolean {
  return result.status === "partial" && result.counts.failed === 0 && result.timings !== undefined;
}
