import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PlexDiscoveryClient } from "../src/plex/discovery.js";
import { createFakePlexServer, type FakePlexServer } from "./helpers/fake-plex.js";

const servers: FakePlexServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ app }) => app.close()));
});

async function createClient() {
  const server = await createFakePlexServer();
  servers.push(server);
  return {
    server,
    client: new PlexDiscoveryClient({
      clientIdentifier: "fixture-client-id",
      plexOrigin: server.origin,
      fetch: server.fetch
    })
  };
}

describe("Plex discovery", () => {
  it("normalizes usable servers and excludes clients, tokenless servers, and insecure connections", async () => {
    const { client, server } = await createClient();
    await expect(client.listServers(server.fixtureToken)).resolves.toEqual([
      {
        id: "fixture-machine-id",
        name: "Fixture Server",
        owned: true,
        presence: true,
        accessToken: server.fixtureToken,
        connections: [{ uri: server.pmsUri, local: false, relay: false }]
      }
    ]);
  });

  it("verifies the selected server identity and returns only music libraries", async () => {
    const { client, server } = await createClient();
    const [plexServer] = await client.listServers(server.fixtureToken);
    if (plexServer === undefined) throw new Error("Expected a fixture Plex server");
    await expect(client.listMusicLibraries(plexServer, server.pmsUri)).resolves.toEqual([
      { id: "2", uuid: "fixture-music-library", title: "Fixture Music" }
    ]);
  });

  it("refuses a connection not supplied by the selected Plex resource", async () => {
    const { client, server } = await createClient();
    const [plexServer] = await client.listServers(server.fixtureToken);
    if (plexServer === undefined) throw new Error("Expected a fixture Plex server");
    await expect(client.listMusicLibraries(plexServer, "https://attacker.example.test")).rejects.toThrow(
      "was not discovered"
    );
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
    await expect(new PlexDiscoveryClient({ clientIdentifier: "fixture-client-id", plexOrigin: origin }).listServers("synthetic-redirect-token")).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(requests).not.toContain("/redirected");
  } finally {
    await new Promise<void>((resolve, reject) => endpoint.close((error) => error ? reject(error) : resolve()));
  }
});
