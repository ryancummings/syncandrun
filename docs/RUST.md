# Native app and CLI

The Rust workspace builds the Mac app, Linux app, and `syncandrun` CLI. They share profiles, music sources, exports, and USB transfer code. Neither app needs Node.js or a local web server at runtime.

Download an app package from [GitHub Releases](https://github.com/ryancummings/syncandrun/releases). Follow the [README](../README.md#download-and-install) to install it. See [Development](DEVELOPMENT.md) if you want to build from source.

## Music sources

Choose Plex, Jellyfin, or Local folder in the app. Plex sign-in opens your browser. Jellyfin asks for a server address, user name, and password. Local folder finds MP3 and FLAC files in the chosen folder. Folders with tracks become playlists. The app uses `ffprobe` for duration estimates and `ffmpeg` to make MP3 output.

Plex and Local folder offer 64, 96, 128, 192, 256, and 320 kbps MP3. Jellyfin offers up to 256 kbps for stereo MP3. Source changes clear saved playlist choices so an export cannot use another source's selection.

## CLI examples

The Linux archive installs `syncandrun` in `~/.local/bin`. A source build puts it in `target/debug` or `target/release`. Run `syncandrun --help` for every option.

```sh
syncandrun login
syncandrun login-jellyfin --server https://your-server.example --username your-user
syncandrun local-folder /path/to/music
syncandrun source plex
syncandrun playlists --json
syncandrun refresh --playlist plex:playlist:123
syncandrun estimate --bitrate 192
syncandrun devices
syncandrun transfer --playlist plex:playlist:123 --bitrate 192
syncandrun export --destination /path/to/output --bitrate 192
syncandrun backup --destination /path/to/private-backups
```

`login` opens a browser and asks you to choose a Plex server and music library. `login-jellyfin` prompts for a hidden password. Its `--password-stdin` option reads one line for automation. Keep passwords out of command arguments and shell history. Use HTTPS for a Jellyfin server outside a trusted home network.

`devices` lists Garmin storage that the app can open. If several watches are connected, pass a device key from that list to `transfer` with `--device`. `transfer` sends new playlist folders by default. Add `--replace-music --yes-replace-music` only when you agree to remove recognized old music under the selected watch's `Music` folder. `--shared-tracks` saves one copy of a track that appears in several playlists. It cannot run with replacement.

`export` makes a dated folder for a manual MTP copy. Its `--route express` and `--route music` options make shared track layouts and Music playlist XML. These extra routes need separate device acceptance. Repeat `--playlist` to choose several playlists. If you omit it, the CLI uses your saved selection.

Ctrl-C cancels CLI work. A network request can finish or time out before cancellation takes effect. A failed folder export stays in a new `.incomplete` folder. It does not replace a complete export.

## Existing profiles

The native app can open a profile made by an older SyncAndRun version. On a Mac, it searches `~/Library/Application Support` for `SyncAndRun` or `syncandrun-desktop`. On Linux, it searches `$XDG_CONFIG_HOME` or `~/.config`. If both names contain profiles, choose one with `--profile`.

```sh
syncandrun --profile /path/to/profile status
syncandrun-desktop --profile /path/to/profile
```

A profile contains `secret` and `data/syncandrun.sqlite`. Keep both files together. Rust keeps the original encryption format, owner checks, and historical database migrations. It refuses a missing secret or a newer schema instead of resetting the profile. Native jobs lock the profile so two processes cannot change it at once. Make a private backup before an upgrade if you need to roll back.

For a Local folder export, the desktop uses `~/Music/SyncAndRun` only after you confirm it. The app reuses unchanged generated files and leaves unrelated files alone. Clear library after transfer removes only unchanged files made by SyncAndRun after confirmation.

See [direct transfer](DIRECT-MTP.md) for USB behavior and [validation](VALIDATION.md) for physical watch results.
