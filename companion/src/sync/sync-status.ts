import type { BrowserDevice } from "../persistence/device-repository.js";
import type { LiveSyncSnapshot } from "./live-sync-tracker.js";
import type { SyncPlan } from "./sync-plan.js";

/**
 * Seed values used until a watch has synced once. The Forerunner 955 sustains
 * roughly 500 kbps over Wi-Fi in practice, and each track carries a fixed cost
 * for request startup plus Garmin's encrypted-cache finalization. Both are
 * replaced by per-device measurements after the first completed sync.
 */
export const defaultThroughputBps = 500_000;
export const defaultPerTrackOverheadMs = 1_500;

export type EstimateSource = "measured" | "session" | "default";

export interface TransferEstimate {
  /** Bits per second the estimate is based on. */
  throughputBps: number;
  perTrackOverheadMs: number;
  source: EstimateSource;
  remainingTracks: number;
  remainingBytes: number;
  /** Null when nothing is left to transfer. */
  remainingMs: number | null;
}

export interface DeviceSyncStatus {
  deviceId: string;
  live: LiveSyncSnapshot | null;
  /** Estimate for the work still outstanding, live or hypothetical. */
  estimate: TransferEstimate;
  /** True when this watch already reports the current manifest revision. */
  upToDate: boolean;
}

export interface SyncStatus {
  plan: SyncPlan;
  devices: DeviceSyncStatus[];
  generatedAt: string;
}

export function buildSyncStatus(
  plan: SyncPlan,
  devices: BrowserDevice[],
  live: LiveSyncSnapshot[],
  now = new Date()
): SyncStatus {
  const liveByDevice = new Map(live.map((session) => [session.deviceId, session]));
  return {
    plan,
    generatedAt: now.toISOString(),
    devices: devices
      .filter((device) => device.revokedAt === null)
      .map((device) => {
        const session = liveByDevice.get(device.id) ?? null;
        return {
          deviceId: device.id,
          live: session,
          estimate: estimateTransfer(plan, device, session),
          upToDate: device.appliedRevision !== null && device.appliedRevision === plan.manifestRevision
        };
      })
  };
}

export function estimateTransfer(
  plan: SyncPlan,
  device: Pick<BrowserDevice, "measuredThroughputBps" | "measuredPerTrackOverheadMs" | "appliedRevision">,
  session: LiveSyncSnapshot | null
): TransferEstimate {
  const { throughputBps, source } = resolveThroughput(device, session);
  const perTrackOverheadMs = device.measuredPerTrackOverheadMs ?? defaultPerTrackOverheadMs;

  // The companion counts what it served; the watch also reports what it
  // downloaded and reused. Take the larger download figure so a companion
  // restart mid-sync, or tracks already cached on the watch, do not inflate
  // the work that is left.
  const alreadyTransferred =
    session === null
      ? 0
      : Math.max(session.completedTracks, session.counts?.downloaded ?? 0) + (session.counts?.reused ?? 0);
  const remainingTracks =
    session !== null && session.finishedStatus !== null
      ? 0
      : Math.max(plan.trackCount - alreadyTransferred, 0);

  const averageBytesPerTrack =
    session !== null && session.completedTracks > 0 && session.observedBytes > 0
      ? session.observedBytes / session.completedTracks
      : plan.trackCount > 0
        ? plan.estimatedBytes / plan.trackCount
        : 0;
  const inFlightRemaining =
    session?.currentTrack == null
      ? 0
      : Math.max((session.currentTrack.expectedBytes ?? averageBytesPerTrack) - session.currentTrack.transferredBytes, 0);
  const remainingBytes = Math.round(remainingTracks * averageBytesPerTrack + inFlightRemaining);

  if (remainingTracks === 0 && inFlightRemaining === 0) {
    return { throughputBps, perTrackOverheadMs, source, remainingTracks: 0, remainingBytes: 0, remainingMs: null };
  }
  const transferMs = (remainingBytes * 8000) / throughputBps;
  return {
    throughputBps,
    perTrackOverheadMs,
    source,
    remainingTracks,
    remainingBytes,
    remainingMs: Math.round(transferMs + remainingTracks * perTrackOverheadMs)
  };
}

/** Live measurement beats history, history beats the seeded default. */
function resolveThroughput(
  device: Pick<BrowserDevice, "measuredThroughputBps">,
  session: LiveSyncSnapshot | null
): { throughputBps: number; source: EstimateSource } {
  if (session?.throughputBps != null && session.throughputBps > 0) {
    return { throughputBps: session.throughputBps, source: "session" };
  }
  if (device.measuredThroughputBps !== null && device.measuredThroughputBps > 0) {
    return { throughputBps: device.measuredThroughputBps, source: "measured" };
  }
  return { throughputBps: defaultThroughputBps, source: "default" };
}
