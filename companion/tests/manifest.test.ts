import { describe, expect, it } from "vitest";
import {
  calculateContentFingerprint,
  calculateManifestRevision,
  canonicalJson
} from "../src/protocol/manifest.js";
import { emptyManifestRevision } from "../src/persistence/migrations/002_initialize_manifest_revision.js";

describe("manifest revision", () => {
  it("matches the migrated empty desired state", () => {
    expect(
      calculateManifestRevision({
        protocolVersion: 1,
        transcodeProfile: "balanced",
        selectedPlaylistIds: [],
        playlists: []
      })
    ).toBe(emptyManifestRevision);
  });

  it("sorts selected ids but preserves playlist and track order", () => {
    const trackA = { id: "plex:track:1", contentFingerprint: "a".repeat(64) };
    const trackB = { id: "plex:track:2", contentFingerprint: "b".repeat(64) };
    const base = {
      protocolVersion: 1 as const,
      transcodeProfile: "balanced" as const,
      selectedPlaylistIds: ["plex:playlist:2", "plex:playlist:1"],
      playlists: [
        {
          id: "plex:playlist:1",
          sourceRevision: "c".repeat(64),
          tracks: [trackA, trackB]
        }
      ]
    };
    expect(calculateManifestRevision(base)).toBe(
      calculateManifestRevision({ ...base, selectedPlaylistIds: [...base.selectedPlaylistIds].reverse() })
    );
    expect(calculateManifestRevision(base)).not.toBe(
      calculateManifestRevision({
        ...base,
        playlists: [{ ...base.playlists[0]!, tracks: [trackB, trackA] }]
      })
    );
  });

  it("changes a content fingerprint when the profile changes", () => {
    expect(calculateContentFingerprint("source", "compact")).not.toBe(
      calculateContentFingerprint("source", "balanced")
    );
  });

  it("sorts object keys recursively without reordering arrays", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: [3, 1] } })).toBe('{"a":{"b":[3,1],"y":2},"z":1}');
  });
});
