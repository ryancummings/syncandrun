# Development agent instructions

Read `README.md`, `docs/ARCHITECTURE.md`, `CONTRIBUTING.md`, and `docs/DEVELOPMENT.md` before you change behavior. Read `docs/VALIDATION.md` before you claim device or package acceptance. Use `CONTEXT-MAP.md` to find the other guides.

- Work on the native Rust desktop and CLI. Keep macOS and Linux behavior aligned when code is shared.
- Keep the local profile single-owner. Preserve encrypted Plex and Jellyfin connections and all historical database migrations.
- Use fake music services, generated audio, and isolated profiles in tests. Never use a real profile or music library as a fixture.
- Keep credentials, setup links, cookies, databases, watch credentials, signing keys, real music, and private library names out of logs, Git, issues, and pull requests.
- Start any test server yourself. Check for an existing server and wait until the new server is ready.
- Keep GPL-3.0, SubMusic history, and asset notices. Keep `upstream` at `https://github.com/memen45/SubMusic.git`.
- Use public GitHub Issues and pull requests. Do not require a private tracker, host path, or agent runtime from contributors.
- Run the relevant checks in `docs/DEVELOPMENT.md`. Report checks that could not run. Separate automated evidence from physical watch checks.
- Follow `docs/AGENT_DEPLOYMENT.md` when you make a package or release. Publish artifacts or change repository visibility only with authorization.

The retired app and service remain in Git history. The files in `tests/fixtures/legacy-migrations` preserve an independent check of the original profile schema.
