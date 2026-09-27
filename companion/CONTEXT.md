# Local Plex service

This code is bundled into the desktop app. It serves Plex sign-in, playlist data, and UI assets on loopback while the app is open. It is not a separately deployed companion.

**Owner**: the first Plex account to sign in to a local profile. Later sign-ins must match it.

**Playlist snapshot**: ordered track IDs and metadata saved before export. An export uses only selected snapshots.

**Historical migrations**: original schema steps kept so existing profiles open safely. Watch tables from the retired app are inert.
