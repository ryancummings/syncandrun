import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RuntimeConfig } from "../src/config.js";
import { DeviceRepository } from "../src/persistence/device-repository.js";
import { pairResponseSchema } from "../src/protocol/index.js";
import { createRuntime } from "../src/runtime.js";

const secret = "operator-secret-with-at-least-32-bytes";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTestRuntime() {
  const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-watch-pair-"));
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

function requestBody(code: string) {
  return {
    code,
    deviceId: "watch:fixture",
    deviceName: "Forerunner 955 Solar",
    appVersion: "1.0.0",
    protocolVersion: 1
  };
}

describe("POST /api/v1/watch/pair", () => {
  it("claims a short-lived code and returns the bearer token exactly once", async () => {
    const runtime = await createTestRuntime();
    const devices = new DeviceRepository(runtime.database.connection, secret);
    const pairingCode = await devices.createPairingCode();

    const response = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/watch/pair",
      payload: requestBody(pairingCode.code)
    });
    expect(response.statusCode).toBe(200);
    expect(pairResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(response.json()).toMatchObject({ protocolVersion: 1 });

    const replay = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/watch/pair",
      payload: requestBody(pairingCode.code)
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ error: { code: "PAIRING_CODE_INVALID", retryable: false } });
    await runtime.app.close();
  });

  it("rejects an unsupported protocol without consuming the pairing code", async () => {
    const runtime = await createTestRuntime();
    const devices = new DeviceRepository(runtime.database.connection, secret);
    const pairingCode = await devices.createPairingCode();

    const mismatch = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/watch/pair",
      payload: { ...requestBody(pairingCode.code), protocolVersion: 2 }
    });
    expect(mismatch.statusCode).toBe(426);
    expect(mismatch.json()).toMatchObject({ error: { code: "PROTOCOL_UNSUPPORTED", retryable: false } });

    const supported = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/watch/pair",
      payload: requestBody(pairingCode.code)
    });
    expect(supported.statusCode).toBe(200);
    await runtime.app.close();
  });

  it("returns the stable expired-code error", async () => {
    const runtime = await createTestRuntime();
    const devices = new DeviceRepository(runtime.database.connection, secret);
    const pairingCode = await devices.createPairingCode(new Date("2026-08-14T12:00:00.000Z"));

    const response = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/watch/pair",
      payload: requestBody(pairingCode.code)
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "PAIRING_CODE_EXPIRED", retryable: false } });
    await runtime.app.close();
  });

  it("rate-limits repeated claims by client address", async () => {
    const runtime = await createTestRuntime();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await runtime.app.inject({ method: "POST", url: "/api/v1/watch/pair", payload: {} });
      expect(response.statusCode).toBe(400);
    }
    const limited = await runtime.app.inject({ method: "POST", url: "/api/v1/watch/pair", payload: {} });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: "RATE_LIMITED", retryable: true } });
    await runtime.app.close();
  });

  it("sanitizes unexpected repository failures", async () => {
    const runtime = await createTestRuntime();
    const devices = new DeviceRepository(runtime.database.connection, secret);
    const pairingCode = await devices.createPairingCode();
    runtime.database.connection.exec("DROP TABLE settings");

    const response = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/watch/pair",
      payload: requestBody(pairingCode.code)
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: { code: "INTERNAL_ERROR", message: "The companion could not complete the request.", retryable: true }
    });
    expect(response.body).not.toContain("settings");
    await runtime.app.close();
  });
});
