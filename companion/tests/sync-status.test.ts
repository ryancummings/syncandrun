import { describe, expect, it } from "vitest";
import type { BrowserDevice } from "../src/persistence/device-repository.js";
import type { LiveSyncSnapshot } from "../src/sync/live-sync-tracker.js";
import { estimateBytes, type SyncPlan } from "../src/sync/sync-plan.js";
import { buildSyncStatus, defaultThroughputBps, estimateTransfer } from "../src/sync/sync-status.js";

const plan: SyncPlan = {
  profile: "balanced",
  bitrateKbps: 96,
  playlistCount: 2,
  trackCount: 100,
  durationSeconds: 100 * 240,
  estimatedBytes: estimateBytes(100 * 240, 96),
  manifestRevision: "a".repeat(64)
};

function device(overrides: Partial<BrowserDevice> = {}): BrowserDevice {
  return {
    id: "watch:1",
    displayName: "Forerunner 955 Solar",
    reportedName: "Forerunner 955 Solar",
    customName: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: null,
    appliedRevision: null,
    revokedAt: null,
    lastSyncStatus: null,
    lastSyncAt: null,
    lastSyncTimings: null,
    lastSyncIsCheckpoint: false,
    measuredThroughputBps: null,
    measuredPerTrackOverheadMs: null,
    ...overrides
  };
}

function session(overrides: Partial<LiveSyncSnapshot> = {}): LiveSyncSnapshot {
  return {
    deviceId: "watch:1",
    startedAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:01:00.000Z",
    phase: "audio",
    revision: plan.manifestRevision,
    counts: null,
    errorCodes: [],
    completedTracks: 0,
    observedBytes: 0,
    transferMs: 0,
    throughputBps: null,
    currentTrack: null,
    lastTrack: null,
    finishedStatus: null,
    stalled: false,
    ...overrides
  };
}

describe("sync estimates", () => {
  it("falls back to the Forerunner default before a watch has ever synced", () => {
    const estimate = estimateTransfer(plan, device(), null);
    expect(estimate.source).toBe("default");
    expect(estimate.throughputBps).toBe(defaultThroughputBps);
    expect(estimate.remainingTracks).toBe(100);
    expect(estimate.remainingBytes).toBe(plan.estimatedBytes);
    // Transfer time plus the seeded per-track overhead.
    const transferMs = (plan.estimatedBytes * 8000) / defaultThroughputBps;
    expect(estimate.remainingMs).toBe(Math.round(transferMs + 100 * 1_500));
  });

  it("prefers this watch's measured history over the default", () => {
    const estimate = estimateTransfer(
      plan,
      device({ measuredThroughputBps: 1_000_000, measuredPerTrackOverheadMs: 400 }),
      null
    );
    expect(estimate.source).toBe("measured");
    expect(estimate.throughputBps).toBe(1_000_000);
    expect(estimate.perTrackOverheadMs).toBe(400);
  });

  it("prefers throughput measured during the running sync", () => {
    const estimate = estimateTransfer(
      plan,
      device({ measuredThroughputBps: 1_000_000 }),
      session({ throughputBps: 400_000, completedTracks: 20, observedBytes: 20 * 2_880_000 })
    );
    expect(estimate.source).toBe("session");
    expect(estimate.throughputBps).toBe(400_000);
    expect(estimate.remainingTracks).toBe(80);
  });

  it("takes the larger of served and watch-reported downloads", () => {
    const estimate = estimateTransfer(
      plan,
      device(),
      session({ completedTracks: 2, counts: { downloaded: 30, reused: 0, deleted: 0, failed: 0 } })
    );
    expect(estimate.remainingTracks).toBe(70);
  });

  it("counts reused tracks as done and sizes the in-flight remainder", () => {
    const estimate = estimateTransfer(
      plan,
      device(),
      session({
        completedTracks: 10,
        counts: { downloaded: 10, reused: 40, deleted: 0, failed: 0 },
        observedBytes: 10 * 2_000_000,
        currentTrack: {
          id: "t",
          title: "Song",
          artist: "Band",
          transferredBytes: 500_000,
          expectedBytes: 2_000_000,
          elapsedMs: 1_000
        }
      })
    );
    expect(estimate.remainingTracks).toBe(50);
    expect(estimate.remainingBytes).toBe(50 * 2_000_000 + 1_500_000);
  });

  it("reports nothing outstanding once the sync has finished", () => {
    const estimate = estimateTransfer(plan, device(), session({ finishedStatus: "applied", phase: "finished" }));
    expect(estimate.remainingMs).toBeNull();
    expect(estimate.remainingTracks).toBe(0);
  });

  it("omits revoked watches and flags the ones already on the current revision", () => {
    const status = buildSyncStatus(
      plan,
      [
        device({ id: "watch:current", appliedRevision: plan.manifestRevision }),
        device({ id: "watch:stale", appliedRevision: "b".repeat(64) }),
        device({ id: "watch:gone", revokedAt: "2026-08-10T00:00:00.000Z" })
      ],
      []
    );
    expect(status.devices.map((entry) => entry.deviceId)).toEqual(["watch:current", "watch:stale"]);
    expect(status.devices[0]!.upToDate).toBe(true);
    expect(status.devices[1]!.upToDate).toBe(false);
  });
});
