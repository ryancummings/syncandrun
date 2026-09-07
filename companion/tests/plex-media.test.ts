import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PlexMediaClient } from "../src/plex/media.js";
import type { StoredPlexConnection } from "../src/plex/setup-service.js";
import { createFakePlexServer, type FakePlexServer } from "./helpers/fake-plex.js";

const servers: FakePlexServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ app }) => app.close()));
});

async function createClient() {
  const server = await createFakePlexServer();
  servers.push(server);
  const connection: StoredPlexConnection = {
    accountToken: server.fixtureToken,
    serverToken: server.fixtureToken,
    serverMachineId: "fixture-machine-id",
    serverBaseUri: server.pmsUri,
    librarySectionId: "2"
  };
  return {
    server,
    connection,
    client: new PlexMediaClient({ clientIdentifier: "fixture-client-id", fetch: server.fetch })
  };
}

describe("Plex media normalization", () => {
  it("paginates and normalizes audio playlists", async () => {
    const { client, connection } = await createClient();
    await expect(client.listAudioPlaylists(connection)).resolves.toEqual([
      {
        id: "plex:playlist:10",
        ratingKey: "10",
        key: "/playlists/10/items",
        title: "Fixture Favorites",
        trackCount: 2,
        durationSeconds: 421,
        sourceUpdatedAt: 1_723_636_800,
        selectable: true,
        unavailableReason: null
      },
      {
        id: "plex:playlist:20",
        ratingKey: "20",
        key: "/playlists/20/items",
        title: "Fixture Shared",
        trackCount: 1,
        durationSeconds: 241,
        sourceUpdatedAt: 1_723_636_900,
        selectable: true,
        unavailableReason: null
      }
    ]);
  });

  it("marks a playlist above the watch safety ceiling as unavailable", async () => {
    const { client, connection, server } = await createClient();
    server.setPlaylistLeafCount("10", 10_001);
    const playlists = await client.listAudioPlaylists(connection);
    expect(playlists[0]).toMatchObject({
      id: "plex:playlist:10",
      trackCount: 10_001,
      selectable: false,
      unavailableReason: "This playlist exceeds the 10,000-track safety limit and cannot be added."
    });
  });

  it("normalizes ordered tracks with stable source fingerprints", async () => {
    const { client, connection } = await createClient();
    const playlists = await client.listAudioPlaylists(connection);
    const first = await client.listPlaylistTracks(connection, playlists[0]!);
    const second = await client.listPlaylistTracks(connection, playlists[1]!);
    expect(first.map(({ id }) => id)).toEqual(["plex:track:100", "plex:track:200"]);
    expect(first[0]).toMatchObject({
      ratingKey: "100",
      title: "Fixture One",
      artist: "Fixture Artist",
      album: "Fixture Album",
      durationSeconds: 180,
      artworkKey: "/library/metadata/100/thumb/fixture"
    });
    expect(first[0]!.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second[0]!.sourceFingerprint).toBe(first[1]!.sourceFingerprint);
  });
});

// Exercise native fetch: mocks that ignore RequestInit would miss token forwarding.
it("does not follow a Plex redirect or send its token to the redirected target", async () => {
  const requests: string[] = [];
  const endpoint = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/redirected") { response.end("{}"); return; }
    response.writeHead(302, { Location: "/redirected" });
    response.end();
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const origin = new URL(`http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`);
  try {
    await expect(new PlexMediaClient({ clientIdentifier: "fixture-client-id" }).listAudioPlaylists({ accountToken: "synthetic-redirect-token", serverToken: "synthetic-redirect-token", serverMachineId: "fixture-machine-id", serverBaseUri: origin.href, librarySectionId: "2" })).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(requests).not.toContain("/redirected");
  } finally {
    await new Promise<void>((resolve, reject) => endpoint.close((error) => error ? reject(error) : resolve()));
  }
});

it.each(["https://attacker.example.test/playlists/10/items", "//attacker.example.test/playlists/10/items", "/\\attacker.example.test/playlists/10/items", "/playlists/10/items?redirect=https://attacker.example.test"])("rejects unsafe playlist key %s before fetching tracks", async (key) => {
  const { client, connection } = await createClient();
  const [playlist] = await client.listAudioPlaylists(connection);
  if (!playlist) throw new Error("Expected fixture playlist");
  await expect(client.listPlaylistTracks(connection, { ...playlist, key })).rejects.toThrow("invalid playlist key");
});
