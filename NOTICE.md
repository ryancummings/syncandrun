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

The native Linux interface uses GPUI (Apache-2.0) and system fonts. Rust dependency
versions are recorded in Cargo.lock; their licenses remain those of their
respective authors. No Electron web fonts are bundled into the Rust binary.

Direct USB transfer dynamically links the system [libmtp](https://github.com/libmtp/libmtp)
(LGPL-2.1) using [libmtp-sys](https://github.com/quebin31/libmtp-rs) bindings (MIT).
Their upstream licenses apply. No third-party MTP protocol implementation is
copied into this repository; packaging must include the applicable dependency
notices and comply with the system library’s license.
