#!/usr/bin/env python3
"""Build a per-user Linux archive with the native app and CLI."""

import argparse
import json
import platform
import shutil
import subprocess
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build" / "linux"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-build", action="store_true")
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("The Linux package must be built on x86_64 Linux")
    if not args.skip_build:
        subprocess.run(["cargo", "build", "--locked", "--release", "--workspace"],
                       cwd=ROOT, check=True)
    metadata = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--no-deps", "--format-version", "1"], cwd=ROOT
    ))
    version = next(package["version"] for package in metadata["packages"]
                   if package["name"] == "syncandrun-desktop")
    name = f"SyncAndRun-{version}-linux-x86_64"
    stage = OUT / name
    if stage.exists():
        shutil.rmtree(stage)
    (stage / "bin").mkdir(parents=True)
    (stage / "share").mkdir()
    for binary in ("syncandrun", "syncandrun-desktop"):
        shutil.copy2(ROOT / "target" / "release" / binary, stage / "bin" / binary)
    for source, destination in (
        (ROOT / "assets" / "icon.png", stage / "share" / "icon.png"),
        (ROOT / "LICENSE", stage / "LICENSE"),
        (ROOT / "NOTICE.md", stage / "NOTICE.md"),
        (ROOT / "scripts" / "install-linux.sh", stage / "install.sh"),
    ):
        shutil.copy2(source, destination)
    (stage / "install.sh").chmod(0o755)
    archive = OUT / f"{name}.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(stage, arcname=name)
    print(archive)


if __name__ == "__main__":
    main()
