import { readFileSync } from "node:fs";
import { musicProvidersMigration } from "../src/persistence/migrations/011_music_providers.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionDatabase } from "../src/persistence/database.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SQLite migrations", () => {
  it("shares the additive provider migration with the native app", () => {
    const nativeSql = readFileSync(new URL("../../crates/core/src/migrations/011_music_providers.sql", import.meta.url), "utf8");
    expect(musicProvidersMigration.sql.trim()).toBe(nativeSql.trim());
  });
  it("migrates an empty database in WAL mode and remains idempotent", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-db-"));
    temporaryDirectories.push(dataDir);
    const database = new CompanionDatabase(dataDir);
    database.migrate();
    database.migrate();
    expect(database.isReady()).toBe(true);
    expect(database.connection.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.connection.prepare("SELECT manifest_revision FROM settings WHERE id = 1").pluck().get()).toMatch(
      /^[a-f0-9]{64}$/
    );
    const tables = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "devices",
        "device_sync_results",
        "browser_sessions",
        "installation",
        "pairing_codes",
        "playlist_snapshots",
        "plex_connection",
        "plex_auth_sessions",
        "schema_migrations",
        "settings",
        "track_metadata",
        "music_provider",
        "jellyfin_connection"
      ])
    );
    expect(database.connection.prepare("SELECT provider FROM music_provider WHERE id=1").pluck().get()).toBe("plex");
    database.close();
  });
});
