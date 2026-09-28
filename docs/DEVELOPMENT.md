# Development

SyncAndRun has one Rust workspace for the Mac app, Linux app, and CLI. The app uses GPUI for its window and libmtp for direct USB transfer. It does not start a local web server. Read [Architecture](ARCHITECTURE.md) before you change profile, export, or device behavior.

## Build and check the workspace

Install the pinned Rust toolchain from `rust-toolchain.toml`. On Ubuntu 24.04, install the build packages below. Then run the checks from the repository root.

```sh
sudo apt-get update
sudo apt-get install build-essential clang pkg-config libmtp-dev libssl-dev \
  libfontconfig1-dev libxkbcommon-dev libxkbcommon-x11-dev libwayland-dev \
  libxcb1-dev libxcb-shape0-dev libxcb-xfixes0-dev libx11-xcb-dev \
  libvulkan1 mesa-vulkan-drivers ffmpeg
cargo fmt --all -- --check
cargo test --locked --workspace
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo build --locked --workspace
python3 scripts/native-smoke.py
```

The smoke script uses a fake Plex server and a temporary profile. Node.js is needed only for the independent test of old credential encryption. Tests must use synthetic data. Do not point them at a real profile or music library.

On Apple Silicon macOS, install Xcode, Rust, Homebrew `pkgconf`, `libmtp`, and `ffmpeg`. Build the app and drag-install DMG with `python3 scripts/package-macos.py`. The script bundles the native libraries, fonts, and license files. It applies a local signature and makes a DMG in `build/macos`. It does not notarize the app.

On Ubuntu 24.04 x86_64, run `python3 scripts/package-linux.py`. It makes an archive in `build/linux`. Extract that archive and run `./install.sh` to install the app for the current user. The archive uses system libraries and the system `ffmpeg` tools.

## Test the interface

Launch the app with an isolated profile. Pass `--no-usb` when a device test is not needed. The app does not need a development server.

```sh
cargo run --locked -p syncandrun-desktop -- --profile /tmp/syncandrun-demo --no-usb
```

For a physical device check, use [Validation](VALIDATION.md) and record the model, firmware, host system, source commit, and result. A successful build does not prove that the watch indexed a playlist or played its tracks.

## Release

Follow the [package and release guide](AGENT_DEPLOYMENT.md). It covers package checks, version tags, GitHub Release assets, and the final handoff.
