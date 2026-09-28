// Force already-paired watches to traverse the manifest once after artwork
// capabilities become available. The next library refresh replaces this
// transition revision with the normal content-derived revision.
export const enableArtworkManifestMigration = {
  version: 7,
  name: "enable_artwork_manifest",
  sql: `
    UPDATE settings
    SET manifest_revision = lower(hex(randomblob(32))),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
  `
} as const;
