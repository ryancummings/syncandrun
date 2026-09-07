import Fastify, { type FastifyInstance } from "fastify";

const fixtureToken = "sanitized_fake_plex_token";

interface FakePin {
  id: number;
  code: string;
  clientIdentifier: string;
  authToken: string | null;
  expiresAt: string;
}

export interface FakePlexServer {
  app: FastifyInstance;
  origin: URL;
  claimPin(): void;
  setUserId(id: number | string): void;
  expirePin(): void;
  failUserRequests(statusCode: number): void;
  failPlaylistRequests(statusCode: number): void;
  setPlaylistLeafCount(id: string, leafCount: number): void;
  failTranscodeRequests(statusCode: number): void;
  lastAudioRequest(): { query: Record<string, string>; headers: Record<string, string | undefined> } | undefined;
  lastArtworkRequest(): { query: Record<string, string>; headers: Record<string, string | undefined> } | undefined;
  fixtureToken: string;
  pmsUri: string;
  fetch: typeof fetch;
}

export async function createFakePlexServer(): Promise<FakePlexServer> {
  const app = Fastify({ logger: false });
  const createdAt = new Date().toISOString();
  let pin: FakePin = {
    id: 42,
    code: "fake-strong-pin-code",
    clientIdentifier: "",
    authToken: null,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  };
  const pins = new Map<number, FakePin>();
  let nextPinId = 42;
  let userStatusCode = 200;
  let userId: number | string = 1234;
  let playlistStatusCode = 200;
  let transcodeStatusCode = 200;
  let lastAudioRequest: ReturnType<FakePlexServer["lastAudioRequest"]>;
  let lastArtworkRequest: ReturnType<FakePlexServer["lastArtworkRequest"]>;

  app.post<{ Querystring: { strong?: string } }>("/api/v2/pins", async (request, reply) => {
    if (request.query.strong !== "true") return reply.code(400).send({ error: "strong PIN required" });
    pin = { ...pin, id: nextPinId++ };
    pins.set(pin.id, pin);
    pin.clientIdentifier = String(request.headers["x-plex-client-identifier"] ?? "");
    return reply.code(201).send({
      ...pin,
      product: request.headers["x-plex-product"],
      expiresIn: 1800,
      createdAt
    });
  });

  app.get<{ Params: { id: string }; Querystring: { code?: string } }>(
    "/api/v2/pins/:id",
    async (request, reply) => {
      const requestedPin = pins.get(Number(request.params.id));
      if (requestedPin === undefined) return reply.code(404).send({ error: "PIN not found" });
      const pin = requestedPin;
      if (
        request.params.id !== String(pin.id) ||
        request.query.code !== pin.code ||
        request.headers["x-plex-client-identifier"] !== pin.clientIdentifier
      ) {
        return reply.code(404).send({ error: "PIN not found" });
      }
      return {
        ...pin,
        product: request.headers["x-plex-product"],
        expiresIn: Math.max(0, Math.floor((Date.parse(pin.expiresAt) - Date.parse(createdAt)) / 1000)),
        createdAt
      };
    }
  );

  app.get("/api/v2/user", async (request, reply) => {
    if (userStatusCode !== 200) return reply.code(userStatusCode).send({ error: "fixture failure" });
    if (request.headers["x-plex-token"] !== fixtureToken) return reply.code(401).send({ error: "unauthorized" });
    return { id: userId, username: "fixture-user", email: "fixture@example.test" };
  });

  app.get("/api/v2/resources", async (request) => [
    {
      name: "Fixture Server",
      clientIdentifier: "fixture-machine-id",
      accessToken: fixtureToken,
      provides: "server",
      owned: true,
      presence: true,
      connections: [
        { uri: "http://private.example.test:32400", protocol: "http", local: true, relay: false },
        { uri: "https://pms.plex.example.test:32400", protocol: "https", local: false, relay: false }
      ],
      requestClientIdentifier: request.headers["x-plex-client-identifier"]
    },
    {
      name: "Fixture Browser",
      clientIdentifier: "fixture-client-resource",
      accessToken: null,
      provides: "client,player",
      owned: true,
      presence: true,
      connections: []
    },
    {
      name: "Unavailable Shared Server",
      clientIdentifier: "unavailable-shared-server",
      accessToken: null,
      provides: "server",
      owned: false,
      presence: false,
      connections: [
        { uri: "https://unavailable.example.test:32400", protocol: "https", local: false, relay: false }
      ]
    }
  ]);

  app.get("/auth", async (_request, reply) => {
    pin.authToken = fixtureToken;
    return reply
      .type("text/html; charset=utf-8")
      .send("<!doctype html><html lang=\"en\"><title>Fixture Plex authorized</title><p>SyncAndRun fixture authorization complete.</p></html>");
  });

  app.get("/identity", async (request, reply) => {
    if (request.headers["x-plex-token"] !== fixtureToken) return reply.code(401).send({ error: "unauthorized" });
    return { MediaContainer: { size: 0, claimed: true, machineIdentifier: "fixture-machine-id" } };
  });

  app.get("/library/sections", async (request, reply) => {
    if (request.headers["x-plex-token"] !== fixtureToken) return reply.code(401).send({ error: "unauthorized" });
    return {
      MediaContainer: {
        size: 3,
        Directory: [
          { key: "1", uuid: "fixture-movie-library", title: "Fixture Movies", type: "movie" },
          { key: "2", uuid: "fixture-music-library", title: "Fixture Music", type: "artist" },
          { key: "3", uuid: "fixture-show-library", title: "Fixture Shows", type: "show" }
        ]
      }
    };
  });

  const playlists = [
    {
      ratingKey: "10",
      key: "/playlists/10/items",
      title: "Fixture Favorites",
      playlistType: "audio",
      duration: 421_000,
      leafCount: 2,
      updatedAt: 1_723_636_800
    },
    {
      ratingKey: "20",
      key: "/playlists/20/items",
      title: "Fixture Shared",
      playlistType: "audio",
      duration: 241_000,
      leafCount: 1,
      updatedAt: 1_723_636_900
    }
  ];
  const tracks = {
    "10": [fixtureTrack("100", "Fixture One", 180_000), fixtureTrack("200", "Fixture Shared Track", 241_000)],
    "20": [fixtureTrack("200", "Fixture Shared Track", 241_000)]
  } as const;

  app.get("/playlists", async (request, reply) => {
    if (playlistStatusCode !== 200) return reply.code(playlistStatusCode).send({ error: "fixture failure" });
    if (request.headers["x-plex-token"] !== fixtureToken) return reply.code(401).send({ error: "unauthorized" });
    const offset = Number(request.headers["x-plex-container-start"] ?? 0);
    const metadata = playlists.slice(offset, offset + 1);
    return { MediaContainer: { offset, size: metadata.length, totalSize: playlists.length, Metadata: metadata } };
  });

  app.get<{ Params: { id: keyof typeof tracks } }>("/playlists/:id/items", async (request, reply) => {
    if (request.headers["x-plex-token"] !== fixtureToken) return reply.code(401).send({ error: "unauthorized" });
    const allTracks = tracks[request.params.id];
    if (allTracks === undefined) return reply.code(404).send({ error: "not found" });
    const offset = Number(request.headers["x-plex-container-start"] ?? 0);
    const metadata = allTracks.slice(offset, offset + 1);
    return { MediaContainer: { offset, size: metadata.length, totalSize: allTracks.length, Metadata: metadata } };
  });

  app.get("/music/*", async (request, reply) => {
    lastAudioRequest = captureProxyRequest(request.query, request.headers);
    if (transcodeStatusCode !== 200) return reply.code(transcodeStatusCode).send("fixture failure");
    if (request.headers["x-plex-token"] !== fixtureToken) return reply.code(401).send("unauthorized");
    return reply.type("audio/mpeg").send(Buffer.from("ID3fixture-mp3-audio", "utf8"));
  });

  app.get("/photo/*", async (request, reply) => {
    lastArtworkRequest = captureProxyRequest(request.query, request.headers);
    if (request.headers["x-plex-token"] !== fixtureToken) return reply.code(401).send("unauthorized");
    return reply.type("image/jpeg").send(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0xff, 0xd9]));
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("Fake Plex server did not bind a TCP port");
  const origin = new URL(`http://127.0.0.1:${address.port}`);
  const pmsUri = "https://pms.plex.example.test:32400";
  return {
    app,
    origin,
    setUserId(id) { userId = id; },
    claimPin() {
      for (const item of pins.values()) item.authToken = fixtureToken;
      pin.authToken = fixtureToken;
    },
    expirePin() {
      pin.expiresAt = "2026-08-14T12:00:00.000Z";
    },
    failUserRequests(statusCode: number) {
      userStatusCode = statusCode;
    },
    failPlaylistRequests(statusCode: number) {
      playlistStatusCode = statusCode;
    },
    setPlaylistLeafCount(id: string, leafCount: number) {
      const playlist = playlists.find((item) => item.ratingKey === id);
      if (playlist === undefined) throw new Error(`Unknown fixture playlist ${id}`);
      playlist.leafCount = leafCount;
    },
    failTranscodeRequests(statusCode: number) {
      transcodeStatusCode = statusCode;
    },
    lastAudioRequest() {
      return lastAudioRequest;
    },
    lastArtworkRequest() {
      return lastArtworkRequest;
    },
    fixtureToken,
    pmsUri,
    fetch(input, init) {
      const requested = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (requested.origin === new URL(pmsUri).origin) {
        const rewritten = new URL(requested.pathname + requested.search, origin);
        return fetch(rewritten, init);
      }
      return fetch(input, init);
    }
  };
}

function captureProxyRequest(
  query: unknown,
  headers: Record<string, string | string[] | undefined>
): { query: Record<string, string>; headers: Record<string, string | undefined> } {
  return {
    query: Object.fromEntries(
      Object.entries((query ?? {}) as Record<string, unknown>).map(([key, value]) => [key, String(value)])
    ),
    headers: {
      token: typeof headers["x-plex-token"] === "string" ? headers["x-plex-token"] : undefined,
      clientIdentifier:
        typeof headers["x-plex-client-identifier"] === "string"
          ? headers["x-plex-client-identifier"]
          : undefined,
      clientProfile:
        typeof headers["x-plex-client-profile-extra"] === "string"
          ? headers["x-plex-client-profile-extra"]
          : undefined
    }
  };
}

function fixtureTrack(ratingKey: string, title: string, duration: number) {
  return {
    ratingKey,
    type: "track",
    title,
    grandparentTitle: "Fixture Artist",
    parentTitle: "Fixture Album",
    duration,
    updatedAt: 1_723_636_800 + Number(ratingKey),
    librarySectionID: 2,
    thumb: `/library/metadata/${ratingKey}/thumb/fixture`,
    Media: [
      {
        id: Number(ratingKey),
        Part: [
          {
            id: Number(ratingKey) * 10,
            key: `/library/parts/${ratingKey}/fixture.mp3`,
            size: duration * 12,
            duration,
            container: "mp3"
          }
        ]
      }
    ]
  };
}
