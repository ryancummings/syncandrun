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
import { buildApp } from "../src/server/app.js";
import type { SyncStatus } from "../src/sync/sync-status.js";
import { createFakePlexServer, type FakePlexServer } from "./helpers/fake-plex.js";

const secret = "operator-secret-with-at-least-32-bytes";
const temporaryDirectories: string[] = [];
const servers: FakePlexServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ app }) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTestApp() {
  const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-sync-live-"));
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
  const session = browserSessions.create(started.sessionId);
  const app = buildApp(
    config,
    database,
    {
      plexSetup,
      plexLibrary,
      browserSessions,
      management: new BrowserManagementService(database.connection, secret, devices, browserSessions)
    },
    new PlexMediaProxy(database.connection, plexSetup, { fetch: server.fetch })
  );
  return {
    app,
    database,
    authorization: `Bearer ${claim.deviceToken}`,
    cookie: `syncandrun_session=${session.token}`,
    csrf: session.csrfToken
  };
}

describe("sync status routes", () => {
  it("requires a browser session", async () => {
    const { app } = await createTestApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/sync/status" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("estimates a first sync from the seeded Forerunner throughput", async () => {
    const { app, cookie } = await createTestApp();
    const status = (await app.inject({ method: "GET", url: "/api/v1/sync/status", headers: { cookie } })).json<SyncStatus>();
    expect(status.plan.trackCount).toBeGreaterThan(0);
    expect(status.plan.estimatedBytes).toBeGreaterThan(0);
    const device = status.devices[0]!;
    expect(device.live).toBeNull();
    expect(device.upToDate).toBe(false);
    expect(device.estimate.source).toBe("default");
    expect(device.estimate.throughputBps).toBe(500_000);
    expect(device.estimate.remainingMs).toBeGreaterThan(0);
    await app.close();
  });

  it("tracks a sync from proxied traffic and records history when it completes", async () => {
    const { app, database, authorization, cookie } = await createTestApp();

    // A bare configuration poll is not a sync.
    await app.inject({ method: "GET", url: "/api/v1/watch/config", headers: { authorization } });
    let status = (await app.inject({ method: "GET", url: "/api/v1/sync/status", headers: { cookie } })).json<SyncStatus>();
    expect(status.devices[0]!.live).toBeNull();

    await app.inject({ method: "GET", url: "/api/v1/watch/playlists", headers: { authorization } });
    status = (await app.inject({ method: "GET", url: "/api/v1/sync/status", headers: { cookie } })).json<SyncStatus>();
    expect(status.devices[0]!.live).toMatchObject({ phase: "metadata", finishedStatus: null });

    const audio = await app.inject({
      method: "GET",
      url: "/api/v1/watch/tracks/plex%3Atrack%3A100/audio",
      headers: { authorization }
    });
    expect(audio.statusCode).toBe(200);
    status = (await app.inject({ method: "GET", url: "/api/v1/sync/status", headers: { cookie } })).json<SyncStatus>();
    const live = status.devices[0]!.live!;
    expect(live.completedTracks).toBe(1);
    expect(live.observedBytes).toBe(audio.rawPayload.length);

    const revision = database.connection.prepare("SELECT manifest_revision FROM settings").pluck().get() as string;
    await app.inject({
      method: "POST",
      url: "/api/v1/watch/sync-result",
      headers: { authorization },
      payload: {
        protocolVersion: 1,
        revision,
        status: "applied",
        counts: { downloaded: 1, reused: 0, deleted: 0, failed: 0 },
        errorCodes: []
      }
    });

    status = (await app.inject({ method: "GET", url: "/api/v1/sync/status", headers: { cookie } })).json<SyncStatus>();
    expect(status.devices[0]!.live).toMatchObject({ finishedStatus: "applied", phase: "finished" });
    expect(status.devices[0]!.upToDate).toBe(true);
    expect(status.devices[0]!.estimate.remainingMs).toBeNull();

    const history = (
      await app.inject({ method: "GET", url: "/api/v1/devices/watch%3Afixture/history", headers: { cookie } })
    ).json<{ history: Array<{ status: string; observedBytes: number }> }>();
    expect(history.history).toHaveLength(1);
    expect(history.history[0]).toMatchObject({ status: "applied", observedBytes: audio.rawPayload.length });
    await app.close();
  });

  it("streams status frames over server-sent events", async () => {
    const { app, cookie, authorization } = await createTestApp();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(`${address}/api/v1/sync/live`, { headers: { cookie } });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const first = decoder.decode((await reader.read()).value);
    expect(first.startsWith("event: status\ndata: ")).toBe(true);

    await app.inject({ method: "GET", url: "/api/v1/watch/playlists", headers: { authorization } });
    let update = "";
    while (!update.includes("\"phase\":\"metadata\"")) {
      update = decoder.decode((await reader.read()).value);
    }
    await reader.cancel();
    await app.close();
  });
});

describe("device management routes", () => {
  it("renames a watch without losing the name it reported", async () => {
    const { app, cookie, csrf } = await createTestApp();
    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/v1/devices/watch%3Afixture",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { displayName: "  Trail  watch  " }
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      device: { displayName: "Trail watch", reportedName: "Forerunner 955 Solar", customName: "Trail watch" }
    });

    const reset = await app.inject({
      method: "PATCH",
      url: "/api/v1/devices/watch%3Afixture",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { displayName: null }
    });
    expect(reset.json()).toMatchObject({ device: { displayName: "Forerunner 955 Solar", customName: null } });
    await app.close();
  });

  it("rejects a blank rename and an unauthenticated rename", async () => {
    const { app, cookie, csrf } = await createTestApp();
    const blank = await app.inject({
      method: "PATCH",
      url: "/api/v1/devices/watch%3Afixture",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { displayName: "   " }
    });
    expect(blank.statusCode).toBe(400);

    const noCsrf = await app.inject({
      method: "PATCH",
      url: "/api/v1/devices/watch%3Afixture",
      headers: { cookie },
      payload: { displayName: "Trail watch" }
    });
    expect(noCsrf.statusCode).toBe(403);
    await app.close();
  });

  it("deletes a watch record only after it has been removed", async () => {
    const { app, cookie, csrf, database } = await createTestApp();
    const premature = await app.inject({
      method: "POST",
      url: "/api/v1/devices/watch%3Afixture/forget",
      headers: { cookie, "x-csrf-token": csrf }
    });
    expect(premature.statusCode).toBe(409);

    await app.inject({
      method: "DELETE",
      url: "/api/v1/devices/watch%3Afixture",
      headers: { cookie, "x-csrf-token": csrf }
    });
    const forgotten = await app.inject({
      method: "POST",
      url: "/api/v1/devices/watch%3Afixture/forget",
      headers: { cookie, "x-csrf-token": csrf }
    });
    expect(forgotten.statusCode).toBe(200);
    expect(database.connection.prepare("SELECT COUNT(*) FROM devices").pluck().get()).toBe(0);
    await app.close();
  });
});
