import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { api, errorMessage, type Playlist, type Profile, type SyncStatus } from "../api";
import { formatBytes, formatDuration, formatRemaining } from "../format";
import { Notice, PlaylistIcon, Readout, SectionLabel } from "./primitives";

const bitrateKbps: Record<Profile, number> = { compact: 64, balanced: 96, high: 128 };

export function Playlists({
  csrf,
  profile,
  status,
  announce
}: {
  csrf: string;
  profile: Profile;
  status: SyncStatus | null;
  announce: (message: string) => void;
}) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<{ playlists: Playlist[] }>("/api/v1/playlists");
      setPlaylists(result.playlists);
      const current = new Set(result.playlists.filter((item) => item.selected).map((item) => item.id));
      setSelected(current);
      setSaved(current);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause, "Plex playlists could not be loaded."));
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const chosen = useMemo(() => playlists.filter((item) => selected.has(item.id)), [playlists, selected]);
  // Playlists may share tracks; without per-track data the browser can only
  // upper-bound the transfer, so the summary is labelled as an upper bound.
  const durationSeconds = chosen.reduce((total, item) => total + item.durationSeconds, 0);
  const trackCount = chosen.reduce((total, item) => total + item.trackCount, 0);
  const estimatedBytes = Math.round((durationSeconds * bitrateKbps[profile] * 1000) / 8);
  const throughputBps = status?.devices[0]?.estimate.throughputBps ?? null;
  const estimatedMs = throughputBps === null ? null : Math.round((estimatedBytes * 8000) / throughputBps);
  const dirty = selected.size !== saved.size || [...selected].some((id) => !saved.has(id));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/playlists/selection", {
        method: "POST",
        csrf,
        body: { selectedPlaylistIds: [...selected] }
      });
      announce("Playlist selection saved.");
      await load();
    } catch (cause) {
      setError(errorMessage(cause, "Playlist selection failed."));
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/playlists/refresh", { method: "POST", csrf });
      announce("Plex playlists refreshed.");
      await load();
    } catch (cause) {
      setError(errorMessage(cause, "Playlist refresh failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <SectionLabel>Desired offline library</SectionLabel>
          <h1 className="display display-lg">Plex playlists</h1>
          <p className="meta">Select whole audio playlists. Track browsing and playlist editing stay in Plex.</p>
        </div>
        <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
          Refresh from Plex
        </button>
      </div>

      {error !== null && <Notice tone="error">{error}</Notice>}

      <div className="readout-grid" style={{ marginBottom: "1.25rem" }}>
        <Readout label="Selected" value={`${chosen.length}/${playlists.length}`} note="playlists" />
        <Readout label="Tracks" value={trackCount.toLocaleString()} note="upper bound" />
        <Readout label="Playing time" value={formatDuration(durationSeconds)} />
        <Readout label="Transfer" value={formatBytes(estimatedBytes)} note={`${bitrateKbps[profile]} kbps MP3`} />
        <Readout
          label="Full sync"
          value={formatRemaining(estimatedMs)}
          note={throughputBps === null ? "no watch paired" : "at current link rate"}
        />
      </div>

      <form onSubmit={submit}>
        {loaded && playlists.length === 0 && (
          <p className="empty">No audio playlists were found in this Plex library.</p>
        )}
        {playlists.length > 0 && (
          <div className="worklist">
            {playlists.map((playlist, index) => {
              const isSelected = selected.has(playlist.id);
              const locked = !playlist.selectable && !isSelected;
              return (
                <label
                  key={playlist.id}
                  className={`worklist-row worklist-row-check${isSelected ? " worklist-row-selected" : ""}${locked ? " worklist-row-disabled" : ""}`}
                >
                  <span className="worklist-index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="icon-tile" aria-hidden="true">
                    <PlaylistIcon />
                  </span>
                  <span className="worklist-main">
                    <span className="worklist-title">{playlist.title}</span>
                    <span className="worklist-detail">
                      <span>{playlist.trackCount.toLocaleString()} tracks</span>
                      <span>{formatDuration(playlist.durationSeconds)}</span>
                      <span>
                        {formatBytes(Math.round((playlist.durationSeconds * bitrateKbps[profile] * 1000) / 8))}
                      </span>
                    </span>
                    {playlist.unavailableReason !== null && (
                      <span className="worklist-detail" style={{ color: "var(--severity-mild)" }}>
                        {playlist.unavailableReason}
                      </span>
                    )}
                  </span>
                  <span className="worklist-status">
                    {isSelected && <span className="tag tag-accent">Synced</span>}
                  </span>
                  <span className="worklist-actions worklist-check">
                    <span className="check-hit">
                      <input
                        type="checkbox"
                        name="playlist"
                        value={playlist.id}
                        checked={isSelected}
                        disabled={locked}
                        aria-label={playlist.title}
                        onChange={(event) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(playlist.id);
                            else next.delete(playlist.id);
                            return next;
                          })
                        }
                      />
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
        <div className="panel-actions spread">
          <p className="meta">
            {dirty ? "Unsaved changes. Watches pick up the new selection on their next sync." : "Selection matches the companion manifest."}
          </p>
          <div className="actions">
            <button className="btn btn-primary" disabled={busy || !dirty}>
              Save playlist selection
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
