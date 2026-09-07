import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserManagementService } from "../src/persistence/browser-management-service.js";
import { BrowserSessionRepository } from "../src/persistence/browser-session-repository.js";
import { CompanionDatabase } from "../src/persistence/database.js";
import { DeviceRepository } from "../src/persistence/device-repository.js";
import { PlexSetupService } from "../src/plex/setup-service.js";
import { createFakePlexServer, type FakePlexServer } from "./helpers/fake-plex.js";

const secret = "operator-secret-with-at-least-32-bytes";
const directories: string[] = [];
const databases: CompanionDatabase[] = [];
const servers: FakePlexServer[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(servers.splice(0).map(({ app }) => app.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createConfiguredManagement() {
  const directory = await mkdtemp(join(tmpdir(), "syncandrun-management-"));
  directories.push(directory);
  const database = new CompanionDatabase(directory);
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
  const sessions = new BrowserSessionRepository(database.connection, secret);
  sessions.create(started.sessionId);
  const devices = new DeviceRepository(database.connection, secret);
  const pairing = await devices.createPairingCode();
  await devices.claimPairingCode(pairing.code, { deviceId: "watch:fixture", deviceName: "Fixture Watch" });
  return {
    database,
    management: new BrowserManagementService(database.connection, secret, devices, sessions)
  };
}

describe("browser management service", () => {
  it("disconnects Plex and invalidates every local credential while retaining revoked device history", async () => {
    const { database, management } = await createConfiguredManagement();
    management.disconnectPlex();
    expect(database.connection.prepare("SELECT COUNT(*) FROM plex_connection").pluck().get()).toBe(0);
    expect(database.connection.prepare("SELECT COUNT(*) FROM plex_auth_sessions").pluck().get()).toBe(0);
    expect(database.connection.prepare("SELECT COUNT(*) FROM browser_sessions").pluck().get()).toBe(0);
    expect(database.connection.prepare("SELECT COUNT(*) FROM pairing_codes").pluck().get()).toBe(0);
    expect(database.connection.prepare("SELECT revoked_at FROM devices").pluck().get()).not.toBeNull();
    expect(management.getSettings()).toMatchObject({ plexConfigured: false, selectedPlaylistCount: 0 });
  });

  it("deletes paired device history during full local data deletion", async () => {
    const { database, management } = await createConfiguredManagement();
    management.deleteUserData();
    expect(database.connection.prepare("SELECT COUNT(*) FROM devices").pluck().get()).toBe(0);
    expect(database.connection.prepare("SELECT COUNT(*) FROM track_metadata").pluck().get()).toBe(0);
    expect(database.connection.prepare("SELECT COUNT(*) FROM playlist_snapshots").pluck().get()).toBe(0);
  });
});
