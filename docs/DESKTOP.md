# Desktop preview

SyncAndRun runs on the computer where you want to save music. It connects to
your Plex server, converts chosen playlists to MP3, and writes a new folder in
the place you choose. It listens only on `127.0.0.1` while open. There is no
watch pairing, LAN address setup, or background sync in the desktop flow.

## Build and start

Build the companion and package on the same operating system as the target:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --dir companion build
corepack pnpm --dir desktop pack:linux # or pack:mac / pack:win
```

Find the package in `desktop/release`. Packages are unsigned previews and are
not published. The first launch asks you to sign in with Plex and choose one
music library. Plex may run on this computer or another host you control.

On the main screen, check the playlists you want, choose the transfer method
and MP3 quality, then choose a local save folder. **Create music folder** writes
a new dated folder. SyncAndRun keeps incomplete output in a folder ending in
`.incomplete` and shows its path if an export stops. It does not overwrite an
earlier complete export.

For MTP, copy the playlist folders inside the new export folder into your
watch's Music folder. The playlist files use relative paths. On Windows,
Garmin Express can scan the saved local folder under Music > My Music. On macOS,
add the Tracks folder to Music before importing `Import playlists.xml`, then
use Garmin Express. The same XML route is available through iTunes on Windows.
Garmin Express is not available on Linux.

## Local data

The app profile contains the encrypted Plex credential, a local secret, and
the playlist database. Electron stores it in the user's app data directory
(typically `~/.config`, `~/Library/Application Support`, or `%APPDATA%`). The
app menu's **Back up app data** action copies the profile to a folder you
choose. Keep that backup private, and keep its secret with its database.

The app does not install a daemon or auto updater. Closing the window quits.
It does not write Plex credentials to an export. It does not know your watch's
free space until direct device access is added, so check space before copying.
See [validation](VALIDATION.md) for the remaining physical-watch checks.
