import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  calculateContentFingerprint,
  calculateManifestRevision,
  canonicalJson,
  type ManifestPlaylistInput
} from "../protocol/manifest.js";
import { revisionSchema, transcodeProfileSchema } from "../protocol/schemas.js";
import {
  PlexMediaClient,
  PlexPlaylistTooLargeError,
  type PlexAudioPlaylist,
  type PlexNormalizedTrack
} from "./media.js";
import type { PlexSetupService } from "./setup-service.js";

type Fetch = typeof fetch;

interface SettingsRow {
  transcode_profile: "compact" | "balanced" | "high";
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
      const sourceRevision = revisionSchema.parse(
        createHash("sha256")
          .update(
            canonicalJson({
              id: playlist.id,
              sourceUpdatedAt: playlist.sourceUpdatedAt,
              tracks: tracks.map((track) => ({ id: track.id, sourceFingerprint: track.sourceFingerprint }))
            }),
            "utf8"
          )
          .digest("hex")
      );
      refreshed.push({ playlist, tracks, sourceRevision });
    }
    return this.#storeRefresh(selectedPlaylistIds, refreshed, this.#getSettings().transcode_profile, now);
  }

  async refreshSelected(now = new Date()): Promise<string> {
    const settings = this.#getSettings();
    return this.selectPlaylists(parseSelectedIds(settings.selected_playlist_ids), now);
  }

  setTranscodeProfile(profile: "compact" | "balanced" | "high", now = new Date()): string {
    transcodeProfileSchema.parse(profile);
    const selectedIds = parseSelectedIds(this.#getSettings().selected_playlist_ids);
    const snapshots = this.#readManifestPlaylists(selectedIds, profile);
    const revision = calculateManifestRevision({
      protocolVersion: 1,
      transcodeProfile: profile,
      selectedPlaylistIds: selectedIds,
      playlists: snapshots
    });
    this.#database
      .prepare("UPDATE settings SET transcode_profile = ?, manifest_revision = ?, updated_at = ? WHERE id = 1")
      .run(profile, revision, now.toISOString());
    return revision;
  }

  #storeRefresh(
    selectedIds: string[],
    refreshed: RefreshedPlaylist[],
    profile: "compact" | "balanced" | "high",
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
    const manifestPlaylists = [...selectedIds]
      .sort()
      .map((id): ManifestPlaylistInput => {
        const item = byId.get(id);
        if (item === undefined) throw new Error("Selected playlist refresh is incomplete");
        return {
          id,
          sourceRevision: item.sourceRevision,
          tracks: item.tracks.map((track) => ({
            id: track.id,
            contentFingerprint: calculateContentFingerprint(track.sourceFingerprint, profile)
          }))
        };
      });
    const manifestRevision = calculateManifestRevision({
      protocolVersion: 1,
      transcodeProfile: profile,
      selectedPlaylistIds: selectedIds,
      playlists: manifestPlaylists
    });
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

  #readManifestPlaylists(
    selectedIds: string[],
    profile: "compact" | "balanced" | "high"
  ): ManifestPlaylistInput[] {
    return [...selectedIds]
      .sort()
      .map((id) => {
        const snapshot = this.#database
          .prepare("SELECT revision, ordered_track_ids FROM playlist_snapshots WHERE playlist_id = ?")
          .get(id) as { revision: string; ordered_track_ids: string } | undefined;
        if (snapshot === undefined) throw new Error("Selected playlist has no snapshot");
        return {
          id,
          sourceRevision: snapshot.revision,
          tracks: parseSelectedIds(snapshot.ordered_track_ids).map((trackId) => {
            const track = this.#database
              .prepare("SELECT media_part_fingerprint FROM track_metadata WHERE track_id = ?")
              .get(trackId) as { media_part_fingerprint: string } | undefined;
            if (track === undefined) throw new Error("Playlist snapshot references missing track metadata");
            return {
              id: trackId,
              contentFingerprint: calculateContentFingerprint(track.media_part_fingerprint, profile)
            };
          })
        };
      });
  }

  #getSettings(): SettingsRow {
    return this.#database
      .prepare("SELECT transcode_profile, selected_playlist_ids FROM settings WHERE id = 1")
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
