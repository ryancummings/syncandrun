export const plexSetupSessionsMigration = {
  version: 3,
  name: "plex_setup_sessions",
  sql: `
    ALTER TABLE plex_connection ADD COLUMN encrypted_account_token BLOB;
    ALTER TABLE plex_connection ADD COLUMN account_token_nonce BLOB;

    CREATE TABLE plex_auth_sessions (
      id TEXT PRIMARY KEY,
      plex_pin_id INTEGER NOT NULL UNIQUE,
      encrypted_code BLOB NOT NULL,
      code_nonce BLOB NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'expired', 'completed')),
      encrypted_account_token BLOB,
      account_token_nonce BLOB,
      username TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `
} as const;
