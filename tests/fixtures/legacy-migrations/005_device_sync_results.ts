export const deviceSyncResultsMigration = {
  version: 5,
  name: "device_sync_results",
  sql: `
    CREATE TABLE device_sync_results (
      device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      revision TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('applied', 'partial', 'cancelled')),
      downloaded INTEGER NOT NULL,
      reused INTEGER NOT NULL,
      deleted INTEGER NOT NULL,
      failed INTEGER NOT NULL,
      error_codes TEXT NOT NULL,
      reported_at TEXT NOT NULL
    );
  `
} as const;
