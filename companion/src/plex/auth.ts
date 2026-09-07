import { z } from "zod";

const product = "SyncAndRun for Garmin";
const version = "1.0.0-dev.0";
const defaultPlexOrigin = new URL("https://plex.tv");
const defaultAuthOrigin = new URL("https://app.plex.tv");
const defaultTimeoutMs = 10_000;

const plexPinSchema = z.object({
  id: z.number().int().positive(),
  code: z.string().min(1).max(128),
  clientIdentifier: z.string().min(1),
  expiresIn: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime(),
  authToken: z.string().min(1).nullable()
});

const plexUserSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().min(1)]),
  username: z.string().min(1)
});

type Fetch = typeof fetch;

export interface PlexAuthClientOptions {
  clientIdentifier: string;
  plexOrigin?: URL;
  authOrigin?: URL;
  fetch?: Fetch;
  timeoutMs?: number;
}

export interface PlexPin {
  id: number;
  code: string;
  expiresAt: string;
  authUrl: string;
}

export type PlexPinStatus =
  | { status: "pending"; expiresAt: string }
  | { status: "expired"; expiresAt: string }
  | { status: "claimed"; expiresAt: string; token: string };

export type PlexTokenValidation =
  | { valid: true; user: { id: number | string; username: string } }
  | { valid: false };

export class PlexServiceUnavailableError extends Error {
  constructor(message = "Plex authentication is unavailable") {
    super(message);
    this.name = "PlexServiceUnavailableError";
  }
}

export class PlexInvalidResponseError extends Error {
  constructor(message = "Plex returned an invalid authentication response") {
    super(message);
    this.name = "PlexInvalidResponseError";
  }
}

export class PlexAuthClient {
  readonly #clientIdentifier: string;
  readonly #plexOrigin: URL;
  readonly #authOrigin: URL;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;

  constructor(options: PlexAuthClientOptions) {
    if (options.clientIdentifier.length === 0) throw new Error("Plex client identifier is required");
    this.#clientIdentifier = options.clientIdentifier;
    this.#plexOrigin = options.plexOrigin ?? defaultPlexOrigin;
    this.#authOrigin = options.authOrigin ?? defaultAuthOrigin;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  }

  async createPin(forwardUrl: URL): Promise<PlexPin> {
    if (forwardUrl.protocol !== "https:") throw new Error("Plex authentication forward URL must use HTTPS");
    const url = new URL("/api/v2/pins", this.#plexOrigin);
    url.searchParams.set("strong", "true");
    const response = await this.#request(url, { method: "POST" });
    const pin = await this.#parsePin(response);
    if (pin.clientIdentifier !== this.#clientIdentifier) throw new PlexInvalidResponseError();

    const parameters = new URLSearchParams({
      clientID: this.#clientIdentifier,
      code: pin.code,
      "context[device][product]": product,
      forwardUrl: forwardUrl.toString()
    });
    const authUrl = new URL("/auth", this.#authOrigin);
    authUrl.hash = `?${parameters.toString()}`;
    return { id: pin.id, code: pin.code, expiresAt: pin.expiresAt, authUrl: authUrl.toString() };
  }

  async getPinStatus(pinId: number, code: string, now = new Date()): Promise<PlexPinStatus> {
    if (!Number.isSafeInteger(pinId) || pinId <= 0) throw new Error("Plex PIN id must be a positive integer");
    if (code.length === 0 || code.length > 128) throw new Error("Plex PIN code is invalid");
    const url = new URL(`/api/v2/pins/${pinId}`, this.#plexOrigin);
    url.searchParams.set("code", code);
    const response = await this.#request(url);
    const pin = await this.#parsePin(response);
    if (pin.id !== pinId || pin.code !== code || pin.clientIdentifier !== this.#clientIdentifier) {
      throw new PlexInvalidResponseError();
    }
    if (Date.parse(pin.expiresAt) <= now.getTime()) return { status: "expired", expiresAt: pin.expiresAt };
    if (pin.authToken === null) return { status: "pending", expiresAt: pin.expiresAt };
    return { status: "claimed", expiresAt: pin.expiresAt, token: pin.authToken };
  }

  async validateToken(token: string): Promise<PlexTokenValidation> {
    if (token.length === 0) return { valid: false };
    const url = new URL("/api/v2/user", this.#plexOrigin);
    const response = await this.#request(url, { headers: { "X-Plex-Token": token } }, [401]);
    if (response.status === 401) return { valid: false };
    try {
      const user = plexUserSchema.parse(await response.json());
      return { valid: true, user: { id: user.id, username: user.username } };
    } catch {
      throw new PlexInvalidResponseError();
    }
  }

  async #request(url: URL, init: RequestInit = {}, allowedStatuses: number[] = []): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("X-Plex-Product", product);
    headers.set("X-Plex-Version", version);
    headers.set("X-Plex-Client-Identifier", this.#clientIdentifier);
    try {
      const response = await this.#fetch(url, {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs)
      });
      if (!response.ok && !allowedStatuses.includes(response.status)) throw new PlexServiceUnavailableError();
      return response;
    } catch (error) {
      if (error instanceof PlexServiceUnavailableError) throw error;
      throw new PlexServiceUnavailableError();
    }
  }

  async #parsePin(response: Response) {
    try {
      return plexPinSchema.parse(await response.json());
    } catch {
      throw new PlexInvalidResponseError();
    }
  }
}
