import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  errorMessage,
  type Device,
  type DeviceSyncStatus,
  type LiveSyncSnapshot,
  type SyncHistoryEntry,
  type SyncPlan,
  type SyncStatus
} from "../api";
import {
  formatBitrate,
  formatBytes,
  formatDate,
  formatElapsed,
  formatRelative,
  formatRemaining,
  formatRevision
} from "../format";
import { ConfirmAction, Notice, Progress, Readout, SectionLabel, StatusDot, WatchIcon } from "./primitives";
import { useTicker, type StreamState } from "../useSyncStatus";

const phaseLabels: Record<LiveSyncSnapshot["phase"], string> = {
  metadata: "Reading manifest",
  audio: "Transferring audio",
  artwork: "Transferring artwork",
  reporting: "Between tracks",
  finished: "Finished"
};

function formatOptionalElapsed(milliseconds: number | undefined): string {
  return milliseconds === undefined ? "—" : formatElapsed(milliseconds);
}

export function Devices({
  csrf,
  status,
  receivedAt,
  stream,
  refreshStatus,
  announce
}: {
  csrf: string;
  status: SyncStatus | null;
  receivedAt: number;
  stream: StreamState;
  refreshStatus: () => void;
  announce: (message: string) => void;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices((await api<{ devices: Device[] }>("/api/v1/devices")).devices);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause, "Paired watches could not be loaded."));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Pairing and playlist edits happen outside the tracker's view.
  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  // A finished sync changes applied revisions and last-seen times.
  const finishedSignature = status?.devices
    .map((entry) => `${entry.deviceId}:${entry.live?.finishedStatus ?? ""}`)
    .join("|");
  useEffect(() => { void load(); }, [finishedSignature, load]);

  const statusByDevice = useMemo(
    () => new Map((status?.devices ?? []).map((entry) => [entry.deviceId, entry])),
    [status]
  );
  const active = devices.filter((device) => device.revokedAt === null);
  const removed = devices.filter((device) => device.revokedAt !== null);
  const liveCount = (status?.devices ?? []).filter(
    (entry) => entry.live !== null && entry.live.finishedStatus === null
  ).length;

  async function createCode() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ code: string; expiresAt: string }>("/api/v1/devices/pairing-code", {
        method: "POST",
        csrf
      });
      setPairing(result);
      refreshStatus();
      announce(`New pairing code created: ${result.code.split("").join(" ")}`);
    } catch (cause) {
      setError(errorMessage(cause, "Pairing code creation failed."));
    } finally {
      setBusy(false);
    }
  }

  async function mutate(action: () => Promise<unknown>, success: string, failure: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      announce(success);
      await load();
      refreshStatus();
    } catch (cause) {
      setError(errorMessage(cause, failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="panel">
        <div className="label-row">
          <SectionLabel>Live transfer</SectionLabel>
          <span className="tag">
            <StatusDot tone={stream === "live" ? "live" : stream === "polling" ? "warn" : "idle"} />
            {stream === "live" ? "Streaming" : stream === "polling" ? "Polling" : "Connecting"}
          </span>
        </div>
        <div className="panel-head">
          <div>
            <h1 className="display display-lg">Sync status</h1>
            <p className="meta">
              Measured by the companion as it serves the watch — no watch-side reporting delay.
            </p>
          </div>
        </div>

        {status !== null && <PlanSummary plan={status.plan} liveCount={liveCount} />}

        {active.length === 0 && <p className="empty">Pair a watch to see sync activity here.</p>}
        {active.map((device) => {
          const entry = statusByDevice.get(device.id);
          return entry === undefined ? null : (
            <LiveCard
              key={device.id}
              device={device}
              entry={entry}
              plan={status?.plan ?? null}
              receivedAt={receivedAt}
            />
          );
        })}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <SectionLabel>Garmin connection</SectionLabel>
            <h2 className="display display-lg">Paired watches</h2>
            <p className="meta">Create a six-character code, then enter it in SyncAndRun on your watch.</p>
          </div>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void createCode()}>
            Create pairing code
          </button>
        </div>

        {error !== null && <Notice tone="error">{error}</Notice>}

        {pairing !== null && (
          <div className="panel crt" style={{ marginBottom: "1.25rem" }} aria-live="polite">
            <p className="readout-label">Pairing code</p>
            <strong className="pairing-code phosphor">{pairing.code}</strong>
            <p className="meta mono">Expires {formatDate(pairing.expiresAt)}</p>
          </div>
        )}

        {active.length === 0 && <p className="empty">No watches are paired yet.</p>}
        {active.length > 0 && (
          <div className="worklist">
            {active.map((device, index) => (
              <DeviceRow
                key={device.id}
                index={index}
                device={device}
                entry={statusByDevice.get(device.id)}
                busy={busy}
                onRename={(name) =>
                  mutate(
                    () =>
                      api(`/api/v1/devices/${encodeURIComponent(device.id)}`, {
                        method: "PATCH",
                        csrf,
                        body: { displayName: name }
                      }),
                    name === null ? "Watch name reset." : `Watch renamed to ${name}.`,
                    "The watch could not be renamed."
                  )
                }
                onRevoke={() =>
                  mutate(
                    () => api(`/api/v1/devices/${encodeURIComponent(device.id)}`, { method: "DELETE", csrf }),
                    "Watch removed.",
                    "The watch could not be removed."
                  )
                }
              />
            ))}
          </div>
        )}

        {removed.length > 0 && (
          <>
            <div className="divider" />
            <SectionLabel>Removed watches</SectionLabel>
            <div className="worklist">
              {removed.map((device, index) => (
                <DeviceRow
                  key={device.id}
                  index={index}
                  device={device}
                  entry={undefined}
                  busy={busy}
                  onForget={() =>
                    mutate(
                      () =>
                        api(`/api/v1/devices/${encodeURIComponent(device.id)}/forget`, { method: "POST", csrf }),
                      "Watch record deleted.",
                      "The watch record could not be deleted."
                    )
                  }
                />
              ))}
            </div>
          </>
        )}
      </section>
    </>
  );
}

function PlanSummary({ plan, liveCount }: { plan: SyncPlan; liveCount: number }) {
  return (
    <div className="readout-grid" style={{ marginBottom: "1.25rem" }}>
      <Readout label="Syncing now" value={String(liveCount)} note={liveCount === 1 ? "watch" : "watches"} />
      <Readout label="Manifest" value={formatRevision(plan.manifestRevision)} note={`${plan.playlistCount} playlists`} />
      <Readout label="Library" value={plan.trackCount.toLocaleString()} note="distinct tracks" />
      <Readout label="Payload" value={formatBytes(plan.estimatedBytes)} note={`${plan.bitrateKbps} kbps`} />
    </div>
  );
}

/**
 * One card shape for every device state. The idle, transferring, and finished
 * states differ only in the values they show: each row and readout is always
 * present so the card never resizes as state changes, and single-line rows
 * truncate rather than wrap for the same reason.
 */
function LiveCard({
  device,
  entry,
  plan,
  receivedAt
}: {
  device: Device;
  entry: DeviceSyncStatus;
  plan: SyncPlan | null;
  receivedAt: number;
}) {
  const live = entry.live;
  const finished = live !== null && live.finishedStatus !== null;
  const running = live !== null && !finished && !live.stalled;
  const now = useTicker(running);
  // The server sends a snapshot; between frames the countdown is interpolated
  // locally so the readout moves every second instead of every event.
  const elapsedSinceFrame = running ? Math.max(now - receivedAt, 0) : 0;
  const remainingMs =
    entry.estimate.remainingMs === null ? null : Math.max(entry.estimate.remainingMs - elapsedSinceFrame, 0);

  const transferredTracks =
    live === null
      ? 0
      : Math.max(live.completedTracks, live.counts?.downloaded ?? 0) + (live.counts?.reused ?? 0);
  const totalTracks = plan?.trackCount ?? 0;
  const overallRatio = finished ? 1 : totalTracks > 0 ? transferredTracks / totalTracks : 0;

  // The in-flight track keeps its own progress; between transfers the name
  // persists and the bar holds at full rather than emptying.
  const current = live?.currentTrack ?? null;
  const track = current ?? live?.lastTrack ?? null;
  const trackRatio =
    current === null
      ? track === null
        ? 0
        : 1
      : current.expectedBytes === null || current.expectedBytes <= 0
        ? null
        : Math.min(current.transferredBytes / current.expectedBytes, 1);

  const statusText =
    live === null
      ? entry.upToDate
        ? "Up to date with the current manifest"
        : "Waiting for the next sync"
      : finished
        ? `Sync ${live.finishedStatus}`
        : live.stalled
          ? "No activity — watch may have stopped"
          : phaseLabels[live.phase];
  const sinceText =
    live === null ? `seen ${formatRelative(device.lastSeenAt)}` : `started ${formatRelative(live.startedAt, now)}`;
  const chip =
    live === null
      ? entry.upToDate
        ? { label: "In sync", className: "tag tag-normal" }
        : { label: "Pending", className: "tag" }
      : finished
        ? { label: "Complete", className: "tag" }
        : { label: "Live", className: "tag tag-accent" };

  return (
    <div className={live === null ? "device-card panel" : "device-card panel crt"} aria-live="polite">
      <div className="device-card-head">
        <p className="display display-sm device-card-name">{device.displayName}</p>
        <span className={chip.className}>{chip.label}</span>
      </div>

      <p className="meta mono status-line device-card-status">
        <StatusDot
          tone={live === null ? (entry.upToDate ? "live" : "idle") : finished ? "idle" : live.stalled ? "warn" : "active"}
        />
        <span className="truncate">
          {statusText} · {sinceText}
        </span>
      </p>

      <div className="device-card-track">
        <p className="truncate">
          {track === null ? (
            <span className="device-card-placeholder">No track transferred yet</span>
          ) : (
            <>
              <strong>{track.title}</strong>
              <span className="device-card-artist"> — {track.artist}</span>
            </>
          )}
        </p>
        <span className="device-card-track-figure mono">
          {current === null
            ? track === null
              ? "—"
              : "done"
            : current.expectedBytes === null
              ? formatBytes(current.transferredBytes)
              : `${Math.round((trackRatio ?? 0) * 100)}%`}
        </span>
      </div>
      <Progress ratio={trackRatio} label={`Current track progress for ${device.displayName}`} subtle />

      <div className="device-card-overall">
        <Progress ratio={overallRatio} label={`Sync progress for ${device.displayName}`} />
        <div className="progress-caption">
          <span className="truncate">
            {transferredTracks.toLocaleString()} / {totalTracks.toLocaleString()} tracks
          </span>
          <span>{formatBytes(live?.observedBytes ?? 0)} transferred</span>
        </div>
      </div>

      <div className="readout-grid">
        <Readout
          label={finished ? "Elapsed" : "Time remaining"}
          value={
            finished && live !== null
              ? formatElapsed(Date.parse(live.updatedAt) - Date.parse(live.startedAt))
              : formatRemaining(remainingMs)
          }
          note={finished ? "total" : estimateNote(entry)}
          primary
        />
        <Readout
          label="Link rate"
          value={formatBitrate(entry.estimate.throughputBps)}
          note={entry.estimate.source === "session" ? "measured now" : estimateNote(entry)}
        />
        <Readout label="Outstanding" value={`${entry.estimate.remainingTracks}`} note="tracks" />
        <Readout
          label="Counts"
          value={
            live?.counts == null ? "—" : `${live.counts.downloaded}/${live.counts.reused}/${live.counts.failed}`
          }
          note="new / reused / failed"
        />
      </div>

      <p className="meta mono device-card-errors truncate">
        {live !== null && live.errorCodes.length > 0 ? live.errorCodes.join(" · ") : "\u00a0"}
      </p>
    </div>
  );
}

function estimateNote(entry: DeviceSyncStatus): string {
  return entry.estimate.source === "session"
    ? "measured this sync"
    : entry.estimate.source === "measured"
      ? "from this watch's history"
      : "default Forerunner estimate";
}

function DeviceRow({
  index,
  device,
  entry,
  busy,
  onRename,
  onRevoke,
  onForget
}: {
  index: number;
  device: Device;
  entry: DeviceSyncStatus | undefined;
  busy: boolean;
  onRename?: (name: string | null) => void;
  onRevoke?: () => void;
  onForget?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(device.displayName);
  const [history, setHistory] = useState<SyncHistoryEntry[] | null>(null);

  async function loadHistory() {
    if (history !== null) return;
    try {
      setHistory((await api<{ history: SyncHistoryEntry[] }>(`/api/v1/devices/${encodeURIComponent(device.id)}/history`)).history);
    } catch {
      setHistory([]);
    }
  }

  return (
    <div className="worklist-row">
      <span className="worklist-index">{String(index + 1).padStart(2, "0")}</span>
      <span className="icon-tile" aria-hidden="true">
        <WatchIcon />
      </span>
      <span className="worklist-main">
        {renaming && onRename !== undefined ? (
          <form
            className="actions"
            onSubmit={(event) => {
              event.preventDefault();
              setRenaming(false);
              const trimmed = draft.trim();
              onRename(trimmed.length === 0 || trimmed === device.reportedName ? null : trimmed);
            }}
          >
            <label className="sr-only" htmlFor={`rename-${device.id}`}>
              Watch name
            </label>
            <input
              id={`rename-${device.id}`}
              type="text"
              value={draft}
              maxLength={48}
              autoFocus
              style={{ maxWidth: "18rem" }}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button className="btn btn-primary btn-small" disabled={busy}>
              Save name
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => {
                setDraft(device.displayName);
                setRenaming(false);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <span className="worklist-title">{device.displayName}</span>
            <span className="worklist-detail">
              <span>{device.revokedAt === null ? `seen ${formatRelative(device.lastSeenAt)}` : `removed ${formatRelative(device.revokedAt)}`}</span>
              <span>rev {formatRevision(device.appliedRevision)}</span>
              {device.customName !== null && <span>reported as {device.reportedName}</span>}
              {device.measuredThroughputBps !== null && <span>{formatBitrate(device.measuredThroughputBps)}</span>}
            </span>
            <details onToggle={() => void loadHistory()} style={{ marginTop: "0.4rem" }}>
              <summary>Sync history and diagnostics</summary>
              <DeviceDetail device={device} history={history} />
            </details>
          </>
        )}
      </span>
      <span className="worklist-status">
        {entry?.upToDate === true && <span className="tag tag-normal">In sync</span>}
        {device.lastSyncStatus === "partial" && !device.lastSyncIsCheckpoint && (
          <span className="tag tag-mild">Partial</span>
        )}
        {device.revokedAt !== null && <span className="tag">Removed</span>}
      </span>
      <span className="worklist-actions">
        {onRename !== undefined && !renaming && (
          <button type="button" className="btn btn-ghost btn-small" onClick={() => setRenaming(true)}>
            Rename
          </button>
        )}
        {onRevoke !== undefined && (
          <ConfirmAction
            label="Remove watch"
            confirmLabel="Confirm removal"
            prompt={`Remove ${device.displayName}? It will need a new pairing code.`}
            disabled={busy}
            onConfirm={onRevoke}
          />
        )}
        {onForget !== undefined && (
          <ConfirmAction
            label="Delete record"
            confirmLabel="Confirm deletion"
            prompt={`Delete the record for ${device.displayName}, including its sync history?`}
            disabled={busy}
            onConfirm={onForget}
          />
        )}
      </span>
    </div>
  );
}

function DeviceDetail({ device, history }: { device: Device; history: SyncHistoryEntry[] | null }) {
  const timings = device.lastSyncTimings;
  return (
    <div className="stack" style={{ marginTop: "0.5rem" }}>
      <p className="meta mono">
        Paired {formatDate(device.createdAt)} · last report {formatDate(device.lastSyncAt)}
        {device.lastSyncStatus !== null && ` · ${device.lastSyncIsCheckpoint ? "checkpoint" : device.lastSyncStatus}`}
      </p>
      {timings !== null && (
        <>
          <p className="meta mono">
            Total {formatElapsed(timings.totalMs)} · launch {formatOptionalElapsed(timings.launchMs)} · configuration{" "}
            {formatOptionalElapsed(timings.configMs)} · metadata {formatElapsed(timings.metadataMs)} · audio{" "}
            {formatElapsed(timings.audioTotalMs)} · artwork {formatElapsed(timings.artworkMs)}
          </p>
          <p className="meta mono">
            Startup {formatElapsed(timings.audioStartupMs)} · transfer {formatElapsed(timings.audioTransferMs)} ·
            cache finalization {formatElapsed(timings.audioFinalizeMs)}
          </p>
          <p className="meta mono">
            {timings.audioCount} audio files · {formatBytes(timings.audioBytes)} · {timings.artworkCount} artwork files
          </p>
        </>
      )}
      {history !== null && history.length === 0 && <p className="meta">No completed syncs recorded yet.</p>}
      {history !== null && history.length > 0 && (
        <div className="table-scroll">
        <table className="mono" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
          <thead>
            <tr style={{ color: "var(--faint)", textAlign: "left" }}>
              <th scope="col">Finished</th>
              <th scope="col">Status</th>
              <th scope="col">New</th>
              <th scope="col">Failed</th>
              <th scope="col">Transferred</th>
              <th scope="col">Rate</th>
            </tr>
          </thead>
          <tbody>
            {history.map((run) => (
              <tr key={run.id} style={{ borderTop: "1px solid var(--line)" }}>
                <td>{formatDate(run.finishedAt)}</td>
                <td>{run.status}</td>
                <td>{run.downloaded}</td>
                <td>{run.failed}</td>
                <td>{formatBytes(run.observedBytes)}</td>
                <td>{run.throughputBps === null ? "—" : formatBitrate(run.throughputBps)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
