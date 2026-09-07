import { createHash } from "node:crypto";
import { revisionSchema, transcodeProfileSchema } from "./schemas.js";

export interface ManifestTrackInput {
  id: string;
  contentFingerprint: string;
}

export interface ManifestPlaylistInput {
  id: string;
  sourceRevision: string;
  tracks: ManifestTrackInput[];
}

export interface ManifestInput {
  protocolVersion: 1;
  transcodeProfile: "compact" | "balanced" | "high";
  selectedPlaylistIds: string[];
  playlists: ManifestPlaylistInput[];
}

export function calculateManifestRevision(input: ManifestInput): string {
  transcodeProfileSchema.parse(input.transcodeProfile);
  const canonical: ManifestInput = {
    protocolVersion: 1,
    transcodeProfile: input.transcodeProfile,
    selectedPlaylistIds: [...input.selectedPlaylistIds].sort(),
    playlists: input.playlists.map((playlist) => ({
      id: playlist.id,
      sourceRevision: playlist.sourceRevision,
      tracks: playlist.tracks.map((track) => ({ id: track.id, contentFingerprint: track.contentFingerprint }))
    }))
  };
  return revisionSchema.parse(createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex"));
}

export function calculateContentFingerprint(
  sourceFingerprint: string,
  transcodeProfile: "compact" | "balanced" | "high"
): string {
  return revisionSchema.parse(
    createHash("sha256")
      .update(canonicalJson({ sourceFingerprint, transcodeProfile }), "utf8")
      .digest("hex")
  );
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
