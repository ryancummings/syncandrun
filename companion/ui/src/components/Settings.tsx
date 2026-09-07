import { useState } from "react";
import type { FormEvent } from "react";
import { api, errorMessage, type Profile, type Settings, type SyncStatus } from "../api";
import { formatBytes, formatDate, formatRemaining, formatRevision } from "../format";
import { ConfirmAction, CopyField, ModeTag, Notice, Readout, SectionLabel } from "./primitives";

const profiles: Array<{ value: Profile; label: string; perHourMb: number }> = [
  { value: "compact", label: "Compact · 64 kbps", perHourMb: 29 },
  { value: "balanced", label: "Balanced · 96 kbps", perHourMb: 43 },
  { value: "high", label: "High · 128 kbps", perHourMb: 58 }
];

export function CompanionSettings({
  csrf,
  settings,
  status,
  onProfileSaved,
  announce
}: {
  csrf: string;
  settings: Settings | null;
  status: SyncStatus | null;
  onProfileSaved: (profile: Profile) => void;
  announce: (message: string) => void;
}) {
  const [profile, setProfile] = useState<Profile>(settings?.transcodeProfile ?? "balanced");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = settings !== null && profile !== settings.transcodeProfile;

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/settings/profile", { method: "POST", csrf, body: { profile } });
      onProfileSaved(profile);
      announce("Audio quality saved.");
    } catch (cause) {
      setError(errorMessage(cause, "Audio quality could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  async function destructive(path: string, method: "POST" | "DELETE", failure: string) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method, csrf });
      window.location.reload();
    } catch (cause) {
      setError(errorMessage(cause, failure));
      setBusy(false);
    }
  }

  const plan = status?.plan ?? null;

  return (
    <>
      <section className="panel">
        <SectionLabel>Installation</SectionLabel>
        <h1 className="display display-lg">Settings</h1>

        {error !== null && <Notice tone="error">{error}</Notice>}

        <div className="label-row" style={{ marginTop: "1.25rem" }}>
          <SectionLabel>Current state</SectionLabel>
          <ModeTag mode="readonly" />
        </div>
        <div className="readout-grid" style={{ margin: "0 0 1.25rem" }}>
          <Readout label="Manifest" value={formatRevision(settings?.manifestRevision ?? null)} />
          <Readout label="Playlists" value={String(settings?.selectedPlaylistCount ?? 0)} />
          <Readout
            label="Library size"
            value={plan === null ? "—" : formatBytes(plan.estimatedBytes)}
            note={plan === null ? undefined : `${plan.trackCount.toLocaleString()} tracks`}
          />
          <Readout label="Updated" value={settings === null ? "—" : formatDate(settings.updatedAt)} />
        </div>

        <div className="label-row">
          <SectionLabel>Audio quality</SectionLabel>
          <ModeTag mode="editable" />
        </div>
        <form className="stack" onSubmit={save}>
          <div className="field">
            <label htmlFor="profile">MP3 quality</label>
            <select id="profile" value={profile} onChange={(event) => setProfile(event.target.value as Profile)}>
              {profiles.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} · about {option.perHourMb} MB/hour
                </option>
              ))}
            </select>
            <p className="field-hint">
              Changing quality re-downloads every selected track on the next sync
              {plan !== null && changed
                ? ` — roughly ${formatBytes(estimateBytesAt(plan.durationSeconds, profile))}, ${formatRemaining(
                    estimateFullSyncMs(plan.durationSeconds, profile, status)
                  )} on the current link.`
                : "."}
            </p>
          </div>
          <div className="actions">
            <button className="btn btn-primary" disabled={busy || !changed}>
              Save audio quality
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="label-row">
          <SectionLabel>Watch setup</SectionLabel>
          <ModeTag mode="readonly" />
        </div>
        <h2 className="display display-sm">Companion address</h2>
        <p className="meta" style={{ margin: "0.5rem 0 1rem" }}>
          The watch cannot discover this companion. Type this address into the watch application's settings, then
          pair from <span className="mono">Settings → Pair watch</span> on the watch itself.
        </p>
        <CopyField label="Companion address" value={settings?.companionUrl ?? null} announce={announce} />
        <ol className="steps">
          <li>
            Open Garmin Connect on your phone, then your watch → <span className="mono">Music</span> →{" "}
            <span className="mono">Music Providers</span> → <span className="mono">SyncAndRun</span> → settings. Menu
            wording moves between Connect releases; Garmin Express on a computer reaches the same screen.
          </li>
          <li>
            Put the address above in <span className="mono">Companion HTTPS URL</span> and save. Connect pushes the
            setting to the watch over Bluetooth, which is not instant.
          </li>
          <li>
            Start a sync on the watch. If it reports that it cannot reach the companion, the setting has not landed
            yet — reopen the screen and confirm the value stuck.
          </li>
        </ol>
      </section>

      <section className="panel">
        <div className="label-row">
          <SectionLabel>About</SectionLabel>
          <ModeTag mode="readonly" />
        </div>
        <h2 className="display display-sm">This companion</h2>
        <p className="meta mono" style={{ marginTop: "0.5rem" }}>
          Version {settings?.version ?? "…"} · protocol 1
        </p>
        <p className="meta" style={{ marginTop: "0.5rem" }}>
          SyncAndRun for Garmin is GPL-3.0 software derived from SubMusic.{" "}
          <a href="/license">View license and upstream attribution</a>
        </p>
      </section>

      <section className="panel danger-zone">
        <div className="label-row">
          <SectionLabel>Private data controls</SectionLabel>
          <span className="tag tag-severe">Irreversible</span>
        </div>
        <h2 className="display display-sm">Disconnect or erase</h2>
        <p className="meta" style={{ margin: "0.5rem 0 1rem" }}>
          Disconnecting removes local Plex credentials and invalidates every watch. Full deletion also removes
          paired-device history.
        </p>
        <div className="actions">
          <ConfirmAction
            label="Disconnect Plex"
            confirmLabel="Confirm disconnect"
            prompt="Disconnect Plex and invalidate every watch?"
            disabled={busy}
            onConfirm={() =>
              void destructive("/api/v1/settings/plex/disconnect", "POST", "Plex could not be disconnected.")
            }
          />
          <ConfirmAction
            label="Delete all local data"
            confirmLabel="Confirm deletion"
            prompt="Permanently delete Plex credentials, synchronized metadata, and paired-device history?"
            disabled={busy}
            onConfirm={() =>
              void destructive("/api/v1/settings/data", "DELETE", "Local companion data could not be deleted.")
            }
          />
        </div>
      </section>
    </>
  );
}

function estimateBytesAt(durationSeconds: number, profile: Profile): number {
  const kbps = profiles.find((option) => option.value === profile)?.perHourMb ?? 43;
  return Math.round((durationSeconds / 3600) * kbps * 1_000_000);
}

function estimateFullSyncMs(durationSeconds: number, profile: Profile, status: SyncStatus | null): number | null {
  const throughputBps = status?.devices[0]?.estimate.throughputBps;
  if (throughputBps === undefined) return null;
  return Math.round((estimateBytesAt(durationSeconds, profile) * 8000) / throughputBps);
}
