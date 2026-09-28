export const initialMigration = {
  version: 1,
  name: "initial",
  sql: `
    CREATE TABLE installation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      plex_client_identifier TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE plex_connection (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      encrypted_token BLOB NOT NULL,
      token_nonce BLOB NOT NULL,
      server_machine_id TEXT NOT NULL,
      server_base_uri TEXT NOT NULL,
      library_section_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      transcode_profile TEXT NOT NULL DEFAULT 'balanced'
        CHECK (transcode_profile IN ('compact', 'balanced', 'high')),
      selected_playlist_ids TEXT NOT NULL DEFAULT '[]',
      manifest_revision TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      token_hash BLOB NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      applied_revision TEXT,
      revoked_at TEXT
    );
    CREATE TABLE pairing_codes (
      id TEXT PRIMARY KEY,
      code_hash BLOB NOT NULL UNIQUE,
      salt BLOB NOT NULL,
      expires_at TEXT NOT NULL,
      claimed_at TEXT,
      failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
      created_at TEXT NOT NULL
    );
    CREATE TABLE playlist_snapshots (
      playlist_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      ordered_track_ids TEXT NOT NULL,
      source_updated_at TEXT,
      revision TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE track_metadata (
      track_id TEXT PRIMARY KEY,
      rating_key TEXT NOT NULL,
      media_part_fingerprint TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      artwork_key TEXT,
      updated_at TEXT NOT NULL
    );
  `
} as const;
