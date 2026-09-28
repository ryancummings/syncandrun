export const musicProvidersMigration = {
  version: 11,
  name: "music_providers",
  sql: `
CREATE TABLE music_provider (id INTEGER PRIMARY KEY CHECK (id = 1), provider TEXT NOT NULL CHECK (provider IN ('plex','jellyfin')), source_revision TEXT NOT NULL DEFAULT '');
INSERT INTO music_provider(id,provider) VALUES(1,'plex');
CREATE TABLE jellyfin_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  encrypted_token BLOB NOT NULL, token_nonce BLOB NOT NULL,
  server_id TEXT NOT NULL, user_id TEXT NOT NULL,
  base_uri TEXT NOT NULL, library_id TEXT NOT NULL
);
  `
} as const;
