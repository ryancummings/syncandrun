import { OwnerRepository } from "../persistence/owner-repository.js";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  decryptPlexPinCode,
  decryptPlexToken,
  encryptPlexPinCode,
  encryptPlexToken
} from "../security/credentials.js";
import { PlexAuthClient, PlexInvalidResponseError } from "./auth.js";
import {
  PlexDiscoveryClient,
  type PlexMusicLibrary,
  type PlexServer,
  type PlexServerConnection
} from "./discovery.js";

type Fetch = typeof fetch;

interface InstallationRow {
  plex_client_identifier: string;
}

interface SessionRow {
  id: string;
  plex_pin_id: number;
  encrypted_code: Buffer;
  code_nonce: Buffer;
  expires_at: string;
  status: "pending" | "claimed" | "expired" | "completed";
  encrypted_account_token: Buffer | null;
  account_token_nonce: Buffer | null;
  username: string | null;
}

export interface PlexSetupServiceOptions {
  plexOrigin?: URL;
  authOrigin?: URL;
  fetch?: Fetch;
  timeoutMs?: number;
}

export interface PlexSetupStart {
  sessionId: string;
  authUrl: string;
  expiresAt: string;
}

export type PlexSetupStatus =
  | { status: "pending"; expiresAt: string }
  | { status: "expired"; expiresAt: string }
  | { status: "claimed" | "completed"; expiresAt: string; username: string };

export interface PlexServerSummary {
  id: string;
  name: string;
  owned: boolean;
  presence: boolean;
  connections: PlexServerConnection[];
}

export interface StoredPlexConnection {
  accountToken: string;
  serverToken: string;
  serverMachineId: string;
  serverBaseUri: string;
  librarySectionId: string;
}

export class PlexSetupService {
  readonly #database: Database.Database;
  readonly #secret: string;
  readonly #clientIdentifier: string;
  readonly #options: PlexSetupServiceOptions;

  constructor(database: Database.Database, secret: string, options: PlexSetupServiceOptions = {}) {
    this.#database = database;
    this.#secret = secret;
    this.#options = options;
    const installation = database
      .prepare("SELECT plex_client_identifier FROM installation WHERE id = 1")
      .get() as InstallationRow | undefined;
    if (installation === undefined) throw new Error("SyncAndRun installation is not initialized");
    this.#clientIdentifier = installation.plex_client_identifier;
  }

  async start(forwardUrl: URL, now = new Date(), invitation?: string): Promise<PlexSetupStart> {
    const startedAt = Date.now();
    const owners = new OwnerRepository(this.#database);
    owners.checkStart(invitation, now);
    const pin = await this.#authClient().createPin(forwardUrl);
    const encryptedCode = encryptPlexPinCode(pin.code, this.#secret);
    const sessionId = randomUUID();
    const timestamp = now.toISOString();
    this.#database.transaction(() => {
      owners.reserve(invitation, sessionId, new Date(now.getTime() + Date.now() - startedAt));
      this.#database
        .prepare(
          `INSERT INTO plex_auth_sessions
             (id, plex_pin_id, encrypted_code, code_nonce, expires_at, status,
              encrypted_account_token, account_token_nonce, username, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`
        )
        .run(
          sessionId,
          pin.id,
          encryptedCode.encryptedToken,
          encryptedCode.nonce,
          pin.expiresAt,
          timestamp,
          timestamp
        );
    })();
    return { sessionId, authUrl: pin.authUrl, expiresAt: pin.expiresAt };
  }

  async getStatus(sessionId: string, now = new Date()): Promise<PlexSetupStatus> {
    const startedAt = Date.now();
    const session = this.#getSession(sessionId);
    if (session.status === "claimed" || session.status === "completed") {
      new OwnerRepository(this.#database).assertSession(sessionId);
      if (session.username === null) throw new Error("Claimed Plex setup session has no username");
      return { status: session.status, expiresAt: session.expires_at, username: session.username };
    }
    if (session.status === "expired" || Date.parse(session.expires_at) <= now.getTime()) {
      this.#markExpired(session.id, now);
      return { status: "expired", expiresAt: session.expires_at };
    }

    const code = decryptPlexPinCode(
      { encryptedToken: session.encrypted_code, nonce: session.code_nonce },
      this.#secret
    );
    const pin = await this.#authClient().getPinStatus(session.plex_pin_id, code, now);
    if (pin.status === "pending") return pin;
    if (pin.status === "expired") {
      this.#markExpired(session.id, now);
      return pin;
    }

    const validation = await this.#authClient().validateToken(pin.token);
    if (!validation.valid) throw new PlexInvalidResponseError("Plex returned an invalid claimed token");
    const encryptedToken = encryptPlexToken(pin.token, this.#secret);
    this.#database.transaction(() => {
      const current = this.#getSession(sessionId);
      if (current.status !== "pending" && current.status !== "claimed") throw new Error("Setup expired");
      const claimedAt = new Date(now.getTime() + Date.now() - startedAt);
      if (Date.parse(current.expires_at) <= claimedAt.getTime()) throw new Error("Setup expired");
      new OwnerRepository(this.#database).claim(String(validation.user.id), sessionId, claimedAt);
      this.#database
        .prepare(
          `UPDATE plex_auth_sessions
           SET plex_user_id = ?, status = 'claimed', encrypted_account_token = ?, account_token_nonce = ?, username = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(
          String(validation.user.id),
          encryptedToken.encryptedToken,
          encryptedToken.nonce,
          validation.user.username,
          now.toISOString(),
          session.id
        );
    })();
    return { status: "claimed", expiresAt: session.expires_at, username: validation.user.username };
  }

  async listServers(sessionId: string): Promise<PlexServerSummary[]> {
    const servers = await this.#discoveryClient().listServers(this.#getAccountToken(sessionId));
    return servers.map(({ accessToken: _accessToken, ...server }) => server);
  }

  async listMusicLibraries(
    sessionId: string,
    serverId: string,
    connectionUri: string
  ): Promise<PlexMusicLibrary[]> {
    const server = await this.#findServer(sessionId, serverId);
    return this.#discoveryClient().listMusicLibraries(server, connectionUri);
  }

  async complete(
    sessionId: string,
    serverId: string,
    connectionUri: string,
    librarySectionId: string,
    now = new Date()
  ): Promise<void> {
    const accountToken = this.#getAccountToken(sessionId);
    const server = await this.#findServer(sessionId, serverId);
    const libraries = await this.#discoveryClient().listMusicLibraries(server, connectionUri);
    if (!libraries.some((library) => library.id === librarySectionId)) {
      throw new Error("The selected music library was not discovered for this server");
    }
    const encryptedServerToken = encryptPlexToken(server.accessToken, this.#secret);
    const encryptedAccountToken = encryptPlexToken(accountToken, this.#secret);
    const timestamp = now.toISOString();
    this.#database.transaction(() => {
      new OwnerRepository(this.#database).assertSession(sessionId);
      this.#database
        .prepare(
          `INSERT INTO plex_connection
             (id, encrypted_token, token_nonce, server_machine_id, server_base_uri, library_section_id,
              created_at, updated_at, encrypted_account_token, account_token_nonce)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             encrypted_token = excluded.encrypted_token,
             token_nonce = excluded.token_nonce,
             server_machine_id = excluded.server_machine_id,
             server_base_uri = excluded.server_base_uri,
             library_section_id = excluded.library_section_id,
             updated_at = excluded.updated_at,
             encrypted_account_token = excluded.encrypted_account_token,
             account_token_nonce = excluded.account_token_nonce`
        )
        .run(
          encryptedServerToken.encryptedToken,
          encryptedServerToken.nonce,
          server.id,
          connectionUri,
          librarySectionId,
          timestamp,
          timestamp,
          encryptedAccountToken.encryptedToken,
          encryptedAccountToken.nonce
        );
      this.#database
        .prepare("UPDATE plex_auth_sessions SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'claimed'")
        .run(timestamp, sessionId);
    })();
  }

  getStoredConnection(): StoredPlexConnection | undefined {
    const row = this.#database
      .prepare(
        `SELECT encrypted_token, token_nonce, encrypted_account_token, account_token_nonce,
                server_machine_id, server_base_uri, library_section_id
         FROM plex_connection WHERE id = 1`
      )
      .get() as
      | {
          encrypted_token: Buffer;
          token_nonce: Buffer;
          encrypted_account_token: Buffer | null;
          account_token_nonce: Buffer | null;
          server_machine_id: string;
          server_base_uri: string;
          library_section_id: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    if (row.encrypted_account_token === null || row.account_token_nonce === null) {
      throw new Error("Stored Plex connection has no account token");
    }
    return {
      accountToken: decryptPlexToken(
        { encryptedToken: row.encrypted_account_token, nonce: row.account_token_nonce },
        this.#secret
      ),
      serverToken: decryptPlexToken({ encryptedToken: row.encrypted_token, nonce: row.token_nonce }, this.#secret),
      serverMachineId: row.server_machine_id,
      serverBaseUri: row.server_base_uri,
      librarySectionId: row.library_section_id
    };
  }

  async #findServer(sessionId: string, serverId: string): Promise<PlexServer> {
    const servers = await this.#discoveryClient().listServers(this.#getAccountToken(sessionId));
    const server = servers.find((candidate) => candidate.id === serverId);
    if (server === undefined) throw new Error("The selected Plex server is unavailable");
    return server;
  }

  #getAccountToken(sessionId: string): string {
    new OwnerRepository(this.#database).assertSession(sessionId);
    const session = this.#getSession(sessionId);
    if (
      (session.status !== "claimed" && session.status !== "completed") ||
      session.encrypted_account_token === null ||
      session.account_token_nonce === null
    ) {
      throw new Error("Plex setup session is not claimed");
    }
    return decryptPlexToken(
      { encryptedToken: session.encrypted_account_token, nonce: session.account_token_nonce },
      this.#secret
    );
  }

  #getSession(sessionId: string): SessionRow {
    const session = this.#database
      .prepare(
        `SELECT id, plex_pin_id, encrypted_code, code_nonce, expires_at, status,
                encrypted_account_token, account_token_nonce, username
         FROM plex_auth_sessions WHERE id = ?`
      )
      .get(sessionId) as SessionRow | undefined;
    if (session === undefined) throw new Error("Plex setup session was not found");
    return session;
  }

  #markExpired(sessionId: string, now: Date): void {
    this.#database
      .prepare("UPDATE plex_auth_sessions SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(now.toISOString(), sessionId);
  }

  #authClient(): PlexAuthClient {
    return new PlexAuthClient({ clientIdentifier: this.#clientIdentifier, ...this.#options });
  }

  #discoveryClient(): PlexDiscoveryClient {
    const { authOrigin: _authOrigin, ...options } = this.#options;
    return new PlexDiscoveryClient({ clientIdentifier: this.#clientIdentifier, ...options });
  }
}
