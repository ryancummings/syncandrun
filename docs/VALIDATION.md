# Validation

## Local folder source (2026-09-28)

Synthetic tests cover bounded, symlink-free MP3/FLAC discovery, profile switching
without losing saved Plex or Jellyfin connections, duration-based size estimates,
and conversion of both formats to the selected MP3 bitrate. A generated FLAC
playlist passed transfer through the fake watch target, including MP3 and M3U8
objects. The native desktop built and its Local folder page was inspected with
an isolated profile containing a generated tone. No real library or NAS data
was accessed. A physical watch transfer from the Local folder source has not
been tested.

## Jellyfin in the Linux app and CLI (2026-09-28)

A disposable Jellyfin 10.11.6 server with generated FLAC tones passed native
CLI authentication, music library and playlist discovery, refresh, and MP3
exports at 64, 96, 128, 192, and 256 kbps. `ffprobe` confirmed the MP3 codec and
exact bitrate. MTP folder exports preserved track order; Express and Music layouts shared
two track files, and Music XML preserved both playlist sequences. Repeated
entries are covered by synthetic API tests; Jellyfin's playlist API removes
duplicates when creating playlists. Restoring a backup retained the encrypted
connection and could list playlists. Wrong passwords and a second account
were rejected without replacing the saved owner's connection.

Jellyfin 10.11.6 caps stereo MP3 at 256 kbps in its
[audio encoding helper](https://github.com/jellyfin/jellyfin/blob/v10.11.6/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs).
The app therefore hides 320 kbps for Jellyfin, and the CLI rejects it before
creating output. Testing also found transcode reuse across quality changes;
each request now supplies a unique playback session ID. All five bitrate
checks passed after this fix. Plex retains its 320 kbps option.

The native desktop launched on a physical Linux graphical session with an
isolated profile and USB access disabled. Typed URL, username, and password
entry, password masking, Tab navigation, Enter submission, music library
selection, and loading both generated playlists passed. The full GUI folder-export
interaction was not run; folder exports were verified through the CLI. No production profile
or library was opened. The real-server smoke test is reproducible with
`scripts/jellyfin-smoke.py`; its container and data are disposable.

Workspace build, formatting, strict Clippy, and 38 Rust tests pass. The retained
companion build and 100 tests pass, with migration/readiness tests rerun after
the source revision column was added.

Synthetic tests cover Jellyfin pagination, repeated entries, library filtering,
base-path URLs, redirect rejection, identity checks, cancellation, encrypted
connection storage, provider switching, source revision tracking, and legacy
Plex profile migration. The existing Plex CLI smoke still passes all three
export layouts and backup restoration. The retained Electron implementation
remains Plex-only; its migration list includes the additive provider schema
so it can reopen a profile switched back to Plex.

Jellyfin uses the existing direct MTP engine. A physical watch transfer and
playback from Jellyfin have not been tested; earlier watch results below are
separate evidence. macOS and Windows Jellyfin support is not implemented.

## On-watch playlist and playback acceptance (2026-09-27)

On a Forerunner 955 Solar running firmware 2905, the corrected direct MTP
transfer passed USB read-back and on-watch checks with generated audio. Two
shared-track test playlists appeared under My Music with three repeated entries
and one entry, matching the synthetic fixture; every entry played the short
tone. A separate-folder test used distinct playlist names. Both playlists
appeared with three and one tracks, and every track played the tone. The
separate-folder layout is the desktop default. Each test used a disposable
profile and fake Plex data; no real Plex library or media was accessed.

The first shared-track upload had passed USB read-back but produced no visible
playlists. It marked M3U8 files as unknown MTP objects. The corrected upload
marks them as playlists. This matches the successful repeat test, though an
indexing delay after the first upload cannot be ruled out.

## Transfer details and page navigation (2026-09-27)

The desktop now has Playlists, Watch music, and Settings tabs. Watch transfer
details stay below the playlist page: verified tracks and bytes, estimated
size, average verified-byte rate, elapsed time, and an estimated time left.
After an item is removed from watch Music, the app reloads the remaining items
automatically. A failed reload says so and offers Refresh watch music.

Two new synthetic tests cover partly overlapping shared-track playlists and
cleanup after an upload fails during the second playlist. The workspace has 33
passing core tests. The isolated native GUI passed the Settings, folder-picker
export, confirmed library purge, and default-library confirmation flows on a
physical Xwayland session.
An isolated window was also inspected floating at 1100 × 850, where a Settings
tab click landed correctly. These UI checks did not use the watch. The real app
was opened as a floating window for manual inspection; the revised progress
display and automatic watch-list reload have not yet been checked on hardware.
Automatic USB scans continue while no usable watch is listed. Once a watch is
found, the app leaves the watch display steady. It scans after a transfer or
removal to update free space. Use **Scan for watch** after connecting,
disconnecting, or changing watches. The post-write scan has not been checked
on hardware.

## Watch music management and shared tracks (2026-09-27)

The updated CLI replaced recognized content inside Music on a Forerunner 955
Solar with two synthetic playlists. Four generated MP3 uploads passed read-back;
137 older music objects were removed. The run did not access a real Plex profile
or print music names. The desktop Manage watch music page showed folder sizes,
confirmed removal of one synthetic folder, and showed the remaining folder
after refresh. Its two transfer choices and removal prompt were inspected in
the native Xwayland window.

An opt-in shared-track run sent one generated MP3 and two M3U8 playlists in one
folder. Both playlists passed USB read-back with references to the same track.
After disconnecting, Ryan reported that neither test playlist appeared on the
watch. USB read-back alone does not establish that Garmin indexed the files.
The first shared layout failed on-watch acceptance. The first transfer labeled
M3U8 files as unknown MTP objects. A second synthetic transfer labeled them as
playlists, as GNOME GVfs does for M3U content. After disconnecting, both
playlists appeared on the watch: playlist 1 showed three entries of the same
track and playlist 2 showed one. Those counts match the fixture. Ryan played
all entries from both playlists; each played the generated short tone. The
type change is consistent with the result, but the test does not rule out an
indexing delay after the first transfer.

Thirty synthetic core tests, strict Clippy, workspace build, and the CLI smoke
passed. A physical GUI session used an isolated synthetic profile. Xvfb was
not used for this revision.

## Direct Linux USB transfer (2026-09-27)

The native GPUI desktop and CLI identified a plugged-in Forerunner 955 Solar
(firmware `2905`) and transferred four generated MP3s and two playlists directly
over libmtp 1.1.23. The desktop showed the model and free space, and its transfer
button completed the operation. Audio read-back passed byte-count and SHA-256
checks; playlists passed ordered-reference checks. No local MP3 files were
created. Testing used fake Plex and a disposable profile; no production Plex
profile or library was read. The later corrected transfer passed on-watch
listing and playback as recorded above.
See [DIRECT-MTP.md](DIRECT-MTP.md) for Garmin’s playlist rewrite behavior and the
explicit physical acceptance command.

The workspace has 23 passing synthetic core tests after this change. Formatting,
strict Clippy, workspace build and the existing CLI smoke pass. The native GUI
was visually inspected through the physical Linux Xwayland session. Xvfb launch
was not validated in this session: a software Vulkan ICD was unavailable, and
the hardware driver could not present to Xvfb. The automated GUI fixture now
uses `--no-usb`, so it cannot access a physical watch.

## Earlier Rust Linux implementation

The native Rust workspace builds on Ubuntu 24.04 x86_64 with Rust 1.98.1 and
GPUI 0.2.2. Fourteen synthetic core tests pass, including all historical migration
SQL, bidirectional Node/Rust credential encryption, owner enforcement, native
profile locking, backup recovery, Plex pagination and identity checks, redirect
rejection, MTP repeats/order, shared-file XML, ID3 handling, cancellation, and
failed-export isolation. `cargo fmt`, workspace tests, and strict Clippy pass.

The CLI smoke script exercises discovery, refresh, estimates, all three export
layouts, and backup restoration using a temporary profile and a fake local Plex
server. The native GPUI binary has launched under Xvfb/Openbox with software
Vulkan. Its synthetic smoke test changed bitrate and playlist selection, chose
an output directory through the GTK desktop portal, and created an export. The
resulting window was visually inspected. This is a native development-binary
launch, not a packaged installer test.

On 2026-09-27, the native development binary from commit `9267f86` also launched
in a physical Linux Hyprland/Wayland session. The window was mapped and focused,
and the user confirmed that it worked. The desktop binary SHA-256 was
`d3d83c9ee18ed5a22fd8baafd24f8051dd52954762467f3cc9a3360b04dc001b`.
This confirms the native launch and visible interface, not the complete export
workflow with a real Plex library.

Real Plex browser authorization and real-library transfer remain unverified.
The earlier fake MP3 stream tested file handling; later generated MP3 tones
passed playback on the Forerunner 955 Solar as recorded above. Historical
watch results below apply to the Electron exporter.

The Linux desktop revision adds separate available/syncing playlist lists,
persisted library and bitrate settings, connection diagnostics, a progress bar
with an estimated remaining time, and a managed music library folder. The
default is `~/Music/SyncAndRun` and is created only after confirmation.
Synthetic tests cover repeat reconciliation, unchanged file reuse, unrelated
file preservation, safe library purge, and refusal to replace an externally
edited generated file.
The native GPUI window was launched under Xvfb and visually inspected after
this revision. A synthetic export through Settings, the GTK folder picker, and
the desktop action produced the expected three MP3 files and saved the chosen
playlist and library folder. The confirmed default-folder export and confirmed
purge also passed in an isolated synthetic home. A real Plex export through the
revised desktop interface and playback of its folder-exported files remain to
be checked.

Reproduce automated and native launch checks using [the Rust guide](RUST.md).

## Historical Electron and physical-device evidence

Automated checks cover TypeScript, Plex sign-in and ownership, playlist snapshots, desktop UI flow, MP3 export layout, and failed-export isolation. Build and launch the native package on each target operating system before describing it as supported. Use an empty isolated profile for launch checks and record the source commit, artifact hash, OS, and result.

The Linux package has built and launched with a ready loopback service. Native macOS and Windows package launches remain unverified. A previous two-folder export copied with OpenMTP appeared as playlists on a personal Forerunner 955. On Linux, the 320 kbps export copied 20 MP3s through GVfs MTP and every file matched the source byte for byte. The watch discarded an extended M3U8 file with an `#EXTM3U` header; a plain relative-path M3U8 survived, was rewritten by the watch to device paths, appeared under its exported title, and played a track. This confirms one Linux playlist transfer and playback at 320 kbps. It does not verify every track, playlist order, other bitrates, or the Music/iTunes and Express routes.

For physical acceptance, using only music the owner authorizes for testing:

1. Export two playlists at 192 kbps and copy their folders into the Forerunner 955 Music folder with OpenMTP. Check names, order, repeated entries, tags, and playback.
2. Repeat at 320 kbps. Garmin documents MP3 support but the cited format list does not set a maximum bitrate for this watch.
3. Check an interrupted export and a playlist with shared tracks. Confirm an earlier complete export still works.
4. On macOS, add Tracks to Music, import the XML, and confirm Express sees and sends both playlists.
5. On Windows, check Express's local-folder scanner and the iTunes XML route. On Linux, use the direct MTP acceptance command above, then check playlist browsing and playback.
6. Compare the app's size estimate with actual output and the watch's available space. The Linux Rust app now reports watch storage; compare the actual change with the estimate.

Record model, firmware, transfer method, app/OS versions, commit, and result without posting private playlist names, media, tokens, or profile data. Do not claim a route or bitrate has been accepted by hardware until it has been tested.
