export const browserSessionsMigration = {
  version: 4,
  name: "browser_sessions",
  sql: `
    CREATE TABLE browser_sessions (
      id TEXT PRIMARY KEY,
      token_hash BLOB NOT NULL UNIQUE,
      plex_auth_session_id TEXT NOT NULL REFERENCES plex_auth_sessions(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX browser_sessions_auth_session_idx ON browser_sessions(plex_auth_session_id);
  `
} as const;
