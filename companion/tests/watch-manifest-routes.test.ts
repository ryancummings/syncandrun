import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RuntimeConfig } from "../src/config.js";
import { BrowserSessionRepository } from "../src/persistence/browser-session-repository.js";
import { BrowserManagementService } from "../src/persistence/browser-management-service.js";
import { CompanionDatabase } from "../src/persistence/database.js";
import { DeviceRepository } from "../src/persistence/device-repository.js";
import { PlexLibraryService } from "../src/plex/library-service.js";
import { PlexMediaProxy } from "../src/plex/media-proxy.js";
import { PlexSetupService } from "../src/plex/setup-service.js";
import { playlistPageSchema, trackPageSchema } from "../src/protocol/index.js";
import { buildApp } from "../src/server/app.js";
import { createFakePlexServer, type FakePlexServer } from "./helpers/fake-plex.js";

const secret = "operator-secret-with-at-least-32-bytes";
const temporaryDirectories: string[] = [];
const servers: FakePlexServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ app }) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTestApp() {
  const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-watch-manifest-routes-"));
  temporaryDirectories.push(dataDir);
  const config: RuntimeConfig = {
    baseUrl: new URL("https://music.example.test"),
    secret,
    dataDir,
    port: 3000,
    logLevel: "silent",
    trustProxy: false
  };
  const database = new CompanionDatabase(dataDir);
  database.migrate();
  database.connection.prepare("INSERT INTO installation_owner(id, plex_user_id) VALUES (1, '1234')").run();
  const server = await createFakePlexServer();
  servers.push(server);
  const plexSetup = new PlexSetupService(database.connection, secret, {
    plexOrigin: server.origin,
    authOrigin: new URL("https://app.plex.example.test"),
    fetch: server.fetch
  });
  const started = await plexSetup.start(new URL("https://music.example.test/callback"));
  server.claimPin();
  await plexSetup.getStatus(started.sessionId);
  await plexSetup.complete(started.sessionId, "fixture-machine-id", server.pmsUri, "2");
  const plexLibrary = new PlexLibraryService(database.connection, plexSetup, { fetch: server.fetch });
  await plexLibrary.selectPlaylists(["plex:playlist:10", "plex:playlist:20"]);
  const devices = new DeviceRepository(database.connection, secret);
  const pairing = await devices.createPairingCode();
  const claim = await devices.claimPairingCode(pairing.code, {
    deviceId: "watch:fixture",
    deviceName: "Forerunner 955 Solar"
  });
  if (claim.status !== "claimed") throw new Error("Expected claimed watch");
  const browserSessions = new BrowserSessionRepository(database.connection, secret);
  const app = buildApp(config, database, {
    plexSetup,
    plexLibrary,
    browserSessions,
    management: new BrowserManagementService(database.connection, secret, devices, browserSessions)
  }, new PlexMediaProxy(database.connection, plexSetup, { fetch: server.fetch }));
  return { app, database, server, authorization: `Bearer ${claim.deviceToken}` };
}

describe("watch manifest routes", () => {
  it("serves authenticated playlist and track pages", async () => {
    const { app, authorization } = await createTestApp();
    const playlists = await app.inject({
      method: "GET",
      url: "/api/v1/watch/playlists",
      headers: { authorization }
    });
    expect(playlists.statusCode).toBe(200);
    expect(playlistPageSchema.safeParse(playlists.json()).success).toBe(true);
    expect(playlists.json().items).toHaveLength(2);

    const tracks = await app.inject({
      method: "GET",
      url: "/api/v1/watch/playlists/plex%3Aplaylist%3A10/tracks",
      headers: { authorization }
    });
    expect(tracks.statusCode).toBe(200);
    expect(trackPageSchema.safeParse(tracks.json()).success).toBe(true);
    expect(tracks.json().items.map((track: { id: string }) => track.id)).toEqual([
      "plex:track:100",
      "plex:track:200"
    ]);

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/watch/playlists/plex%3Aplaylist%3Amissing/tracks",
      headers: { authorization }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "PLAYLIST_NOT_FOUND" } });
    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/watch/playlists?cursor=invalid",
      headers: { authorization }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    await app.close();
  });

  it("persists sync results for the authenticated device", async () => {
    const { app, database, authorization } = await createTestApp();
    const revision = database.connection.prepare("SELECT manifest_revision FROM settings").pluck().get() as string;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/watch/sync-result",
      headers: { authorization },
      payload: {
        protocolVersion: 1,
        revision,
        status: "applied",
        counts: { downloaded: 2, reused: 0, deleted: 0, failed: 0 },
        errorCodes: [],
        timings: {
          totalMs: 125_000,
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
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ recorded: true });
    expect(database.connection.prepare("SELECT applied_revision FROM devices").pluck().get()).toBe(revision);
    expect(database.connection.prepare("SELECT timings_json FROM device_sync_results").pluck().get()).toContain(
      '"audioTransferMs":96000'
    );

    const stale = await app.inject({
      method: "POST",
      url: "/api/v1/watch/sync-result",
      headers: { authorization },
      payload: {
        protocolVersion: 1,
        revision,
        status: "partial",
        counts: { downloaded: 29, reused: 89, deleted: 0, failed: 2 },
        errorCodes: ["TRANSCODE_FAILED"]
      }
    });
    expect(stale.statusCode).toBe(200);
    expect(database.connection.prepare("SELECT status FROM device_sync_results").pluck().get()).toBe("applied");

    const mismatch = await app.inject({
      method: "POST",
      url: "/api/v1/watch/sync-result",
      headers: { authorization },
      payload: { protocolVersion: 2 }
    });
    expect(mismatch.statusCode).toBe(426);
    await app.close();
  });

  it("streams authenticated audio and artwork without exposing Plex credentials", async () => {
    const { app, server, authorization } = await createTestApp();
    const audio = await app.inject({
      method: "GET",
      url: "/api/v1/watch/tracks/plex%3Atrack%3A100/audio",
      headers: { authorization }
    });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers["content-type"]).toContain("audio/mpeg");
    expect(audio.rawPayload.subarray(0, 3).toString("utf8")).toBe("ID3");
    expect(server.lastAudioRequest()?.query.musicBitrate).toBe("96");

    const tracks = await app.inject({
      method: "GET",
      url: "/api/v1/watch/playlists/plex%3Aplaylist%3A10/tracks",
      headers: { authorization }
    });
    const artworkPath = tracks.json().items[0].artworkPath as string;
    const artwork = await app.inject({ method: "GET", url: artworkPath });
    expect(artwork.statusCode).toBe(200);
    expect(artwork.headers["content-type"]).toContain("image/jpeg");
    expect(artwork.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    const tamperedArtwork = await app.inject({ method: "GET", url: `${artworkPath}x` });
    expect(tamperedArtwork.statusCode).toBe(404);

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/watch/tracks/plex%3Atrack%3Amissing/audio",
      headers: { authorization }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "TRACK_NOT_FOUND" } });
    await app.close();
  });

  it("rejects manifest access without a device credential", async () => {
    const { app } = await createTestApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/watch/playlists" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
    await app.close();
  });
});
