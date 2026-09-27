import { OwnerRepository } from "../../src/persistence/owner-repository.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RuntimeConfig } from "../../src/config.js";
import { BrowserManagementService } from "../../src/persistence/browser-management-service.js";
import { BrowserSessionRepository } from "../../src/persistence/browser-session-repository.js";
import { CompanionDatabase } from "../../src/persistence/database.js";
import { PlexLibraryService } from "../../src/plex/library-service.js";
import { PlexSetupService } from "../../src/plex/setup-service.js";
import { buildApp } from "../../src/server/app.js";
import { createFakePlexServer } from "../helpers/fake-plex.js";

const secret = "operator-secret-with-at-least-32-bytes";
const port = Number(process.env.SYNCANDRUN_E2E_PORT ?? 34117);
const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-playwright-"));
const fake = await createFakePlexServer();
fake.setPlaylistLeafCount("20", 10_001);
const database = new CompanionDatabase(dataDir);
database.migrate();

// The synthetic server stays on loopback.
const host = "127.0.0.1";
const config: RuntimeConfig = {
  secret,
  dataDir,
  port,
  logLevel: "silent",
  host,
  trustProxy: false
};
const setup = new PlexSetupService(database.connection, secret, {
  plexOrigin: fake.origin,
  authOrigin: fake.origin,
  fetch: fake.fetch
});
const sessions = new BrowserSessionRepository(database.connection, secret);
const app = buildApp(
  config,
  database,
  {
    plexSetup: setup,
    plexLibrary: new PlexLibraryService(database.connection, setup, { fetch: fake.fetch }),
    browserSessions: sessions,
    management: new BrowserManagementService(database.connection, secret, sessions)
  }
);

// Test-only bootstrap endpoint; this file is excluded from the production build.
app.get("/__test/setup-link", async () => ({ path: `/#setup=${new OwnerRepository(database.connection).issueInvitation()}` }));

async function shutdown() {
  await app.close();
  await fake.app.close();
  database.close();
  await rm(dataDir, { recursive: true, force: true });
}

process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });

await app.listen({ host, port });
