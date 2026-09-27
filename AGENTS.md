# Contributor agent instructions

Read `README.md`, `docs/ARCHITECTURE.md`, `CONTRIBUTING.md`, and `docs/DEVELOPMENT.md` before changing behavior. `docs/VALIDATION.md` separates automated results from physical device acceptance.

- Build the personal desktop export flow. The Connect IQ app, self-hosted deployment, and watch API are retired.
- Keep the local profile single-owner. An existing profile and its encrypted Plex connection must remain usable after upgrades; retain historical database migrations.
- Never print, commit, or include in issues Plex credentials, setup links, cookies, database contents, real library metadata, media, or profile backups.
- Use fake Plex data and isolated profiles for automated tests. Never use production data or volumes for tests.
- Start required development servers after checking whether one is running; wait for readiness before testing.
- Preserve GPL-3.0 licensing, SubMusic ancestry, and asset attribution. Keep `upstream` pointed at `https://github.com/memen45/SubMusic.git`; do not rewrite inherited history.
- Use public GitHub Issues and pull requests. No maintainer-private tracker, host paths, credentials, or agent runtime is required.
- Run relevant checks and report unavailable prerequisites as not run. A cross-build is not native launch or physical-watch evidence.
- Do not publish artifacts, submit to a store, change repository visibility, or deploy to another person's host without authorization for that action.
