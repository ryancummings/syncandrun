import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionDatabase } from "../src/persistence/database.js";
import { DeviceRepository } from "../src/persistence/device-repository.js";
import { WatchManifestRepository } from "../src/persistence/watch-manifest-repository.js";
import { PlexLibraryService } from "../src/plex/library-service.js";
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

async function createRepository() {
  const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-watch-manifest-"));
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
  const library = new PlexLibraryService(database.connection, setup, { fetch: server.fetch });
  await library.selectPlaylists(["plex:playlist:10", "plex:playlist:20"]);
  return { database, repository: new WatchManifestRepository(database.connection, secret) };
}

async function createPublicArtworkRepository() {
  const result = await createRepository();
  return {
    ...result,
    repository: new WatchManifestRepository(
      result.database.connection,
      secret,
      new URL("https://art.example.test")
    )
  };
}

describe("watch manifest repository", () => {
  it("maps snapshots to compact watch playlist and track pages", async () => {
    const { repository } = await createRepository();
    const playlists = repository.listPlaylists();
    expect(playlists.items).toHaveLength(2);
    expect(playlists.items[0]).toMatchObject({
      id: "plex:playlist:10",
      name: "Fixture Favorites",
      trackCount: 2,
      durationSeconds: 421,
      tracksPath: "/api/v1/watch/playlists/plex%3Aplaylist%3A10/tracks"
    });
    expect(playlists.nextCursor).toBeNull();

    const now = new Date("2026-08-15T12:00:00.000Z");
    const tracks = repository.listTracks("plex:playlist:10", undefined, now);
    expect(tracks?.items.map(({ id }) => id)).toEqual(["plex:track:100", "plex:track:200"]);
    expect(tracks?.items[0]).toMatchObject({
      title: "Fixture One",
      durationSeconds: 180,
      downloadPath: "/api/v1/watch/tracks/plex%3Atrack%3A100/audio"
    });
    expect(tracks?.items[0]?.artworkId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(tracks?.items[0]?.artworkPath).toMatch(
      /^\/api\/v1\/watch\/a\/[A-Za-z0-9_-]{22}\/\d{10}\/[A-Za-z0-9_-]{22}\/plex%3Atrack%3A100$/
    );
    const capability = tracks?.items[0]?.artworkPath?.split("/");
    expect(
      repository.authorizeArtwork(
        "plex:track:100",
        capability?.[5] ?? "",
        capability?.[6] ?? "",
        capability?.[7] ?? "",
        now
      )
    ).toBe(true);
    expect(
      repository.authorizeArtwork(
        "plex:track:100",
        capability?.[5] ?? "",
        capability?.[6] ?? "",
        `${capability?.[7]}x`,
        now
      )
    ).toBe(false);
    expect(
      repository.authorizeArtwork(
        "plex:track:100",
        capability?.[5] ?? "",
        capability?.[6] ?? "",
        capability?.[7] ?? "",
        new Date("2026-08-16T12:00:00.000Z")
      )
    ).toBe(false);
    expect(repository.listTracks("plex:playlist:missing")).toBeUndefined();
  });

  it("uses signed opaque cursors for pages larger than ten", async () => {
    const { database, repository } = await createRepository();
    const insert = database.connection.prepare(
      `INSERT INTO playlist_snapshots
         (playlist_id, title, ordered_track_ids, source_updated_at, revision, updated_at)
       VALUES (?, ?, '[]', '0', ?, ?)`
    );
    const ids = ["plex:playlist:10", "plex:playlist:20"];
    for (let index = 0; index < 9; index += 1) {
      const id = `plex:playlist:extra-${index}`;
      ids.push(id);
      insert.run(id, `Extra ${index}`, String(index).padStart(64, "0"), new Date().toISOString());
    }
    database.connection.prepare("UPDATE settings SET selected_playlist_ids = ?").run(JSON.stringify(ids));

    const first = repository.listPlaylists();
    expect(first.items).toHaveLength(10);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const second = repository.listPlaylists(first.nextCursor ?? undefined);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(() => repository.listPlaylists(`${first.nextCursor}x`)).toThrow("Invalid watch cursor");
  });

  it("emits an absolute capability URL for a separate artwork origin", async () => {
    const { repository } = await createPublicArtworkRepository();
    const artworkUrl = repository.listTracks("plex:playlist:10")?.items[0]?.artworkPath;
    expect(artworkUrl).toMatch(
      /^https:\/\/art\.example\.test\/api\/v1\/watch\/a\/[A-Za-z0-9_-]{22}\/\d{10}\/[A-Za-z0-9_-]{22}\/plex%3Atrack%3A100$/
    );
  });

  it("records bounded sync results and advances applied revision only on success", async () => {
    const { database, repository } = await createRepository();
    const devices = new DeviceRepository(database.connection, secret);
    const pairing = await devices.createPairingCode();
    const claim = await devices.claimPairingCode(pairing.code, { deviceId: "watch:fixture", deviceName: "Watch" });
    if (claim.status !== "claimed") throw new Error("Expected claimed device");
    const revision = "a".repeat(64);
    repository.recordSyncResult("watch:fixture", {
      protocolVersion: 1,
      revision,
      status: "partial",
      counts: { downloaded: 1, reused: 2, deleted: 0, failed: 1 },
      errorCodes: ["TRANSCODE_FAILED"]
    });
    expect(database.connection.prepare("SELECT applied_revision FROM devices").pluck().get()).toBeNull();
    repository.recordSyncResult("watch:fixture", {
      protocolVersion: 1,
      revision,
      status: "partial",
      counts: { downloaded: 3, reused: 2, deleted: 0, failed: 0 },
      errorCodes: [],
      timings: {
        launchMs: 8_500,
        totalMs: 125_000,
        configMs: 1_500,
        metadataMs: 5_000,
        audioTotalMs: 108_000,
        audioStartupMs: 3_000,
        audioTransferMs: 96_000,
        audioFinalizeMs: 9_000,
        artworkMs: 12_000,
        audioBytes: 9_200_000,
        audioProgressCallbacks: 180,
        audioCount: 3,
        artworkCount: 3
      }
    });
    expect(devices.listDevices()[0]?.lastSyncIsCheckpoint).toBe(true);
    repository.recordSyncResult("watch:fixture", {
      protocolVersion: 1,
      revision,
      status: "applied",
      counts: { downloaded: 1, reused: 2, deleted: 1, failed: 0 },
      errorCodes: [],
      timings: {
        launchMs: 8_500,
        totalMs: 125_000,
        configMs: 1_500,
        metadataMs: 5_000,
        audioTotalMs: 108_000,
        audioStartupMs: 3_000,
        audioTransferMs: 96_000,
        audioFinalizeMs: 9_000,
        artworkMs: 12_000,
        audioBytes: 9_200_000,
        audioProgressCallbacks: 180,
        audioCount: 3,
        artworkCount: 3
      }
    });
    expect(database.connection.prepare("SELECT applied_revision FROM devices").pluck().get()).toBe(revision);
    expect(database.connection.prepare("SELECT status FROM device_sync_results").pluck().get()).toBe("applied");
    expect(
      JSON.parse(database.connection.prepare("SELECT timings_json FROM device_sync_results").pluck().get() as string)
    ).toMatchObject({ launchMs: 8_500, configMs: 1_500, audioTransferMs: 96_000, audioCount: 3 });
    expect(devices.listDevices()[0]?.lastSyncTimings).toMatchObject({
      launchMs: 8_500,
      configMs: 1_500,
      audioTransferMs: 96_000,
      audioCount: 3
    });
    expect(devices.listDevices()[0]?.lastSyncIsCheckpoint).toBe(false);

    expect(
      repository.recordSyncResult("watch:fixture", {
        protocolVersion: 1,
        revision,
        status: "partial",
        counts: { downloaded: 29, reused: 89, deleted: 0, failed: 2 },
        errorCodes: ["TRANSCODE_FAILED"]
      })
    ).toBe(false);
    expect(database.connection.prepare("SELECT status FROM device_sync_results").pluck().get()).toBe("applied");
    expect(devices.listDevices()[0]?.lastSyncTimings).toMatchObject({ launchMs: 8_500, configMs: 1_500 });
  });
});
