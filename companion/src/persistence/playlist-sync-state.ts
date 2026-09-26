import type Database from "better-sqlite3";

/** Preserve a watch's confirmed selection before changing the current manifest. */
export function preserveAppliedPlaylists(database: Database.Database): void {
  database.prepare(`
    INSERT OR REPLACE INTO device_applied_playlists
      (device_id, playlist_id, playlist_revision, transcode_profile)
    SELECT devices.id, snapshots.playlist_id, snapshots.revision, settings.transcode_profile
    FROM devices
    CROSS JOIN settings
    JOIN playlist_snapshots AS snapshots
      ON EXISTS (SELECT 1 FROM json_each(settings.selected_playlist_ids) WHERE value = snapshots.playlist_id)
    WHERE devices.revoked_at IS NULL AND devices.applied_revision = settings.manifest_revision
  `).run();
}

/** A successful watch report replaces the playlists known to be on that watch. */
export function recordAppliedPlaylists(database: Database.Database, deviceId: string, revision: string): void {
  const current = database.prepare("SELECT manifest_revision FROM settings WHERE id = 1")
    .get() as { manifest_revision: string };
  if (revision !== current.manifest_revision) return;
  database.prepare("DELETE FROM device_applied_playlists WHERE device_id = ?").run(deviceId);
  database.prepare(`
    INSERT INTO device_applied_playlists
      (device_id, playlist_id, playlist_revision, transcode_profile)
    SELECT ?, snapshots.playlist_id, snapshots.revision, settings.transcode_profile
    FROM settings
    JOIN playlist_snapshots AS snapshots
      ON EXISTS (SELECT 1 FROM json_each(settings.selected_playlist_ids) WHERE value = snapshots.playlist_id)
    WHERE settings.id = 1
  `).run(deviceId);
}

/** True means every active watch has confirmed this exact playlist and profile. */
export function playlistSyncState(database: Database.Database): Record<string, boolean> {
  const settings = database.prepare("SELECT selected_playlist_ids, transcode_profile, manifest_revision FROM settings WHERE id = 1")
    .get() as { selected_playlist_ids: string; transcode_profile: string; manifest_revision: string };
  const selectedIds = JSON.parse(settings.selected_playlist_ids) as string[];
  const devices = database.prepare("SELECT id, applied_revision FROM devices WHERE revoked_at IS NULL")
    .all() as Array<{ id: string; applied_revision: string | null }>;
  const snapshots = database.prepare("SELECT playlist_id, revision FROM playlist_snapshots")
    .all() as Array<{ playlist_id: string; revision: string }>;
  const applied = database.prepare("SELECT device_id, playlist_id, playlist_revision, transcode_profile FROM device_applied_playlists")
    .all() as Array<{ device_id: string; playlist_id: string; playlist_revision: string; transcode_profile: string }>;
  const revisions = new Map(snapshots.map((row) => [row.playlist_id, row.revision]));
  const appliedByDevice = new Map(applied.map((row) => [`${row.device_id}\0${row.playlist_id}`, row]));
  return Object.fromEntries(selectedIds.map((id) => [id, devices.length > 0 && devices.every((device) => {
    if (device.applied_revision === settings.manifest_revision) return true;
    const prior = appliedByDevice.get(`${device.id}\0${id}`);
    return prior !== undefined && prior.playlist_revision === revisions.get(id)
      && prior.transcode_profile === settings.transcode_profile;
  })]));
}
