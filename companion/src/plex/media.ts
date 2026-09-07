import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../protocol/manifest.js";
import type { StoredPlexConnection } from "./setup-service.js";
import { PlexInvalidResponseError, PlexServiceUnavailableError } from "./auth.js";

const pageSize = 100;
export const maximumPlaylistTracks = 10_000;
const product = "SyncAndRun for Garmin";
const version = "1.0.0-dev.0";

const playlistSchema = z.object({
  ratingKey: z.string().min(1).max(64),
  key: z.string().min(1).max(180),
  title: z.string().min(1),
  playlistType: z.string(),
  duration: z.number().int().nonnegative().default(0),
  leafCount: z.number().int().nonnegative().default(0),
  updatedAt: z.number().int().nonnegative().default(0)
});

const partSchema = z.object({
  id: z.number().int().positive(),
  key: z.string().min(1),
  size: z.number().int().nonnegative().optional(),
  duration: z.number().int().nonnegative().optional(),
  container: z.string().optional()
});

const mediaSchema = z.object({
  id: z.number().int().positive(),
  Part: z.array(partSchema).min(1)
});

const trackSchema = z.object({
  ratingKey: z.string().min(1).max(64),
  type: z.string(),
  title: z.string().default(""),
  grandparentTitle: z.string().default(""),
  parentTitle: z.string().default(""),
  duration: z.number().int().nonnegative().default(0),
  updatedAt: z.number().int().nonnegative().default(0),
  librarySectionID: z.union([z.number().int(), z.string()]),
  thumb: z.string().optional(),
  Media: z.array(mediaSchema).min(1)
});

const pageSchema = z.object({
  MediaContainer: z.object({
    offset: z.number().int().nonnegative().default(0),
    size: z.number().int().nonnegative(),
    totalSize: z.number().int().nonnegative(),
    Metadata: z.array(z.unknown()).default([])
  })
});

type Fetch = typeof fetch;

export interface PlexMediaClientOptions {
  clientIdentifier: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

export interface PlexAudioPlaylist {
  id: string;
  ratingKey: string;
  key: string;
  title: string;
  trackCount: number;
  durationSeconds: number;
  sourceUpdatedAt: number;
  selectable: boolean;
  unavailableReason: string | null;
}

export interface PlexNormalizedTrack {
  id: string;
  ratingKey: string;
  sourceFingerprint: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  artworkKey: string | null;
}

export class PlexPlaylistTooLargeError extends Error {
  constructor() {
    super(`Plex playlists may contain at most ${maximumPlaylistTracks.toLocaleString("en-US")} tracks`);
    this.name = "PlexPlaylistTooLargeError";
  }
}

export class PlexMediaClient {
  readonly #clientIdentifier: string;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;

  constructor(options: PlexMediaClientOptions) {
    this.#clientIdentifier = options.clientIdentifier;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async listAudioPlaylists(connection: StoredPlexConnection): Promise<PlexAudioPlaylist[]> {
    const url = new URL("/playlists", connection.serverBaseUri);
    url.searchParams.set("playlistType", "audio");
    const items = await this.#paginate(url, connection.serverToken);
    return items.flatMap((item) => {
      const result = playlistSchema.safeParse(item);
      if (!result.success || result.data.playlistType !== "audio") return [];
      const playlist = result.data;
      return [
        {
          id: `plex:playlist:${playlist.ratingKey}`,
          ratingKey: playlist.ratingKey,
          key: playlist.key,
          title: playlist.title,
          trackCount: playlist.leafCount,
          durationSeconds: Math.round(playlist.duration / 1000),
          sourceUpdatedAt: playlist.updatedAt,
          selectable: playlist.leafCount <= maximumPlaylistTracks,
          unavailableReason:
            playlist.leafCount <= maximumPlaylistTracks
              ? null
              : `This playlist exceeds the ${maximumPlaylistTracks.toLocaleString("en-US")}-track safety limit and cannot be added.`
        }
      ];
    });
  }

  async listPlaylistTracks(connection: StoredPlexConnection, playlist: PlexAudioPlaylist): Promise<PlexNormalizedTrack[]> {
    if (!/^\/playlists\/[A-Za-z0-9._~-]+\/items$/.test(playlist.key)) {
      throw new PlexInvalidResponseError("Plex returned an invalid playlist key");
    }
    const items = await this.#paginate(
      new URL(playlist.key, connection.serverBaseUri),
      connection.serverToken,
      true
    );
    return items.flatMap((item) => {
      const result = trackSchema.safeParse(item);
      if (!result.success || result.data.type !== "track") return [];
      if (String(result.data.librarySectionID) !== connection.librarySectionId) return [];
      const track = result.data;
      const sourceFingerprint = createHash("sha256")
        .update(
          canonicalJson({
            ratingKey: track.ratingKey,
            updatedAt: track.updatedAt,
            media: track.Media.map((media) => ({
              id: media.id,
              parts: media.Part.map((part) => ({
                id: part.id,
                key: part.key,
                size: part.size ?? null,
                duration: part.duration ?? null,
                container: part.container ?? null
              }))
            }))
          }),
          "utf8"
        )
        .digest("hex");
      return [
        {
          id: `plex:track:${track.ratingKey}`,
          ratingKey: track.ratingKey,
          sourceFingerprint,
          title: track.title,
          artist: track.grandparentTitle,
          album: track.parentTitle,
          durationSeconds: Math.round(track.duration / 1000),
          artworkKey: track.thumb ?? null
        }
      ];
    });
  }

  async #paginate(url: URL, token: string, isPlaylistTrackCollection = false): Promise<unknown[]> {
    const items: unknown[] = [];
    let offset = 0;
    while (true) {
      const response = pageSchema.parse(await this.#requestJson(url, token, offset));
      const page = response.MediaContainer;
      if (page.offset !== offset || page.size !== page.Metadata.length) throw new PlexInvalidResponseError();
      items.push(...page.Metadata);
      if (items.length > maximumPlaylistTracks) {
        if (isPlaylistTrackCollection) throw new PlexPlaylistTooLargeError();
        throw new PlexInvalidResponseError("Plex collection exceeds the v1 limit");
      }
      if (items.length >= page.totalSize) return items;
      if (page.Metadata.length === 0) throw new PlexInvalidResponseError();
      offset += page.Metadata.length;
    }
  }

  async #requestJson(url: URL, token: string, offset: number): Promise<unknown> {
    try {
      const response = await this.#fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Plex-Client-Identifier": this.#clientIdentifier,
          "X-Plex-Product": product,
          "X-Plex-Version": version,
          "X-Plex-Token": token,
          "X-Plex-Container-Start": String(offset),
          "X-Plex-Container-Size": String(pageSize)
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs)
      });
      if (!response.ok) throw new PlexServiceUnavailableError();
      return await response.json();
    } catch (error) {
      if (error instanceof PlexServiceUnavailableError || error instanceof PlexInvalidResponseError) throw error;
      throw new PlexServiceUnavailableError();
    }
  }
}
