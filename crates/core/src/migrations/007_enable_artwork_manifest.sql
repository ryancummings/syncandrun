UPDATE settings
    SET manifest_revision = lower(hex(randomblob(32))),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
