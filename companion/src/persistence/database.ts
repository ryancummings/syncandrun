import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { initialMigration } from "./migrations/001_initial.js";
import { initializeManifestRevisionMigration } from "./migrations/002_initialize_manifest_revision.js";
import { plexSetupSessionsMigration } from "./migrations/003_plex_setup_sessions.js";
import { browserSessionsMigration } from "./migrations/004_browser_sessions.js";
import { deviceSyncResultsMigration } from "./migrations/005_device_sync_results.js";
import { syncTimingsMigration } from "./migrations/006_sync_timings.js";
import { enableArtworkManifestMigration } from "./migrations/007_enable_artwork_manifest.js";
import { deviceManagementMigration } from "./migrations/008_device_management.js";
import { artworkOriginFingerprintMigration } from "./migrations/009_artwork_origin_fingerprint.js";

import { ownerAuthorizationMigration } from "./migrations/010_owner_authorization.js";

const migrations = [
  initialMigration,
  initializeManifestRevisionMigration,
  plexSetupSessionsMigration,
  browserSessionsMigration,
  deviceSyncResultsMigration,
  syncTimingsMigration,
  enableArtworkManifestMigration,
  deviceManagementMigration,
  artworkOriginFingerprintMigration,
  ownerAuthorizationMigration
] as const;

export class CompanionDatabase {
  readonly path: string;
  readonly connection: Database.Database;
  #open = true;

  constructor(dataDir: string) {
    this.path = resolve(dataDir, "syncandrun.sqlite");
    this.connection = new Database(this.path);
    this.connection.pragma("journal_mode = WAL");
    this.connection.pragma("foreign_keys = ON");
    this.connection.pragma("busy_timeout = 5000");
  }

  migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      )
    `);
    const rows = this.connection
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number; name: string }>;
    const applied = new Map(rows.map((row) => [row.version, row.name]));

    for (const migration of migrations) {
      const appliedName = applied.get(migration.version);
      if (appliedName !== undefined && appliedName !== migration.name) {
        throw new Error(`Migration ${migration.version} name mismatch`);
      }
      if (appliedName !== undefined) continue;

      this.connection.transaction(() => {
        this.connection.exec(migration.sql);
        this.connection
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, new Date().toISOString());
        if (migration.version === 1) {
          const now = new Date().toISOString();
          this.connection
            .prepare(
              "INSERT INTO installation (id, schema_version, plex_client_identifier, created_at, updated_at) VALUES (1, ?, ?, ?, ?)"
            )
            .run(migration.version, randomUUID(), now, now);
          this.connection
            .prepare("INSERT INTO settings (id, transcode_profile, selected_playlist_ids, updated_at) VALUES (1, 'balanced', '[]', ?)")
            .run(now);
        }
      })();
    }
  }

  /**
   * Invalidates the rendered manifest when artwork capabilities move between
   * the companion origin and a public artwork-only origin. This makes paired
   * watches traverse metadata again while preserving cached audio.
   */
  reconcileArtworkOrigin(artworkBaseUrl?: string | URL): void {
    const fingerprint = createHash("sha256")
      .update(artworkBaseUrl?.toString() ?? "relative-companion-origin", "utf8")
      .digest("hex");
    const row = this.connection
      .prepare("SELECT manifest_revision, artwork_origin_fingerprint FROM settings WHERE id = 1")
      .get() as { manifest_revision: string; artwork_origin_fingerprint: string | null };
    if (row.artwork_origin_fingerprint === fingerprint) return;

    const revision = createHash("sha256")
      .update(`${row.manifest_revision}:${fingerprint}`, "utf8")
      .digest("hex");
    this.connection
      .prepare(
        "UPDATE settings SET manifest_revision = ?, artwork_origin_fingerprint = ?, updated_at = ? WHERE id = 1"
      )
      .run(revision, fingerprint, new Date().toISOString());
  }

  isReady(): boolean {
    if (!this.#open) return false;
    try {
      const row = this.connection
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get() as { count: number };
      return row.count === migrations.length;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.#open) {
      this.connection.close();
      this.#open = false;
    }
  }
}
