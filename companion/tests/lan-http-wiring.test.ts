import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { CompanionDatabase } from "../src/persistence/database.js";
import { buildApp } from "../src/server/app.js";
import { createFakePlexServer } from "./helpers/fake-plex.js";

it("wires LAN HTTP opt-in through the production Plex setup path", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-lan-http-"));
  const fake = await createFakePlexServer();
  const originalFetch = globalThis.fetch;
  const config = loadConfig({ SYNCANDRUN_BASE_URL: "http://192.168.1.20",
    SYNCANDRUN_ALLOW_LAN_HTTP: "true", SYNCANDRUN_SECRET: "a".repeat(32),
    SYNCANDRUN_DATA_DIR: dataDir, SYNCANDRUN_LOG_LEVEL: "silent" });
  const database = new CompanionDatabase(dataDir);
  database.migrate();
  database.connection.prepare("INSERT INTO installation_owner(id, plex_user_id) VALUES (1, '1234')").run();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const requested = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (requested.origin === "https://plex.tv") {
      return originalFetch(new URL(requested.pathname + requested.search, fake.origin), init);
    }
    return originalFetch(input, init);
  });
  const app = buildApp(config, database);
  try {
    const response = await app.inject({ method: "POST", url: "/api/v1/setup/plex/pin" });
    expect(response.statusCode).toBe(200);
    expect(response.json().authUrl).toContain("forwardUrl=http%3A%2F%2F192.168.1.20%2Fsetup%2Fplex%2Fcallback");
  } finally {
    await app.close();
    await fake.app.close();
    vi.unstubAllGlobals();
    await rm(dataDir, { recursive: true, force: true });
  }
});
