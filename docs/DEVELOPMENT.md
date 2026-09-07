# Development

## Companion prerequisites

Install Git, Node.js 22, Corepack, and Docker with the Compose plugin. The repository pins pnpm in `package.json`. Tests use a fake Plex service and synthetic credentials, so a real Plex account is not needed.

```sh
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm --dir companion exec playwright install chromium
make companion-build companion-test companion-e2e contract-test NODE22=node
```

On Linux, Playwright can require system packages: run `corepack pnpm --dir companion exec playwright install --with-deps chromium` on a machine where you can install them. Node 22 is required for the native SQLite module. Reinstall dependencies under Node 22 if they were built under another Node version.

`make companion-dev NODE22=node` starts the API in watch mode and requires deployment environment variables. Use [DEPLOYMENT.md](DEPLOYMENT.md) for secure interactive setup; never enable test authentication on a real installation. The browser bundle is built with `make companion-ui NODE22=node`.

## Watch toolchain

Install Garmin Connect IQ SDK 9.2.0, Java required by that SDK, and the `fr955` device definition using Garmin's SDK Manager. Obtain the SDK from [Garmin](https://developer.garmin.com/connect-iq/sdk/). Keep your developer signing key outside the repository. Do not use another person's private key.

Set `CIQ_HOME` to the unpacked SDK directory and `GARMIN_KEY` to your DER signing key. These explicit paths work without the maintainer's local SDK layout.

```sh
export CIQ_HOME=/absolute/path/to/connectiq-sdk
export GARMIN_KEY=/absolute/private/path/developer.der
make watch-build DEVICE=fr955
make watch-test DEVICE=fr955
make watch-memory-profile DEVICE=fr955
```

The simulator requires a graphical desktop. If automatic simulator startup is unavailable on your platform, start the SDK simulator before running the test targets. A missing SDK, simulator, device definition, or key means the corresponding check was not run.

The build writes `build/watch/SyncAndRun-fr955.prg`. For development sideloading, connect the watch by USB and copy the PRG to `GARMIN/APPS` using an MTP-capable file manager. Safely disconnect and restart the watch. This is a development build, not a Connect IQ Store package. Preserve the same local key for subsequent updates and back it up securely.

## Verification

```sh
make lint contract-test companion-build companion-test companion-e2e NODE22=node
make watch-test watch-memory-profile watch-build
make docker-test
make secret-scan
```

`make verify` combines these checks. Docker verification uses disposable project `syncandrun-verify` and container `syncandrun-cross-verify`; do not use those names for a real installation. It tests clean startup, restart persistence, quiesced backup/restore, and the other CPU architecture through Docker emulation. Install gitleaks for secret scanning.

CI checks the companion and protocol, source hygiene, secrets, and container builds. The Garmin simulator and physical acceptance are separate local checks. Read [VALIDATION.md](VALIDATION.md) before making compatibility or release claims.
