import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionDatabase } from "../src/persistence/database.js";
import { OwnerRepository } from "../src/persistence/owner-repository.js";
import { BrowserSessionRepository } from "../src/persistence/browser-session-repository.js";
import { BrowserManagementService } from "../src/persistence/browser-management-service.js";
import { PlexSetupService } from "../src/plex/setup-service.js";
import { buildApp } from "../src/server/app.js";
import { createFakePlexServer } from "./helpers/fake-plex.js";

const defaultSecret = "test-secret-with-at-least-32-bytes";
const baseUrl = new URL("https://music.example.test");
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(secret = defaultSecret) {
  const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-owner-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const db = new CompanionDatabase(dataDir);
  db.migrate();
  const fake = await createFakePlexServer();
  cleanup.push(() => fake.app.close());
  const owners = new OwnerRepository(db.connection);
  const setup = new PlexSetupService(db.connection, secret, { plexOrigin: fake.origin, fetch: fake.fetch });
  const sessions = new BrowserSessionRepository(db.connection, secret);
  const management = new BrowserManagementService(db.connection, secret);
  const app = buildApp({ baseUrl, dataDir, secret, port: 3000, logLevel: "silent", trustProxy: false }, db,
    { plexSetup: setup, browserSessions: sessions, management });
  cleanup.push(() => app.close());
  return { db, fake, owners, setup, sessions, management, app };
}

describe("single-owner authorization", () => {
  it("isolates two installations' owner state, browser sessions, and watch credentials", async () => {
    const first = await fixture();
    const second = await fixture(randomBytes(32).toString("hex"));
    const firstInvitation = first.owners.issueInvitation();
    await expect(second.setup.start(baseUrl, new Date(), firstInvitation)).rejects.toThrow();
    const firstLogin = await first.setup.start(baseUrl, new Date(), firstInvitation);
    first.fake.claimPin();
    await first.setup.getStatus(firstLogin.sessionId);
    expect(second.owners.owner()).toBeUndefined();

    second.fake.setUserId(9999);
    const secondLogin = await second.setup.start(baseUrl, new Date(), second.owners.issueInvitation());
    second.fake.claimPin();
    await second.setup.getStatus(secondLogin.sessionId);
    expect(first.owners.owner()).toBe("1234");
    expect(second.owners.owner()).toBe("9999");
    const firstBrowser = first.sessions.create(firstLogin.sessionId);
    const secondBrowser = second.sessions.create(secondLogin.sessionId);
    const browserRequest = (token: string) => ({ method: "GET" as const, url: "/api/v1/settings",
      headers: { cookie: `syncandrun_session=${token}` } });
    expect((await first.app.inject(browserRequest(firstBrowser.token))).statusCode).toBe(200);
    expect((await second.app.inject(browserRequest(secondBrowser.token))).statusCode).toBe(200);
    expect((await second.app.inject(browserRequest(firstBrowser.token))).statusCode).toBe(401);
    expect((await first.app.inject(browserRequest(secondBrowser.token))).statusCode).toBe(401);

    const pair = async (instance: typeof first) => {
      const code = await instance.management.createPairingCode();
      const response = await instance.app.inject({ method: "POST", url: "/api/v1/watch/pair", payload: {
        code: code.code, deviceId: "watch:fixture", deviceName: "Fixture watch", appVersion: "1.0.0", protocolVersion: 1
      } });
      expect(response.statusCode).toBe(200);
      return response.json<{ deviceToken: string }>().deviceToken;
    };
    const firstWatch = await pair(first);
    const secondWatch = await pair(second);
    const watchRequest = (token: string) => ({ method: "GET" as const, url: "/api/v1/watch/config",
      headers: { authorization: `Bearer ${token}` } });
    expect((await first.app.inject(watchRequest(firstWatch))).statusCode).toBe(200);
    expect((await second.app.inject(watchRequest(secondWatch))).statusCode).toBe(200);
    expect((await second.app.inject(watchRequest(firstWatch))).statusCode).toBe(401);
    expect((await first.app.inject(watchRequest(secondWatch))).statusCode).toBe(401);

    first.management.disconnectPlex();
    expect((await first.app.inject(browserRequest(firstBrowser.token))).statusCode).toBe(401);
    expect((await second.app.inject(browserRequest(secondBrowser.token))).statusCode).toBe(200);
    expect((await second.app.inject(watchRequest(secondWatch))).statusCode).toBe(200);
    expect(second.owners.owner()).toBe("9999");
  });

  it("fails closed before operator setup and denies a different Plex account before issuing a session or overwriting state", async () => {
    const { db, app, fake, owners } = await fixture();
    expect((await app.inject({ method: "POST", url: "/api/v1/setup/plex/pin" })).statusCode).toBe(403);
    const invitation = owners.issueInvitation();
    const started = await app.inject({ method: "POST", url: "/api/v1/setup/plex/pin", payload: { invitation } });
    expect(started.statusCode).toBe(200);
    fake.claimPin();
    const url = `/api/v1/setup/plex/pin/${started.json().sessionId}`;
    const login = await app.inject({ method: "GET", url });
    expect(login.statusCode).toBe(200);
    expect(owners.owner()).toBe("1234");
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const complete = await app.inject({ method: "POST", url: "/api/v1/setup/plex/complete",
      headers: { cookie, "x-csrf-token": login.json().csrfToken },
      payload: { serverId: "fixture-machine-id", connectionUri: fake.pmsUri, librarySectionId: "2" } });
    expect(complete.statusCode).toBe(200);
    const before = db.connection.prepare("SELECT * FROM plex_connection").get();
    fake.setUserId(9999);
    const attacker = await app.inject({ method: "POST", url: "/api/v1/setup/plex/pin" });
    const rejected = await app.inject({ method: "GET", url: `/api/v1/setup/plex/pin/${attacker.json().sessionId}` });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.headers["set-cookie"]).toBeUndefined();
    expect(db.connection.prepare("SELECT * FROM plex_connection").get()).toEqual(before);
    expect(db.connection.prepare("SELECT count(*) FROM browser_sessions").pluck().get()).toBe(1);
    expect(db.connection.prepare("SELECT encrypted_account_token FROM plex_auth_sessions WHERE id=?").pluck().get(attacker.json().sessionId)).toBeNull();
    await app.inject({ method: "POST", url: "/api/v1/session/logout", headers: { cookie, "x-csrf-token": login.json().csrfToken } });
    const replay = await app.inject({ method: "GET", url });
    expect(replay.headers["set-cookie"]).toBeUndefined();
    expect(replay.statusCode).not.toBe(200);
  });

  it("consumes an invitation once even when PIN requests race; replacement invalidates the pending claim", async () => {
    const { owners, setup, fake, db } = await fixture();
    const token = owners.issueInvitation();
    expect(JSON.stringify(db.connection.prepare("SELECT * FROM setup_invitation").get())).not.toContain(token);
    const results = await Promise.allSettled([setup.start(baseUrl, new Date(), token), setup.start(baseUrl, new Date(), token)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = results.find((r) => r.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("Missing winner");
    await expect(setup.start(baseUrl, new Date(), token)).rejects.toThrow();
    owners.issueInvitation();
    fake.claimPin();
    await expect(setup.getStatus(winner.value.sessionId)).rejects.toThrow();
    expect(owners.owner()).toBeUndefined();
  });

  it("rejects expired links and claims without assigning an owner", async () => {
    const { owners, setup, fake } = await fixture();
    const expired = owners.issueInvitation(new Date(Date.now() - 31 * 60_000));
    await expect(setup.start(baseUrl, new Date(), expired)).rejects.toThrow();
    const token = owners.issueInvitation();
    const started = await setup.start(baseUrl, new Date(), token);
    fake.claimPin();
    await expect(setup.getStatus(started.sessionId, new Date(Date.now() + 31 * 60_000))).resolves.toMatchObject({ status: "expired" });
    expect(owners.owner()).toBeUndefined();
  });

  it("keeps owner binding across disconnect/data deletion, allows the same stable identity to reconnect, and prevents in-flight completion resurrecting disconnected state", async () => {
    const { owners, setup, fake, sessions, management, db } = await fixture();
    const started = await setup.start(baseUrl, new Date(), owners.issueInvitation());
    fake.claimPin();
    await setup.getStatus(started.sessionId);
    const browser = sessions.create(started.sessionId);
    const pendingComplete = setup.complete(started.sessionId, "fixture-machine-id", fake.pmsUri, "2");
    management.disconnectPlex();
    await expect(pendingComplete).rejects.toThrow();
    expect(sessions.authenticate(browser.token)).toBeUndefined();
    expect(db.connection.prepare("SELECT * FROM plex_connection").get()).toBeUndefined();
    expect(owners.owner()).toBe("1234");
    expect(() => owners.issueInvitation()).toThrow();
    fake.setUserId("1234");
    const reconnect = await setup.start(baseUrl);
    await setup.getStatus(reconnect.sessionId);
    expect(sessions.authenticate(sessions.create(reconnect.sessionId).token)).toBeDefined();
    management.deleteUserData();
    expect(owners.owner()).toBe("1234");
    fake.setUserId(9999);
    const attacker = await setup.start(baseUrl);
    await expect(setup.getStatus(attacker.sessionId)).rejects.toThrow();
  });

  it("refuses browser exchange after PIN expiry and permits exactly one concurrent exchange", async () => {
    const { owners, setup, fake, sessions } = await fixture();
    const started = await setup.start(baseUrl, new Date(), owners.issueInvitation());
    fake.claimPin();
    await setup.getStatus(started.sessionId);
    expect(() => sessions.create(started.sessionId, new Date(Date.now() + 31 * 60_000))).toThrow();
    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => sessions.create(started.sessionId)),
      Promise.resolve().then(() => sessions.create(started.sessionId))
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("invalidates legacy management sessions on migration without silently claiming a legacy account", async () => {
    const { owners, setup, fake, db, sessions } = await fixture();
    const started = await setup.start(baseUrl, new Date(), owners.issueInvitation());
    fake.claimPin();
    await setup.getStatus(started.sessionId);
    sessions.create(started.sessionId);
    await setup.complete(started.sessionId, "fixture-machine-id", fake.pmsUri, "2");
    db.connection.exec(`DROP TABLE installation_owner; DROP TABLE setup_invitation;
      ALTER TABLE plex_auth_sessions DROP COLUMN plex_user_id;
      ALTER TABLE plex_auth_sessions DROP COLUMN exchanged_at;
      DELETE FROM schema_migrations WHERE version=10;`);
    db.migrate();
    expect(owners.owner()).toBeUndefined();
    expect(db.connection.prepare("SELECT count(*) FROM browser_sessions").pluck().get()).toBe(0);
    expect(db.connection.prepare("SELECT * FROM plex_connection").get()).toBeDefined();
    await expect(setup.start(baseUrl)).rejects.toThrow();
  });
});
