# Security

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/ryancummings/syncandrun/security/advisories/new). Include the affected commit and sanitized reproduction steps. Do not attach a real profile, database, Plex token, setup link, exported media, or private library metadata.

SyncAndRun is a personal desktop app. Its internal Fastify service binds to `127.0.0.1:31415` while the app is open. It serves Plex sign-in, playlist data, and UI assets; there is no watch API or intended LAN endpoint. The first Plex account that signs in owns the local profile. Later sign-ins must match that account. State-changing requests use a session cookie and CSRF token.

The SQLite profile contains encrypted Plex credentials and playlist metadata. The encryption secret is stored alongside it. Back up the database and secret together and keep backups private. Export folders contain music files and playlist names, so protect them like the source library. Exported files do not contain Plex tokens. Closing the app stops the loopback service.

Dependencies and unsigned preview packages need normal local-app review before use. There is no auto updater. See [desktop use](docs/DESKTOP.md) for the profile backup action.
