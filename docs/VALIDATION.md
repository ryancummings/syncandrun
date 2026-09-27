# Desktop export validation

The new desktop flow has passed TypeScript checks, export structure tests with
fake Plex metadata, a browser screenshot check with fake Plex, and a native
Linux package build and launch. The package answered its loopback readiness
check. These checks do not prove that a real Plex server returns playable audio
at every offered bitrate or that a Garmin watch recognizes the new files.

Before calling the desktop app ready, verify on the owner's Forerunner 955:

1. Export two selected playlists from a real Plex library at 192 kbps. Copy
   their folders into the watch's Music folder with OpenMTP. Confirm names,
   track order, tags, playback, and repeat entries.
2. Repeat at 320 kbps and confirm playback. Garmin's format documentation lists
   MP3 but gives no maximum bitrate for this watch in the cited material.
3. Check a failed/interrupted export, an export with shared tracks, and a watch
   with too little free space. Confirm previous complete folders remain usable.
4. On macOS, add the exported Tracks folder to Music, then import the playlist
   XML and check that Garmin Express sees and sends both playlists.
5. On Windows, check Garmin Express's local-folder scanner and the optional
   iTunes import route. On Linux, check an MTP copy with the target device.

Record the source commit, app and OS versions, Garmin model and firmware,
transfer method, and result without posting private music metadata. Do not
claim compatibility for a transfer route that has only automated evidence.

## Previous watch-app validation plan

This source preview is not a stable hardware-qualified release. Automated checks cannot prove offline Bluetooth playback, behavior during an activity, battery use, or the watch's compatibility with a particular network route.

## Automated gate

Run `make verify` from a clean checkout with the prerequisites in [DEVELOPMENT.md](DEVELOPMENT.md). Record the source commit and tool versions with the results. This checks the companion, browser journey, protocol fixtures, `fr955` compile and simulator tests, memory profiles, secret scans, and native/cross-architecture containers including backup and restore.

Docker verification creates a unique disposable Compose project and image tags,
uses an automatically assigned loopback port, and ignores deployment `.env` files,
Compose overrides, and enabled profiles. It removes only its own test resources.
The native stage checks startup, browser security headers, restart persistence,
and stopped-service backup/restore. The cross-architecture stage requires Docker
Buildx and CPU emulation; missing prerequisites leave that stage unverified and
cause the command to fail even when the native stage passed.

For desktop packages, additionally build on each native OS, launch with an isolated empty user profile, inspect a screenshot of the first-run and management windows, verify `/health/ready` and anonymous 401 from another LAN device, then restart and verify persistence. Record OS, architecture, artifact hash, and whether the app was actually launched. A package cross-built for Windows on Linux is not a native Windows run. Test a real Plex connection only with the owner's authorization and without printing credentials or library data. The desktop app's HTTP route uses a private IP and port 31415; test that the exact watch origin is reachable on the intended LAN and is not publicly forwarded.

Secret scanning covers history reachable from the current `HEAD`, the working
tree, and generated build artifacts. Unrelated fetched branches are outside this
release gate; inspect all local refs separately with
`gitleaks git --no-banner --redact --log-opts=--all .` when auditing archives.

For a public deployment, additionally verify that the owner claimed the installation before it was exposed, another Plex account cannot obtain management access, owner disconnect does not remove ownership, and multiple watches belonging to the owner retain separate credentials and synchronization state.

## Physical acceptance — awaiting the watch owner

All items below require a new result tied to the preview commit and deployment. Historical development results are not evidence for this build. Record firmware, source commit, artifact SHA-256, deployment method, result, and date without private metadata.

1. Install on a Forerunner 955 / Solar, enter the configured companion origin, and pair with the short-lived watch code.
2. Synchronize two playlists with a shared track and verify order, deduplication, and all three bitrate profiles.
3. Repeat unchanged synchronization and confirm audio reuse.
4. Interrupt a transfer, restart, and confirm that synchronization resumes without losing completed audio.
5. Remove a playlist and confirm that tracks still used by another playlist remain playable.
6. Exercise insufficient storage and recover without corrupting the existing cache.
7. Disable watch networking and remove the phone, then play audio through Bluetooth headphones.
8. Record a 30-minute Run while using pause, next, previous, shuffle, and repeat; record battery use and failures.
9. Restart the watch and companion, verify persistence, then revoke the watch and confirm that new synchronization is denied.
10. On the watch's intended network, verify DNS resolution when the origin uses a name and repeat pairing, artwork retrieval, long audio downloads, and interrupted synchronization through the exact deployed route. For a home-only route, use home Wi-Fi and verify that the endpoint is not publicly reachable; for public ingress, test from outside the LAN.

Tailscale Funnel is optional. Do not claim route compatibility, a stable release, or broader device compatibility from simulator results.
