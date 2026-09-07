// SHA-256 of the canonical empty desired state documented in docs/protocol/README.md.
export const emptyManifestRevision = "e9fc5a5ceba1460d3467860d3bf6a25174754baf43785ad9cf3ec184ddc57c8a";

export const initializeManifestRevisionMigration = {
  version: 2,
  name: "initialize_manifest_revision",
  sql: `
    UPDATE settings
    SET manifest_revision = '${emptyManifestRevision}'
    WHERE manifest_revision IS NULL;
  `
} as const;
