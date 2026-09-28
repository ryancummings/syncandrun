# SyncAndRun notices

SyncAndRun is free software distributed under the GNU General Public
License, version 3. See `LICENSE` for the complete license.

This project is derived from SubMusic by memen45 and contributors:

- Upstream source: <https://github.com/memen45/SubMusic>
- Inherited revision: `3f6830d6cd76ed8f3bb3a8af4be6f84dbb94afe5`
- Upstream application name: SubMusic

The inherited Git history and relevant source-level copyright notices are
retained. Changes made for SyncAndRun are also distributed under
GPL-3.0.

The retained Electron desktop interface bundles subsetted web fonts distributed under
the SIL Open Font License, Version 1.1:

- Archivo by The Archivo Project Authors —
  `companion/ui/public/assets/fonts/LICENSE-Archivo.txt`
- IBM Plex Sans and IBM Plex Mono by IBM Corp. —
  `companion/ui/public/assets/fonts/LICENSE-IBM-Plex.txt`

SyncAndRun is an independent, unofficial project. It is not
affiliated with, endorsed by, or sponsored by Plex, Garmin, or the SubMusic
maintainers. Plex and Garmin names are used only to describe interoperability.

The native interface uses GPUI (Apache-2.0). The macOS app bundles IBM Plex Sans
and IBM Plex Mono from IBM under the SIL Open Font License, Version 1.1;
see `assets/fonts/LICENSE.txt`. Linux uses system fonts. Rust dependency versions
are recorded in Cargo.lock; their licenses remain those of their respective authors.

Direct USB transfer dynamically links [libmtp](https://github.com/libmtp/libmtp)
(LGPL-2.1) using [libmtp-sys](https://github.com/quebin31/libmtp-rs) bindings (MIT).
Linux uses the system library. The macOS app bundles libmtp, libusb, ffmpeg,
ffprobe, and their dynamic dependencies. Their license files are included under
`Contents/Resources/ThirdPartyLicenses` in the macOS app. Their upstream licenses
apply, and the bundled dynamic libraries can be replaced for relinking.
