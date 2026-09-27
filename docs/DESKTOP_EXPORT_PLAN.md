# Desktop music export pivot

Status: option A chosen and implemented in the desktop preview. Synthetic
export and Linux package checks pass; physical-watch and Music/iTunes imports
remain unverified.

## Product flow

SyncAndRun becomes a personal desktop application for macOS, Windows, and Linux.
It reads the owner's existing Plex playlists, converts selected tracks to local MP3
files, preserves playlist order in local playlist files, and shows the steps to
move the result to a Garmin music watch. Garmin's native player handles playback;
the Connect IQ watch app and watch pairing are retired once this flow works.

The application must not present a generated folder as already installed on a
watch. Export completion means that local files have been written and verified.
The user transfers them with Garmin Express or an MTP file manager and confirms
playback on the watch.

## Transfer routes

| Host | Supported route | What SyncAndRun prepares |
| --- | --- | --- |
| Windows | Garmin Express > Music > My Music, browsing to a local folder | Tagged MP3 files and ordered M3U8 playlists in a local folder. Garmin Express can scan the folder; the user selects content and sends it to the device. |
| Windows | iTunes or Windows Media Player library, then Garmin Express | The same local audio, plus a client-specific playlist import where that client can be verified. iTunes playlist visibility may require sharing its library XML with other apps. |
| macOS | Music library, then Garmin Express | Local audio and an import workflow that first adds the audio to Music, then builds playlists from those imported tracks. Importing a playlist before its tracks are in the library can silently omit tracks. |
| macOS | OpenMTP direct copy | A portable export with one folder per selected playlist. Ryan has confirmed that two exported folders copied with OpenMTP to a personal Forerunner 955 appeared as playlists. The role of any M3U/M3U8 files and track ordering remain separate acceptance checks. |
| Linux | MTP file manager direct copy | The same portable folder. Garmin Express is unavailable on Linux. Playback and playlist recognition require hardware verification for supported models. |

Garmin lists MP3, M3U, and M3U8 among supported types. Its documentation says WPL,
ZPL, and PLS playlists require Garmin Express; they must not be offered for direct
MTP copy. Garmin Express documentation also says media for its scanner must be on
the computer's local disk rather than a network or cloud volume. The app should
show this only when the Express route is selected.

## Export contract

- The user selects whole Plex playlists and a destination directory.
- Quality choices: MP3 constant bit rate at 64, 96, 128, 192, 256, and 320 kbps.
  The UI must distinguish tested compatibility from a nominal codec setting.
  Garmin's cited format list does not specify a maximum bitrate.
- For library and M3U8 routes, one transcoded audio file can be shared by
  playlists that reference the same Plex track. For the proven direct MTP route,
  preserve one folder per playlist even if shared tracks must be copied into
  both folders. Stable file names use opaque track IDs; display metadata lives
  in ID3 tags, not only in paths. M3U8 entries use relative paths and preserve
  duplicate appearances and order within a playlist.
- Include title, artist, album, album artist and track number when Plex provides
  them. Check file tags after writing; Garmin says missing ID3 tags can make
  content appear under opaque names or disappear from music views.
- Estimate unique-track bytes from duration and chosen bitrate, then compare
  with local destination free space. A model preset may show a published total
  capacity, but it must not claim to know available watch space without an MTP
  query or user-entered value. Forerunner 955 has up to 32 GB media storage,
  subject to actual device use.
- Download into temporary files, validate MP3 structure and tags, and rename
  atomically. Keep an export manifest for incremental refresh and safe cleanup.
  Do not delete unrelated files or previous working output on a failed export.
- A failed track must produce a visible per-track error and an incomplete export
  state. Resume must reuse verified files and preserve playlist order.
- Keep Plex credentials in OS-protected local app storage. Never write them to
  exported folders, logs, issue reports, or command arguments.

## Implementation direction

The first working path uses the inherited Electron desktop package and Plex
services, with export in the main process and a native folder picker. This
keeps local file access off the loopback HTTP API. Rust remains the preferred
language for a later filesystem and MTP engine. A Tauri shell is a possible
longer-term replacement after this flow is validated on target devices.

Direct MTP search and sync, Jellyfin, and device free-space discovery are future
features. The first release prepares files and shows an accurate handoff.

[HifiMule](https://github.com/HifiMule/HifiMule) is relevant prior art: its
published design uses a Rust daemon and Tauri UI with Garmin MTP support and
Jellyfin/Subsonic sources. It does not list Plex support. Review its behavior
and licensing before considering any reuse; no HifiMule code is included here.

## Owner's Mac export inspection

A read-only inspection of the owner's local export found two portable layouts:
playlist folders that contain MP3s and an M3U8 each, and a shared-tracks folder
with separate M3U8 playlist files. Every M3U8 entry resolved to a local MP3.
The MP3s had title, artist, and album tags. No track or playlist names were
recorded. Confirm which layout was copied to the watch and whether watch order
matched Plex before choosing the default MTP layout.

## Source notes

- [Garmin personal music installation](https://support.garmin.com/sv-SE/?faq=1ZDlVH09XB1169yYD5FIWA): Windows local folders and libraries; macOS Music/iTunes; Express transfer steps.
- [Garmin supported audio types](https://support.garmin.com/es-AR/?faq=JyNEOTsZaR3KMXqej3oQp5&identifier=1611937&tab=topics): MP3, M3U/M3U8, metadata, and Express-only playlist formats.
- [Garmin Express compatibility](https://support.garmin.com/en-US/navionics/faq/4QVp7mKSIA1LDk5fc1OHX8/): Windows and macOS support; Linux incompatibility.
- [Garmin Forerunner 955 manual](https://www8.garmin.com/manuals-apac/webhelp/forerunner955/EN-SG/GUID-3651B5E6-F4FA-4FE1-A3D5-95F818A6CE3D-3697.html): personal audio and Express instructions.
- [Forerunner 955 specifications](https://www8.garmin.com/manuals/webhelp/GUID-9D99A9D4-467A-4F1A-A0EA-023184FEA3DD/EN-AU/GUID-1303C86D-DC13-472B-A168-DE176AEFD1C0.html): up to 32 GB media storage.
- [Apple Music playlist import](https://support.apple.com/en-lamr/guide/music/mus27cd5060f/mac): import uses XML and includes only songs already in Music.
- [iTunes playlist import](https://support.apple.com/en-ie/guide/itunes/itns2998/windows): the same XML and library membership constraint.
- [Apple Music Windows import](https://support.apple.com/en-ca/guide/music-windows/mus3081/windows): adding a folder may leave pointers to the original files.

These are documentation claims, not physical-watch validation of every route or
quality setting. Ryan's OpenMTP result is direct personal-device evidence that
two exported folders from `~/Music/SyncAndRun` copied to a Forerunner 955
appeared as playlists.
