import { afterEach, describe, expect, it } from "vitest";
import {
  PlexAuthClient,
  PlexInvalidResponseError,
  PlexServiceUnavailableError
} from "../src/plex/auth.js";
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
    client: new PlexAuthClient({
      clientIdentifier: "fixture-client-id",
      plexOrigin: server.origin,
      authOrigin: new URL("https://app.plex.example.test")
    })
  };
}

describe("Plex PIN authentication", () => {
  it("creates a strong PIN and a correctly encoded Plex Auth App URL", async () => {
    const { client } = await createClient();
    const pin = await client.createPin(new URL("https://music.example.test/setup/plex/callback"));
    expect(pin).toMatchObject({
      id: 42,
      code: "fake-strong-pin-code"
    });
    const authUrl = new URL(pin.authUrl);
    expect(authUrl.origin).toBe("https://app.plex.example.test");
    expect(authUrl.pathname).toBe("/auth");
    const fragment = new URLSearchParams(authUrl.hash.slice(2));
    expect(Object.fromEntries(fragment)).toEqual({
      clientID: "fixture-client-id",
      code: "fake-strong-pin-code",
      "context[device][product]": "SyncAndRun for Garmin",
      forwardUrl: "https://music.example.test/setup/plex/callback"
    });
  });

  it("reports pending, claimed, and expired PIN states without validating a pending token", async () => {
    const { client, server } = await createClient();
    const pin = await client.createPin(new URL("https://music.example.test/setup/plex/callback"));
    expect(await client.getPinStatus(pin.id, pin.code, new Date("2026-08-14T12:45:00.000Z"))).toEqual({
      status: "pending",
      expiresAt: pin.expiresAt
    });

    server.claimPin();
    const claimed = await client.getPinStatus(pin.id, pin.code, new Date("2026-08-14T12:45:00.000Z"));
    expect(claimed).toEqual({ status: "claimed", expiresAt: pin.expiresAt, token: server.fixtureToken });

    server.expirePin();
    expect(await client.getPinStatus(pin.id, pin.code, new Date("2026-08-14T12:45:00.000Z"))).toEqual({
      status: "expired",
      expiresAt: "2026-08-14T12:00:00.000Z"
    });
  });

  it("validates claimed tokens through Plex user information", async () => {
    const { client, server } = await createClient();
    await expect(client.validateToken(server.fixtureToken)).resolves.toEqual({
      valid: true,
      user: { id: 1234, username: "fixture-user" }
    });
    await expect(client.validateToken("wrong-fixture-token")).resolves.toEqual({ valid: false });
  });

  it("distinguishes invalid Plex payloads from service failures", async () => {
    const { client, server } = await createClient();
    server.failUserRequests(503);
    await expect(client.validateToken(server.fixtureToken)).rejects.toBeInstanceOf(PlexServiceUnavailableError);

    const malformed = new PlexAuthClient({
      clientIdentifier: "fixture-client-id",
      plexOrigin: server.origin,
      fetch: async () => new Response(JSON.stringify({ id: "missing-fields" }), { status: 201 })
    });
    await expect(malformed.createPin(new URL("https://music.example.test/callback"))).rejects.toBeInstanceOf(
      PlexInvalidResponseError
    );
  });

  it("fails closed when Plex requests time out", async () => {
    const client = new PlexAuthClient({
      clientIdentifier: "fixture-client-id",
      timeoutMs: 5,
      fetch: async (_input, init) => {
        await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
        throw new Error("unreachable");
      }
    });
    await expect(client.validateToken("sanitized-token")).rejects.toBeInstanceOf(PlexServiceUnavailableError);
  });
});

it("does not follow credential-bearing Plex authentication redirects", async () => {
  const client = new PlexAuthClient({
    clientIdentifier: "fixture-client-id",
    fetch: async (_input, init) => {
      expect(init?.redirect).toBe("error");
      return new Response(null, { status: 302, headers: { Location: "https://other.example.test" } });
    }
  });
  await expect(client.validateToken("fixture-token")).rejects.toBeInstanceOf(PlexServiceUnavailableError);
});
