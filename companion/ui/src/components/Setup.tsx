import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, errorMessage, type PlexConnection, type PlexLibrary, type PlexServer } from "../api";
import { Notice, SectionLabel } from "./primitives";

/** Backs off from an eager first check to a steady poll while the owner signs in. */
const pollIntervalMs = 1_500;

export function Setup({ onReady }: { onReady: (csrf: string) => void }) {
  const [step, setStep] = useState<"account" | "server" | "library">("account");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [csrf, setCsrf] = useState<string | null>(null);
  const [servers, setServers] = useState<PlexServer[]>([]);
  const [serverChoice, setServerChoice] = useState("");
  const [selectedServer, setSelectedServer] = useState<PlexServer | null>(null);
  const [selectedConnection, setSelectedConnection] = useState<PlexConnection | null>(null);
  const [libraries, setLibraries] = useState<PlexLibrary[]>([]);
  const [libraryId, setLibraryId] = useState("");
  // Operators can still hand out setup links; they are optional.
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
      setStatus("Sign in to Plex in the window that opened. This page continues on its own.");
      const deadline = Date.parse(started.expiresAt);
      while (mounted.current && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, pollIntervalMs));
        if (!mounted.current) return;
        const result = await api<{ status: string; csrfToken?: string }>(
          `/api/v1/setup/plex/pin/${encodeURIComponent(started.sessionId)}`
        );
        if ((result.status === "claimed" || result.status === "completed") && result.csrfToken) {
          setStatus("Signed in. Finding your Plex servers…");
          const discovered = await api<{ servers: PlexServer[] }>("/api/v1/setup/plex/servers");
          if (!mounted.current) return;
          setCsrf(result.csrfToken);
          setServers(discovered.servers);
          setServerChoice(discovered.servers[0]?.id ?? "");
          setStep("server");
          if (discovered.servers.length === 1 && discovered.servers[0]) {
            setStatus(`Connecting to ${discovered.servers[0].name}…`);
            await openServer(discovered.servers[0], result.csrfToken);
            return;
          }
          if (discovered.servers.length === 0) {
            setError(
              "No Plex servers were found on this account. Check that Plex Media Server is running and signed in to the same Plex account."
            );
          }
          setStatus(null);
          setBusy(false);
          return;
        }
        if (result.status === "expired") throw new Error("The Plex sign-in timed out. Try again.");
      }
      if (mounted.current) throw new Error("The Plex sign-in timed out. Try again.");
    } catch (cause) {
      if (!mounted.current) return;
      setError(errorMessage(cause, "Plex sign-in failed."));
      setStatus(null);
      setBusy(false);
    }
  }

  /**
   * Tries the server's connections from most to least direct and keeps the
   * first that answers, so nobody has to know which Plex address works. A
   * single music library finishes setup without another question.
   */
  async function openServer(server: PlexServer, token: string) {
    setBusy(true);
    setError(null);
    for (const connection of orderedConnections(server)) {
      let found: PlexLibrary[];
      try {
        found = (await api<{ libraries: PlexLibrary[] }>("/api/v1/setup/plex/libraries", {
          method: "POST",
          csrf: token,
          body: { serverId: server.id, connectionUri: connection.uri }
        })).libraries;
      } catch {
        continue;
      }
      if (!mounted.current) return;
      if (found.length === 0) {
        setError(`${server.name} has no music library. Add one in Plex, then try again.`);
        setStatus(null);
        setStep("server");
        setBusy(false);
        return;
      }
      setSelectedServer(server);
      setSelectedConnection(connection);
      setLibraries(found);
      setLibraryId(found[0]?.id ?? "");
      if (found.length === 1 && found[0]) {
        await finish(server, connection, found[0].id, token);
        return;
      }
      setStatus(null);
      setStep("library");
      setBusy(false);
      return;
    }
    if (!mounted.current) return;
    setError(
      `SyncAndRun could not reach ${server.name}. Check that Plex Media Server is running and reachable from the computer running SyncAndRun.`
    );
    setStatus(null);
    setStep("server");
    setBusy(false);
  }

  async function finish(server: PlexServer, connection: PlexConnection, library: string, token: string) {
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/setup/plex/complete", {
        method: "POST",
        csrf: token,
        body: { serverId: server.id, connectionUri: connection.uri, librarySectionId: library }
      });
      onReady(token);
    } catch (cause) {
      if (!mounted.current) return;
      setError(errorMessage(cause, "Plex setup could not be completed."));
      setStatus(null);
      setBusy(false);
    }
  }

  async function chooseServer(event: FormEvent) {
    event.preventDefault();
    const server = servers.find((candidate) => candidate.id === serverChoice);
    if (!csrf || !server) return;
    setStatus(`Connecting to ${server.name}…`);
    await openServer(server, csrf);
  }

  async function chooseLibrary(event: FormEvent) {
    event.preventDefault();
    if (!csrf || !selectedServer || !selectedConnection || !libraryId) return;
    await finish(selectedServer, selectedConnection, libraryId, csrf);
  }

  if (step === "server") {
    return (
      <section className="panel bracket-frame">
        <SectionLabel>Setup · step 2 of 3</SectionLabel>
        <h1 className="display display-lg">Choose your Plex server</h1>
        <p className="lede">Pick the server that holds your music. SyncAndRun finds the best way to reach it.</p>
        {status !== null && <Notice>{status}</Notice>}
        {error !== null && <Notice tone="error">{error}</Notice>}
        {servers.length > 0 && (
          <form className="stack" onSubmit={chooseServer} style={{ marginTop: "1.25rem" }}>
            <div className="field">
              <label htmlFor="server-choice">Plex server</label>
              <select id="server-choice" value={serverChoice} onChange={(event) => setServerChoice(event.target.value)}>
                {servers.map((server) => (
                  <option key={server.id} value={server.id}>
                    {server.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="actions">
              <button className="btn btn-primary" disabled={busy}>
                {busy ? "Connecting…" : "Continue"}
              </button>
            </div>
          </form>
        )}
      </section>
    );
  }

  if (step === "library") {
    return (
      <section className="panel bracket-frame">
        <SectionLabel>Setup · step 3 of 3</SectionLabel>
        <h1 className="display display-lg">Choose a music library</h1>
        <p className="lede">
          {selectedServer?.name ?? "This server"} has more than one music library. SyncAndRun uses playlists from the one
          you pick.
        </p>
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

  return (
    <section className="panel bracket-frame">
      <SectionLabel>Setup · step 1 of 3</SectionLabel>
      <h1 className="display display-xl">Your Plex music. Offline on your Garmin.</h1>
      <p className="lede" style={{ marginTop: "1rem" }}>
        Sign in with Plex, pick the playlists you want, then pair your watch. The Plex account that signs in first owns
        this SyncAndRun; only that account can manage it afterwards.
      </p>
      {status !== null && <Notice>{status}</Notice>}
      {error !== null && <Notice tone="error">{error}</Notice>}
      <div className="actions" style={{ marginTop: "1.25rem" }}>
        <button className="btn btn-primary" disabled={busy} onClick={() => void connectPlex()}>
          {busy ? "Waiting for Plex…" : "Sign in with Plex"}
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

/** Direct connections first, then remote ones, relays last. */
function orderedConnections(server: PlexServer): PlexConnection[] {
  const rank = (connection: PlexConnection) => (connection.relay ? 2 : connection.local ? 0 : 1);
  return [...server.connections].sort((left, right) => rank(left) - rank(right));
}
