# Contributing to SyncAndRun

Use [GitHub Issues](https://github.com/ryancummings/syncandrun/issues) for reproducible bugs and pull requests for changes. Include the source commit, operating system, transfer method, expected behavior, and sanitized steps. For device problems, include the Garmin model and firmware. Never post a real database, token, setup link, playlist name, media file, or unedited network trace. Report vulnerabilities through [SECURITY.md](SECURITY.md).

Fork the repository and branch from `main`. Read [development](docs/DEVELOPMENT.md) and [architecture](docs/ARCHITECTURE.md). Keep changes focused, preserve upstream copyright notices, and use fake Plex data for automated tests. Run relevant checks and list results and any unavailable prerequisites in the pull request. A native package build and physical watch result must be identified separately.

The product is a personal desktop exporter. The Connect IQ app, self-hosted sync service, and watch API are retired. Existing database migrations stay in place for profile compatibility. Changes to stored data must preserve existing profiles or document a tested recovery path. Direct MTP sync, storage discovery, Jellyfin, and a Rust native engine are possible future work.

Contributions are distributed under GPL-3.0. Submit only work you can license. Keep dependency and bundled-asset notices. Agent-assisted contributions follow the same review rules; the submitting person remains responsible for the patch and provenance. Be respectful and avoid disclosing private information.
