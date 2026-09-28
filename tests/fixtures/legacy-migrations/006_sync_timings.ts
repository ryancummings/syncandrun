export const syncTimingsMigration = {
  version: 6,
  name: "sync_timings",
  sql: `
    ALTER TABLE device_sync_results ADD COLUMN timings_json TEXT;
  `
} as const;
