# Validation

This page separates automated tests, package checks, and physical watch results. A successful build or USB read-back does not prove that a watch lists a playlist or plays its tracks.

## Automated checks

The Rust workspace has 41 core tests and one Mac desktop diagnostic test. Tests use fake Plex and Jellyfin servers, generated audio, isolated profiles, and a fake device target. They cover profile migration, owner checks, playlist order, repeated tracks, MP3 output, direct transfer, read-back, cancellation, cleanup, and device presence. Linux CI also runs the native smoke script with a fake Plex server.

Run these checks before a pull request:

```sh
cargo fmt --all -- --check
cargo test --locked --workspace
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo build --locked --workspace
python3 scripts/native-smoke.py
```

The legacy credential test and smoke script need Node.js as an independent encryption test. One Mac had a broken default Node executable. The complete suite passed there with the working Node 22 installation. Linux CI passed the full workspace suite at commit `048c317`.

## Mac package and device checks

On Apple Silicon macOS, the app built and launched from a drag-install DMG. The DMG bundles libmtp, ffmpeg, ffprobe, fonts, and their license files. Strict `codesign` checks passed. The bundled audio tools worked without Homebrew in `PATH`. A synthetic local MP3/M3U8 folder export passed.

The CLI and packaged app detected a Forerunner 955 Solar and read its storage after other MTP apps released USB. This was a read-only check. A direct Mac transfer, watch playlist listing, and playback remain open checks. The new device-disconnect display and steady waiting line also need a physical unplug check.

## Linux physical watch results

On a Forerunner 955 Solar with firmware 2905, the native Linux app and CLI sent generated MP3 files and M3U8 playlists through libmtp. Uploaded files passed read-back checks. The watch listed two synthetic playlists with the expected track counts and repeated entries. Each tested entry played the generated tone.

A replacement test sent new synthetic music and then removed 137 recognized old music objects under `Music`. It left other watch folders alone. The Manage device content page showed folder sizes and reloaded after one synthetic item was removed. These results apply to this watch and firmware. Other models need separate physical checks.

## Device acceptance procedure

Use a disposable profile and music that the owner authorizes for the test. The command below writes synthetic playlists to the connected watch. It does not remove them after the test.

```sh
python3 scripts/watch-smoke.py --write-watch
```

1. Record the watch model, edition, firmware, host system, app commit, and transfer method.
2. Make sure that the MP3 files and playlists pass USB read-back checks.
3. Eject and disconnect the watch. Check playlist names, order, repeated entries, and playback on the watch.
4. Reconnect the watch. Make sure that add mode kept the old music.
5. Test replacement only with a watch library that the owner agrees to erase.

Do not publish real music, credentials, profile files, or private playlist names in a test report. See [the model guide](GARMIN-COMPATIBILITY.md) for models that still need checks.
