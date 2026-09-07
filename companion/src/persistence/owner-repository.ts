import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export class OwnerAuthorizationError extends Error {
  constructor() { super("Use a valid setup link or sign in as this installation's owner."); }
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class OwnerRepository {
  constructor(private readonly database: Database.Database) {}

  issueInvitation(now = new Date()): string {
    return this.database.transaction(() => {
      if (this.owner() !== undefined) throw new Error("This installation already has an owner; reset its data to change owners.");
      const token = randomBytes(32).toString("base64url");
      this.database.prepare(`INSERT INTO setup_invitation (id, token_hash, expires_at, session_id)
        VALUES (1, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,
        expires_at=excluded.expires_at, session_id=NULL`)
        .run(digest(token), new Date(now.getTime() + 30 * 60_000).toISOString());
      return token;
    })();
  }

  owner(): string | undefined {
    return (this.database.prepare("SELECT plex_user_id FROM installation_owner WHERE id=1").get() as
      { plex_user_id: string } | undefined)?.plex_user_id;
  }

  checkStart(token: string | undefined, now: Date): void {
    if (this.owner() !== undefined && token === undefined) return;
    if (token === undefined || !/^[A-Za-z0-9_-]{43}$/.test(token) || this.owner() !== undefined ||
      !this.database.prepare("SELECT 1 FROM setup_invitation WHERE id=1 AND token_hash=? AND expires_at>? AND session_id IS NULL")
        .get(digest(token), now.toISOString())) throw new OwnerAuthorizationError();
  }

  reserve(token: string | undefined, sessionId: string, now: Date): void {
    this.checkStart(token, now);
    if (token !== undefined) {
      const changed = this.database.prepare("UPDATE setup_invitation SET session_id=? WHERE id=1 AND token_hash=? AND session_id IS NULL AND expires_at>?")
        .run(sessionId, digest(token), now.toISOString());
      if (changed.changes !== 1) throw new OwnerAuthorizationError();
    }
  }

  claim(userId: string, sessionId: string, now: Date): void {
    const owner = this.owner();
    if (owner !== undefined) {
      if (owner !== userId) throw new OwnerAuthorizationError();
      return;
    }
    if (!this.database.prepare("SELECT 1 FROM setup_invitation WHERE id=1 AND session_id=? AND expires_at>?").get(sessionId, now.toISOString())) {
      throw new OwnerAuthorizationError();
    }
    this.database.prepare("INSERT INTO installation_owner(id, plex_user_id) VALUES (1, ?)").run(userId);
    this.database.prepare("DELETE FROM setup_invitation").run();
  }

  assertSession(sessionId: string): void {
    if (!this.database.prepare(`SELECT 1 FROM plex_auth_sessions s JOIN installation_owner o ON o.plex_user_id=s.plex_user_id
      WHERE s.id=? AND s.status IN ('claimed','completed')`).get(sessionId)) throw new OwnerAuthorizationError();
  }
}
