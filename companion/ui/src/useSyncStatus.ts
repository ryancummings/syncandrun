import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SyncStatus } from "./api";

export type StreamState = "connecting" | "live" | "polling";

interface SyncStatusResult {
  status: SyncStatus | null;
  /** Wall-clock time the current status was received, for local interpolation. */
  receivedAt: number;
  stream: StreamState;
  /** Pulls a fresh snapshot immediately, for changes the tracker cannot see. */
  refresh: () => void;
}

const pollIntervalMs = 5_000;

/**
 * Streams companion-observed sync state over server-sent events, falling back
 * to polling if the stream cannot be held open (a proxy that buffers, say).
 */
export function useSyncStatus(enabled: boolean): SyncStatusResult {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [stream, setStream] = useState<StreamState>("connecting");
  const pollTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let source: EventSource | undefined;

    const accept = (next: SyncStatus) => {
      if (!active) return;
      setStatus(next);
      setReceivedAt(Date.now());
    };

    const poll = () => {
      void api<SyncStatus>("/api/v1/sync/status")
        .then(accept)
        .catch(() => undefined);
    };

    const startPolling = () => {
      if (!active || pollTimer.current !== undefined) return;
      setStream("polling");
      poll();
      pollTimer.current = window.setInterval(poll, pollIntervalMs);
    };

    try {
      source = new EventSource("/api/v1/sync/live");
      source.addEventListener("status", (event) => {
        try {
          accept(JSON.parse((event as MessageEvent<string>).data) as SyncStatus);
          setStream("live");
        } catch {
          startPolling();
        }
      });
      source.addEventListener("error", () => {
        // EventSource retries on its own; polling covers the interim and any
        // deployment where the stream never establishes at all.
        startPolling();
      });
    } catch {
      startPolling();
    }

    return () => {
      active = false;
      source?.close();
      if (pollTimer.current !== undefined) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = undefined;
      }
    };
  }, [enabled]);

  const refresh = useCallback(() => {
    void api<SyncStatus>("/api/v1/sync/status")
      .then((next) => {
        setStatus(next);
        setReceivedAt(Date.now());
      })
      .catch(() => undefined);
  }, []);

  return { status, receivedAt, stream, refresh };
}

/** Ticks once a second so countdowns move between server frames. */
export function useTicker(active: boolean, intervalMs = 1_000): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setTick(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return tick;
}
