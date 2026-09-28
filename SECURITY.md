# Security

Report a vulnerability through [GitHub private vulnerability reporting](https://github.com/ryancummings/syncandrun/security/advisories/new). Include the affected version or commit and steps that use synthetic data. Do not attach a real profile, database, token, music file, or private library name.

A local SQLite profile stores encrypted Plex and Jellyfin tokens. The encryption secret is stored beside the database. Back up and protect both files together. The first Plex account that signs in owns the profile. Later sign-ins must match that owner. Exported files do not contain service tokens.

The app sends music directly to a selected watch over USB MTP. Replace mode asks for confirmation before it removes old recognized music from the watch's `Music` folder. That removal cannot be undone. The app has no auto updater or local network service.
