import type Database from "better-sqlite3";
import { calculateManifestRevision } from "../protocol/manifest.js";
import { BrowserSessionRepository } from "./browser-session-repository.js";
import {
  DeviceRepository,
  type BrowserDevice,
  type PairingCode,
  type SyncHistoryEntry
} from "./device-repository.js";

interface SettingsRow {
  transcode_profile: "compact" | "balanced" | "high";
  selected_playlist_ids: string;
  manifest_revision: string;
  updated_at: string;
}

export interface BrowserSettings {
  plexConfigured: boolean;
  transcodeProfile: "compact" | "balanced" | "high";
  selectedPlaylistCount: number;
  manifestRevision: string;
  updatedAt: string;
  version: string;
}

export class BrowserManagementService {
  readonly #devices: DeviceRepository;
  readonly #sessions: BrowserSessionRepository;

  constructor(
    private readonly database: Database.Database,
    secret: string,
    devices?: DeviceRepository,
    sessions?: BrowserSessionRepository
  ) {
    this.#devices = devices ?? new DeviceRepository(database, secret);
    this.#sessions = sessions ?? new BrowserSessionRepository(database, secret);
  }

  createPairingCode(now = new Date()): Promise<PairingCode> {
    return this.#devices.createPairingCode(now);
  }

  listDevices(): BrowserDevice[] {
    return this.#devices.listDevices();
  }

  revokeDevice(deviceId: string, now = new Date()): boolean {
    return this.#devices.revokeDevice(deviceId, now);
  }

  renameDevice(deviceId: string, displayName: string | null): boolean {
    return this.#devices.renameDevice(deviceId, displayName);
  }

  forgetDevice(deviceId: string): boolean {
    return this.#devices.forgetDevice(deviceId);
  }

  listSyncHistory(deviceId: string, limit?: number): SyncHistoryEntry[] {
    return this.#devices.listSyncHistory(deviceId, limit);
  }

  getSettings(): BrowserSettings {
    const settings = this.database
      .prepare("SELECT transcode_profile, selected_playlist_ids, manifest_revision, updated_at FROM settings WHERE id = 1")
      .get() as SettingsRow;
    const selected: unknown = JSON.parse(settings.selected_playlist_ids);
    if (!Array.isArray(selected)) throw new Error("Stored playlist ids are invalid");
    return {
      plexConfigured: this.database.prepare("SELECT 1 FROM plex_connection WHERE id = 1").get() !== undefined,
      transcodeProfile: settings.transcode_profile,
      selectedPlaylistCount: selected.length,
      manifestRevision: settings.manifest_revision,
      updatedAt: settings.updated_at,
      version: "1.0.0-dev.0"
    };
  }

  disconnectPlex(now = new Date()): void {
    this.#clearUserState(false, now);
  }

  deleteUserData(now = new Date()): void {
    this.#clearUserState(true, now);
  }

  #clearUserState(deleteDevices: boolean, now: Date): void {
    const settings = this.database
      .prepare("SELECT transcode_profile FROM settings WHERE id = 1")
      .get() as Pick<SettingsRow, "transcode_profile">;
    const revision = calculateManifestRevision({
      protocolVersion: 1,
      transcodeProfile: settings.transcode_profile,
      selectedPlaylistIds: [],
      playlists: []
    });
    const timestamp = now.toISOString();
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM pairing_codes").run();
      this.database.prepare("DELETE FROM playlist_snapshots").run();
      this.database.prepare("DELETE FROM track_metadata").run();
      this.database.prepare("DELETE FROM plex_connection").run();
      if (deleteDevices) this.database.prepare("DELETE FROM devices").run();
      else this.database.prepare("UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL").run(timestamp);
      this.database
        .prepare(
          "UPDATE settings SET selected_playlist_ids = '[]', manifest_revision = ?, updated_at = ? WHERE id = 1"
        )
        .run(revision, timestamp);
      this.database.prepare("DELETE FROM plex_auth_sessions").run();
    })();
    this.#sessions.revokeAll(now);
  }
}
