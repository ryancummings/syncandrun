# Privacy

SyncAndRun runs on the user's computer. It connects to the user's Plex account and chosen Plex server, writes music to a folder the user selects, and does not send user data to the project authors. It has no analytics, advertising, telemetry, or third-party crash reporting.

The local profile stores the Plex owner identity, server and library choice, selected playlist identifiers, encrypted Plex credentials, sessions, and playlist snapshots. Its encryption secret is stored beside the database. Old profiles may also contain historical watch records from the retired service; the desktop app does not use or send them. The **Back up app data** menu action copies the profile, including its secret. Keep backups private.

The export folder contains MP3 files, tags, and playlist names. Users transfer these files through an MTP app, Garmin Express, Music, or iTunes; those products have their own privacy terms. The local loopback service exists only while SyncAndRun is open. Plex sign-in uses Plex's service. SyncAndRun is unofficial and is not affiliated with Plex or Garmin.
