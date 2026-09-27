# SyncAndRun

SyncAndRun is a personal desktop app that turns Plex music playlists into local MP3 files for a Garmin music watch. Choose playlists, a transfer method, MP3 quality, and a save folder. The app creates the files and tells you what to do next.

![Desktop app](docs/desktop-ui-implemented.png)

## Move music to a watch

| Computer | Choose in SyncAndRun | Then |
| --- | --- | --- |
| macOS | MTP app | Copy the exported playlist folders into the watch's Music folder with OpenMTP or another MTP app. |
| macOS | Music + Express | Add the exported Tracks folder to Music, import `Import playlists.xml`, then send the playlists with Garmin Express. |
| Windows | Garmin Express | In Garmin Express, open the watch's Music page. Use My Music to choose the saved local folder, then send the music. |
| Windows | iTunes + Express | Add Tracks to iTunes, import the playlist XML, and send the playlists with Garmin Express. |
| Windows or Linux | MTP app | Copy the exported playlist folders into the watch's Music folder with an MTP app. |

Garmin documents [local folders and music libraries in Express](https://support.garmin.com/sv-SE/?faq=1ZDlVH09XB1169yYD5FIWA), [iTunes playlist visibility](https://support.garmin.com/en-US/?faq=iBiZBj3Cer5py2x29trVN8), and [supported MP3 and M3U8 files](https://support.garmin.com/en-US/?faq=JyNEOTsZaR3KMXqej3oQp5). [Express runs on Windows and macOS, not Linux](https://support.garmin.com/en-US/navionics/faq/4QVp7mKSIA1LDk5fc1OHX8/). Apple says to [add tracks before importing a playlist XML on Mac](https://support.apple.com/es-es/guide/music/-mus27cd5060f/mac) or [in iTunes on Windows](https://support.apple.com/en-ie/guide/itunes/itns2998/windows).

SyncAndRun offers MP3 at 64, 96, 128, 192, 256, and 320 kbps. The size shown is an estimate. The app cannot read free space on the watch yet. An earlier two-folder MTP export was recognized as playlists on a personal Forerunner 955; the current exporter still needs physical playback checks at each transfer route and quality. See [validation](docs/VALIDATION.md).

## Build from source

Install Node.js 22 and Corepack. On the target operating system, run:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --dir companion build
corepack pnpm --dir desktop pack:linux # use pack:mac or pack:win on that OS
```

The unsigned package appears in `desktop/release`. No package is published yet. See [desktop use](docs/DESKTOP.md), [development](docs/DEVELOPMENT.md), and [architecture](docs/ARCHITECTURE.md).

The former Connect IQ app and self-hosted sync service are retired. Their source remains available in Git history. Direct MTP sync, device free-space detection, Jellyfin, and a Rust export engine are possible future work.

SyncAndRun is GPL-3.0 software derived from [SubMusic](https://github.com/memen45/SubMusic). Its history and attribution are preserved in [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). It is unofficial and is not affiliated with Plex, Garmin, or SubMusic's maintainers. Use [GitHub Issues](https://github.com/ryancummings/syncandrun/issues) and pull requests to contribute.
