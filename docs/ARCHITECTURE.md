# Architecture

The native Linux and macOS implementation is a Rust workspace. `syncandrun-core` owns the local
profile, Plex and Jellyfin requests, and streaming export engine. The GPUI desktop app runs
blocking work on worker threads and receives progress through a channel; the CLI
calls the same core. No local HTTP server is started. Linux and macOS support direct USB MTP transfer and the MTP folder
flow; the CLI also supports shared Tracks and Music/iTunes XML layouts.

Rust preserves the existing SQLite migration sequence and credential encryption
format. Native operations lock the profile, validate single-owner sign-in, reject
HTTP redirects, and keep tokens in request headers. Exports use unique incomplete
folders, ID3v2.3 tags, and plain relative M3U8 files for MTP. Tests use synthetic
profiles and fake Plex/Jellyfin servers. See [the native guide](RUST.md).
The desktop keeps nonsecret playlist and output preferences in an atomic JSON file
inside the profile. Its MTP export reconciles generated files directly inside the
chosen library folder using a hash manifest; it leaves unrelated files alone.

## Music providers

The native `provider::MusicSource` dispatches discovery, snapshots, diagnostics,
and MP3 requests to Plex or Jellyfin. Export layouts, tags, cancellation, and MTP
read-back use the same engine for both sources. Jellyfin uses server-local user
sign-in and header authentication, with redirect rejection and bounded JSON
responses. The saved connection pins the server and user identity. Playlist
entries retain their order and repeats; IDs are prefixed by provider.

Local folder is a third native source. Migration 012 saves the selected folder
without changing Plex or Jellyfin credentials. Discovery ignores symlinks and
caps depth, directory and file counts, and total source bytes. A folder that
contains audio becomes one playlist group. IDs use relative folder paths so
groups stay distinct. `ffprobe` supplies track durations; MP3 and FLAC files
stream through `ffmpeg` at the selected MP3 bitrate into the common tag writer.
The same verified MTP transfer engine handles all three sources.

Migration 011 adds Jellyfin credentials and the active music provider without
replacing Plex credentials, the Plex owner, or the ten historical migrations.
Switching sources clears snapshots and selection so an export cannot apply a
previous source's plan to the newly selected source. A saved source revision
also invalidates desktop playlist preferences after CLI source changes or a
connection to another library. The Jellyfin password is
used only for authentication; the resulting access token is encrypted in the
profile. Each audio request uses a unique playback session to avoid reusing a previous
transcode at another bitrate. Jellyfin stereo MP3 is limited to 256 kbps.
Both connections belong to the same personal local profile, and each
provider enforces its saved account identity on later sign-ins.

## Direct USB MTP

`core::device` reuses the system libmtp library through `libmtp-sys`. A small
RAII wrapper owns the device, file metadata, and synchronous memory callbacks.
A process mutex serializes discovery and transfer sessions. Worker threads
poll for Garmin USB devices, identify model/firmware/storage, and release the
connection after each scan. Transfers reopen and check the selected device’s
identity before writing. Raw serial numbers are not displayed or persisted.

Provider MP3 streams pass through the same tag/validation writer as folder exports,
into a bounded 256 MiB memory buffer. MTP needs the exact length before upload;
there is no audio staging directory. The transfer engine checks storage, creates
new folders under Music, uploads and hashes each MP3 by reading it back, then
publishes and validates the playlist. It deletes only objects created by the
current attempt on cancellation or failure; unsuccessful cleanup is reported.
A private target trait supplies an in-memory fake for failure tests. Discovery
keeps writable devices when another Garmin is busy and reports unavailable
devices separately. Optional replacement validates the Music subtree, stages
and verifies new playlists, then removes old recognized music objects. Unknown
files stop replacement before upload. Deletion is confined to Music and cannot
be rolled back; partial removal is reported. The desktop can inspect and remove
individual top-level Music items.

Garmin rewrites playlist paths while retaining the old MTP object length on the
validated Forerunner. Direct transfers therefore write canonical `0:/MUSIC/…`
paths with CRLF up front. Folder exports retain their existing relative M3U8
format. See [DIRECT-MTP.md](DIRECT-MTP.md) for evidence and limits.

The macOS app uses the same GPUI screens and core transfer engine. Its profile
defaults to Application Support so existing Electron credentials survive. The
drag-install package carries libmtp, ffmpeg, ffprobe, and their dynamic libraries;
the Linux build continues to use system packages. Watch troubleshooting uses
platform-specific read-only USB checks.

## Retained Electron implementation

The previous implementation is an Electron desktop app. The renderer shows Plex playlists and export choices. A narrow preload bridge lets it choose an output folder, start an export, receive progress, and open the result. Only Electron's main process writes music files.

The app starts an internal Fastify service on `127.0.0.1:31415` for Plex sign-in, playlist discovery, and local UI assets. It is available only while the app runs. A session cookie and CSRF token protect playlist changes. The first Plex account to sign in owns the local profile; later sign-ins must match that account. The service has no watch pairing, watch download, or LAN route.

Plex connection details, encrypted credentials, playlist snapshots, and owner state live in SQLite inside the user's Electron profile. The encryption secret lives beside the database and must be backed up with it. Existing SQLite migrations remain so a profile from the former watch service can open without deleting its Plex connection. Historical watch tables are inert; new code does not serve watch endpoints. The app menu can back up the profile.

`desktop/export.mjs` reads saved playlist snapshots and requests MP3 streams from Plex at the chosen bitrate. It writes ID3v2.3 tags, checks the MP3 header, and creates a new dated output folder. A failed run keeps an `.incomplete` folder and cannot overwrite a complete export. MTP output has one folder and ordered relative M3U8 per playlist. Music/iTunes output shares track files and writes playlist XML. Tokens never enter exported files.

This implementation exports through JavaScript in Electron's main process. The Linux Rust implementation is independent of that runtime. The Electron implementation does not offer direct MTP transfer or storage discovery. It supports Plex only. See [validation](VALIDATION.md) for what has been verified.
