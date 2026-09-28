#!/bin/sh
set -eu

package_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
prefix=${1:-"$HOME/.local"}

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo 'This package needs x86_64 Linux.' >&2
  exit 1
fi

mkdir -p "$prefix/bin" "$prefix/share/applications" "$prefix/share/icons/hicolor/1024x1024/apps"
install -m 755 "$package_dir/bin/syncandrun" "$prefix/bin/syncandrun"
install -m 755 "$package_dir/bin/syncandrun-desktop" "$prefix/bin/syncandrun-desktop"
install -m 644 "$package_dir/share/icon.png" "$prefix/share/icons/hicolor/1024x1024/apps/syncandrun.png"
cat > "$prefix/share/applications/syncandrun.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=SyncAndRun
Comment=Move your music to a Garmin watch
Exec="$prefix/bin/syncandrun-desktop"
Icon=$prefix/share/icons/hicolor/1024x1024/apps/syncandrun.png
Categories=AudioVideo;Audio;
Terminal=false
EOF
echo "Installed SyncAndRun in $prefix"
