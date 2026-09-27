# SyncAndRun

SyncAndRun is a personal desktop app that turns Plex playlists into local MP3
folders for a Garmin music watch. Choose playlists, MP3 quality, a transfer
method, and a place to save. The app creates the files; you then move them to
the watch with an MTP app or Garmin Express.

This is a source preview. The new export has automated checks and a Linux native
launch check, but its files have not yet been played on a physical watch. An
earlier local export copied with OpenMTP appeared as two playlists on a personal
Forerunner 955. See [validation](docs/VALIDATION.md).

## Transfer methods

| Computer | Choose in the app | Next step |
| --- | --- | --- |
| macOS | MTP app | Copy the playlist folders into the watch's Music folder with OpenMTP or another MTP app. |
| macOS | Music + Express | Add the exported tracks to Music, import the playlist XML, then send them with Garmin Express. |
| Windows | Garmin Express | Add the saved local folder under **Music > My Music** in Garmin Express. |
| Windows | iTunes + Express | Add the exported tracks to iTunes, import the playlist XML, then send them with Garmin Express. |
| Windows or Linux | MTP app | Copy the playlist folders into the watch's Music folder with an MTP app. |

Garmin Express does not support Linux. The app offers MP3 quality from 64 through
320 kbps. A watch's free space is not known until it is connected; the size shown
in the app is an estimate, not a capacity check.

## Build from source

Install Node.js 22 and Corepack, then run:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --dir companion build
corepack pnpm --dir desktop pack:linux # use pack:mac or pack:win on that OS
```

Packages appear in `desktop/release`. See [desktop development](docs/DEVELOPMENT.md)
for local tests. No package is published yet.

The Connect IQ watch app and self-hosted sync service remain in source history
while the desktop export is verified. They are not part of the new desktop flow.
This is one person's Plex library and local app data. SyncAndRun has no account
service, analytics, advertising, or telemetry.

## Contribute

Use [GitHub Issues](https://github.com/ryancummings/syncandrun/issues) and pull
requests. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[architecture](docs/ARCHITECTURE.md) before changing behavior.

SyncAndRun is GPL-3.0 software derived from
[SubMusic](https://github.com/memen45/SubMusic). Its history and attribution are
preserved in [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). It is unofficial and
is not affiliated with Plex, Garmin, or SubMusic's maintainers.
