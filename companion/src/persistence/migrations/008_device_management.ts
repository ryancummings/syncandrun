// Operator-facing device management: a rename that never overwrites the name
// the watch reported, plus a bounded per-device sync history that supplies
// measured transfer throughput for sync estimates.
export const deviceManagementMigration = {
  version: 8,
  name: "device_management",
  sql: `
    ALTER TABLE devices ADD COLUMN custom_name TEXT;
    CREATE TABLE device_sync_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      revision TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('applied', 'partial', 'cancelled')),
      downloaded INTEGER NOT NULL,
      reused INTEGER NOT NULL,
      deleted INTEGER NOT NULL,
      failed INTEGER NOT NULL,
      error_codes TEXT NOT NULL,
      observed_bytes INTEGER NOT NULL,
      transfer_ms INTEGER NOT NULL,
      throughput_bps INTEGER,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL
    );
    CREATE INDEX device_sync_history_device_idx
      ON device_sync_history (device_id, finished_at DESC);
  `
} as const;
