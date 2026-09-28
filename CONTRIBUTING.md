# Contributing

Use a [GitHub issue](https://github.com/ryancummings/syncandrun/issues) for a bug or feature request. Search existing issues first. Use synthetic names and files in public reports. Do not post credentials, profile backups, music files, setup links, or private library details. Report security problems through [private vulnerability reporting](SECURITY.md).

Make a focused branch and open a pull request against `main`. Read [development](docs/DEVELOPMENT.md) and [architecture](docs/ARCHITECTURE.md) before you change behavior. Keep the GPL-3.0 license, SubMusic ancestry, asset attribution, and historical profile migrations. Tests must use fake services and disposable profiles.

Run the checks listed in [development](docs/DEVELOPMENT.md). In the pull request, state the result for each check that applies. Name any check that you could not run. State separately whether a package launched on its target system and whether a physical watch listed and played the transferred music.

For a device bug, include the exact watch model, firmware, transfer method, app version or commit, expected result, and actual result. Sanitize logs before posting them. A read-back result alone does not prove that the watch indexed a playlist.
