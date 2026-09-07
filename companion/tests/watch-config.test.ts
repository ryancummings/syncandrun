import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RuntimeConfig } from "../src/config.js";
import { DeviceRepository } from "../src/persistence/device-repository.js";
import { watchConfigSchema } from "../src/protocol/index.js";
import { createRuntime } from "../src/runtime.js";

const secret = "operator-secret-with-at-least-32-bytes";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTestRuntime() {
  const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-watch-config-"));
  temporaryDirectories.push(dataDir);
  const config: RuntimeConfig = {
    baseUrl: new URL("https://music.example.test"),
    secret,
    dataDir,
    port: 3000,
    logLevel: "silent",
    trustProxy: false
  };
  return createRuntime(config);
}

async function pairDevice(runtime: Awaited<ReturnType<typeof createTestRuntime>>) {
  const devices = new DeviceRepository(runtime.database.connection, secret);
  const pairingCode = await devices.createPairingCode();
  const claim = await devices.claimPairingCode(pairingCode.code, {
    deviceId: "watch:fixture",
    deviceName: "Forerunner 955 Solar"
  });
  if (claim.status !== "claimed") throw new Error("Expected claimed pairing code");
  return claim.deviceToken;
}

describe("GET /api/v1/watch/config", () => {
  it("returns the bounded current config and honors its revision ETag", async () => {
    const runtime = await createTestRuntime();
    const token = await pairDevice(runtime);
    const response = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/watch/config",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(response.statusCode).toBe(200);
    expect(watchConfigSchema.safeParse(response.json()).success).toBe(true);
    expect(response.json()).toMatchObject({ protocolVersion: 1, transcodeProfile: "balanced", pageSize: 10 });
    expect(response.headers.etag).toBe(`"${response.json().manifestRevision}"`);

    const unchanged = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/watch/config",
      headers: { authorization: `Bearer ${token}`, "if-none-match": response.headers.etag! }
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe("");
    await runtime.app.close();
  });

  it("rejects missing and unknown device credentials", async () => {
    const runtime = await createTestRuntime();
    const missing = await runtime.app.inject({ method: "GET", url: "/api/v1/watch/config" });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ error: { code: "AUTH_REQUIRED", retryable: false } });

    const unknown = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/watch/config",
      headers: { authorization: `Bearer ${"x".repeat(43)}` }
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toMatchObject({ error: { code: "AUTH_REQUIRED", retryable: false } });
    await runtime.app.close();
  });

  it("returns the stable revoked-device error without updating last seen", async () => {
    const runtime = await createTestRuntime();
    const token = await pairDevice(runtime);
    runtime.database.connection
      .prepare("UPDATE devices SET revoked_at = ?, last_seen_at = NULL WHERE id = ?")
      .run("2026-08-14T12:00:00.000Z", "watch:fixture");

    const response = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/watch/config",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "DEVICE_REVOKED", retryable: false } });
    expect(runtime.database.connection.prepare("SELECT last_seen_at FROM devices").pluck().get()).toBeNull();
    await runtime.app.close();
  });
});
