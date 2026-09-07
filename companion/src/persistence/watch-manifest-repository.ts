import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { calculateContentFingerprint } from "../protocol/manifest.js";
import {
  playlistPageSchema,
  syncResultRequestSchema,
  trackPageSchema,
  type PlaylistPage,
  type SyncResultRequest,
  type TrackPage
} from "../protocol/schemas.js";

const pageSize = 10;
const artworkCapabilityLifetimeSeconds = 6 * 60 * 60;
const artworkDigestBytes = 16;

interface SettingsRow {
  selected_playlist_ids: string;
  transcode_profile: "compact" | "balanced" | "high";
}

interface SnapshotRow {
  playlist_id: string;
  title: string;
  ordered_track_ids: string;
  revision: string;
}

interface TrackRow {
  track_id: string;
  media_part_fingerprint: string;
  title: string;
  artist: string;
  album: string;
  duration_seconds: number;
  artwork_key: string | null;
}

export class WatchManifestRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly secret: string,
    private readonly artworkBaseUrl?: URL
  ) {}

  listPlaylists(cursor?: string): PlaylistPage {
    const offset = this.#decodeCursor(cursor);
    const settings = this.#getSettings();
    const selectedIds = parseStringArray(settings.selected_playlist_ids);
    const pageIds = selectedIds.slice(offset, offset + pageSize);
    const items = pageIds.map((id) => {
      const snapshot = this.#getSnapshot(id);
      const trackIds = parseStringArray(snapshot.ordered_track_ids);
      const durationSeconds = trackIds.reduce((total, trackId) => total + this.#getTrack(trackId).duration_seconds, 0);
      return {
        id: snapshot.playlist_id,
        name: truncate(snapshot.title, 80),
        revision: snapshot.revision,
        trackCount: Math.min(trackIds.length, 10_000),
        durationSeconds: Math.min(durationSeconds, 10_000_000),
        tracksPath: `/api/v1/watch/playlists/${encodeURIComponent(snapshot.playlist_id)}/tracks`
      };
    });
    const nextOffset = offset + items.length;
    return playlistPageSchema.parse({
      protocolVersion: 1,
      items,
      nextCursor: nextOffset < selectedIds.length ? this.#encodeCursor(nextOffset) : null
    });
  }

  listTracks(playlistId: string, cursor?: string, now = new Date()): TrackPage | undefined {
    const offset = this.#decodeCursor(cursor);
    const settings = this.#getSettings();
    const selectedIds = parseStringArray(settings.selected_playlist_ids);
    if (!selectedIds.includes(playlistId)) return undefined;
    const snapshot = this.#getSnapshot(playlistId);
    const trackIds = parseStringArray(snapshot.ordered_track_ids);
    const pageIds = trackIds.slice(offset, offset + pageSize);
    const items = pageIds.map((id) => {
      const track = this.#getTrack(id);
      const artwork = track.artwork_key === null ? null : this.#artworkCapability(track, now);
      return {
        id: track.track_id,
        contentFingerprint: calculateContentFingerprint(track.media_part_fingerprint, settings.transcode_profile),
        title: truncate(track.title, 80),
        artist: truncate(track.artist, 80),
        album: truncate(track.album, 80),
        durationSeconds: Math.min(track.duration_seconds, 86_400),
        downloadPath: `/api/v1/watch/tracks/${encodeURIComponent(track.track_id)}/audio`,
        artworkId: artwork?.id ?? null,
        artworkPath: artwork?.path ?? null
      };
    });
    const nextOffset = offset + items.length;
    return trackPageSchema.parse({
      protocolVersion: 1,
      playlistId,
      items,
      nextCursor: nextOffset < trackIds.length ? this.#encodeCursor(nextOffset) : null
    });
  }

  authorizeArtwork(
    trackId: string,
    artworkId: string,
    expires: string,
    signature: string,
    now = new Date()
  ): boolean {
    if (!/^\d{10}$/.test(expires) || !/^[A-Za-z0-9_-]{22}$/.test(artworkId) || !/^[A-Za-z0-9_-]{22}$/.test(signature)) {
      return false;
    }
    const expiration = Number(expires);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (!Number.isSafeInteger(expiration) || expiration <= nowSeconds) return false;
    let track: TrackRow;
    try {
      track = this.#getTrack(trackId);
    } catch {
      return false;
    }
    if (track.artwork_key === null || this.#artworkId(track.artwork_key) !== artworkId) return false;
    const expected = this.#artworkSignature(trackId, artworkId, expires);
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, "base64url");
    } catch {
      return false;
    }
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** Display-only track detail for the operator's live sync view. */
  describeTrack(trackId: string): { title: string; artist: string; durationSeconds: number } | undefined {
    try {
      const track = this.#getTrack(trackId);
      return { title: track.title, artist: track.artist, durationSeconds: track.duration_seconds };
    } catch {
      return undefined;
    }
  }

  recordSyncResult(deviceId: string, value: SyncResultRequest, now = new Date()): boolean {
    const result = syncResultRequestSchema.parse(value);
    const timestamp = now.toISOString();
    return this.database.transaction(() => {
      const device = this.database
        .prepare("SELECT applied_revision FROM devices WHERE id = ?")
        .get(deviceId) as { applied_revision: string | null } | undefined;
      // An interrupted Garmin sync can outlive a later retry and deliver its
      // final callback after that retry has already applied the same manifest.
      // Never let that stale non-applying report downgrade authoritative state.
      if (result.status !== "applied" && device?.applied_revision === result.revision) return false;
      this.database
        .prepare(
          `INSERT INTO device_sync_results
             (device_id, revision, status, downloaded, reused, deleted, failed, error_codes, timings_json, reported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
             revision = excluded.revision,
             status = excluded.status,
             downloaded = excluded.downloaded,
             reused = excluded.reused,
             deleted = excluded.deleted,
             failed = excluded.failed,
             error_codes = excluded.error_codes,
             timings_json = excluded.timings_json,
             reported_at = excluded.reported_at`
        )
        .run(
          deviceId,
          result.revision,
          result.status,
          result.counts.downloaded,
          result.counts.reused,
          result.counts.deleted,
          result.counts.failed,
          JSON.stringify(result.errorCodes),
          result.timings === undefined ? null : JSON.stringify(result.timings),
          timestamp
        );
      if (result.status === "applied") {
        this.database.prepare("UPDATE devices SET applied_revision = ? WHERE id = ?").run(result.revision, deviceId);
      }
      return true;
    })();
  }

  #getSettings(): SettingsRow {
    return this.database
      .prepare("SELECT selected_playlist_ids, transcode_profile FROM settings WHERE id = 1")
      .get() as SettingsRow;
  }

  #getSnapshot(playlistId: string): SnapshotRow {
    const row = this.database
      .prepare("SELECT playlist_id, title, ordered_track_ids, revision FROM playlist_snapshots WHERE playlist_id = ?")
      .get(playlistId) as SnapshotRow | undefined;
    if (row === undefined) throw new Error("Selected playlist snapshot is missing");
    return row;
  }

  #getTrack(trackId: string): TrackRow {
    const row = this.database
      .prepare(
        `SELECT track_id, media_part_fingerprint, title, artist, album, duration_seconds, artwork_key
         FROM track_metadata WHERE track_id = ?`
      )
      .get(trackId) as TrackRow | undefined;
    if (row === undefined) throw new Error("Playlist track metadata is missing");
    return row;
  }

  #artworkCapability(track: TrackRow, now: Date): { id: string; path: string } {
    if (track.artwork_key === null) throw new Error("Artwork capability requires artwork");
    const id = this.#artworkId(track.artwork_key);
    const expires = String(Math.floor(now.getTime() / 1000) + artworkCapabilityLifetimeSeconds);
    const signature = this.#artworkSignature(track.track_id, id, expires).toString("base64url");
    const path = `/api/v1/watch/a/${id}/${expires}/${signature}/${encodeURIComponent(track.track_id)}`;
    return {
      id,
      path: this.artworkBaseUrl === undefined ? path : new URL(path, this.artworkBaseUrl).href
    };
  }

  #artworkId(artworkKey: string): string {
    return createHash("sha256").update(artworkKey, "utf8").digest().subarray(0, artworkDigestBytes).toString("base64url");
  }

  #artworkSignature(trackId: string, artworkId: string, expires: string): Buffer {
    return createHmac("sha256", this.secret)
      .update(`watch-artwork:${trackId}:${artworkId}:${expires}`, "utf8")
      .digest()
      .subarray(0, artworkDigestBytes);
  }

  #encodeCursor(offset: number): string {
    const value = Buffer.from(String(offset), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret).update(`watch-cursor:${value}`).digest("base64url");
    return `${value}.${signature}`;
  }

  #decodeCursor(cursor: string | undefined): number {
    if (cursor === undefined) return 0;
    const [value, signature, ...extra] = cursor.split(".");
    if (value === undefined || signature === undefined || extra.length > 0) throw new Error("Invalid watch cursor");
    const expected = createHmac("sha256", this.secret).update(`watch-cursor:${value}`).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, "base64url");
    } catch {
      throw new Error("Invalid watch cursor");
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid watch cursor");
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (!/^\d+$/.test(decoded)) throw new Error("Invalid watch cursor");
    const offset = Number(decoded);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) throw new Error("Invalid watch cursor");
    return offset;
  }
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Stored manifest list is invalid");
  }
  return parsed;
}

function truncate(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join("");
}
