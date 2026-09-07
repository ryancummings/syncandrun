import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RuntimeConfig } from "../src/config.js";
import { createRuntime } from "../src/runtime.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function testConfig(): Promise<RuntimeConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-health-"));
  temporaryDirectories.push(dataDir);
  return {
    baseUrl: new URL("https://music.example.test"),
    secret: "a".repeat(32),
    dataDir,
    port: 3000,
    logLevel: "silent",
    trustProxy: false
  };
}

describe("health endpoints", () => {
  it("reports liveness and migration-backed readiness", async () => {
    const runtime = await createRuntime(await testConfig());
    const live = await runtime.app.inject({ method: "GET", url: "/health/live" });
    const ready = await runtime.app.inject({ method: "GET", url: "/health/ready" });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "ok" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ok" });
    await runtime.app.close();
  });

  it("keeps liveness up but fails readiness when SQLite is unavailable", async () => {
    const runtime = await createRuntime(await testConfig());
    runtime.database.close();
    const live = await runtime.app.inject({ method: "GET", url: "/health/live" });
    const ready = await runtime.app.inject({ method: "GET", url: "/health/ready" });
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "unavailable" });
    await runtime.app.close();
  });
});
