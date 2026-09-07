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
    const initialRevision = database.connection
      .prepare("SELECT manifest_revision FROM settings WHERE id = 1")
      .pluck()
      .get() as string;
    database.reconcileArtworkOrigin("https://art.example.test");
    const publicRevision = database.connection
      .prepare("SELECT manifest_revision FROM settings WHERE id = 1")
      .pluck()
      .get() as string;
    expect(publicRevision).not.toBe(initialRevision);
    database.reconcileArtworkOrigin("https://art.example.test");
    expect(database.connection.prepare("SELECT manifest_revision FROM settings WHERE id = 1").pluck().get()).toBe(
      publicRevision
    );
    database.reconcileArtworkOrigin();
    expect(database.connection.prepare("SELECT manifest_revision FROM settings WHERE id = 1").pluck().get()).not.toBe(
      publicRevision
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
        "track_metadata"
      ])
    );
    database.close();
  });
});
