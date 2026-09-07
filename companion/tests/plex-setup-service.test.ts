import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionDatabase } from "../src/persistence/database.js";
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
  const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-setup-service-"));
  temporaryDirectories.push(dataDir);
  const database = new CompanionDatabase(dataDir);
  databases.push(database);
  database.migrate();
  database.connection.prepare("INSERT INTO installation_owner(id, plex_user_id) VALUES (1, '1234')").run();
  const server = await createFakePlexServer();
  servers.push(server);
  const service = new PlexSetupService(database.connection, secret, {
    plexOrigin: server.origin,
    authOrigin: new URL("https://app.plex.example.test"),
    fetch: server.fetch
  });
  return { database, server, service };
}

describe("Plex setup service", () => {
  it("persists only encrypted PIN and account credentials through the setup journey", async () => {
    const { database, server, service } = await createService();
    const started = await service.start(
      new URL("https://music.example.test/setup/plex/callback"),
      new Date("2026-08-14T12:30:00.000Z")
    );
    expect(started.authUrl).toContain("https://app.plex.example.test/auth#?");
    const pendingRow = database.connection
      .prepare("SELECT encrypted_code, code_nonce, status FROM plex_auth_sessions WHERE id = ?")
      .get(started.sessionId) as { encrypted_code: Buffer; code_nonce: Buffer; status: string };
    expect(pendingRow.status).toBe("pending");
    expect(pendingRow.encrypted_code.toString("utf8")).not.toContain("fake-strong-pin-code");
    expect(pendingRow.code_nonce).toHaveLength(12);

    await expect(service.getStatus(started.sessionId, new Date("2026-08-14T12:45:00.000Z"))).resolves.toEqual({
      status: "pending",
      expiresAt: started.expiresAt
    });
    server.claimPin();
    await expect(service.getStatus(started.sessionId, new Date("2026-08-14T12:45:00.000Z"))).resolves.toEqual({
      status: "claimed",
      expiresAt: started.expiresAt,
      username: "fixture-user"
    });
    const claimedRow = database.connection
      .prepare("SELECT encrypted_account_token, account_token_nonce, status FROM plex_auth_sessions WHERE id = ?")
      .get(started.sessionId) as {
      encrypted_account_token: Buffer;
      account_token_nonce: Buffer;
      status: string;
    };
    expect(claimedRow.status).toBe("claimed");
    expect(claimedRow.encrypted_account_token.toString("utf8")).not.toContain(server.fixtureToken);
    expect(claimedRow.account_token_nonce).toHaveLength(12);

    const plexServers = await service.listServers(started.sessionId);
    expect(plexServers).toEqual([
      {
        id: "fixture-machine-id",
        name: "Fixture Server",
        owned: true,
        presence: true,
        connections: [{ uri: server.pmsUri, local: false, relay: false }]
      }
    ]);
    expect(JSON.stringify(plexServers)).not.toContain(server.fixtureToken);
    await expect(service.listMusicLibraries(started.sessionId, "fixture-machine-id", server.pmsUri)).resolves.toEqual([
      { id: "2", uuid: "fixture-music-library", title: "Fixture Music" }
    ]);

    await service.complete(
      started.sessionId,
      "fixture-machine-id",
      server.pmsUri,
      "2",
      new Date("2026-08-14T12:50:00.000Z")
    );
    expect(service.getStoredConnection()).toEqual({
      accountToken: server.fixtureToken,
      serverToken: server.fixtureToken,
      serverMachineId: "fixture-machine-id",
      serverBaseUri: server.pmsUri,
      librarySectionId: "2"
    });
    expect(database.connection.prepare("SELECT status FROM plex_auth_sessions WHERE id = ?").pluck().get(started.sessionId)).toBe(
      "completed"
    );
    const connection = database.connection
      .prepare("SELECT encrypted_token, encrypted_account_token FROM plex_connection WHERE id = 1")
      .get() as { encrypted_token: Buffer; encrypted_account_token: Buffer };
    expect(connection.encrypted_token.toString("utf8")).not.toContain(server.fixtureToken);
    expect(connection.encrypted_account_token.toString("utf8")).not.toContain(server.fixtureToken);
  });

  it("rejects a library that was not discovered on the selected server", async () => {
    const { server, service } = await createService();
    const started = await service.start(
      new URL("https://music.example.test/setup/plex/callback"),
      new Date("2026-08-14T12:30:00.000Z")
    );
    server.claimPin();
    await service.getStatus(started.sessionId, new Date("2026-08-14T12:45:00.000Z"));
    await expect(
      service.complete(started.sessionId, "fixture-machine-id", server.pmsUri, "999")
    ).rejects.toThrow("music library was not discovered");
    expect(service.getStoredConnection()).toBeUndefined();
  });
});
