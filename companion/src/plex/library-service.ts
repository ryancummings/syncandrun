import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalJson } from "./canonical-json.js";
import {
  PlexMediaClient,
  PlexPlaylistTooLargeError,
  type PlexAudioPlaylist,
  type PlexNormalizedTrack
} from "./media.js";
import type { PlexSetupService } from "./setup-service.js";

type Fetch = typeof fetch;

interface SettingsRow {
  selected_playlist_ids: string;
}

interface InstallationRow {
  plex_client_identifier: string;
}

interface RefreshedPlaylist {
  playlist: PlexAudioPlaylist;
  tracks: PlexNormalizedTrack[];
  sourceRevision: string;
}

export interface PlexLibraryServiceOptions {
  fetch?: Fetch;
  timeoutMs?: number;
}

export interface BrowserPlaylist {
  id: string;
  title: string;
  trackCount: number;
  durationSeconds: number;
  selected: boolean;
  sourceUpdatedAt: number;
  selectable: boolean;
  unavailableReason: string | null;
}

export class PlexLibraryService {
  readonly #database: Database.Database;
  readonly #setup: PlexSetupService;
  readonly #media: PlexMediaClient;

  constructor(database: Database.Database, setup: PlexSetupService, options: PlexLibraryServiceOptions = {}) {
    this.#database = database;
    this.#setup = setup;
    const installation = database
      .prepare("SELECT plex_client_identifier FROM installation WHERE id = 1")
      .get() as InstallationRow | undefined;
    if (installation === undefined) throw new Error("SyncAndRun installation is not initialized");
    this.#media = new PlexMediaClient({ clientIdentifier: installation.plex_client_identifier, ...options });
  }

  async listPlaylists(): Promise<BrowserPlaylist[]> {
    const connection = this.#setup.getStoredConnection();
    if (connection === undefined) throw new Error("Plex is not configured");
    const settings = this.#getSettings();
    const selected = new Set(parseSelectedIds(settings.selected_playlist_ids));
    return (await this.#media.listAudioPlaylists(connection)).map((playlist) => ({
      id: playlist.id,
      title: playlist.title,
      trackCount: playlist.trackCount,
      durationSeconds: playlist.durationSeconds,
      selected: selected.has(playlist.id),
      sourceUpdatedAt: playlist.sourceUpdatedAt,
      selectable: playlist.selectable,
      unavailableReason: playlist.unavailableReason
    }));
  }

  async selectPlaylists(selectedPlaylistIds: string[], now = new Date()): Promise<string> {
    if (selectedPlaylistIds.length > 500 || new Set(selectedPlaylistIds).size !== selectedPlaylistIds.length) {
      throw new Error("Selected Plex playlists are invalid");
    }
    const connection = this.#setup.getStoredConnection();
    if (connection === undefined) throw new Error("Plex is not configured");
    const available = await this.#media.listAudioPlaylists(connection);
    const byId = new Map(available.map((playlist) => [playlist.id, playlist]));
    const selected = selectedPlaylistIds.map((id) => {
      const playlist = byId.get(id);
      if (playlist === undefined) throw new Error("A selected Plex playlist is unavailable");
      if (!playlist.selectable) throw new PlexPlaylistTooLargeError();
      return playlist;
    });
    const refreshed: RefreshedPlaylist[] = [];
    for (const playlist of selected) {
      const tracks = await this.#media.listPlaylistTracks(connection, playlist);
      const sourceRevision = createHash("sha256")
        .update(canonicalJson({
          id: playlist.id,
          sourceUpdatedAt: playlist.sourceUpdatedAt,
          tracks: tracks.map((track) => ({ id: track.id, sourceFingerprint: track.sourceFingerprint }))
        }), "utf8")
        .digest("hex");
      refreshed.push({ playlist, tracks, sourceRevision });
    }
    return this.#storeRefresh(selectedPlaylistIds, refreshed, now);
  }

  async refreshSelected(now = new Date()): Promise<string> {
    const settings = this.#getSettings();
    return this.selectPlaylists(parseSelectedIds(settings.selected_playlist_ids), now);
  }

  #storeRefresh(
    selectedIds: string[],
    refreshed: RefreshedPlaylist[],
    now: Date
  ): string {
    const trackById = new Map<string, PlexNormalizedTrack>();
    for (const { tracks } of refreshed) {
      for (const track of tracks) {
        const existing = trackById.get(track.id);
        if (existing !== undefined && existing.sourceFingerprint !== track.sourceFingerprint) {
          throw new Error("Plex returned conflicting metadata for one track");
        }
        trackById.set(track.id, track);
      }
    }
    const byId = new Map(refreshed.map((item) => [item.playlist.id, item]));
    // Keep the existing revision column usable for upgrades from the retired
    // watch service. Desktop export only needs the stored playlist snapshots.
    const manifestRevision = createHash("sha256")
      .update(canonicalJson({
        selectedIds: [...selectedIds].sort(),
        snapshots: [...byId.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, item]) => ({ id, revision: item.sourceRevision }))
      }))
      .digest("hex");
    const timestamp = now.toISOString();

    this.#database.transaction(() => {
      this.#database.prepare("DELETE FROM playlist_snapshots").run();
      this.#database.prepare("DELETE FROM track_metadata").run();
      const insertTrack = this.#database.prepare(
        `INSERT INTO track_metadata
           (track_id, rating_key, media_part_fingerprint, title, artist, album, duration_seconds, artwork_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const track of trackById.values()) {
        insertTrack.run(
          track.id,
          track.ratingKey,
          track.sourceFingerprint,
          track.title,
          track.artist,
          track.album,
          track.durationSeconds,
          track.artworkKey,
          timestamp
        );
      }
      const insertPlaylist = this.#database.prepare(
        `INSERT INTO playlist_snapshots
           (playlist_id, title, ordered_track_ids, source_updated_at, revision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const item of refreshed) {
        insertPlaylist.run(
          item.playlist.id,
          item.playlist.title,
          JSON.stringify(item.tracks.map((track) => track.id)),
          String(item.playlist.sourceUpdatedAt),
          item.sourceRevision,
          timestamp
        );
      }
      this.#database
        .prepare("UPDATE settings SET selected_playlist_ids = ?, manifest_revision = ?, updated_at = ? WHERE id = 1")
        .run(JSON.stringify(selectedIds), manifestRevision, timestamp);
    })();
    return manifestRevision;
  }

  #getSettings(): SettingsRow {
    return this.#database
      .prepare("SELECT selected_playlist_ids FROM settings WHERE id = 1")
      .get() as SettingsRow;
  }
}

function parseSelectedIds(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Stored playlist ids are invalid");
  }
  return parsed;
}
