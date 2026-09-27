import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionDatabase } from "../src/persistence/database.js";
import { PlexLibraryService } from "../src/plex/library-service.js";
import {
  buildAudioTranscodeUrl,
  PlexMediaNotFoundError,
  PlexMediaProxy,
  PlexTranscodeBusyError,
  PlexTranscodeFailedError
} from "../src/plex/media-proxy.js";
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

async function createProxy() {
  const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-media-proxy-"));
  temporaryDirectories.push(dataDir);
  const database = new CompanionDatabase(dataDir);
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
  const library = new PlexLibraryService(database.connection, setup, { fetch: server.fetch });
  await library.selectPlaylists(["plex:playlist:10"]);
  return { database, server, proxy: new PlexMediaProxy(database.connection, setup, { fetch: server.fetch }) };
}

async function consume(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("Plex media proxy", () => {
  it.each([64, 96, 128, 192, 256, 320] as const)("streams an MP3 at %s kbps", async (bitrate) => {
    const { server, proxy } = await createProxy();
    const stream = await proxy.openAudio("plex:track:100", bitrate);
    expect((await consume(stream.body)).subarray(0, 3).toString("utf8")).toBe("ID3");
    expect(server.lastAudioRequest()).toMatchObject({
      query: { path: "/library/metadata/100", musicBitrate: String(bitrate) },
      headers: { token: server.fixtureToken }
    });
  });

  it("uses sanitized domain errors for missing tracks and failed transcodes", async () => {
    const { server, proxy } = await createProxy();
    await expect(proxy.openAudio("plex:track:missing", 192)).rejects.toBeInstanceOf(
      PlexMediaNotFoundError
    );
    server.failTranscodeRequests(500);
    await expect(proxy.openAudio("plex:track:100", 192)).rejects.toBeInstanceOf(
      PlexTranscodeFailedError
    );
  });

  it("allows only one active audio transcode", async () => {
    const { proxy } = await createProxy();
    const first = await proxy.openAudio("plex:track:100", 192);
    await expect(proxy.openAudio("plex:track:100", 192)).rejects.toBeInstanceOf(
      PlexTranscodeBusyError
    );
    first.body.destroy();
    await new Promise<void>((resolve) => first.body.once("close", resolve));
    const next = await proxy.openAudio("plex:track:100", 192);
    expect((await consume(next.body)).subarray(0, 3).toString("utf8")).toBe("ID3");
  });

  it("constructs a credential-free Plex URL", () => {
    const url = buildAudioTranscodeUrl("https://pms.example.test", "123", 96, "fixture-session");
    expect(url.pathname).toBe("/music/:/transcode/universal/start.mp3");
    expect(url.searchParams.get("musicBitrate")).toBe("96");
    expect(url.searchParams.has("X-Plex-Token")).toBe(false);
  });
});
