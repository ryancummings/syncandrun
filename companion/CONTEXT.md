# Companion

## Language

**Installation owner**:
The single user whose Plex connection, playlist choices, and paired watches belong to a companion installation.
_Avoid_: Host administrator

**Host administrator**:
The person who operates the hardware for one or more companion installations. An installation owner trusts this person with access to their credentials and library metadata.
_Avoid_: Installation owner

**Guest installation**:
A companion installation operated for its owner by another person, with its own credentials, settings, watch pairing, and data.
_Avoid_: Shared account

**Live sync**:
A view of one watch's current synchronization, inferred from manifest requests, audio transfers, artwork requests, and sync results.
_Avoid_: Download queue

**Observed audio transfer**:
Audio bytes that pass from the companion toward a watch during a live sync.
A completed transfer does not prove that the watch committed the audio to its cache.
_Avoid_: Applied revision
