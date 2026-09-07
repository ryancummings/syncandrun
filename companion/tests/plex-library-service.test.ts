import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionDatabase } from "../src/persistence/database.js";
import { PlexLibraryService } from "../src/plex/library-service.js";
import { PlexPlaylistTooLargeError } from "../src/plex/media.js";
import { PlexSetupService } from "../src/plex/setup-service.js";
import { createFakePlexServer, type FakePlexServer } from "./helpers/fake-plex.js";

const secret = "operator-secret-with-at-least-32-bytes";
const temporaryDirectories: string[] = [];
const databases: CompanionDatabase[] = [];
const servers: FakePlexServer[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(servers.splice(0).map(({ app }) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createService() {
  const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-library-service-"));
  temporaryDirectories.push(dataDir);
  const database = new CompanionDatabase(dataDir);
  databases.push(database);
  database.migrate();
  database.connection.prepare("INSERT INTO installation_owner(id, plex_user_id) VALUES (1, '1234')").run();
  const server = await createFakePlexServer();
  servers.push(server);
  const setup = new PlexSetupService(database.connection, secret, {
    plexOrigin: server.origin,
    authOrigin: new URL("https://app.plex.example.test"),
    fetch: server.fetch
  });
  const started = await setup.start(new URL("https://music.example.test/callback"));
  server.claimPin();
  await setup.getStatus(started.sessionId);
  await setup.complete(started.sessionId, "fixture-machine-id", server.pmsUri, "2");
  return {
    database,
    server,
    service: new PlexLibraryService(database.connection, setup, { fetch: server.fetch })
  };
}

describe("Plex library service", () => {
  it("refreshes selected playlists transactionally and deduplicates shared tracks", async () => {
    const { database, service } = await createService();
    const playlists = await service.listPlaylists();
    expect(playlists.map(({ id, selected }) => ({ id, selected }))).toEqual([
      { id: "plex:playlist:10", selected: false },
      { id: "plex:playlist:20", selected: false }
    ]);

    const revision = await service.selectPlaylists(["plex:playlist:10", "plex:playlist:20"]);
    expect(revision).toMatch(/^[a-f0-9]{64}$/);
    expect(database.connection.prepare("SELECT COUNT(*) FROM playlist_snapshots").pluck().get()).toBe(2);
    expect(database.connection.prepare("SELECT COUNT(*) FROM track_metadata").pluck().get()).toBe(2);
    expect(database.connection.prepare("SELECT selected_playlist_ids FROM settings").pluck().get()).toBe(
      '["plex:playlist:10","plex:playlist:20"]'
    );
    expect(await service.refreshSelected()).toBe(revision);
    expect((await service.listPlaylists()).every(({ selected }) => selected)).toBe(true);
  });

  it("changes the manifest for selection and profile changes", async () => {
    const { database, service } = await createService();
    const both = await service.selectPlaylists(["plex:playlist:10", "plex:playlist:20"]);
    expect(database.connection.prepare("SELECT COUNT(*) FROM playlist_snapshots").pluck().get()).toBe(2);

    // Deselecting playlist 20 removes its snapshot, but the track it shares
    // with the still-selected playlist 10 is not dropped along with it.
    const one = await service.selectPlaylists(["plex:playlist:10"]);
    expect(one).not.toBe(both);
    expect(
      database.connection
        .prepare("SELECT playlist_id FROM playlist_snapshots")
        .pluck()
        .all()
    ).toEqual(["plex:playlist:10"]);
    expect(
      database.connection.prepare("SELECT track_id FROM track_metadata ORDER BY track_id").pluck().all()
    ).toEqual(["plex:track:100", "plex:track:200"]);

    const compact = service.setTranscodeProfile("compact");
    expect(compact).not.toBe(one);
  });

  it("rejects oversized playlists before attempting a snapshot refresh", async () => {
    const { server, service } = await createService();
    server.setPlaylistLeafCount("10", 10_001);
    await expect(service.selectPlaylists(["plex:playlist:10"])).rejects.toBeInstanceOf(
      PlexPlaylistTooLargeError
    );
  });

  it("preserves the last complete snapshot when Plex refresh fails", async () => {
    const { database, server, service } = await createService();
    const revision = await service.selectPlaylists(["plex:playlist:10"]);
    server.failPlaylistRequests(503);
    await expect(service.refreshSelected()).rejects.toThrow();
    expect(database.connection.prepare("SELECT manifest_revision FROM settings").pluck().get()).toBe(revision);
    expect(database.connection.prepare("SELECT COUNT(*) FROM playlist_snapshots").pluck().get()).toBe(1);
  });
});
