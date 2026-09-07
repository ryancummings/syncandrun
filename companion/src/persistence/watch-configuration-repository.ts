import type Database from "better-sqlite3";
import { watchConfigSchema, type WatchConfig } from "../protocol/index.js";

interface SettingsRow {
  manifest_revision: string;
  transcode_profile: "compact" | "balanced" | "high";
}

export class WatchConfigurationRepository {
  constructor(private readonly database: Database.Database) {}

  getConfig(now = new Date()): WatchConfig {
    const row = this.database
      .prepare("SELECT manifest_revision, transcode_profile FROM settings WHERE id = 1")
      .get() as SettingsRow;
    return watchConfigSchema.parse({
      protocolVersion: 1,
      manifestRevision: row.manifest_revision,
      transcodeProfile: row.transcode_profile,
      pageSize: 10,
      serverTime: now.toISOString()
    });
  }
}
