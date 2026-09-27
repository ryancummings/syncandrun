# Validation

## Direct Linux USB transfer (2026-09-27)

The native GPUI desktop and CLI identified a plugged-in Forerunner 955 Solar
(firmware `2905`) and transferred four generated MP3s and two playlists directly
over libmtp 1.1.23. The desktop showed the model and free space, and its transfer
button completed the operation. Audio read-back passed byte-count and SHA-256
checks; playlists passed ordered-reference checks. No local MP3 files were
created. Testing used fake Plex and a disposable profile; no production Plex
profile or library was read. Playback after disconnect remains unverified.
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

Real Plex browser authorization and playback of Rust-generated output on a
Garmin watch remain unverified. The fake MP3 stream verifies file handling,
not playable audio. Historical watch results below apply to the Electron
exporter. Recheck physical acceptance before describing Rust output as
watch-validated.

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
purge also passed in an isolated synthetic home. A real Plex export through the revised desktop
interface and physical watch playback remain to be checked.

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
