# Direct Garmin transfer on Linux

The Rust desktop app detects Garmin watches over USB MTP, shows their model,
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

## Transfer behavior

- The same MP3 validation and ID3v2.3 tagging code serves direct and folder flows.
- One track is buffered in memory because MTP requires its exact length up front
  and Plex transcodes can omit Content-Length. A track larger than 256 MiB stops
  the transfer; lowering the bitrate may help. Audio is never staged on disk.
- Free space is checked before starting and before each upload. Estimates remain
  estimates; the actual track size is checked too.
- Each playlist gets a fresh `Music/<title> - SAR <run-id>` folder. Repeated tracks
  retain their order. Earlier music is retained, including earlier app transfers.
- Every MP3 is read back and compared by byte count and SHA-256. Playlist files
  are published last and read back to check ordered track references.
- Direct playlists use Garmin’s `0:/MUSIC/…` paths and CRLF. On the Forerunner 955,
  uploading relative paths lets the watch expand them without updating the MTP
  object length, so later reads are truncated. Sending the final paths avoids
  that behavior. The existing folder exporter still uses relative M3U8 paths.
- Cancellation and errors trigger cleanup of the current attempt’s objects.
  If unplugging prevents cleanup, the app reports that incomplete SAR folders
  may remain. Earlier music is never part of cleanup.

Automatic reconciliation/removal of earlier watch transfers is not implemented.
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
music, low space, invalid audio, failed downloads/uploads/read-back, cancellation,
and cleanup after disconnect. None of these unit tests accesses USB.
