import { OwnerRepository } from "./owner-repository.js";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  createBrowserSessionToken,
  createCsrfToken,
  hashBrowserSessionToken,
  verifyBrowserSessionToken,
  verifyCsrfToken
} from "../security/credentials.js";

const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;

interface BrowserSessionRow {
  id: string;
  token_hash: Buffer;
  plex_auth_session_id: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface CreatedBrowserSession {
  token: string;
  csrfToken: string;
  expiresAt: string;
}

export interface AuthenticatedBrowserSession {
  id: string;
  plexAuthSessionId: string;
  csrfToken: string;
  rawToken: string;
}

export class BrowserSessionRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly secret: string
  ) {}

  create(plexAuthSessionId: string, now = new Date()): CreatedBrowserSession {
    const token = createBrowserSessionToken();
    const tokenHash = hashBrowserSessionToken(token, this.secret);
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + sessionLifetimeMs).toISOString();
    this.database.transaction(() => {
      new OwnerRepository(this.database).assertSession(plexAuthSessionId);
      if (this.database.prepare("UPDATE plex_auth_sessions SET exchanged_at=? WHERE id=? AND exchanged_at IS NULL AND expires_at>?").run(createdAt, plexAuthSessionId, createdAt).changes !== 1) throw new Error("Sign-in session already exchanged");
      this.database.prepare("DELETE FROM browser_sessions WHERE expires_at <= ?").run(createdAt);
      this.database
        .prepare(
          `INSERT INTO browser_sessions
             (id, token_hash, plex_auth_session_id, created_at, expires_at, last_seen_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(randomUUID(), tokenHash, plexAuthSessionId, createdAt, expiresAt, createdAt);
    })();
    return { token, csrfToken: createCsrfToken(token, this.secret), expiresAt };
  }

  authenticate(token: string, now = new Date()): AuthenticatedBrowserSession | undefined {
    const rows = this.database
      .prepare("SELECT id, token_hash, plex_auth_session_id, expires_at, revoked_at FROM browser_sessions ORDER BY id")
      .all() as BrowserSessionRow[];
    let matched: BrowserSessionRow | undefined;
    for (const row of rows) {
      if (verifyBrowserSessionToken(token, row.token_hash, this.secret)) matched = row;
    }
    if (matched === undefined || matched.revoked_at !== null || Date.parse(matched.expires_at) <= now.getTime()) {
      return undefined;
    }
    try { new OwnerRepository(this.database).assertSession(matched.plex_auth_session_id); } catch { return undefined; }
    this.database.prepare("UPDATE browser_sessions SET last_seen_at = ? WHERE id = ?").run(now.toISOString(), matched.id);
    return {
      id: matched.id,
      plexAuthSessionId: matched.plex_auth_session_id,
      csrfToken: createCsrfToken(token, this.secret),
      rawToken: token
    };
  }

  verifyCsrf(session: AuthenticatedBrowserSession, value: string): boolean {
    return verifyCsrfToken(value, session.rawToken, this.secret);
  }

  revokeAll(now = new Date()): void {
    this.database.prepare("UPDATE browser_sessions SET revoked_at = ? WHERE revoked_at IS NULL").run(now.toISOString());
  }

  revoke(sessionId: string, now = new Date()): void {
    this.database
      .prepare("UPDATE browser_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(now.toISOString(), sessionId);
  }
}
