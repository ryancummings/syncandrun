# Native Linux app and CLI

The Rust workspace contains `syncandrun-core` (Plex, profiles, and exports),
`syncandrun-desktop` (GPUI), and `syncandrun-cli` (the `syncandrun` command).
Neither binary needs Node, Electron, a browser renderer, or a local HTTP service
at runtime. Plex sign-in opens the system browser and polls Plex directly.

## Build and run

Install Rust using rustup. The repository pins the toolchain and GPUI release.
On Ubuntu 24.04, install the native build and runtime dependencies:

```sh
sudo apt-get install build-essential clang pkg-config libssl-dev \
  libfontconfig1-dev libxkbcommon-dev libxkbcommon-x11-dev libwayland-dev \
  libxcb1-dev libxcb-shape0-dev libxcb-xfixes0-dev libx11-xcb-dev \
  libvulkan1 mesa-vulkan-drivers xdg-desktop-portal xdg-desktop-portal-gtk
cargo build --locked --workspace
cargo run --locked -p syncandrun-desktop
```

The window needs a Linux graphical session and a working Vulkan driver. Folder
selection uses the desktop portal. Create a SyncAndRun music library folder
wherever you want, then select it on the main page or in Settings. If you do not
choose one, the app offers `~/Music/SyncAndRun` and asks before creating
it on the first export. Click playlists to move them between Available and
Syncing, choose MP3 quality, then **Export selected playlists to MP3**. The app
stages one folder and `.m3u8` file per selected playlist directly in the library
folder. Copy those playlist folders into the watch's Music folder using Files or
another MTP application. After transfer, **Clear library after transfer** removes
only unchanged app-generated files after confirmation. The app does not transfer
files to the watch itself.

For optimized binaries, use `cargo build --locked --release --workspace`.
For just the CLI, `cargo build --locked -p syncandrun-cli` avoids GPUI and its
Linux graphics dependencies. Binaries are in `target/debug` or `target/release`.
No Rust installer or release artifact is published.

## CLI

Examples assume the binaries are on PATH. After a development build, use
`./target/debug/syncandrun` in place of `syncandrun`, or install with
`cargo install --locked --path crates/cli`.

```sh
syncandrun login
syncandrun status
syncandrun playlists --json
syncandrun refresh --playlist plex:playlist:123
syncandrun estimate --bitrate 192
syncandrun export --destination /path/to/music --bitrate 192
syncandrun backup --destination /path/to/private-backups
```

`login` opens the browser and then asks for a server and music library by number.
It deliberately does not print authentication links or accept tokens in command
arguments. It needs access to a browser on the same desktop session. On a headless
host, use an existing profile with its matching secret.

Repeat `--playlist` to select multiple playlists; omit it to reuse the saved
selection. Export refreshes the selection first. `--offline-plan` uses saved
snapshots, but audio downloads still need Plex. Available bitrates are 64, 96,
128, 192, 256, and 320 kbps. `--route mtp` creates separate playlist folders;
`--route express` shares a Tracks folder; `--route music` also writes Music/iTunes
playlist XML. Express and Music/iTunes transfer acceptance remain unverified.
CLI output deliberately displays library metadata only for discovery commands;
do not paste it into public issues without replacing personal information.

Ctrl-C cancels CLI work. The desktop has a Cancel button. Cancellation is checked
between requests and audio chunks; an outstanding blocking network request must
finish or reach its timeout first. Export progress reports track counts and the
desktop estimates remaining time after the first track. The desktop reuses
unchanged generated files in the chosen library, updates changed files, and
removes obsolete generated files when they have not been edited outside the app.
Other files are preserved. A conflicting unmanaged file or edited generated file
stops synchronization. Failed or cancelled downloads remain in a uniquely named
`.incomplete` folder. The CLI continues to create a new dated export each run.

## Existing profiles

Close Electron before using the same profile in Rust. The default searches
`$XDG_CONFIG_HOME` (or `~/.config`) for the existing `syncandrun-desktop` or
`SyncAndRun` profile. If both exist, choose explicitly:

```sh
syncandrun --profile /path/to/profile status
syncandrun-desktop --profile /path/to/profile
```

The profile contains `secret` and `data/syncandrun.sqlite`. Rust uses the exact
secret bytes, the original HKDF-SHA256/AES-256-GCM format, client identifier,
owner, and all ten historical migrations. No migration or retired watch table
is deleted. It refuses a missing secret or a newer schema instead of resetting
the profile. Native jobs take an exclusive profile lock; concurrent CLI/desktop
operations receive a clear error. The Electron app does not know this lock.

First sign-in establishes one owner. Later sign-ins must validate as that same
Plex account. For an older profile without an owner, the saved account credential
must also validate as that account before a new connection is saved. Selecting
a connection clears old snapshots so they cannot accidentally refer to tracks
on another server. Backups use SQLite's online backup API and include the exact
encryption secret in a private folder. Restoring a backup is simply selecting
that folder with `--profile` while the other app is closed.

## Development checks

Node is required only for the independent legacy encryption tests and smoke
fixture. Python 3 runs the smoke script. All tests use fake data and temporary
profiles; none discover or open the default profile.

```sh
cargo fmt --all -- --check
cargo test --locked --workspace
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo build --locked --workspace
python3 scripts/native-smoke.py
```

For a synthetic graphical launch, install Xvfb, Openbox, xdotool, and ImageMagick:

```sh
XDG_CURRENT_DESKTOP=GNOME xvfb-run -a dbus-run-session -- sh -c 'openbox >/dev/null 2>&1 & python3 scripts/native-smoke.py --gui --screenshot /tmp/syncandrun-native.png'
```

Add `--gui-export` to the smoke command to also exercise the GTK portal folder
picker and desktop export button. This option requires the GTK portal and a
session bus, as supplied by the command above.

Inspect the screenshot. An Xvfb launch with software Vulkan is Linux rendering
evidence, not a physical GPU, real Plex sign-in, or watch playback
acceptance test. See [validation](VALIDATION.md).
