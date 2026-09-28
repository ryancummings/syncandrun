#!/usr/bin/env python3
"""Build a self-contained, ad hoc signed macOS app and drag-install DMG."""

import argparse
import os
import plistlib
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build" / "macos"
APP = OUT / "SyncAndRun.app"
MACOS = APP / "Contents" / "MacOS"
FRAMEWORKS = APP / "Contents" / "Frameworks"
RESOURCES = APP / "Contents" / "Resources"
DEPS = re.compile(r"^\s+(.+?) \(compatibility version ")


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def dependencies(binary: Path) -> list[str]:
    output = subprocess.check_output(["otool", "-L", str(binary)], text=True)
    return [match.group(1) for line in output.splitlines()[1:] if (match := DEPS.match(line))]


def system_library(path: str) -> bool:
    return path.startswith(("/System/Library/", "/usr/lib/"))


def make_icon() -> None:
    iconset = OUT / "SyncAndRun.iconset"
    iconset.mkdir()
    source = ROOT / "assets" / "icon.png"
    for size in (16, 32, 128, 256, 512):
        for scale, suffix in ((1, ""), (2, "@2x")):
            run(
                "sips", "-s", "format", "png", "-z", str(size * scale),
                str(size * scale), str(source), "--out",
                str(iconset / f"icon_{size}x{size}{suffix}.png"),
                stdout=subprocess.DEVNULL,
            )
    run("iconutil", "-c", "icns", str(iconset), "-o", str(RESOURCES / "SyncAndRun.icns"))
    shutil.rmtree(iconset)


def copy_homebrew_licenses(sources: list[Path]) -> None:
    roots = set()
    for source in sources:
        parts = source.resolve().parts
        if "Cellar" in parts:
            index = parts.index("Cellar")
            roots.add(Path(*parts[: index + 3]))
    for root in sorted(roots):
        candidates = [path for pattern in ("LICENSE*", "COPYING*", "NOTICE*")
                      for path in root.glob(pattern) if path.is_file()]
        if not candidates:
            raise RuntimeError(f"No bundled license found for {root.name}")
        destination = RESOURCES / "ThirdPartyLicenses" / root.parent.name
        destination.mkdir(parents=True)
        for candidate in candidates:
            shutil.copy2(candidate, destination / candidate.name)


def bundle_libraries(binaries: list[Path], sources: list[Path]) -> list[Path]:
    copied: dict[str, Path] = {}
    pending = list(binaries)
    while pending:
        binary = pending.pop()
        for dependency in dependencies(binary):
            if system_library(dependency) or dependency.startswith("@"):
                continue
            source = Path(dependency)
            if not source.is_file():
                raise RuntimeError(f"Missing linked library: {dependency}")
            name = source.name
            if name in copied:
                if copied[name].resolve() != source.resolve():
                    raise RuntimeError(f"Conflicting libraries named {name}")
                continue
            target = FRAMEWORKS / name
            shutil.copy2(source, target)
            target.chmod(target.stat().st_mode | 0o200)
            copied[name] = source
            pending.append(target)

    copy_homebrew_licenses(sources + list(copied.values()))
    targets = binaries + [FRAMEWORKS / name for name in copied]
    for binary in targets:
        for dependency in dependencies(binary):
            if dependency.startswith("@") or system_library(dependency):
                continue
            run("install_name_tool", "-change", dependency,
                f"@rpath/{Path(dependency).name}", str(binary))
        if binary.parent == FRAMEWORKS:
            run("install_name_tool", "-id", f"@rpath/{binary.name}", str(binary))
            run("install_name_tool", "-add_rpath", "@loader_path", str(binary))
        else:
            run("install_name_tool", "-add_rpath", "@executable_path/../Frameworks", str(binary))
        for dependency in dependencies(binary):
            if dependency.startswith("@rpath/"):
                if not (FRAMEWORKS / Path(dependency).name).is_file():
                    raise RuntimeError(f"Unbundled library: {dependency}")
            elif not system_library(dependency):
                raise RuntimeError(f"External library remains: {dependency}")
    return targets


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--debug", action="store_true", help="Package an existing debug build")
    args = parser.parse_args()
    if not args.skip_build:
        command = ["cargo", "build", "--locked", "-p", "syncandrun-desktop"]
        if not args.debug:
            command.append("--release")
        run(*command, cwd=ROOT)

    binary = ROOT / "target" / ("debug" if args.debug else "release") / "syncandrun-desktop"
    if not binary.is_file():
        raise RuntimeError(f"Build first: {binary}")
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            raise RuntimeError(f"Install {tool} before packaging local music support")

    if OUT.exists():
        shutil.rmtree(OUT)
    for directory in (MACOS, FRAMEWORKS, RESOURCES):
        directory.mkdir(parents=True)
    version = subprocess.check_output(
        ["cargo", "metadata", "--no-deps", "--format-version", "1"], cwd=ROOT, text=True
    )
    import json
    packages = json.loads(version)["packages"]
    app_version = next(package["version"] for package in packages if package["name"] == "syncandrun-desktop")
    with (APP / "Contents" / "Info.plist").open("wb") as handle:
        plistlib.dump({
            "ATSApplicationFontsPath": "Fonts/",
            "CFBundleDevelopmentRegion": "en",
            "CFBundleDisplayName": "SyncAndRun",
            "CFBundleExecutable": "syncandrun-desktop",
            "CFBundleIconFile": "SyncAndRun",
            "CFBundleIdentifier": "icu.rads.syncandrun",
            "CFBundleInfoDictionaryVersion": "6.0",
            "CFBundleName": "SyncAndRun",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": app_version,
            "CFBundleVersion": app_version,
            "LSMinimumSystemVersion": "13.0",
            "NSHighResolutionCapable": True,
        }, handle)
    main_binary = MACOS / "syncandrun-desktop"
    shutil.copy2(binary, main_binary)
    binaries = [main_binary]
    tool_sources = []
    for tool in ("ffmpeg", "ffprobe"):
        target = MACOS / tool
        source = Path(shutil.which(tool))
        shutil.copy2(source, target)
        tool_sources.append(source)
        binaries.append(target)
    make_icon()
    shutil.copytree(ROOT / "assets" / "fonts", RESOURCES / "Fonts")
    for name in ("LICENSE", "NOTICE.md"):
        shutil.copy2(ROOT / name, RESOURCES / name)
    for target in bundle_libraries(binaries, tool_sources):
        run("codesign", "--force", "--sign", "-", str(target))
    run("codesign", "--force", "--sign", "-", str(APP))
    run("codesign", "--verify", "--deep", "--strict", str(APP))

    staging = OUT / "dmg-root"
    staging.mkdir()
    shutil.copytree(APP, staging / APP.name, symlinks=True)
    (staging / "Applications").symlink_to("/Applications")
    dmg = OUT / f"SyncAndRun-{app_version}-macos-arm64.dmg"
    run("hdiutil", "create", "-volname", "SyncAndRun", "-srcfolder", str(staging),
        "-format", "UDZO", "-ov", str(dmg), stdout=subprocess.DEVNULL)
    shutil.rmtree(staging)
    print(dmg)


if __name__ == "__main__":
    main()
