import { Component, useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, type Profile, type Settings } from "./api";
import { Devices } from "./components/Devices";
import { Playlists } from "./components/Playlists";
import { CompanionSettings } from "./components/Settings";
import { Setup } from "./components/Setup";
import { Notice, StatusDot } from "./components/primitives";
import { useSyncStatus } from "./useSyncStatus";

type Screen = "playlists" | "watch" | "settings";
type Theme = "dark" | "light";

const screens: Array<{ id: Screen; label: string }> = [
  { id: "playlists", label: "Playlists" },
  { id: "watch", label: "Watch" },
  { id: "settings", label: "Settings" }
];

const themeStorageKey = "syncandrun.theme";

function readTheme(): Theme {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

export function App() {
  const [mode, setMode] = useState<"loading" | "setup" | "ready">("loading");
  const [csrf, setCsrf] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>("playlists");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [theme, setTheme] = useState<Theme>(readTheme);

  const announce = useCallback((message: string) => {
    setAnnouncement("");
    window.setTimeout(() => setAnnouncement(message), 20);
  }, []);

  const loadSettings = useCallback(async () => {
    const value = await api<Settings>("/api/v1/settings");
    setSettings(value);
    return value;
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [session, value] = await Promise.all([
          api<{ csrfToken: string }>("/api/v1/session"),
          loadSettings()
        ]);
        if (!active) return;
        setCsrf(session.csrfToken);
        setMode(value.plexConfigured ? "ready" : "setup");
      } catch {
        if (active) setMode("setup");
      }
    })();
    return () => { active = false; };
  }, [loadSettings]);

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      window.localStorage.setItem(themeStorageKey, theme);
    } catch {
      // A companion opened in private browsing still themes for this session.
    }
  }, [theme]);

  const ready = mode === "ready" && csrf !== null;
  const { status, receivedAt, stream, refresh: refreshStatus } = useSyncStatus(ready);
  const syncing = (status?.devices ?? []).some((entry) => entry.live !== null && entry.live.finishedStatus === null);

  return (
    <>
      <a className="skip-link" href="#content">Skip to content</a>
      <header className="masthead">
        <a className="ident" href="/" aria-label="SyncAndRun for Garmin home">
          <span>
            syncandrun<span className="ident-cursor" aria-hidden="true" />
          </span>
          <span className="tag">for Garmin</span>
        </a>
        <div className="status-strip">
          <span className="tag">
            <StatusDot tone={mode === "ready" ? (syncing ? "active" : "live") : mode === "setup" ? "warn" : "idle"} />
            {mode === "ready" ? (syncing ? "Sync running" : "Companion ready") : mode === "setup" ? "Setup required" : "Checking"}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            aria-pressed={theme === "light"}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? "Dark console" : "Light printout"}
          </button>
        </div>
      </header>

      {ready && (
        <nav className="navigation" aria-label="Main navigation">
          <div className="segment-track">
            {screens.map((item) => (
              <button
                key={item.id}
                type="button"
                className="segment"
                aria-current={screen === item.id ? "page" : undefined}
                onClick={() => setScreen(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </nav>
      )}

      <main id="content" className="shell" tabIndex={-1}>
        <ErrorBoundary>
          {mode === "loading" && (
            <section className="panel">
              <p className="meta mono">Loading your companion…</p>
            </section>
          )}
          {mode === "setup" && (
            <Setup
              onReady={(token) => {
                setCsrf(token);
                setMode("ready");
                void loadSettings();
                announce("SyncAndRun setup is complete.");
              }}
            />
          )}
          {ready && csrf !== null && screen === "playlists" && (
            <Playlists
              csrf={csrf}
              profile={settings?.transcodeProfile ?? "balanced"}
              status={status}
              announce={(message) => {
                announce(message);
                void loadSettings();
                refreshStatus();
              }}
            />
          )}
          {ready && csrf !== null && screen === "watch" && (
            <Devices
              csrf={csrf}
              status={status}
              receivedAt={receivedAt}
              stream={stream}
              refreshStatus={refreshStatus}
              announce={announce}
            />
          )}
          {ready && csrf !== null && screen === "settings" && (
            <CompanionSettings
              csrf={csrf}
              settings={settings}
              status={status}
              onProfileSaved={(profile: Profile) => {
                setSettings((current) => (current === null ? current : { ...current, transcodeProfile: profile }));
                void loadSettings();
                refreshStatus();
              }}
              announce={announce}
            />
          )}
        </ErrorBoundary>
      </main>

      <footer className="footer">
        SyncAndRun for Garmin · self-hosted · GPL-3.0 · <a href="/license">license</a>
      </footer>
      <div className="sr-only" aria-live="polite">{announcement}</div>
    </>
  );
}

/** A render failure must not leave the operator with a blank console. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="panel">
        <Notice tone="error">
          The companion interface hit an unexpected error. Reload the page; your Plex connection and paired watches are
          unaffected.
        </Notice>
        <div className="actions" style={{ marginTop: "1rem" }}>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </section>
    );
  }
}
