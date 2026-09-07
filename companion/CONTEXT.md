# Companion

## Language

**Installation owner**:
The single user whose Plex connection, playlist choices, and paired watches belong to a companion installation.
_Avoid_: Host administrator

**Paired watch**:
A Garmin watch belonging to the installation owner, with its own revocable companion credential and synchronization state. One owner may pair multiple watches.
_Avoid_: User

**Live sync**:
A view of one watch's current synchronization, inferred from manifest requests, audio transfers, artwork requests, and sync results.
_Avoid_: Download queue

**Observed audio transfer**:
Audio bytes that pass from the companion toward a watch during a live sync.
A completed transfer does not prove that the watch committed the audio to its cache.
_Avoid_: Applied revision
