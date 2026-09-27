# Architecture

SyncAndRun is an Electron desktop app. The renderer shows Plex playlists and export choices. A narrow preload bridge lets it choose an output folder, start an export, receive progress, and open the result. Only Electron's main process writes music files.

The app starts an internal Fastify service on `127.0.0.1:31415` for Plex sign-in, playlist discovery, and local UI assets. It is available only while the app runs. A session cookie and CSRF token protect playlist changes. The first Plex account to sign in owns the local profile; later sign-ins must match that account. The service has no watch pairing, watch download, or LAN route.

Plex connection details, encrypted credentials, playlist snapshots, and owner state live in SQLite inside the user's Electron profile. The encryption secret lives beside the database and must be backed up with it. Existing SQLite migrations remain so a profile from the former watch service can open without deleting its Plex connection. Historical watch tables are inert; new code does not serve watch endpoints. The app menu can back up the profile.

`desktop/export.mjs` reads saved playlist snapshots and requests MP3 streams from Plex at the chosen bitrate. It writes ID3v2.3 tags, checks the MP3 header, and creates a new dated output folder. A failed run keeps an `.incomplete` folder and cannot overwrite a complete export. MTP output has one folder and ordered relative M3U8 per playlist. Music/iTunes output shares track files and writes playlist XML. Tokens never enter exported files.

Export is currently JavaScript in Electron's main process. Rust is preferred for a future native MTP and filesystem engine. Device discovery, free-space checks, direct MTP sync, and Jellyfin are outside this version. See [validation](VALIDATION.md) for what has been verified.
