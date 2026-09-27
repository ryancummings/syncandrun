import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, type Playlist } from "./api";
import { formatBytes, formatDuration } from "./format";
import "./desktop.css";

type Route = "mtp" | "express" | "music";
type Bitrate = 64 | 96 | 128 | 192 | 256 | 320;
type Progress = { completed: number; expected: number; title: string };
type Result = { path: string; completed: number; route: Route };

interface DesktopBridge {
  platform: string;
  chooseFolder(): Promise<string | null>;
  exportMusic(options: { playlistIds: string[]; bitrate: Bitrate; route: Route }): Promise<Result>;
  showFolder(path: string): Promise<void>;
  onProgress(callback: (progress: Progress) => void): () => void;
}

declare global {
  interface Window { syncandrunDesktop?: DesktopBridge }
}

const qualities: Bitrate[] = [64, 96, 128, 192, 256, 320];

export function DesktopApp() {
  const bridge = window.syncandrunDesktop!;
  const [session, setSession] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [route, setRoute] = useState<Route>(bridge.platform === "darwin" ? "mtp" : bridge.platform === "win32" ? "express" : "mtp");
  const [bitrate, setBitrate] = useState<Bitrate>(192);
  const [folder, setFolder] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"loading" | "setup" | "ready">("loading");

  async function loadPlaylists() {
    const response = await api<{ playlists: Playlist[] }>("/api/v1/playlists");
    setPlaylists(response.playlists);
    setSelected(new Set(response.playlists.filter((item) => item.selected).map((item) => item.id)));
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [auth, settings] = await Promise.all([
          api<{ csrfToken: string }>("/api/v1/session"),
          api<{ plexConfigured: boolean }>("/api/v1/settings")
        ]);
        if (!active) return;
        setSession(auth.csrfToken);
        setMode(settings.plexConfigured ? "ready" : "setup");
        if (settings.plexConfigured) await loadPlaylists();
      } catch { if (active) setMode("setup"); }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => bridge.onProgress(setProgress), [bridge]);

  const chosen = useMemo(() => playlists.filter((item) => selected.has(item.id)), [playlists, selected]);
  const trackCount = chosen.reduce((count, item) => count + item.trackCount, 0);
  const duration = chosen.reduce((seconds, item) => seconds + item.durationSeconds, 0);
  const estimatedBytes = Math.ceil(duration * bitrate * 1000 / 8 * 1.03);
  const routeHelp = route === "mtp"
    ? "Copy the playlist folders into the Music folder on your watch with an MTP app."
    : route === "express"
      ? "In Garmin Express, open Music, choose My Music, then add the saved folder."
      : bridge.platform === "darwin"
        ? "Add the Tracks folder to Music, then import the playlist XML file. Use Garmin Express to send the playlists to your watch."
        : "Add the Tracks folder to iTunes, then import the playlist XML file. Use Garmin Express to send the playlists to your watch.";

  async function refresh() {
    if (!session) return;
    setBusy(true); setError(null); setResult(null);
    try {
      await api("/api/v1/playlists/refresh", { method: "POST", csrf: session });
      await loadPlaylists();
    } catch (cause) { setError(errorMessage(cause, "Could not refresh playlists from Plex.")); }
    finally { setBusy(false); }
  }

  async function createFiles() {
    if (!session || !folder || chosen.length === 0) return;
    setBusy(true); setError(null); setResult(null); setProgress(null);
    try {
      await api("/api/v1/playlists/selection", {
        method: "POST", csrf: session, body: { selectedPlaylistIds: chosen.map((item) => item.id) }
      });
      const exported = await bridge.exportMusic({ playlistIds: chosen.map((item) => item.id), bitrate, route });
      setResult(exported);
    } catch (cause) { setError(errorMessage(cause, "Could not create the music folder. Check Plex and try again.")); }
    finally { setBusy(false); }
  }

  return <div className="desktop">
    <header className="desktop-top"><span className="desktop-brand">sync<span>&amp;</span>run</span><span className="desktop-source">{mode === "ready" ? "Plex connected" : "Plex not connected"}</span></header>
    <main className="desktop-main">
      {mode === "loading" && <p>Loading…</p>}
      {mode === "setup" && <DesktopSetup onReady={async (token) => { setSession(token); setMode("ready"); await loadPlaylists(); }} />}
      {mode === "ready" && <>
        <div className="desktop-heading"><div><h1>Your music</h1><p>Choose playlists and create files for your watch.</p></div></div>
        <div className="desktop-grid">
          <section className="desktop-card desktop-library" aria-labelledby="desktop-playlists">
            <div className="desktop-card-head"><h2 id="desktop-playlists">Playlists <span>{chosen.length} selected</span></h2><button type="button" className="desktop-link" onClick={() => void refresh()} disabled={busy}>Refresh from Plex</button></div>
            {playlists.length === 0 ? <p className="desktop-empty">No music playlists found in Plex.</p> :
              <div className="desktop-playlists">{playlists.map((playlist) => <label key={playlist.id} className="desktop-playlist">
                <input type="checkbox" checked={selected.has(playlist.id)} disabled={busy || !playlist.selectable} onChange={(event) => {
                  setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(playlist.id); else next.delete(playlist.id); return next; });
                  setResult(null);
                }} />
                <span className="desktop-music-icon" aria-hidden="true">♫</span>
                <span className="desktop-playlist-text"><strong>{playlist.title}</strong><small>{playlist.trackCount.toLocaleString()} tracks · {formatDuration(playlist.durationSeconds)}{!playlist.selectable && playlist.unavailableReason ? ` · ${playlist.unavailableReason}` : ""}</small></span>
              </label>)}</div>}
          </section>
          <section className="desktop-card desktop-export" aria-labelledby="desktop-export-title">
            <h2 id="desktop-export-title">Create files</h2>
            <fieldset className="desktop-field"><legend>Transfer with</legend><div className="desktop-route-options">
              <label><input type="radio" name="route" checked={route === "mtp"} onChange={() => { setRoute("mtp"); setResult(null); }} />MTP app</label>
              {bridge.platform === "win32" && <label><input type="radio" name="route" checked={route === "express"} onChange={() => { setRoute("express"); setResult(null); }} />Garmin Express</label>}
              {bridge.platform !== "linux" && <label><input type="radio" name="route" checked={route === "music"} onChange={() => { setRoute("music"); setResult(null); }} />{bridge.platform === "darwin" ? "Music + Express" : "iTunes + Express"}</label>}
            </div></fieldset>
            <label className="desktop-field">MP3 quality<select value={bitrate} onChange={(event) => { setBitrate(Number(event.target.value) as Bitrate); setResult(null); }}>
              {qualities.map((value) => <option key={value} value={value}>{value} kbps{value === 192 ? " · recommended" : ""}</option>)}
            </select></label>
            <div className="desktop-field"><span>Save in</span><button type="button" className="desktop-folder" onClick={async () => { const path = await bridge.chooseFolder(); if (path) { setFolder(path); setResult(null); } }}><span>{folder ?? "Choose a folder"}</span><span aria-hidden="true">Browse</span></button></div>
            <div className="desktop-estimate"><span>{route === "mtp" ? "Estimated size" : "Estimated size, up to"}</span><strong>{formatBytes(estimatedBytes)}</strong><small>{trackCount.toLocaleString()} tracks{route !== "mtp" ? " · shared tracks saved once" : ""}</small></div>
            <button type="button" className="desktop-primary" disabled={busy || !folder || chosen.length === 0} onClick={() => void createFiles()}>{busy ? "Creating files…" : "Create music folder"}</button>
            {busy && progress && <p className="desktop-progress" role="status">{progress.completed} of {progress.expected} tracks saved</p>}
            {error && <p className="desktop-error" role="alert">{error}</p>}
            {result ? <div className="desktop-done" role="status"><strong>Files ready</strong><p>{routeHelp}</p><button type="button" className="desktop-link" onClick={() => void bridge.showFolder(result.path)}>Open folder</button></div> : <p className="desktop-next">{routeHelp}</p>}
          </section>
        </div>
      </>}
    </main>
  </div>;
}

import { Setup } from "./components/Setup";

function DesktopSetup({ onReady }: { onReady: (token: string) => void | Promise<void> }) {
  return <div className="desktop-setup"><Setup onReady={(token) => { void onReady(token); }} /></div>;
}
