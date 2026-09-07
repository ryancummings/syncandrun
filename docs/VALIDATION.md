# Preview validation

This source preview is not a stable hardware-qualified release. Automated checks cannot prove offline Bluetooth playback, behavior during an activity, battery use, or the watch's compatibility with a particular tunnel certificate.

## Automated gate

Run `make verify` from a clean checkout with the prerequisites in [DEVELOPMENT.md](DEVELOPMENT.md). Record the source commit and tool versions with the results. This checks the companion, browser journey, protocol fixtures, `fr955` compile and simulator tests, memory profiles, secret scans, and native/cross-architecture containers including backup and restore.

For a public deployment, additionally verify that a visitor without a setup link cannot claim an empty installation, another Plex account cannot obtain management access, a setup link expires and cannot be reused, owner disconnect does not remove ownership, and multiple watches belonging to the owner retain separate credentials and synchronization state.

## Physical acceptance — awaiting the watch owner

All items below require a new result tied to the preview commit and deployment. Historical development results are not evidence for this build. Record firmware, source commit, artifact SHA-256, deployment method, result, and date without private metadata.

1. Install on a Forerunner 955 / Solar, enter the HTTPS companion origin, and pair with the short-lived watch code.
2. Synchronize two playlists with a shared track and verify order, deduplication, and all three bitrate profiles.
3. Repeat unchanged synchronization and confirm audio reuse.
4. Interrupt a transfer, restart, and confirm that synchronization resumes without losing completed audio.
5. Remove a playlist and confirm that tracks still used by another playlist remain playable.
6. Exercise insufficient storage and recover without corrupting the existing cache.
7. Disable watch networking and remove the phone, then play audio through Bluetooth headphones.
8. Record a 30-minute Run while using pause, next, previous, shuffle, and repeat; record battery use and failures.
9. Restart the watch and companion, verify persistence, then revoke the watch and confirm that new synchronization is denied.
10. Repeat pairing, artwork retrieval, long audio downloads, and interrupted synchronization through the chosen HTTPS tunnel.

Tailscale Funnel is an optional preview path until the last item passes on hardware. Do not claim a stable release or broader device compatibility from simulator results.
