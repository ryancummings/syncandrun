# Architecture

SyncAndRun uses a Rust workspace. `syncandrun-core` owns profiles, music sources, exports, and USB transfers. `syncandrun-desktop` draws the Mac and Linux interface with GPUI. `syncandrun-cli` uses the same core for terminal commands. The desktop sends slow work to worker threads and shows progress from events.

## Music and profiles

Plex, Jellyfin, and Local folder use one music-source interface. Source discovery produces playlists and track details. The export engine requests or reads audio, converts it to MP3, writes ID3 tags, and builds M3U8 playlists. Local files and downloaded audio use the same validation code.

The local SQLite profile belongs to one owner. Plex and Jellyfin tokens are encrypted with a secret stored beside the database. Source changes clear old playlist choices. Rust keeps the historical database migrations so an existing profile can open without losing its credentials. The old app and service remain available in Git history, but they are not part of this build.

The desktop saves nonsecret choices in an atomic JSON file in the profile. A folder export tracks its generated files with hashes. It can reuse unchanged files and leaves unrelated files alone. A failed export stays in a separate `.incomplete` folder.

## Device transfer

The device module uses libmtp through `libmtp-sys`. A process lock keeps device discovery and transfers from opening the same USB interface at once. Transfers check device identity and free space before writing. The app buffers one MP3 at a time because MTP needs its size before upload.

Each uploaded MP3 passes a read-back size and hash check. The app publishes a playlist after its tracks pass. A failed attempt removes only objects made by that attempt when the watch remains connected. Replace mode checks the selected `Music` tree, sends new music, and then removes recognized old music. Unknown files stop replacement before upload.

The desktop checks raw USB presence every two seconds while a watch is listed and the app is idle. A missing watch disappears from the interface. Full MTP discovery continues while no usable watch is listed. The Mac package bundles libmtp, audio tools, fonts, and licenses. Linux uses system packages.
