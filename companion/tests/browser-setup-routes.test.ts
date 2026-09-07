import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RuntimeConfig } from "../src/config.js";
import { BrowserSessionRepository } from "../src/persistence/browser-session-repository.js";
import { BrowserManagementService } from "../src/persistence/browser-management-service.js";
import { CompanionDatabase } from "../src/persistence/database.js";
import { PlexSetupService } from "../src/plex/setup-service.js";
import { PlexLibraryService } from "../src/plex/library-service.js";
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
  const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-browser-routes-"));
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
  const browserSessions = new BrowserSessionRepository(database.connection, secret);
  const plexLibrary = new PlexLibraryService(database.connection, plexSetup, { fetch: server.fetch });
  const app = buildApp(config, database, {
    plexSetup,
    plexLibrary,
    browserSessions,
    management: new BrowserManagementService(database.connection, secret, undefined, browserSessions)
  });
  return { app, database, server };
}

describe("browser Plex setup routes", () => {
  it("completes setup through an HttpOnly session and CSRF-protected mutations", async () => {
    const { app, database, server } = await createTestApp();
    const startedResponse = await app.inject({ method: "POST", url: "/api/v1/setup/plex/pin" });
    expect(startedResponse.statusCode).toBe(200);
    const started = startedResponse.json<{ sessionId: string; authUrl: string; expiresAt: string }>();
    expect(started.authUrl).toContain("forwardUrl=https%3A%2F%2Fmusic.example.test%2Fsetup%2Fplex%2Fcallback");
    expect(startedResponse.headers["cache-control"]).toBe("no-store");

    const pending = await app.inject({ method: "GET", url: `/api/v1/setup/plex/pin/${started.sessionId}` });
    expect(pending.json()).toEqual({ status: "pending", expiresAt: started.expiresAt });

    server.claimPin();
    const claimedResponse = await app.inject({ method: "GET", url: `/api/v1/setup/plex/pin/${started.sessionId}` });
    expect(claimedResponse.statusCode).toBe(200);
    const claimed = claimedResponse.json<{ status: string; username: string; csrfToken: string }>();
    expect(claimed).toMatchObject({ status: "claimed", username: "fixture-user" });
    expect(claimedResponse.body).not.toContain(server.fixtureToken);
    const setCookie = claimedResponse.headers["set-cookie"];
    if (typeof setCookie !== "string") throw new Error("Expected a browser session cookie");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    const cookie = setCookie.split(";", 1)[0]!;
    const rawSessionToken = cookie.split("=", 2)[1]!;
    const storedSessionHash = database.connection.prepare("SELECT token_hash FROM browser_sessions").pluck().get() as Buffer;
    expect(storedSessionHash.toString("utf8")).not.toContain(rawSessionToken);

    const sessionResponse = await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie } });
    expect(sessionResponse.json()).toEqual({ authenticated: true, csrfToken: claimed.csrfToken });
    const serversResponse = await app.inject({ method: "GET", url: "/api/v1/setup/plex/servers", headers: { cookie } });
    expect(serversResponse.statusCode).toBe(200);
    expect(serversResponse.body).not.toContain(server.fixtureToken);
    expect(serversResponse.json()).toEqual({
      servers: [
        {
          id: "fixture-machine-id",
          name: "Fixture Server",
          owned: true,
          presence: true,
          connections: [{ uri: server.pmsUri, local: false, relay: false }]
        }
      ]
    });

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/setup/plex/libraries",
      headers: { cookie },
      payload: { serverId: "fixture-machine-id", connectionUri: server.pmsUri }
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ error: { code: "CSRF_INVALID" } });

    const librariesResponse = await app.inject({
      method: "POST",
      url: "/api/v1/setup/plex/libraries",
      headers: { cookie, "x-csrf-token": claimed.csrfToken },
      payload: { serverId: "fixture-machine-id", connectionUri: server.pmsUri }
    });
    expect(librariesResponse.statusCode).toBe(200);
    expect(librariesResponse.json()).toEqual({
      libraries: [{ id: "2", uuid: "fixture-music-library", title: "Fixture Music" }]
    });

    const completed = await app.inject({
      method: "POST",
      url: "/api/v1/setup/plex/complete",
      headers: { cookie, "x-csrf-token": claimed.csrfToken },
      payload: { serverId: "fixture-machine-id", connectionUri: server.pmsUri, librarySectionId: "2" }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toEqual({ configured: true });
    expect(database.connection.prepare("SELECT COUNT(*) FROM plex_connection").pluck().get()).toBe(1);

    server.setPlaylistLeafCount("10", 10_001);
    const playlists = await app.inject({ method: "GET", url: "/api/v1/playlists", headers: { cookie } });
    expect(playlists.statusCode).toBe(200);
    expect(playlists.json().playlists).toHaveLength(2);
    expect(playlists.json().playlists[0]).toMatchObject({
      id: "plex:playlist:10",
      selectable: false,
      unavailableReason: "This playlist exceeds the 10,000-track safety limit and cannot be added."
    });
    const oversizedSelection = await app.inject({
      method: "POST",
      url: "/api/v1/playlists/selection",
      headers: { cookie, "x-csrf-token": claimed.csrfToken },
      payload: { selectedPlaylistIds: ["plex:playlist:10"] }
    });
    expect(oversizedSelection.statusCode).toBe(422);
    expect(oversizedSelection.json()).toMatchObject({ error: { code: "PLAYLIST_TOO_LARGE" } });
    server.setPlaylistLeafCount("10", 2);
    const selection = await app.inject({
      method: "POST",
      url: "/api/v1/playlists/selection",
      headers: { cookie, "x-csrf-token": claimed.csrfToken },
      payload: { selectedPlaylistIds: ["plex:playlist:10", "plex:playlist:20"] }
    });
    expect(selection.statusCode).toBe(200);
    expect(selection.json()).toMatchObject({ selectedPlaylistIds: ["plex:playlist:10", "plex:playlist:20"] });
    expect(selection.json().manifestRevision).toMatch(/^[a-f0-9]{64}$/);
    const profile = await app.inject({
      method: "POST",
      url: "/api/v1/settings/profile",
      headers: { cookie, "x-csrf-token": claimed.csrfToken },
      payload: { profile: "compact" }
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({ profile: "compact" });

    const settings = await app.inject({ method: "GET", url: "/api/v1/settings", headers: { cookie } });
    expect(settings.json()).toMatchObject({
      plexConfigured: true,
      transcodeProfile: "compact",
      selectedPlaylistCount: 2,
      version: "1.0.0-dev.0",
      // The browser is the only place the operator can read the origin that has
      // to be typed into the watch's app settings by hand.
      companionUrl: "https://music.example.test/"
    });
    const pairing = await app.inject({
      method: "POST",
      url: "/api/v1/devices/pairing-code",
      headers: { cookie, "x-csrf-token": claimed.csrfToken }
    });
    expect(pairing.statusCode).toBe(200);
    const pairingCode = pairing.json<{ code: string; expiresAt: string }>();
    expect(pairingCode.code).toMatch(/^[0-9]{6}$/);
    const paired = await app.inject({
      method: "POST",
      url: "/api/v1/watch/pair",
      payload: {
        code: pairingCode.code,
        deviceId: "watch:browser-fixture",
        deviceName: "Forerunner 955 Solar",
        appVersion: "1.0.0",
        protocolVersion: 1
      }
    });
    expect(paired.statusCode).toBe(200);
    const devices = await app.inject({ method: "GET", url: "/api/v1/devices", headers: { cookie } });
    expect(devices.json()).toMatchObject({
      devices: [{ id: "watch:browser-fixture", displayName: "Forerunner 955 Solar", revokedAt: null }]
    });
    const revoked = await app.inject({
      method: "DELETE",
      url: "/api/v1/devices/watch%3Abrowser-fixture",
      headers: { cookie, "x-csrf-token": claimed.csrfToken }
    });
    expect(revoked.json()).toEqual({ revoked: true });

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/session/logout",
      headers: { cookie, "x-csrf-token": claimed.csrfToken }
    });
    expect(logout.json()).toEqual({ loggedOut: true });
    const afterLogout = await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie } });
    expect(afterLogout.statusCode).toBe(401);
    await app.close();
  });

  it("does not expose setup data without a valid browser session", async () => {
    const { app } = await createTestApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/setup/plex/servers" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
    await app.close();
  });
});
