# Privacy

SyncAndRun runs on your computer. It contacts the music source that you choose and sends music to your watch or a local folder. It has no analytics, ads, cloud relay, or crash reporting. The project authors do not receive your music or profile.

The local profile stores one owner's identity, server and library choices, playlist choices, and encrypted Plex or Jellyfin tokens. Its encryption secret sits beside the database. Jellyfin passwords are not saved. Old profiles can contain historical watch records from the retired service. The native app does not use those records.

A profile backup contains the database and its secret. Keep it private. Exported folders contain music files, tags, and playlist names. Protect them like the source library. SyncAndRun starts no local web server or background service. Plex sign-in opens your browser and contacts Plex directly.
