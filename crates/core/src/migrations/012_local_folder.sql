CREATE TABLE music_provider_new (id INTEGER PRIMARY KEY CHECK (id = 1), provider TEXT NOT NULL CHECK (provider IN ('plex','jellyfin','local')), source_revision TEXT NOT NULL DEFAULT '');
INSERT INTO music_provider_new SELECT * FROM music_provider;
DROP TABLE music_provider;
ALTER TABLE music_provider_new RENAME TO music_provider;
CREATE TABLE local_folder (id INTEGER PRIMARY KEY CHECK (id = 1), root TEXT NOT NULL);
