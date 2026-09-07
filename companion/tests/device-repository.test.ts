import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionDatabase } from "../src/persistence/database.js";
import { DeviceRepository } from "../src/persistence/device-repository.js";
import { verifyDeviceToken } from "../src/security/credentials.js";

const secret = "operator-secret-with-at-least-32-bytes";
const temporaryDirectories: string[] = [];
const databases: CompanionDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createRepository() {
  const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-device-repository-"));
  temporaryDirectories.push(dataDir);
  const database = new CompanionDatabase(dataDir);
  databases.push(database);
  database.migrate();
  return { database, repository: new DeviceRepository(database.connection, secret) };
}

describe("device repository", () => {
  it("stores only a slow hash and expires pairing codes after ten minutes", async () => {
    const { database, repository } = await createRepository();
    const now = new Date("2026-08-14T12:00:00.000Z");
    const created = await repository.createPairingCode(now);
    expect(created.expiresAt).toBe("2026-08-14T12:10:00.000Z");
    const row = database.connection.prepare("SELECT code_hash, salt FROM pairing_codes").get() as {
      code_hash: Buffer;
      salt: Buffer;
    };
    expect(row.code_hash.toString("utf8")).not.toContain(created.code);
    expect(row.salt).toHaveLength(16);

    const claim = await repository.claimPairingCode(
      created.code,
      { deviceId: "watch:fixture", deviceName: "Forerunner 955 Solar" },
      new Date("2026-08-14T12:10:00.000Z")
    );
    expect(claim).toEqual({ status: "expired" });
  });

  it("claims a code once and persists only the keyed device-token hash", async () => {
    const { database, repository } = await createRepository();
    const created = await repository.createPairingCode();
    const claim = await repository.claimPairingCode(created.code, {
      deviceId: "watch:fixture",
      deviceName: "Forerunner 955 Solar"
    });
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") throw new Error("Expected claimed pairing code");
    expect(claim.manifestRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(claim.companionId).toMatch(/^companion:[a-f0-9-]+$/);

    const device = database.connection.prepare("SELECT token_hash, display_name FROM devices").get() as {
      token_hash: Buffer;
      display_name: string;
    };
    expect(device.display_name).toBe("Forerunner 955 Solar");
    expect(device.token_hash.toString("utf8")).not.toContain(claim.deviceToken);
    expect(verifyDeviceToken(claim.deviceToken, device.token_hash, secret)).toBe(true);
    expect(await repository.claimPairingCode(created.code, { deviceId: "watch:other", deviceName: "Other" })).toEqual({
      status: "invalid"
    });
  });

  it("locks a code after five failed claims", async () => {
    const { database, repository } = await createRepository();
    const created = await repository.createPairingCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await repository.claimPairingCode("ZZZZZZ", { deviceId: "watch:fixture", deviceName: "Watch" })).toEqual({
        status: "invalid"
      });
    }
    expect(database.connection.prepare("SELECT failed_attempts FROM pairing_codes").pluck().get()).toBe(5);
    expect(
      await repository.claimPairingCode(created.code, { deviceId: "watch:fixture", deviceName: "Watch" })
    ).toEqual({ status: "invalid" });
  });

  it("re-pairing a stable device rotates its token and clears revocation state", async () => {
    const { database, repository } = await createRepository();
    const firstCode = await repository.createPairingCode();
    const first = await repository.claimPairingCode(firstCode.code, { deviceId: "watch:fixture", deviceName: "Old name" });
    if (first.status !== "claimed") throw new Error("Expected first claim");
    database.connection
      .prepare("UPDATE devices SET revoked_at = ?, applied_revision = ? WHERE id = ?")
      .run(new Date().toISOString(), "a".repeat(64), "watch:fixture");

    const secondCode = await repository.createPairingCode();
    const second = await repository.claimPairingCode(secondCode.code, { deviceId: "watch:fixture", deviceName: "New name" });
    if (second.status !== "claimed") throw new Error("Expected second claim");
    expect(second.deviceToken).not.toBe(first.deviceToken);
    expect(database.connection.prepare("SELECT display_name, revoked_at, applied_revision FROM devices").get()).toEqual({
      display_name: "New name",
      revoked_at: null,
      applied_revision: null
    });
  });

  it("authenticates active tokens, records last seen, and distinguishes revoked devices", async () => {
    const { database, repository } = await createRepository();
    const pairingCode = await repository.createPairingCode();
    const claim = await repository.claimPairingCode(pairingCode.code, {
      deviceId: "watch:fixture",
      deviceName: "Watch"
    });
    if (claim.status !== "claimed") throw new Error("Expected claimed pairing code");

    expect(repository.authenticateDevice("x".repeat(43))).toEqual({ status: "invalid" });
    expect(repository.authenticateDevice(claim.deviceToken, new Date("2026-08-14T12:00:00.000Z"))).toEqual({
      status: "authenticated",
      deviceId: "watch:fixture"
    });
    expect(database.connection.prepare("SELECT last_seen_at FROM devices").pluck().get()).toBe("2026-08-14T12:00:00.000Z");

    database.connection
      .prepare("UPDATE devices SET revoked_at = ? WHERE id = ?")
      .run("2026-08-14T12:01:00.000Z", "watch:fixture");
    expect(repository.authenticateDevice(claim.deviceToken)).toEqual({ status: "revoked" });
  });
});
