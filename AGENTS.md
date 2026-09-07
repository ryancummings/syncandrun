# Contributor and deployment agent instructions

Read `README.md` and `docs/ARCHITECTURE.md` before changing behavior. For deployment, follow `docs/AGENT_DEPLOYMENT.md` and its human setup guide. For code changes, follow `CONTRIBUTING.md` and `docs/DEVELOPMENT.md`. `docs/protocol/openapi.yaml` owns the watch contract; `CONTEXT-MAP.md` links the glossary.

- Keep the companion single-owner. Guests use independent installations and trust the host administrator.
- Never print, commit, or include in issue reports Plex credentials, setup links, cookies, database contents, watch credentials, signing keys, or real library metadata.
- Keep browser and watch deployment traffic on trusted HTTPS. Do not bypass authentication to make a tunnel work.
- Use fake Plex data for automated testing. Never use production data or volumes for tests.
- Start required development servers yourself after checking whether they are already running; wait for readiness before testing.
- Preserve GPL-3.0 licensing, SubMusic ancestry, and asset attribution. Keep `upstream` pointed at `https://github.com/memen45/SubMusic.git`; do not rewrite inherited history.
- Use public GitHub Issues and pull requests. No maintainer-private tracker, host paths, credentials, or agent runtime is required.
- Run relevant checks and report unavailable prerequisites as not run. `docs/VALIDATION.md` separates automated evidence from physical-watch acceptance.
- Do not publish artifacts, submit to a store, change repository visibility, or deploy to another person's host without authorization for that action.

For an installation, ask the operator for the intended instance and networking method before changing it. Do not expose a new public endpoint or erase a volume merely because an earlier check failed. Record the source commit, non-secret configuration, verification results, and next action in the pull request or operator handoff.
