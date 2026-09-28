# Direct Garmin transfer and desktop portability

On Linux and macOS, the Rust desktop app detects Garmin music devices over USB MTP, shows their model,
firmware and free storage, and sends selected playlists directly to Music.
Choose **Direct to device**, select the device if there is more than one, and click
**Transfer to device**. No local export folder or mounted filesystem is involved.

## Reused open-source code

- [libmtp](https://github.com/libmtp/libmtp) implements MTP transport and device
  quirks. The app dynamically links the installed library using
  [libmtp-sys](https://github.com/quebin31/libmtp-rs) Rust bindings.
- [Garmin MTP CLI](https://github.com/Likenttt/garmin-mtp-cli) is a comparable
  open-source Garmin tool using libmtp directly. It supports detection and file
  uploads without mounting the device. Its code was reviewed as a reference;
  none was copied.
- [mtp-rs](https://github.com/vdavid/mtp-rs) offers a pure Rust implementation
  with Forerunner 955 fixes. Version 0.32.0 was evaluated, but its nusb dependency
  requires core-foundation 0.10.1 while GPUI 0.2.2 pins 0.10.0. Cargo rejects
  that combination even for Linux. Using libmtp avoids patching the UI framework.

Install `libmtp-dev` on Debian/Ubuntu or `libmtp` on Arch, including the package’s
USB permission rules. No daemon or MCP server is needed: the device uses **Media
Transfer Protocol (MTP)**. A busy-device message usually means Files, another MTP
app, or another SyncAndRun process owns the USB interface. Close or unmount it
there, then use **Scan for device**. The app scans periodically until it finds a usable
device. It also scans after a transfer or removal so the free-space display updates.
A raw USB check removes a disconnected watch from the display. Use **Scan for device** when you want an immediate check.

## macOS development references

These projects informed the macOS port. Their stated support alone does not
establish physical transfer acceptance for SyncAndRun.

| Project | Relevant evidence | Use for SyncAndRun |
| --- | --- | --- |
| [Garmin MTP CLI](https://github.com/Likenttt/garmin-mtp-cli) | Garmin-specific file reads and writes through libmtp; its build instructions use Homebrew on macOS and describe device contention with Garmin Express and other MTP apps. | Closest reference for opening a Garmin device directly through the library SyncAndRun already uses. |
| [OpenMTP](https://github.com/ganeshrvel/openmtp) | macOS file manager with explicit Garmin support. An earlier SyncAndRun export copied with OpenMTP appeared as playlists on a Forerunner 955; see [validation](VALIDATION.md). | Established manual-transfer fallback and a Mac device-access comparison. Its file manager does not implement SyncAndRun's transfer verification. |
| [HifiMule](https://github.com/HifiMule/HifiMule) | Music-sync app advertising Garmin profiles, MTP through libmtp, and macOS support. Its maintainer requests Mac and device feedback. | Product and device-flow comparison; do not treat its stated support as physical acceptance for SyncAndRun. |
| [mtp-rs](https://github.com/vdavid/mtp-rs/blob/main/crates/mtp-rs/README.md) | Pure Rust MTP library with Garmin handling. Its macOS notes describe USB ownership conflicts, including `ptpcamerad`; it does not implement MTP playlist operations. | Alternative transport to revisit if libmtp proves unsuitable, subject to the dependency conflict above and physical tests. |

[Homebrew packages libmtp for macOS](https://formulae.brew.sh/formula/libmtp),
and [GPUI supports macOS](https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md).
The native app now builds and launches on Apple Silicon macOS. The CLI detected
a connected Forerunner 955 Solar through libmtp after Garmin Express Service
and OpenMTP released the USB interface. The locally signed DMG bundles libmtp
and its dependencies, and the app uses the existing profile location
under Application Support. The physical Mac transfer, read-back, playlist
indexing and playback checks are separate acceptance work; see [validation](VALIDATION.md).

## Transfer behavior

- The same MP3 validation and ID3v2.3 tagging code serves direct and folder flows.
- One track is buffered in memory because MTP requires its exact length up front
  and Plex transcodes can omit Content-Length. A track larger than 256 MiB stops
  the transfer; lowering the bitrate may help. Audio is never staged on disk.
- Free space is checked before starting and before each upload. Estimates remain
  estimates; the actual track size is checked too.
- Each playlist gets a fresh `Music/<title> - SAR <run-id>` folder. Repeated tracks
  retain their order. The default add mode retains earlier music.
- **Replace watch music** is explicit and confirmed. It checks that all prior
  objects inside Music are recognized audio, playlist, or cover image files;
  unknown files refuse replacement before upload. It stages and verifies new
  playlists, then removes old objects. It needs enough free space to stage new
  music. Only the selected storage's Music subtree is eligible for deletion.
  Activities, Garmin apps, firmware, and other folders are untouched. Removal
  cannot be rolled back; cancellation or USB failure can leave both new and
  some old music. The app reports the partial state.
- **Manage watch music** lists top-level Music items and permits confirmed
  removal of one item after rechecking the connected watch. Folder sizes sum
  the reported sizes of files inside them.
- The CLI has an opt-in `--shared-tracks` layout. It puts one copy of each
  track in a single new folder with multiple M3U8 playlists. A repeated track
  appears in each playlist by path. This layout passed synthetic tests and USB
  read-back on the Forerunner 955 Solar. The first on-watch check found neither
  test playlist; those files had an unknown MTP object type. After changing the
  upload to use the playlist object type, both synthetic playlists appeared on
  the watch with the expected entry counts. The generated tone played from all
  entries in both playlists. This layout remains opt-in for other models. A
  [Forerunner 955 owner reports](https://forums.garmin.com/sports-fitness/running-multisport/f/forerunner-955-series/402291/how-to-copy-music-under-linux)
  using top-level Music playlists that reference tracks in subfolders. Garmin
  [lists M3U8 as a supported format](https://support.garmin.com/en-US/?faq=JyNEOTsZaR3KMXqej3oQp5).
- Every MP3 is read back and compared by byte count and SHA-256. Playlist files
  are published last and read back to check ordered track references.
- Direct playlists use Garmin’s `0:/MUSIC/…` paths and CRLF. On the Forerunner 955,
  uploading relative paths lets the watch expand them without updating the MTP
  object length, so later reads are truncated. Sending the final paths avoids
  that behavior. The existing folder exporter still uses relative M3U8 paths.
- Cancellation and errors trigger cleanup of the current attempt’s objects.
  If unplugging prevents cleanup, the app reports that incomplete SAR folders
  may remain. Earlier music is never part of cleanup.

Automatic matching of playlist identities across transfers is not implemented.
The `0:` music volume and playlist handling have been checked on the Forerunner
955 Solar; other Garmin models and storage layouts need physical acceptance.
See the [model compatibility guide](GARMIN-COMPATIBILITY.md) for Garmin's
documented families and a reproducible synthetic acceptance procedure.

## Evidence and reproduction

On 2026-09-27, using Linux, libmtp 1.1.23 and a Forerunner 955 Solar reporting
firmware `2905`, both CLI and the native GPUI desktop identified the watch and
transferred four generated MP3s across two playlists. All audio passed read-back
verification. Playlist upload exposed the rewrite/length behavior above; sending
canonical paths passed verification. The GUI showed completion after clicking
**Transfer to watch**. Only synthetic Plex metadata and an isolated profile were
used; source audio was generated and served from memory. No local MP3 files were
created. That first run established device transfer and read-back only.

After the MTP playlist-type fix, a shared-track run sent one generated MP3 and
two playlists. Both appeared on the watch with the expected three repeated
entries and one entry; every entry played the short tone. A distinct test of
the default separate-folder layout sent four generated MP3s in two playlists.
Both appeared with the expected three and one tracks, and every track played.
All tests used fake Plex data and disposable profiles. Other Garmin models,
real Plex media, and playback after destructive replacement remain untested.

```sh
cargo test --locked --workspace
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo build --locked --workspace
python3 scripts/native-smoke.py
# Explicit physical write acceptance, using synthetic music only:
python3 scripts/watch-smoke.py --write-watch
# Interactive synthetic desktop (requires a working X display):
python3 scripts/watch-smoke.py --write-watch --gui
```

Synthetic tests cover successful transfer, ordered repeats, keeping previous
music, multi-device discovery isolation, replacement scope and partial deletion,
folder size totals, shared tracks across playlists,
low space, invalid audio, failed downloads/uploads/read-back, cancellation,
and cleanup after disconnect. None of these unit tests accesses USB.
