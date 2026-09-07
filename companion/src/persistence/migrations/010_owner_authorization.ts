export const ownerAuthorizationMigration = {
  version: 10,
  name: "owner_authorization",
  sql: `
    CREATE TABLE installation_owner (id INTEGER PRIMARY KEY CHECK (id = 1), plex_user_id TEXT NOT NULL);
    CREATE TABLE setup_invitation (
      id INTEGER PRIMARY KEY CHECK (id = 1), token_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
      session_id TEXT
    );
    DELETE FROM plex_auth_sessions;
    ALTER TABLE plex_auth_sessions ADD COLUMN plex_user_id TEXT;
    ALTER TABLE plex_auth_sessions ADD COLUMN exchanged_at TEXT;
  `
} as const;
