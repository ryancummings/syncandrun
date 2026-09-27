# Development

Use Node.js 22 and Corepack. The repository pins pnpm. Install dependencies and run the checks from the root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --dir companion build
corepack pnpm --dir companion test
corepack pnpm --dir companion exec playwright install chromium
corepack pnpm --dir companion e2e
corepack pnpm --dir desktop test
```

Playwright may need system packages on Linux; use `playwright install --with-deps chromium` where you can install them. Tests use fake Plex data and temporary profiles. Never point a test at a real Plex database or app profile.

Package on the target operating system with `corepack pnpm --dir desktop pack:linux`, `pack:mac`, or `pack:win`. The package scripts stage `companion/dist` into the desktop bundle and write unsigned artifacts to `desktop/release`. `better-sqlite3` contains native code, so verify a packaged launch on each operating system. A TypeScript build or cross-build alone does not prove that the native module loads.

For an isolated launch, set `SYNCANDRUN_DESKTOP_TEST_PROFILE` to a new absolute private directory. Check `http://127.0.0.1:31415/health/ready` while the app is open. The runtime must not listen on another network interface. The profile contains secrets and is not a test fixture after real Plex sign-in.

The browser end-to-end test supplies a fake desktop bridge, signs in to synthetic Plex, and checks the create-files flow. It cannot validate playable transcoded audio. The desktop unit tests check file layout, tags, and failure isolation with synthetic streams. Physical device and Music/iTunes acceptance steps are in [VALIDATION.md](VALIDATION.md).
