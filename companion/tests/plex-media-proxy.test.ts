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
  it.each([
    ["compact", "64"],
    ["balanced", "96"],
    ["high", "128"]
  ] as const)("builds and streams the %s MP3 profile", async (profile, expectedBitrate) => {
    const { database, server, proxy } = await createProxy();
    database.connection.prepare("UPDATE settings SET transcode_profile = ? WHERE id = 1").run(profile);
    const stream = await proxy.openAudio("plex:track:100", `watch:${profile}`);
    expect((await consume(stream.body)).subarray(0, 3).toString("utf8")).toBe("ID3");
    expect(server.lastAudioRequest()).toMatchObject({
      query: {
        path: "/library/metadata/100",
        protocol: "http",
        mediaIndex: "0",
        partIndex: "0",
        directPlay: "0",
        directStream: "0",
        directStreamAudio: "0",
        audioChannelCount: "2",
        musicBitrate: expectedBitrate
      },
      headers: {
        token: server.fixtureToken,
        clientProfile:
          "add-transcode-target(type=musicProfile&context=streaming&protocol=http&container=mp3&audioCodec=mp3)"
      }
    });
  });

  it("streams watch-sized JPEG artwork", async () => {
    const { server, proxy } = await createProxy();
    const stream = await proxy.openArtwork("plex:track:100");
    expect(await consume(stream.body)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0xff, 0xd9]));
    expect(server.lastArtworkRequest()).toMatchObject({
      query: {
        url: "/library/metadata/100/thumb/fixture",
        format: "jpeg",
        width: "80",
        height: "80",
        upscale: "0"
      }
    });
  });

  it("uses sanitized domain errors for missing tracks and failed transcodes", async () => {
    const { server, proxy } = await createProxy();
    await expect(proxy.openAudio("plex:track:missing", "watch:missing")).rejects.toBeInstanceOf(
      PlexMediaNotFoundError
    );
    server.failTranscodeRequests(500);
    await expect(proxy.openAudio("plex:track:100", "watch:failed")).rejects.toBeInstanceOf(
      PlexTranscodeFailedError
    );
  });

  it("allows only one active audio transcode per watch", async () => {
    const { proxy } = await createProxy();
    const first = await proxy.openAudio("plex:track:100", "watch:one-at-a-time");
    await expect(proxy.openAudio("plex:track:100", "watch:one-at-a-time")).rejects.toBeInstanceOf(
      PlexTranscodeBusyError
    );
    first.body.destroy();
    await new Promise<void>((resolve) => first.body.once("close", resolve));
    const next = await proxy.openAudio("plex:track:100", "watch:one-at-a-time");
    expect((await consume(next.body)).subarray(0, 3).toString("utf8")).toBe("ID3");
  });

  it("constructs a credential-free Plex URL", () => {
    const url = buildAudioTranscodeUrl("https://pms.example.test", "123", 96, "fixture-session");
    expect(url.pathname).toBe("/music/:/transcode/universal/start.mp3");
    expect(url.searchParams.get("musicBitrate")).toBe("96");
    expect(url.searchParams.has("X-Plex-Token")).toBe(false);
  });
});
