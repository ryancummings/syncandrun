import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { syncTimingsSchema, type SyncTimings } from "../protocol/schemas.js";
import {
  createDeviceToken,
  createPairingCode,
  createPairingCodeSalt,
  hashDeviceToken,
  hashPairingCode,
  verifyDeviceToken,
  verifyPairingCode
} from "../security/credentials.js";

const pairingLifetimeMs = 10 * 60 * 1000;
const maximumFailedAttempts = 5;

interface PairingCodeRow {
  id: string;
  code_hash: Buffer;
  salt: Buffer;
  expires_at: string;
  failed_attempts: number;
}

interface DeviceCredentialRow {
  id: string;
  token_hash: Buffer;
  revoked_at: string | null;
}

export interface PairingCode {
  code: string;
  expiresAt: string;
}

export interface PairingDevice {
  deviceId: string;
  deviceName: string;
}

export type PairingClaim =
  | { status: "claimed"; deviceToken: string; companionId: string; manifestRevision: string }
  | { status: "expired" }
  | { status: "invalid" };

export type DeviceAuthentication =
  | { status: "authenticated"; deviceId: string }
  | { status: "revoked" }
  | { status: "invalid" };

export interface BrowserDevice {
  id: string;
  displayName: string;
  reportedName: string;
  customName: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  appliedRevision: string | null;
  revokedAt: string | null;
  lastSyncStatus: "applied" | "partial" | "cancelled" | null;
  lastSyncAt: string | null;
  lastSyncTimings: SyncTimings | null;
  lastSyncIsCheckpoint: boolean;
  measuredThroughputBps: number | null;
  measuredPerTrackOverheadMs: number | null;
}

export interface SyncHistoryEntry {
  id: number;
  revision: string;
  status: "applied" | "partial" | "cancelled";
  downloaded: number;
  reused: number;
  deleted: number;
  failed: number;
  errorCodes: string[];
  observedBytes: number;
  transferMs: number;
  throughputBps: number | null;
  startedAt: string;
  finishedAt: string;
}

export interface SyncHistoryRecord {
  deviceId: string;
  revision: string;
  status: "applied" | "partial" | "cancelled";
  downloaded: number;
  reused: number;
  deleted: number;
  failed: number;
  errorCodes: string[];
  observedBytes: number;
  transferMs: number;
  startedAt: string;
  finishedAt: string;
}

/** Newer runs dominate, but a single outlier must not erase the baseline. */
const throughputSampleLimit = 5;
const historyRetentionPerDevice = 25;
const maximumDeviceNameLength = 48;

export class DeviceRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly secret: string
  ) {}

  async createPairingCode(now = new Date()): Promise<PairingCode> {
    const code = createPairingCode();
    const salt = createPairingCodeSalt();
    const codeHash = await hashPairingCode(code, salt);
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + pairingLifetimeMs).toISOString();

    this.database.transaction(() => {
      this.database.prepare("DELETE FROM pairing_codes WHERE claimed_at IS NULL").run();
      this.database
        .prepare(
          `INSERT INTO pairing_codes
             (id, code_hash, salt, expires_at, claimed_at, failed_attempts, created_at)
           VALUES (?, ?, ?, ?, NULL, 0, ?)`
        )
        .run(randomUUID(), codeHash, salt, expiresAt, createdAt);
    })();
    return { code, expiresAt };
  }

  listDevices(): BrowserDevice[] {
    return (
      this.database
        .prepare(
          `SELECT d.id, d.display_name, d.custom_name, d.created_at, d.last_seen_at, d.applied_revision, d.revoked_at,
                  r.status AS last_sync_status, r.reported_at AS last_sync_at, r.timings_json AS last_sync_timings,
                  r.failed AS last_sync_failed
           FROM devices d
           LEFT JOIN device_sync_results r ON r.device_id = d.id
           ORDER BY d.created_at DESC, d.id`
        )
        .all() as Array<{
        id: string;
        display_name: string;
        custom_name: string | null;
        created_at: string;
        last_seen_at: string | null;
        applied_revision: string | null;
        revoked_at: string | null;
        last_sync_status: "applied" | "partial" | "cancelled" | null;
        last_sync_at: string | null;
        last_sync_timings: string | null;
        last_sync_failed: number | null;
      }>
    ).map((row) => {
      const timings = parseSyncTimings(row.last_sync_timings);
      return {
        id: row.id,
        displayName: row.custom_name ?? row.display_name,
        reportedName: row.display_name,
        customName: row.custom_name,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        appliedRevision: row.applied_revision,
        revokedAt: row.revoked_at,
        lastSyncStatus: row.last_sync_status,
        lastSyncAt: row.last_sync_at,
        lastSyncTimings: timings,
        lastSyncIsCheckpoint:
          row.last_sync_status === "partial" && row.last_sync_failed === 0 && row.last_sync_timings !== null,
        measuredThroughputBps: this.getMeasuredThroughputBps(row.id),
        measuredPerTrackOverheadMs: perTrackOverheadMs(timings)
      };
    });
  }

  /**
   * Operators name their own hardware; the watch-reported name stays on record
   * so a rename never hides which device actually paired.
   */
  renameDevice(deviceId: string, displayName: string | null): boolean {
    const normalized = displayName === null ? null : normalizeDeviceName(displayName);
    if (normalized !== null && normalized.length === 0) return false;
    return (
      this.database.prepare("UPDATE devices SET custom_name = ? WHERE id = ?").run(normalized, deviceId).changes === 1
    );
  }

  revokeDevice(deviceId: string, now = new Date()): boolean {
    return (
      this.database
        .prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(now.toISOString(), deviceId).changes === 1
    );
  }

  /** Deletes a revoked device outright, including its sync history. */
  forgetDevice(deviceId: string): boolean {
    return (
      this.database.prepare("DELETE FROM devices WHERE id = ? AND revoked_at IS NOT NULL").run(deviceId).changes === 1
    );
  }

  recordSyncHistory(record: SyncHistoryRecord): void {
    const throughput =
      record.transferMs > 0 && record.observedBytes > 0
        ? Math.round((record.observedBytes * 8000) / record.transferMs)
        : null;
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO device_sync_history
             (device_id, revision, status, downloaded, reused, deleted, failed, error_codes,
              observed_bytes, transfer_ms, throughput_bps, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.deviceId,
          record.revision,
          record.status,
          record.downloaded,
          record.reused,
          record.deleted,
          record.failed,
          JSON.stringify(record.errorCodes),
          record.observedBytes,
          record.transferMs,
          throughput,
          record.startedAt,
          record.finishedAt
        );
      this.database
        .prepare(
          `DELETE FROM device_sync_history
           WHERE device_id = ?
             AND id NOT IN (
               SELECT id FROM device_sync_history WHERE device_id = ? ORDER BY id DESC LIMIT ?
             )`
        )
        .run(record.deviceId, record.deviceId, historyRetentionPerDevice);
    })();
  }

  listSyncHistory(deviceId: string, limit = 10): SyncHistoryEntry[] {
    return (
      this.database
        .prepare(
          `SELECT id, revision, status, downloaded, reused, deleted, failed, error_codes,
                  observed_bytes, transfer_ms, throughput_bps, started_at, finished_at
           FROM device_sync_history WHERE device_id = ? ORDER BY id DESC LIMIT ?`
        )
        .all(deviceId, Math.min(Math.max(limit, 1), historyRetentionPerDevice)) as Array<{
        id: number;
        revision: string;
        status: "applied" | "partial" | "cancelled";
        downloaded: number;
        reused: number;
        deleted: number;
        failed: number;
        error_codes: string;
        observed_bytes: number;
        transfer_ms: number;
        throughput_bps: number | null;
        started_at: string;
        finished_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      revision: row.revision,
      status: row.status,
      downloaded: row.downloaded,
      reused: row.reused,
      deleted: row.deleted,
      failed: row.failed,
      errorCodes: parseErrorCodes(row.error_codes),
      observedBytes: row.observed_bytes,
      transferMs: row.transfer_ms,
      throughputBps: row.throughput_bps,
      startedAt: row.started_at,
      finishedAt: row.finished_at
    }));
  }

  /** Median of the most recent samples, so one stalled transfer cannot skew estimates. */
  getMeasuredThroughputBps(deviceId: string): number | null {
    const samples = (
      this.database
        .prepare(
          `SELECT throughput_bps FROM device_sync_history
           WHERE device_id = ? AND throughput_bps IS NOT NULL
           ORDER BY id DESC LIMIT ?`
        )
        .all(deviceId, throughputSampleLimit) as Array<{ throughput_bps: number }>
    ).map((row) => row.throughput_bps);
    if (samples.length === 0) return null;
    const sorted = [...samples].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[middle]!
      : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
  }

  authenticateDevice(token: string, now = new Date()): DeviceAuthentication {
    const rows = this.database
      .prepare("SELECT id, token_hash, revoked_at FROM devices ORDER BY id")
      .all() as DeviceCredentialRow[];
    let matched: DeviceCredentialRow | undefined;
    for (const row of rows) {
      if (verifyDeviceToken(token, row.token_hash, this.secret)) matched = row;
    }
    if (matched === undefined) return { status: "invalid" };
    if (matched.revoked_at !== null) return { status: "revoked" };

    this.database.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now.toISOString(), matched.id);
    return { status: "authenticated", deviceId: matched.id };
  }

  async claimPairingCode(code: string, device: PairingDevice, now = new Date()): Promise<PairingClaim> {
    const row = this.database
      .prepare(
        `SELECT id, code_hash, salt, expires_at, failed_attempts
         FROM pairing_codes
         WHERE claimed_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get() as PairingCodeRow | undefined;
    if (row === undefined || row.failed_attempts >= maximumFailedAttempts) return { status: "invalid" };

    const matches = await verifyPairingCode(code, row.code_hash, row.salt);
    if (!matches) {
      this.database
        .prepare(
          `UPDATE pairing_codes
           SET failed_attempts = MIN(failed_attempts + 1, ?)
           WHERE id = ? AND claimed_at IS NULL`
        )
        .run(maximumFailedAttempts, row.id);
      return { status: "invalid" };
    }
    if (Date.parse(row.expires_at) <= now.getTime()) return { status: "expired" };

    const deviceToken = createDeviceToken();
    const tokenHash = hashDeviceToken(deviceToken, this.secret);
    const claimedAt = now.toISOString();
    const result = this.database.transaction(() => {
      const claimed = this.database
        .prepare(
          `UPDATE pairing_codes
           SET claimed_at = ?
           WHERE id = ? AND claimed_at IS NULL AND failed_attempts < ? AND expires_at > ?`
        )
        .run(claimedAt, row.id, maximumFailedAttempts, claimedAt);
      if (claimed.changes !== 1) return undefined;

      this.database
        .prepare(
          `INSERT INTO devices
             (id, display_name, token_hash, created_at, last_seen_at, applied_revision, revoked_at)
           VALUES (?, ?, ?, ?, NULL, NULL, NULL)
           ON CONFLICT(id) DO UPDATE SET
             display_name = excluded.display_name,
             token_hash = excluded.token_hash,
             created_at = excluded.created_at,
             last_seen_at = NULL,
             applied_revision = NULL,
             revoked_at = NULL`
        )
        .run(device.deviceId, device.deviceName, tokenHash, claimedAt);

      const installation = this.database
        .prepare("SELECT plex_client_identifier FROM installation WHERE id = 1")
        .get() as { plex_client_identifier: string };
      const settings = this.database
        .prepare("SELECT manifest_revision FROM settings WHERE id = 1")
        .get() as { manifest_revision: string };
      return {
        companionId: `companion:${installation.plex_client_identifier}`,
        manifestRevision: settings.manifest_revision
      };
    })();

    return result === undefined
      ? { status: "invalid" }
      : { status: "claimed", deviceToken, ...result };
  }
}

/**
 * Per-track cost that is not transfer: Garmin's request startup plus the
 * encrypted-cache finalization that follows every download.
 */
function perTrackOverheadMs(timings: SyncTimings | null): number | null {
  if (timings === null || timings.audioCount === 0) return null;
  return Math.round((timings.audioStartupMs + timings.audioFinalizeMs) / timings.audioCount);
}

export function normalizeDeviceName(value: string): string {
  return [...value.replaceAll(/[\p{Cc}\p{Cf}]/gu, " ").trim().replaceAll(/\s+/gu, " ")]
    .slice(0, maximumDeviceNameLength)
    .join("")
    .trim();
}

function parseErrorCodes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseSyncTimings(value: string | null): SyncTimings | null {
  if (value === null) return null;
  try {
    const parsed = syncTimingsSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
