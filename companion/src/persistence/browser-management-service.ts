import type Database from "better-sqlite3";
import { BrowserSessionRepository } from "./browser-session-repository.js";

export interface BrowserSettings {
  plexConfigured: boolean;
}

export class BrowserManagementService {
  readonly #sessions: BrowserSessionRepository;

  constructor(
    private readonly database: Database.Database,
    secret: string,
    sessions?: BrowserSessionRepository
  ) {
    this.#sessions = sessions ?? new BrowserSessionRepository(database, secret);
  }

  getSettings(): BrowserSettings {
    return {
      plexConfigured: this.database.prepare("SELECT 1 FROM plex_connection WHERE id = 1").get() !== undefined
    };
  }

  disconnectPlex(now = new Date()): void {
    this.#clearUserState(false, now);
  }

  deleteUserData(now = new Date()): void {
    this.#clearUserState(true, now);
  }

  #clearUserState(deleteDevices: boolean, now: Date): void {
    const timestamp = now.toISOString();
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM pairing_codes").run();
      this.database.prepare("DELETE FROM playlist_snapshots").run();
      this.database.prepare("DELETE FROM track_metadata").run();
      this.database.prepare("DELETE FROM plex_connection").run();
      if (deleteDevices) this.database.prepare("DELETE FROM devices").run();
      else this.database.prepare("UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL").run(timestamp);
      this.database.prepare("UPDATE settings SET selected_playlist_ids = '[]', updated_at = ? WHERE id = 1").run(timestamp);
      this.database.prepare("DELETE FROM plex_auth_sessions").run();
    })();
    this.#sessions.revokeAll(now);
  }
}
