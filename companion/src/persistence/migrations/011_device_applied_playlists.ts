export const deviceAppliedPlaylistsMigration = {
  version: 11,
  name: "device_applied_playlists",
  sql: `
    CREATE TABLE device_applied_playlists (
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      playlist_id TEXT NOT NULL,
      playlist_revision TEXT NOT NULL,
      transcode_profile TEXT NOT NULL,
      PRIMARY KEY (device_id, playlist_id)
    );
  `
} as const;
