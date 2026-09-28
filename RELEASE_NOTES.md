# SyncAndRun 0.2.0

This release provides native Mac and Linux apps. Both apps use the same interface and support Plex, Jellyfin, and local MP3 or FLAC folders. You can choose playlists and MP3 quality, send music directly to a Garmin music watch, or export folders for a manual copy. Direct transfers read files back before reporting success.

Download the Mac DMG or Linux archive below. Follow the [installation and usage steps](README.md#download-and-install). The Mac DMG runs on Apple Silicon and has a local signature. Apple has not notarized it, so macOS can ask you to select Open Anyway after the first launch. The Linux archive targets Ubuntu 24.04 x86_64 and needs the system packages listed in the README.

Direct transfer and playback passed a synthetic music test on a Forerunner 955 Solar under Linux. The Mac app detected the watch and read its storage. A direct Mac transfer and playback check remain open. Other Garmin models need their own physical checks. See [validation](docs/VALIDATION.md).

The older desktop app and service are removed from this source tree. Existing local profiles keep their historical database migrations and encrypted connections. Back up the profile before an upgrade if you need to return to an older version.
