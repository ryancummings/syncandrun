// Remember which artwork delivery origin the current manifest was rendered
// for. The URL itself is deliberately not persisted; only its fingerprint is.
export const artworkOriginFingerprintMigration = {
  version: 9,
  name: "artwork_origin_fingerprint",
  sql: `
    ALTER TABLE settings ADD COLUMN artwork_origin_fingerprint TEXT;
  `
} as const;
