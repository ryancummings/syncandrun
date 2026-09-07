import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, errorMessage, type PlexConnection, type PlexLibrary, type PlexServer } from "../api";
import { Notice, SectionLabel } from "./primitives";

/** Backs off from an eager first check to a steady poll while the operator signs in. */
const pollIntervalMs = 1_500;

export function Setup({ onReady }: { onReady: (csrf: string) => void }) {
  const [step, setStep] = useState<"account" | "server" | "library">("account");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [csrf, setCsrf] = useState<string | null>(null);
  const [servers, setServers] = useState<PlexServer[]>([]);
  const [serverChoice, setServerChoice] = useState("0:0");
  const [selectedServer, setSelectedServer] = useState<PlexServer | null>(null);
  const [selectedConnection, setSelectedConnection] = useState<PlexConnection | null>(null);
  const [libraries, setLibraries] = useState<PlexLibrary[]>([]);
  const [libraryId, setLibraryId] = useState("");
  const invitation = useRef(new URLSearchParams(window.location.hash.slice(1)).get("setup") ?? undefined);
  useEffect(() => {
    if (invitation.current) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  async function connectPlex() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const started = await api<{ sessionId: string; authUrl: string; expiresAt: string }>(
        "/api/v1/setup/plex/pin",
        { method: "POST", body: invitation.current ? { invitation: invitation.current } : {} }
      );
      invitation.current = undefined;
      setAuthUrl(started.authUrl);
      window.open(started.authUrl, "plex-auth", "noopener");
      setStatus("Finish signing in to Plex in the new window. This page continues automatically.");
      const deadline = Date.parse(started.expiresAt);
      while (mounted.current && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, pollIntervalMs));
        if (!mounted.current) return;
        const result = await api<{ status: string; csrfToken?: string }>(
          `/api/v1/setup/plex/pin/${encodeURIComponent(started.sessionId)}`
        );
        if ((result.status === "claimed" || result.status === "completed") && result.csrfToken) {
          const discovered = await api<{ servers: PlexServer[] }>("/api/v1/setup/plex/servers");
          if (!mounted.current) return;
          setCsrf(result.csrfToken);
          setServers(discovered.servers);
          setStep("server");
          setBusy(false);
          return;
        }
        if (result.status === "expired") throw new Error("The Plex sign-in expired. Start again.");
      }
      if (mounted.current) throw new Error("The Plex sign-in expired. Start again.");
    } catch (cause) {
      if (!mounted.current) return;
      setError(errorMessage(cause, "Plex sign-in failed."));
      setStatus(null);
      setBusy(false);
    }
  }

  async function chooseServer(event: FormEvent) {
    event.preventDefault();
    if (!csrf) return;
    setBusy(true);
    setError(null);
    try {
      const [serverIndex = -1, connectionIndex = -1] = serverChoice.split(":").map(Number);
      const server = servers[serverIndex];
      const connection = server?.connections[connectionIndex];
      if (!server || !connection) throw new Error("Choose a Plex server connection.");
      const result = await api<{ libraries: PlexLibrary[] }>("/api/v1/setup/plex/libraries", {
        method: "POST",
        csrf,
        body: { serverId: server.id, connectionUri: connection.uri }
      });
      setSelectedServer(server);
      setSelectedConnection(connection);
      setLibraries(result.libraries);
      setLibraryId(result.libraries[0]?.id ?? "");
      setStep("library");
    } catch (cause) {
      setError(errorMessage(cause, "Plex server discovery failed."));
    } finally {
      setBusy(false);
    }
  }

  async function chooseLibrary(event: FormEvent) {
    event.preventDefault();
    if (!csrf || !selectedServer || !selectedConnection || !libraryId) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/setup/plex/complete", {
        method: "POST",
        csrf,
        body: {
          serverId: selectedServer.id,
          connectionUri: selectedConnection.uri,
          librarySectionId: libraryId
        }
      });
      onReady(csrf);
    } catch (cause) {
      setError(errorMessage(cause, "Plex setup could not be completed."));
      setBusy(false);
    }
  }

  if (step === "server") {
    return (
      <section className="panel bracket-frame">
        <SectionLabel>Setup · step 2 of 3</SectionLabel>
        <h1 className="display display-lg">Choose a Plex server</h1>
        <p className="lede">Only trusted HTTPS connections are offered to the watch companion.</p>
        {error !== null && <div className="divider" />}
        {error !== null && <Notice tone="error">{error}</Notice>}
        <form className="stack" onSubmit={chooseServer} style={{ marginTop: "1.25rem" }}>
          <div className="field">
            <label htmlFor="server-choice">Server and HTTPS connection</label>
            <select id="server-choice" value={serverChoice} onChange={(event) => setServerChoice(event.target.value)}>
              {servers.flatMap((server, serverIndex) =>
                server.connections.map((connection, connectionIndex) => (
                  <option key={`${server.id}:${connection.uri}`} value={`${serverIndex}:${connectionIndex}`}>
                    {server.name}
                    {connection.relay ? " · Relay" : ""}
                  </option>
                ))
              )}
            </select>
          </div>
          <div className="actions">
            <button className="btn btn-primary" disabled={busy}>
              Continue to music library
            </button>
          </div>
        </form>
      </section>
    );
  }

  if (step === "library") {
    return (
      <section className="panel bracket-frame">
        <SectionLabel>Setup · step 3 of 3</SectionLabel>
        <h1 className="display display-lg">Choose a music library</h1>
        <p className="lede">SyncAndRun reads audio playlists from one library. Plex stays the playlist editor.</p>
        {error !== null && <Notice tone="error">{error}</Notice>}
        <form className="stack" onSubmit={chooseLibrary} style={{ marginTop: "1.25rem" }}>
          <div className="field">
            <label htmlFor="library-choice">Plex music library</label>
            <select id="library-choice" value={libraryId} onChange={(event) => setLibraryId(event.target.value)}>
              {libraries.map((library) => (
                <option key={library.id} value={library.id}>
                  {library.title}
                </option>
              ))}
            </select>
          </div>
          <div className="actions">
            <button className="btn btn-primary" disabled={busy || libraryId === ""}>
              Finish setup
            </button>
          </div>
        </form>
      </section>
    );
  }

  const secure = window.location.protocol === "https:";
  return (
    <section className="panel bracket-frame">
      <SectionLabel>Setup · step 1 of 3 · private by design</SectionLabel>
      <h1 className="display display-xl">Your Plex music. Offline on your Garmin.</h1>
      <p className="lede" style={{ marginTop: "1rem" }}>
        Connect one Plex server, choose existing audio playlists, and keep them playable when your phone and every
        network are gone.
      </p>
      <div className="readout-grid" style={{ margin: "1.5rem 0" }}>
        <Readout label="Endpoint" value={window.location.host} />
        <Readout label="Transport" value={secure ? "HTTPS" : "HTTP"} />
        <Readout label="Watch pairing" value={secure ? "Available" : "Blocked"} />
      </div>
      {!secure && (
        <Notice tone="error">
          A publicly trusted HTTPS endpoint is required before a watch can pair. Setup can continue, but pairing will
          not work over plain HTTP.
        </Notice>
      )}
      <Notice>First setup requires a private setup link from the host. After setup, only the installation owner can sign in.</Notice>
      {status !== null && <Notice>{status}</Notice>}
      {error !== null && <Notice tone="error">{error}</Notice>}
      <div className="actions" style={{ marginTop: "1.25rem" }}>
        <button className="btn btn-primary" disabled={busy} onClick={() => void connectPlex()}>
          {busy ? "Waiting for Plex…" : "Connect Plex"}
        </button>
        {authUrl !== null && (
          <a className="btn btn-ghost" href={authUrl} target="_blank" rel="noopener noreferrer">
            Reopen the Plex sign-in
          </a>
        )}
      </div>
    </section>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="readout">
      <p className="readout-label">{label}</p>
      <p className="readout-value" style={{ fontSize: "0.95rem", overflowWrap: "anywhere" }}>
        {value}
      </p>
    </div>
  );
}
