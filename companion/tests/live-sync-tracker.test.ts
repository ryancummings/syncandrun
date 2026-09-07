import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { LiveSyncTracker, type TrackDescription } from "../src/sync/live-sync-tracker.js";
import type { SyncResultRequest } from "../src/protocol/schemas.js";

const timings = {
  totalMs: 12_000,
  metadataMs: 1_000,
  audioTotalMs: 10_000,
  audioStartupMs: 900,
  audioTransferMs: 8_600,
  audioFinalizeMs: 500,
  artworkMs: 1_000,
  audioBytes: 3_000_000,
  audioProgressCallbacks: 42,
  audioCount: 3,
  artworkCount: 1
} as const;

function result(overrides: Partial<SyncResultRequest> = {}): SyncResultRequest {
  return {
    protocolVersion: 1,
    revision: "a".repeat(64),
    status: "applied",
    counts: { downloaded: 3, reused: 1, deleted: 0, failed: 0 },
    errorCodes: [],
    timings,
    ...overrides
  } as SyncResultRequest;
}

function createTracker() {
  let now = 1_000;
  const tracker = new LiveSyncTracker({ now: () => now });
  return { tracker, advance: (ms: number) => { now += ms; }, at: () => now };
}

function audio(tracker: LiveSyncTracker, track: TrackDescription) {
  const source = new PassThrough();
  const observed = tracker.observeAudio("watch:1", track, source);
  observed.resume();
  return { source, observed, done: finished(observed, { cleanup: true }) };
}

describe("live sync tracker", () => {
  it("ignores configuration polls but opens a session on a manifest traversal", () => {
    const { tracker } = createTracker();
    tracker.noteMetadata("watch:1", false);
    expect(tracker.snapshots()).toHaveLength(0);

    tracker.noteMetadata("watch:1");
    expect(tracker.snapshots()).toMatchObject([{ deviceId: "watch:1", phase: "metadata" }]);
  });

  it("measures throughput from proxied bytes rather than watch reports", async () => {
    const { tracker, advance } = createTracker();
    tracker.noteMetadata("watch:1");
    const transfer = audio(tracker, { id: "t1", title: "Song", artist: "Band", expectedBytes: 1_000_000 });
    advance(1_000);
    transfer.source.write(Buffer.alloc(250_000));
    const midway = tracker.snapshots()[0]!;
    expect(midway.phase).toBe("audio");
    expect(midway.currentTrack).toMatchObject({ title: "Song", transferredBytes: 250_000 });

    advance(1_000);
    transfer.source.write(Buffer.alloc(250_000));
    transfer.source.end();
    await transfer.done;
    const snapshot = tracker.snapshots()[0]!;
    expect(snapshot.completedTracks).toBe(1);
    expect(snapshot.observedBytes).toBe(500_000);
    // 500 kB over 2 s is 2 Mbps.
    expect(snapshot.throughputBps).toBe(2_000_000);
  });

  it("keeps the last track name while the watch finalizes between transfers", async () => {
    const { tracker, advance } = createTracker();
    tracker.noteMetadata("watch:1");
    const transfer = audio(tracker, { id: "t1", title: "Song", artist: "Band", expectedBytes: null });
    advance(500);
    transfer.source.write(Buffer.alloc(1_000));
    transfer.source.end();
    await transfer.done;

    const between = tracker.snapshots()[0]!;
    expect(between.currentTrack).toBeNull();
    expect(between.lastTrack).toMatchObject({ title: "Song", artist: "Band" });

    const next = audio(tracker, { id: "t2", title: "Next", artist: "Band", expectedBytes: null });
    expect(tracker.snapshots()[0]!.lastTrack).toMatchObject({ title: "Next" });

    // It survives the end of the sync, so the finished card still names the work.
    tracker.noteSyncResult("watch:1", result({ status: "applied" }));
    expect(tracker.snapshots()[0]!.lastTrack).toMatchObject({ title: "Next" });
    next.source.end();
    await next.done;
  });

  it("treats an interim checkpoint as progress and a real result as the end of the sync", async () => {
    const { tracker, advance } = createTracker();
    tracker.noteMetadata("watch:1");
    const transfer = audio(tracker, { id: "t1", title: "Song", artist: "Band", expectedBytes: null });
    advance(500);
    transfer.source.write(Buffer.alloc(100_000));
    transfer.source.end();
    await transfer.done;

    const checkpoint = tracker.noteSyncResult("watch:1", result({ status: "partial" }));
    expect(checkpoint).toBeNull();
    expect(tracker.snapshots()[0]!.finishedStatus).toBeNull();

    const completed = tracker.noteSyncResult("watch:1", result({ status: "applied" }));
    expect(completed).toMatchObject({ deviceId: "watch:1", status: "applied", observedBytes: 100_000 });
    expect(completed!.transferMs).toBeGreaterThan(0);
    expect(tracker.snapshots()[0]).toMatchObject({ phase: "finished", finishedStatus: "applied" });
  });

  it("records a genuine partial outcome, which carries failures", () => {
    const { tracker } = createTracker();
    tracker.noteMetadata("watch:1");
    const record = tracker.noteSyncResult(
      "watch:1",
      result({ status: "partial", counts: { downloaded: 1, reused: 0, deleted: 0, failed: 2 }, errorCodes: ["STORAGE_INSUFFICIENT"] })
    );
    expect(record).toMatchObject({ status: "partial", failed: 2, errorCodes: ["STORAGE_INSUFFICIENT"] });
  });

  it("reopens a session when a checkpointed watch keeps transferring", async () => {
    const { tracker } = createTracker();
    tracker.noteMetadata("watch:1");
    tracker.noteSyncResult("watch:1", result({ status: "partial" }));
    const next = audio(tracker, { id: "t2", title: "Next", artist: "Band", expectedBytes: null });
    expect(tracker.snapshots()[0]).toMatchObject({ phase: "audio", finishedStatus: null });
    next.source.end();
    await next.done;
  });

  it("marks a silent sync as stalled and eventually forgets it", () => {
    const { tracker, advance } = createTracker();
    tracker.noteMetadata("watch:1");
    advance(60_000);
    expect(tracker.snapshots()[0]!.stalled).toBe(true);
    advance(16 * 60 * 1000);
    expect(tracker.snapshots()).toHaveLength(0);
  });

  it("attributes artwork only when a single sync is running", () => {
    const { tracker } = createTracker();
    tracker.noteMetadata("watch:1");
    tracker.noteMetadata("watch:2");
    tracker.noteArtworkActivity();
    expect(tracker.snapshots().every((snapshot) => snapshot.phase === "metadata")).toBe(true);

    tracker.noteSyncResult("watch:2", result());
    tracker.noteArtworkActivity();
    expect(tracker.snapshots().find((snapshot) => snapshot.deviceId === "watch:1")!.phase).toBe("artwork");
  });

  it("publishes to subscribers and clears on revocation", () => {
    const { tracker } = createTracker();
    const frames: number[] = [];
    const unsubscribe = tracker.subscribe((snapshots) => frames.push(snapshots.length));
    tracker.noteMetadata("watch:1");
    tracker.clear("watch:1");
    unsubscribe();
    tracker.noteMetadata("watch:2");
    expect(frames).toEqual([1, 0]);
  });
});

const track = { id: "t1", title: "Song", artist: "Band", expectedBytes: null };

describe("audio stream observation", () => {
  it("passes bytes through and counts normal end plus close exactly once", async () => {
    const { tracker } = createTracker();
    const source = new PassThrough();
    const observed = tracker.observeAudio("watch:1", track, source);
    const received: Buffer[] = [];
    observed.on("data", (chunk: Buffer) => received.push(chunk));
    const done = finished(observed, { cleanup: true });
    source.end(Buffer.from("audio"));
    await done;
    expect(Buffer.concat(received).toString()).toBe("audio");
    expect(tracker.snapshots()[0]).toMatchObject({ observedBytes: 5, completedTracks: 1, currentTrack: null });
    expect(source.listenerCount("error")).toBe(0);
    expect(source.listenerCount("close")).toBe(0);
  });

  it("propagates source failures without marking the transfer completed", async () => {
    const { tracker } = createTracker();
    const transfer = audio(tracker, track);
    const failure = new Error("Plex connection lost");
    const rejected = expect(transfer.done).rejects.toBe(failure);
    transfer.source.write(Buffer.alloc(3));
    transfer.source.destroy(failure);
    await rejected;
    expect(tracker.snapshots()[0]).toMatchObject({ observedBytes: 3, completedTracks: 0, currentTrack: null });
  });

  it("terminates observation when the source closes prematurely", async () => {
    const { tracker } = createTracker();
    const transfer = audio(tracker, track);
    const rejected = expect(transfer.done).rejects.toThrow("Audio source closed before completion");
    transfer.source.destroy();
    await rejected;
    expect(tracker.snapshots()[0]).toMatchObject({ completedTracks: 0, currentTrack: null });
  });

  it("cancels the source when the consumer destroys the observed stream", async () => {
    const { tracker } = createTracker();
    const transfer = audio(tracker, track);
    const rejected = expect(transfer.done).rejects.toThrow();
    transfer.observed.destroy();
    await rejected;
    expect(transfer.source.destroyed).toBe(true);
    expect(tracker.snapshots()[0]).toMatchObject({ completedTracks: 0, currentTrack: null });
  });

  it.each([false, true])("ignores old stream events after a replacement (new session: %s)", async (replaceSession) => {
    const { tracker } = createTracker();
    const old = audio(tracker, track);
    if (replaceSession) tracker.clear("watch:1");
    const next = audio(tracker, { ...track, id: "t2" });
    old.source.end(Buffer.alloc(100));
    await old.done;
    expect(tracker.snapshots()[0]).toMatchObject({ observedBytes: 0, completedTracks: 0, currentTrack: { id: "t2" } });
    next.source.end(Buffer.alloc(3));
    await next.done;
    expect(tracker.snapshots()[0]).toMatchObject({ observedBytes: 3, completedTracks: 1 });
  });

  it("keeps a final sync report authoritative when an older stream finishes", async () => {
    const { tracker } = createTracker();
    const transfer = audio(tracker, track);
    tracker.noteSyncResult("watch:1", result());
    transfer.source.end(Buffer.alloc(100));
    await transfer.done;
    expect(tracker.snapshots()[0]).toMatchObject({
      phase: "finished", finishedStatus: "applied", observedBytes: 0, completedTracks: 0, currentTrack: null
    });
  });

  it("preserves backpressure when the consumer has not started reading", async () => {
    const { tracker } = createTracker();
    const source = new PassThrough({ highWaterMark: 1 });
    const observed = tracker.observeAudio("watch:1", track, source);
    source.write(Buffer.alloc(1024 * 1024));
    expect(source.write(Buffer.alloc(1024 * 1024))).toBe(false);
    expect(tracker.snapshots()[0]!.observedBytes).toBe(1024 * 1024);
    const done = finished(observed, { cleanup: true });
    observed.resume();
    source.end();
    await done;
    expect(tracker.snapshots()[0]!.observedBytes).toBe(2 * 1024 * 1024);
  });
});
