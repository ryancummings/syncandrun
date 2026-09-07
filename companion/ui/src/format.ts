const dateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** Playing time, e.g. "3 hr 5 min". Minutes never reach 60. */
export function formatDuration(seconds: number): string {
  const total = Math.max(Math.round(seconds / 60), 0);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}

/**
 * Countdown for work still outstanding. Deliberately uniform and compact: a
 * readout that switches between a phrase and a figure changes width, and at
 * the primary size that wraps and resizes the whole card.
 */
export function formatRemaining(milliseconds: number | null): string {
  if (milliseconds === null) return "—";
  const seconds = Math.max(Math.round(milliseconds / 1000), 0);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatElapsed(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} kB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

export function formatBitrate(bitsPerSecond: number): string {
  return bitsPerSecond >= 1_000_000
    ? `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`
    : `${Math.round(bitsPerSecond / 1_000)} kbps`;
}

export function formatDate(value: string | null): string {
  return value === null ? "Never" : dateTimeFormatter.format(new Date(value));
}

/** "4 minutes ago" for freshness, which is what an operator actually reads. */
export function formatRelative(value: string | null, now = Date.now()): string {
  if (value === null) return "Never";
  const deltaSeconds = Math.round((Date.parse(value) - now) / 1000);
  const absolute = Math.abs(deltaSeconds);
  if (absolute < 45) return "just now";
  if (absolute < 3600) return relativeFormatter.format(Math.round(deltaSeconds / 60), "minute");
  if (absolute < 86_400) return relativeFormatter.format(Math.round(deltaSeconds / 3600), "hour");
  return relativeFormatter.format(Math.round(deltaSeconds / 86_400), "day");
}

export function formatRevision(revision: string | null): string {
  return revision === null ? "—" : revision.slice(0, 10);
}
