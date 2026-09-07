import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionDatabase } from "../src/persistence/database.js";
import { SyncPlanService, estimateBytes } from "../src/sync/sync-plan.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createDatabase() {
  const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-sync-plan-"));
  directories.push(dataDir);
  const database = new CompanionDatabase(dataDir);
  database.migrate();
  const now = new Date().toISOString();
  const insertTrack = database.connection.prepare(
    `INSERT INTO track_metadata
       (track_id, rating_key, media_part_fingerprint, title, artist, album, duration_seconds, artwork_key, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  );
  for (const [id, duration] of [["a", 200], ["b", 300], ["c", 400]] as const) {
    insertTrack.run(`plex:track:${id}`, id, `fingerprint-${id}`, id, "Artist", "Album", duration, now);
  }
  const insertPlaylist = database.connection.prepare(
    `INSERT INTO playlist_snapshots (playlist_id, title, ordered_track_ids, source_updated_at, revision, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?)`
  );
  insertPlaylist.run("plex:playlist:1", "One", JSON.stringify(["plex:track:a", "plex:track:b"]), "r1", now);
  insertPlaylist.run("plex:playlist:2", "Two", JSON.stringify(["plex:track:b", "plex:track:c"]), "r2", now);
  database.connection
    .prepare("UPDATE settings SET selected_playlist_ids = ?, manifest_revision = ? WHERE id = 1")
    .run(JSON.stringify(["plex:playlist:1", "plex:playlist:2"]), "revision-one");
  return database;
}

describe("sync plan", () => {
  it("counts a shared track once and sizes it at the current profile", async () => {
    const database = await createDatabase();
    const plan = new SyncPlanService(database.connection).get();
    expect(plan.trackCount).toBe(3);
    expect(plan.durationSeconds).toBe(900);
    expect(plan.bitrateKbps).toBe(96);
    expect(plan.estimatedBytes).toBe(estimateBytes(900, 96));
    database.close();
  });

  it("recomputes when the manifest revision changes", async () => {
    const database = await createDatabase();
    const service = new SyncPlanService(database.connection);
    expect(service.get().trackCount).toBe(3);

    database.connection
      .prepare("UPDATE settings SET selected_playlist_ids = ?, transcode_profile = 'high', manifest_revision = ? WHERE id = 1")
      .run(JSON.stringify(["plex:playlist:1"]), "revision-two");
    const updated = service.get();
    expect(updated.trackCount).toBe(2);
    expect(updated.durationSeconds).toBe(500);
    expect(updated.bitrateKbps).toBe(128);
    database.close();
  });
});
