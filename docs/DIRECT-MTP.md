# Direct Garmin transfer and desktop portability

On Linux, the Rust desktop app detects Garmin watches over USB MTP, shows their model,
firmware and free storage, and sends selected Plex playlists directly to Music.
Choose **Direct to watch**, select the watch if there is more than one, and click
**Transfer to watch**. No local export folder or mounted filesystem is involved.

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
USB permission rules. No daemon or MCP server is needed: the watch uses **Media
Transfer Protocol (MTP)**. A busy-device message usually means Files, another MTP
app, or another SyncAndRun process owns the USB interface. Close or unmount it
there, then use **Scan USB**. The app also scans periodically while idle.

## macOS development references

These projects are useful when bringing direct transfer to macOS. Their stated
support does not establish that SyncAndRun's Rust app works on a Mac; this project
has not built or run that app there.

| Project | Relevant evidence | Use for SyncAndRun |
| --- | --- | --- |
| [Garmin MTP CLI](https://github.com/Likenttt/garmin-mtp-cli) | Garmin-specific file reads and writes through libmtp; its build instructions use Homebrew on macOS and describe device contention with Garmin Express and other MTP apps. | Closest reference for opening a Garmin watch directly through the library SyncAndRun already uses. |
| [OpenMTP](https://github.com/ganeshrvel/openmtp) | macOS file manager with explicit Garmin support. An earlier SyncAndRun export copied with OpenMTP appeared as playlists on a Forerunner 955; see [validation](VALIDATION.md). | Established manual-transfer fallback and a Mac device-access comparison. Its file manager does not implement SyncAndRun's transfer verification. |
| [HifiMule](https://github.com/HifiMule/HifiMule) | Music-sync app advertising Garmin profiles, MTP through libmtp, and macOS support. Its maintainer requests Mac and device feedback. | Product and device-flow comparison; do not treat its stated support as physical acceptance for SyncAndRun. |
| [mtp-rs](https://github.com/vdavid/mtp-rs/blob/main/crates/mtp-rs/README.md) | Pure Rust MTP library with Garmin handling. Its macOS notes describe USB ownership conflicts, including `ptpcamerad`; it does not implement MTP playlist operations. | Alternative transport to revisit if libmtp proves unsuitable, subject to the dependency conflict above and physical tests. |

[Homebrew packages libmtp for macOS](https://formulae.brew.sh/formula/libmtp),
and [GPUI supports macOS](https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md).
Those are prerequisites, not a successful Mac build or device test. The first
Mac check should use a connected watch to detect and list storage with libmtp,
then test the Rust CLI with a disposable profile. Before claiming parity with
Linux, verify upload, byte-for-byte read-back, playlist indexing and playback,
cancel/disconnect cleanup, and recovery when another app owns the USB device.
Also check app packaging of libmtp and its dependencies on both Mac architectures
and preserve the existing Electron profile under macOS Application Support;
the current Rust default profile path is Linux-oriented.

## Windows development references

Windows provides [Windows Portable Devices (WPD)](https://learn.microsoft.com/en-us/windows-hardware/drivers/portable/wpd-drivers-overview)
and [standard MTP class drivers](https://learn.microsoft.com/en-us/windows-hardware/drivers/portable/the-mtp-setup-information---inf--file).
This gives an application a native path to an attached watch without replacing
its normal Windows driver. None of the references below establishes successful
Windows transfer with SyncAndRun's Rust app or a Forerunner 955.

| Project or API | Relevant evidence | Use for SyncAndRun |
| --- | --- | --- |
| [mtp-rs](https://github.com/vdavid/mtp-rs/blob/main/crates/mtp-rs/README.md) | Its Windows backend uses WPD for device discovery and file operations without installing a USB driver. The author reports hardware verification on a Pixel 9 Pro XL; its Forerunner 955 evidence is a separate read-only integration test, not a Windows watch transfer. | Candidate adapter for Windows if it can build with this workspace and pass Garmin hardware tests. |
| [winmtp](https://docs.rs/winmtp/latest/winmtp/) | Windows-only Rust wrapper for WPD with device and content enumeration plus file transfer. | Smaller reference for a direct WPD adapter; check its API against SyncAndRun's read-back and cleanup needs. |
| [libmtp Windows notes](https://github.com/libmtp/libmtp/blob/master/README.windows.txt) and [Garmin MTP CLI](https://github.com/Likenttt/garmin-mtp-cli) | libmtp documents a MinGW/MSYS build and libusb driver setup. Garmin MTP CLI disables its libmtp backend in the default Windows build because that route is not reliable through its current toolchain. | Treat reuse of the Linux USB wrapper on Windows as unproven; test native WPD before considering a driver change. |
| [HifiMule](https://github.com/HifiMule/HifiMule) | Advertises Windows, Garmin device profiles and MTP music sync. Its maintainer asks for more device feedback. | Product comparison, not hardware acceptance for this app. |

The first Windows check should enumerate and list the watch's Music storage
through WPD with the normal driver, then upload and read back synthetic files
using an isolated profile. Test playlist indexing and playback, cancellation,
disconnect cleanup, competing access, and packaged launch separately. The Rust
core currently uses Unix-specific profile permission APIs and a Linux-oriented
default profile path, so Windows also needs profile portability work that keeps
existing encrypted Electron profiles usable. The current Electron Windows build
exports folders for manual transfer; it has no direct MTP implementation.

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
  read-back on the Forerunner 955 Solar. On-watch browsing and playback remain
  unverified. A [Forerunner 955 owner reports](https://forums.garmin.com/sports-fitness/running-multisport/f/forerunner-955-series/402291/how-to-copy-music-under-linux)
  using multiple playlists that reference tracks in Music subfolders. Garmin
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

## Evidence and reproduction

On 2026-09-27, using Linux, libmtp 1.1.23 and a Forerunner 955 Solar reporting
firmware `2905`, both CLI and the native GPUI desktop identified the watch and
transferred four generated MP3s across two playlists. All audio passed read-back
verification. Playlist upload exposed the rewrite/length behavior above; sending
canonical paths passed verification. The GUI showed completion after clicking
**Transfer to watch**. Only synthetic Plex metadata and an isolated profile were
used; source audio was generated and served from memory. No local MP3 files were
created. This is device transfer evidence, not on-watch playback acceptance.

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
