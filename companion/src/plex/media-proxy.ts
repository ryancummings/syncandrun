import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type Database from "better-sqlite3";
import type { StoredPlexConnection } from "./setup-service.js";
import { PlexSetupService } from "./setup-service.js";

const product = "SyncAndRun for Garmin";
const version = "1.0.0-dev.0";
const headerTimeoutMs = 15_000;
const audioTimeoutMs = 30 * 60 * 1000;
const artworkTimeoutMs = 60_000;
const profileExtra =
  "add-transcode-target(type=musicProfile&context=streaming&protocol=http&container=mp3&audioCodec=mp3)";

const profileBitrates = {
  compact: 64,
  balanced: 96,
  high: 128
} as const;

interface InstallationRow {
  plex_client_identifier: string;
}

interface TrackRow {
  rating_key: string;
  artwork_key: string | null;
}

interface SettingsRow {
  transcode_profile: keyof typeof profileBitrates;
}

type Fetch = typeof fetch;

export interface PlexMediaProxyOptions {
  fetch?: Fetch;
  headerTimeoutMs?: number;
  audioTimeoutMs?: number;
  artworkTimeoutMs?: number;
}

export interface PlexProxyStream {
  body: Readable;
  contentLength?: number;
}

interface PendingPlexStream {
  response: Response;
  cleanup(): void;
}

export class PlexMediaNotFoundError extends Error {}
export class PlexArtworkNotFoundError extends Error {}
export class PlexTranscodeBusyError extends Error {}
export class PlexTranscodeFailedError extends Error {}
export class PlexProxyUnavailableError extends Error {}

/**
 * Resolves only selected snapshot tracks and keeps every Plex-specific URL,
 * token, and transcode parameter behind the companion's watch API.
 */
export class PlexMediaProxy {
  readonly #database: Database.Database;
  readonly #plexSetup: PlexSetupService;
  readonly #clientIdentifier: string;
  readonly #fetch: Fetch;
  readonly #headerTimeoutMs: number;
  readonly #audioTimeoutMs: number;
  readonly #artworkTimeoutMs: number;
  readonly #activeAudioDevices = new Set<string>();

  constructor(
    database: Database.Database,
    plexSetup: PlexSetupService,
    options: PlexMediaProxyOptions = {}
  ) {
    this.#database = database;
    this.#plexSetup = plexSetup;
    this.#fetch = options.fetch ?? fetch;
    this.#headerTimeoutMs = options.headerTimeoutMs ?? headerTimeoutMs;
    this.#audioTimeoutMs = options.audioTimeoutMs ?? audioTimeoutMs;
    this.#artworkTimeoutMs = options.artworkTimeoutMs ?? artworkTimeoutMs;
    const installation = database
      .prepare("SELECT plex_client_identifier FROM installation WHERE id = 1")
      .get() as InstallationRow | undefined;
    if (installation === undefined) throw new Error("SyncAndRun installation is not initialized");
    this.#clientIdentifier = installation.plex_client_identifier;
  }

  async openAudio(trackId: string, deviceId: string, disconnected?: AbortSignal): Promise<PlexProxyStream> {
    if (this.#activeAudioDevices.has(deviceId)) throw new PlexTranscodeBusyError();
    this.#activeAudioDevices.add(deviceId);
    try {
      const track = this.#getTrack(trackId);
      const connection = this.#getConnection();
      const settings = this.#database
        .prepare("SELECT transcode_profile FROM settings WHERE id = 1")
        .get() as SettingsRow | undefined;
      if (settings === undefined) throw new Error("SyncAndRun settings are not initialized");
      const url = buildAudioTranscodeUrl(
        connection.serverBaseUri,
        track.rating_key,
        profileBitrates[settings.transcode_profile],
        randomUUID()
      );
      const pending = await this.#requestStream(url, connection, disconnected, this.#audioTimeoutMs, {
        "X-Plex-Client-Profile-Name": "Generic",
        "X-Plex-Client-Profile-Extra": profileExtra
      });
      const response = pending.response;
      if (!response.ok || response.body === null || !isContentType(response, "audio/mpeg")) {
        await response.body?.cancel();
        pending.cleanup();
        throw new PlexTranscodeFailedError();
      }
      return this.#toProxyStream(pending, () => this.#activeAudioDevices.delete(deviceId));
    } catch (error) {
      this.#activeAudioDevices.delete(deviceId);
      throw error;
    }
  }

  async openArtwork(trackId: string, disconnected?: AbortSignal): Promise<PlexProxyStream> {
    const track = this.#getTrack(trackId);
    if (track.artwork_key === null) throw new PlexArtworkNotFoundError();
    if (!/^\/library\/metadata\/[A-Za-z0-9._~-]+\/(?:thumb|art)\/[A-Za-z0-9._~-]+$/.test(track.artwork_key)) {
      throw new PlexArtworkNotFoundError();
    }
    const connection = this.#getConnection();
    const url = new URL("/photo/:/transcode", connection.serverBaseUri);
    url.searchParams.set("url", track.artwork_key);
    url.searchParams.set("format", "jpeg");
    url.searchParams.set("width", "80");
    url.searchParams.set("height", "80");
    url.searchParams.set("upscale", "0");
    const pending = await this.#requestStream(url, connection, disconnected, this.#artworkTimeoutMs);
    const response = pending.response;
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      pending.cleanup();
      if (response.status === 404) throw new PlexArtworkNotFoundError();
      throw new PlexProxyUnavailableError();
    }
    if (!isContentType(response, "image/jpeg")) {
      await response.body.cancel();
      pending.cleanup();
      throw new PlexProxyUnavailableError();
    }
    return this.#toProxyStream(pending);
  }

  #getTrack(trackId: string): TrackRow {
    const track = this.#database
      .prepare("SELECT rating_key, artwork_key FROM track_metadata WHERE track_id = ?")
      .get(trackId) as TrackRow | undefined;
    if (track === undefined || !/^[A-Za-z0-9._~-]+$/.test(track.rating_key)) {
      throw new PlexMediaNotFoundError();
    }
    return track;
  }

  #getConnection(): StoredPlexConnection {
    const connection = this.#plexSetup.getStoredConnection();
    if (connection === undefined) throw new PlexProxyUnavailableError();
    return connection;
  }

  async #requestStream(
    url: URL,
    connection: StoredPlexConnection,
    disconnected: AbortSignal | undefined,
    streamTimeoutMs: number,
    extraHeaders: Record<string, string> = {}
  ): Promise<PendingPlexStream> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (disconnected?.aborted) controller.abort();
    else disconnected?.addEventListener("abort", abort, { once: true });
    const headerTimer = setTimeout(abort, this.#headerTimeoutMs);
    try {
      const response = await this.#fetch(url, {
        headers: {
          Accept: "*/*",
          "X-Plex-Client-Identifier": this.#clientIdentifier,
          "X-Plex-Product": product,
          "X-Plex-Version": version,
          "X-Plex-Token": connection.serverToken,
          ...extraHeaders
        },
        redirect: "error",
        signal: controller.signal
      });
      clearTimeout(headerTimer);
      const streamTimer = setTimeout(abort, streamTimeoutMs);
      let cleaned = false;
      return {
        response,
        cleanup() {
          if (cleaned) return;
          cleaned = true;
          clearTimeout(streamTimer);
          disconnected?.removeEventListener("abort", abort);
        }
      };
    } catch (error) {
      clearTimeout(headerTimer);
      disconnected?.removeEventListener("abort", abort);
      if (error instanceof PlexTranscodeFailedError || error instanceof PlexProxyUnavailableError) throw error;
      throw new PlexProxyUnavailableError();
    }
  }

  #toProxyStream(pending: PendingPlexStream, cleanup?: () => void): PlexProxyStream {
    const response = pending.response;
    if (response.body === null) throw new PlexProxyUnavailableError();
    const body = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
    let cleaned = false;
    const once = () => {
      if (cleaned) return;
      cleaned = true;
      pending.cleanup();
      cleanup?.();
    };
    body.once("close", once);
    body.once("end", once);
    body.once("error", once);
    const rawLength = response.headers.get("content-length");
    const contentLength = rawLength === null ? undefined : Number(rawLength);
    return contentLength !== undefined && Number.isSafeInteger(contentLength) && contentLength >= 0
      ? { body, contentLength }
      : { body };
  }
}

export function buildAudioTranscodeUrl(
  serverBaseUri: string,
  ratingKey: string,
  bitrate: 64 | 96 | 128,
  sessionId: string
): URL {
  const url = new URL("/music/:/transcode/universal/start.mp3", serverBaseUri);
  const parameters = {
    path: `/library/metadata/${ratingKey}`,
    protocol: "http",
    mediaIndex: "0",
    partIndex: "0",
    directPlay: "0",
    directStream: "0",
    directStreamAudio: "0",
    audioChannelCount: "2",
    musicBitrate: String(bitrate),
    transcodeSessionId: sessionId
  } as const;
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return url;
}

function isContentType(response: Response, expected: string): boolean {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === expected;
}
