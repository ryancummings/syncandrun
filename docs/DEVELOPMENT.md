# Development

## Companion prerequisites

Install Git, Node.js 22, and Corepack. Docker with the Compose plugin is required for deployment verification, but not companion development. Run the commands below from the repository root. The repository pins pnpm in `package.json`. Tests use a fake Plex service and synthetic credentials, so a real Plex account is not needed.

```sh
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm --dir companion exec playwright install chromium
make companion-build companion-test companion-e2e contract-test NODE22=node
```

On Linux, Playwright can require system packages: run `corepack pnpm --dir companion exec playwright install --with-deps chromium` on a machine where you can install them. Node 22 is required for the native SQLite module. Reinstall dependencies under Node 22 if they were built under another Node version.

## Local browser development with fake Plex

```sh
corepack pnpm --dir companion dev:demo
```

Once the readiness message appears, open `http://127.0.0.1:3000/__demo/start`. Click **Connect Plex**; the local fixture authorizes the popup without a Plex account. Return to the companion, select **Fixture Server**, select **Fixture Music**, and finish setup. Both sample playlists can be selected and saved. The settings and watch-management screens use the same application services as production.

This command builds the browser UI and watches backend source changes. After editing UI files, stop and rerun the command to rebuild the assets served by Fastify. Each process start creates a fresh temporary database outside the repository; graceful shutdown removes it. Reopen `/__demo/start` after a restart to claim that fresh demo. Use `SYNCANDRUN_DEMO_PORT=3001 corepack pnpm --dir companion dev:demo` if port 3000 is occupied.

The demo binds only to loopback and uses synthetic credentials, metadata, and placeholder media. Its setup routes exist only in the test harness, which is excluded from the production build. Keep it local. The example HTTPS watch address in Settings is a fixture, not a deployed endpoint, and the placeholder audio is not playable music. This workflow verifies browser development; real Plex transcoding and physical-watch playback require a real installation.

## Development against real Plex

Use [DEPLOYMENT.md](DEPLOYMENT.md) for the intended instance, trusted HTTPS, environment setup, and owner invitation. Put your generated environment file in a private directory outside the repository, and add `SYNCANDRUN_DATA_DIR=/absolute/private/path/data` to it. The directory must be writable by your user; `/data` is the container default. Keep the existing secret with its database. Then run, substituting your private environment-file path:

```sh
make companion-ui NODE22=node
node --env-file=/absolute/private/path/companion.env companion/node_modules/tsx/dist/cli.mjs watch companion/src/main.ts
```

Node parses this file without executing shell code. `make companion-dev NODE22=node` is equivalent when the variables are already exported, but does not automatically read `.env`. The API binds to `127.0.0.1` by default and must sit behind your intended HTTPS proxy; it is not the local fake-Plex demo. Never run tests against its data directory or enable test authentication on a real installation. Rebuild the browser bundle and restart the API after UI changes.

With that process running, create the owner invitation from a second terminal,
using the same private environment file and a new private output filename:

```sh
node --env-file=/absolute/private/path/companion.env companion/node_modules/tsx/dist/cli.mjs companion/src/operator.ts setup-link --output /absolute/private/path/setup-link.txt
```

Open the saved link privately in your browser and complete Plex authentication.
It expires after 30 minutes; delete the file after use. Do not paste its contents
into logs or issue reports. `SYNCANDRUN_HOST` can explicitly select another IP
address, but keep direct development on loopback behind HTTPS. The Docker image
sets this variable to `0.0.0.0` inside its container so Compose's loopback-only
published port can reach it; `SYNCANDRUN_BIND_ADDRESS` controls that host mapping.

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

`make verify` combines these checks. Docker verification creates a unique disposable project, image tags, and automatic loopback port, and ignores deployment `.env`, Compose overrides, and profiles. It tests native startup, restart persistence, quiesced backup/restore, and the other CPU architecture through Buildx and Docker emulation. Install gitleaks for secret scanning.

CI checks the companion and protocol, source hygiene, secrets, and container builds. The Garmin simulator and physical acceptance are separate local checks. Read [VALIDATION.md](VALIDATION.md) before making compatibility or release claims.
