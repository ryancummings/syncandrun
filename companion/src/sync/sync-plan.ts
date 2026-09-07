import type Database from "better-sqlite3";

/** Mirrors the transcode ladder the media proxy asks Plex for. */
export const profileBitrateKbps = {
  compact: 64,
  balanced: 96,
  high: 128
} as const;

export type TranscodeProfile = keyof typeof profileBitrateKbps;

/** Kept well under SQLite's variable limit. */
const durationBatchSize = 400;

export interface SyncPlan {
  profile: TranscodeProfile;
  bitrateKbps: number;
  playlistCount: number;
  /** Distinct tracks: a track shared by two playlists is transferred once. */
  trackCount: number;
  durationSeconds: number;
  estimatedBytes: number;
  manifestRevision: string;
}

/**
 * Describes the full offline library implied by the current selection. This is
 * the denominator for sync progress and the basis of pre-transfer estimates;
 * a watch that already holds tracks transfers a subset of it.
 */
export class SyncPlanService {
  #cached: SyncPlan | undefined;

  constructor(private readonly database: Database.Database) {}

  /**
   * Memoized on the manifest revision, which changes whenever the selection,
   * the profile, or the library content changes. The live status stream reads
   * this on every frame, and the uncached walk touches every selected track.
   */
  get(): SyncPlan {
    const revision = this.database.prepare("SELECT manifest_revision FROM settings WHERE id = 1").pluck().get();
    if (this.#cached !== undefined && this.#cached.manifestRevision === revision) return this.#cached;
    this.#cached = this.#compute();
    return this.#cached;
  }

  #compute(): SyncPlan {
    const settings = this.database
      .prepare("SELECT transcode_profile, selected_playlist_ids, manifest_revision FROM settings WHERE id = 1")
      .get() as {
      transcode_profile: TranscodeProfile;
      selected_playlist_ids: string;
      manifest_revision: string;
    };
    const selected = parseStringArray(settings.selected_playlist_ids);
    const trackIds = new Set<string>();
    for (const playlistId of selected) {
      const snapshot = this.database
        .prepare("SELECT ordered_track_ids FROM playlist_snapshots WHERE playlist_id = ?")
        .get(playlistId) as { ordered_track_ids: string } | undefined;
      if (snapshot === undefined) continue;
      for (const trackId of parseStringArray(snapshot.ordered_track_ids)) trackIds.add(trackId);
    }

    // Summed in bounded batches rather than one query per track: a selection
    // can hold thousands of tracks.
    let durationSeconds = 0;
    const ids = [...trackIds];
    for (let offset = 0; offset < ids.length; offset += durationBatchSize) {
      const batch = ids.slice(offset, offset + durationBatchSize);
      const placeholders = batch.map(() => "?").join(",");
      const row = this.database
        .prepare(`SELECT COALESCE(SUM(duration_seconds), 0) FROM track_metadata WHERE track_id IN (${placeholders})`)
        .pluck()
        .get(...batch) as number;
      durationSeconds += row;
    }

    const bitrateKbps = profileBitrateKbps[settings.transcode_profile];
    return {
      profile: settings.transcode_profile,
      bitrateKbps,
      playlistCount: selected.length,
      trackCount: trackIds.size,
      durationSeconds,
      estimatedBytes: estimateBytes(durationSeconds, bitrateKbps),
      manifestRevision: settings.manifest_revision
    };
  }
}

export function estimateBytes(durationSeconds: number, bitrateKbps: number): number {
  return Math.round((durationSeconds * bitrateKbps * 1000) / 8);
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}
