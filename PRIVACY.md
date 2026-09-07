# Privacy policy

SyncAndRun for Garmin is self-hosted software. The person who operates a
SyncAndRun companion controls the service and its data; the project authors do
not receive that data.

The companion stores the selected Plex server and library, selected playlist
identifiers, encrypted Plex credentials, browser sessions, watch device
credentials, synchronization status, and service configuration in its local
SQLite database. Plex audio and artwork flow from the operator's Plex server,
through the companion, to the paired watch. The companion does not retain an
audio cache in v1.

SyncAndRun has no analytics, advertising, telemetry, or third-party crash
reporting. Normal service logs contain operational metadata and request ids;
credential fields and credential-bearing URLs are redacted. The operator is
responsible for protecting logs, backups, the HTTPS endpoint, and the
`SYNCANDRUN_SECRET` used to encrypt Plex credentials.

The browser Settings screen can disconnect Plex, revoke an individual watch,
or erase companion library data. Installation ownership remains bound until an
operator deliberately resets the installation. Disconnecting Plex invalidates local browser and
watch credentials. Revoking a watch prevents future synchronization but does
not remotely erase audio already stored on that watch. The watch's reset
action removes its local pairing state and cached SyncAndRun media.

Plex and Garmin process data under their own terms when the operator uses
their products. SyncAndRun is unofficial and is not affiliated with either
company.

The installation owner authenticates with their Plex identity. The companion
retains the identity needed to enforce ownership after a disconnect. Every
paired watch belongs to that owner and has its own revocable credential.

An optional tunnel provider routes HTTPS traffic to the host and processes
connection metadata under its own policy. A self-hosted companion does not
mean all traffic stays on the LAN: Plex authentication, Garmin artwork
retrieval, and a public tunnel can involve external services.
