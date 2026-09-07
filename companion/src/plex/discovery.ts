import { z } from "zod";
import { PlexInvalidResponseError, PlexServiceUnavailableError } from "./auth.js";

const product = "SyncAndRun for Garmin";
const version = "1.0.0-dev.0";
const defaultPlexOrigin = new URL("https://plex.tv");
const defaultTimeoutMs = 10_000;

const connectionSchema = z.object({
  uri: z.url(),
  protocol: z.string(),
  local: z.boolean(),
  relay: z.boolean()
});

const resourceSchema = z.object({
  name: z.string().min(1),
  clientIdentifier: z.string().min(1),
  accessToken: z.string().min(1).nullish(),
  provides: z.string(),
  owned: z.boolean(),
  presence: z.boolean(),
  connections: z.array(connectionSchema)
});

const resourcesSchema = z.array(resourceSchema);
const identitySchema = z.object({
  MediaContainer: z.object({ machineIdentifier: z.string().min(1), claimed: z.boolean() })
});
const librariesSchema = z.object({
  MediaContainer: z.object({
    Directory: z
      .array(
        z.object({
          key: z.string().min(1),
          uuid: z.string().min(1),
          title: z.string().min(1),
          type: z.string()
        })
      )
      .default([])
  })
});

type Fetch = typeof fetch;

export interface PlexDiscoveryClientOptions {
  clientIdentifier: string;
  plexOrigin?: URL;
  fetch?: Fetch;
  timeoutMs?: number;
}

export interface PlexServerConnection {
  uri: string;
  local: boolean;
  relay: boolean;
}

export interface PlexServer {
  id: string;
  name: string;
  owned: boolean;
  presence: boolean;
  accessToken: string;
  connections: PlexServerConnection[];
}

export interface PlexMusicLibrary {
  id: string;
  uuid: string;
  title: string;
}

export class PlexDiscoveryClient {
  readonly #clientIdentifier: string;
  readonly #plexOrigin: URL;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;

  constructor(options: PlexDiscoveryClientOptions) {
    if (options.clientIdentifier.length === 0) throw new Error("Plex client identifier is required");
    this.#clientIdentifier = options.clientIdentifier;
    this.#plexOrigin = options.plexOrigin ?? defaultPlexOrigin;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  }

  async listServers(accountToken: string): Promise<PlexServer[]> {
    const url = new URL("/api/v2/resources", this.#plexOrigin);
    url.searchParams.set("includeHttps", "1");
    const resources = resourcesSchema.parse(await this.#requestJson(url, accountToken));
    return resources
      .filter(
        (resource): resource is typeof resource & { accessToken: string } =>
          resource.provides.split(",").includes("server") &&
          resource.accessToken !== null &&
          resource.accessToken !== undefined
      )
      .map((resource) => ({
        id: resource.clientIdentifier,
        name: resource.name,
        owned: resource.owned,
        presence: resource.presence,
        accessToken: resource.accessToken,
        connections: resource.connections.flatMap((connection) => {
          const uri = normalizeHttpsOrigin(connection.uri);
          return uri === undefined ? [] : [{ uri, local: connection.local, relay: connection.relay }];
        })
      }))
      .filter((server) => server.connections.length > 0);
  }

  async listMusicLibraries(server: PlexServer, connectionUri: string): Promise<PlexMusicLibrary[]> {
    const origin = this.#selectedConnectionOrigin(server, connectionUri);
    const identity = identitySchema.parse(await this.#requestJson(new URL("/identity", origin), server.accessToken));
    if (!identity.MediaContainer.claimed || identity.MediaContainer.machineIdentifier !== server.id) {
      throw new PlexInvalidResponseError("The selected Plex connection did not identify the expected server");
    }

    const response = librariesSchema.parse(
      await this.#requestJson(new URL("/library/sections", origin), server.accessToken)
    );
    return response.MediaContainer.Directory.filter((library) => library.type === "artist").map((library) => ({
      id: library.key,
      uuid: library.uuid,
      title: library.title
    }));
  }

  #selectedConnectionOrigin(server: PlexServer, connectionUri: string): URL {
    const selected = server.connections.find((connection) => connection.uri === connectionUri);
    if (selected === undefined) throw new Error("The selected Plex connection was not discovered for this server");
    return new URL(selected.uri);
  }

  async #requestJson(url: URL, token: string): Promise<unknown> {
    if (token.length === 0) throw new Error("Plex token is required");
    try {
      const response = await this.#fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Plex-Client-Identifier": this.#clientIdentifier,
          "X-Plex-Product": product,
          "X-Plex-Version": version,
          "X-Plex-Token": token
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs)
      });
      if (!response.ok) throw new PlexServiceUnavailableError();
      try {
        return await response.json();
      } catch {
        throw new PlexInvalidResponseError();
      }
    } catch (error) {
      if (error instanceof PlexServiceUnavailableError || error instanceof PlexInvalidResponseError) throw error;
      throw new PlexServiceUnavailableError();
    }
  }
}

function normalizeHttpsOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}
