# Deploy your own companion

This is a preview. Automated tests do not establish physical-watch compatibility. Complete the watch acceptance run in [VALIDATION.md](VALIDATION.md), including offline audio playback, before relying on it. Compatibility with your chosen route remains unverified until that run succeeds with your endpoint.

Each installation is for one Plex owner on hardware they control. It supports multiple watches belonging to that owner. Hosting for other people is outside the product scope.

## Quick start on a home network

```sh
git clone https://github.com/ryancummings/syncandrun.git
cd syncandrun
docker compose up -d --build
```

Open `http://<this computer's IP address>` and select **Sign in with Plex**. No environment file, secret, setup link, or proxy is needed:

- The companion listens on port 80 of every address the computer has. Set `SYNCANDRUN_PORT` to use another port.
- It generates its encryption secret into the `syncandrun-data` volume on first start. Back up that volume as a whole: the secret and the database belong together.
- The first Plex account to finish signing in owns the installation. Afterwards only that account can sign in to manage it. To give it to another account, delete its data from **Settings** or remove the volume.
- The Watch page shows the address and pairing code to enter on the watch, taken from the address you opened the page with. Use the computer's IP address rather than its name: watches often cannot look up local computer names.

Traffic is plain HTTP, so anyone on the same network could read setup, sessions, watch credentials, and music in transit. That is the intended tradeoff for a home network. Do not forward port 80 from your router. Use the HTTPS routes below if the network is shared or the companion must be reachable from outside.

To upgrade, run `git pull` and `docker compose up -d --build` again. Paired watches and settings are kept.

The rest of this guide covers advanced installations: HTTPS, a public domain, a reverse proxy, or Tailscale Funnel.

## Requirements

For an always-on deployment, use a Linux amd64 or arm64 host with Docker Engine and the Compose v2 plugin, Git, Python 3, and enough persistent storage. For local persistent development, macOS Docker Desktop is also supported by the helper below. Build on the target architecture. Plex Media Server must be reachable from the container and able to serve/transcode the owner's music. `localhost` inside a container is the container, not the Plex host: use Plex's reachable LAN address or DNS name. Keep Plex authentication enabled.

Plain HTTP on the home network, described above, is the default. A private tailnet-only URL cannot be accessed directly by a Garmin watch. For HTTPS, choose a public domain, a home-LAN domain whose DNS resolves to a reachable LAN proxy, or the optional Tailscale Funnel route below, and set `SYNCANDRUN_BASE_URL` to the exact address the browser and watch use. None of these routes requires making Plex itself anonymously accessible.

## Repeatable local deployment

For a persistent development or personal instance, run this from a clean checkout
of a reviewed commit. Choose the instance identity once and keep the state
directory outside the checkout:

```sh
python3 scripts/deploy-local.py \
  --origin https://music.example.com \
  --project syncandrun-personal \
  --port 3000 \
  --state-dir "$HOME/.local/state/syncandrun-personal"
```

The helper works with a local Linux Docker Engine or macOS Docker Desktop and
requires Git, Python 3, and `tar`. It creates private configuration once, builds
only committed files, starts the production Compose service on loopback, and
checks readiness and HTTP 401 for anonymous management. It does not configure
ingress or connect Plex. Docker Desktop must already be running on macOS;
desktop sleep and Docker availability affect service availability.

Repeat the same command after restarting Docker or checking out another reviewed
commit. An unchanged commit reuses its local source/architecture image without a
build. A new commit builds once; back up the database and environment, then add
`--upgrade-after-backup` to acknowledge the upgrade. The helper refuses changed
revisions without that flag. Do not use it for rollback onto a migrated database;
follow the restore procedure below. A dirty checkout, occupied project/port, changed instance identity, or
changed/missing encryption secret stops the command. The helper never deletes
volumes or adopts another deployment. Keep the private `companion.env` and
`deployment.json` together; the receipt records source commit, actual image ID,
and successful local checks. Image bytes are not reproducible across fresh builds
because the base image tag can advance; retain the previous image for rollback.

For the owner invitation, backup, restore, and other commands below, use
`docker compose --env-file "$HOME/.local/state/syncandrun-personal/companion.env" -f docker-compose.yml`
in place of `docker compose`, from this checkout. Back up that private
`companion.env` in place of `.env`. Do not export conflicting Compose or
`SYNCANDRUN_*` settings when running manual commands. The helper itself ignores
those ambient settings and selects its own explicit file/project.

## Manual installation

Clone the public source and choose a reviewed release tag or commit. From the checkout, generate configuration using your actual canonical origin:

```sh
git clone https://github.com/ryancummings/syncandrun.git
cd syncandrun
python3 scripts/setup-deployment.py --origin https://music.example.com
# Quiet validation avoids printing the secret in rendered configuration.
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 120
curl --fail http://127.0.0.1:3000/health/ready
```

The generator refuses to overwrite existing credentials and creates a mode-0600 `.env` containing a random encryption secret. Preserve this file with the database; replacing the secret makes existing encrypted credentials unreadable. Never paste `.env`, rendered Compose configuration, or setup links into an issue or an agent transcript. Do not source `.env` as shell code.

Compose binds the companion to host loopback. Its non-root container has a read-only root filesystem and writable persistent `/data` volume. Do not change the bind address to expose port 3000 directly. The optional inherited `artwork-public` profile is not needed for this deployment: leave it disabled and leave `SYNCANDRUN_ARTWORK_BASE_URL` empty to use the canonical origin.

## HTTPS with a public domain

Point your domain's DNS at your host and route TCP 80/443 to it. Install Caddy on the host using its [official installation instructions](https://caddyserver.com/docs/install). Adapt `deploy/Caddyfile.example` with your actual hostname and local port, validate the configuration with `caddy validate --config /etc/caddy/Caddyfile`, and reload Caddy using your host's service manager. Caddy must be able to obtain a trusted certificate. Keep the proxy on the same host so it can reach loopback.

Leave access logging disabled for authentication/setup routes. Do not add proxy rules that cache authenticated responses. Keep `SYNCANDRUN_TRUST_PROXY=false` unless you have identified and restricted the actual proxy source address; broad trust lets forged forwarded headers defeat IP rate limits. With false, clients share the proxy's rate-limit identity, which may reduce throughput under repeated authentication attempts.

## HTTPS on home Wi-Fi

If the watch only synchronizes at home, its configured domain can resolve to a LAN reverse proxy. On the watch's Wi-Fi network, confirm the domain resolves to that proxy's reachable LAN address and that port 443 serves a publicly trusted certificate for the domain. A DNS-01 certificate challenge can issue and renew that certificate without forwarding inbound router ports. The watch connects to the domain over Wi-Fi; it does not need Tailscale or a `ts.net` name. DNS providers and home resolvers may filter answers containing private IP addresses, so test resolution on the actual watch network.

The reverse proxy may run on a different host from the companion. In that case, keep the companion bound to loopback and use a private, authenticated, certificate-verified HTTPS route between the hosts. For example, the companion host can use [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) to proxy its loopback service to a tailnet HTTPS name; a Caddy host on the same tailnet can [reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) to that exact name with TLS verification enabled. Only the proxy hosts use Tailscale. Do not expose the companion's plaintext port on the LAN or disable TLS verification between hosts.

Verify the complete route from a device on the watch's Wi-Fi: DNS answer, certificate, `/health/ready`, owner authentication, pairing, artwork, and a sustained audio download. Check that the endpoint is inaccessible from outside the LAN if home-only access is intended. A valid certificate and a healthy proxy do not prove that the watch accepts the route; complete [physical acceptance](VALIDATION.md#physical-acceptance--awaiting-the-watch-owner) on the Forerunner. If the watch-visible origin changes later, pair the watch again.

## Plain HTTP behind a reverse proxy

The quick start serves plain HTTP directly and needs no proxy. If you already run a reverse proxy on the home network and want it in front of the companion, publish the companion on loopback with `SYNCANDRUN_BIND_ADDRESS=127.0.0.1 SYNCANDRUN_PORT=3000` and point the proxy at `127.0.0.1:3000`. [The LAN Caddy example](../deploy/Caddyfile.lan-http.example) shows the shape. Pairing still uses whatever address the browser and watch reach the proxy on.

## HTTPS without a domain or router access

[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) provides a public HTTPS name under your tailnet's `ts.net` domain. It is optional, currently beta, and has non-configurable bandwidth limits. Large music synchronizations may be slow. The host needs a Tailscale account, MagicDNS, HTTPS, and Funnel permission in its tailnet policy. Follow the official setup instructions to install and authenticate Tailscale on the Linux host.

1. Read the machine's DNS name with `tailscale status --json` (the `Self.DNSName` field; remove the trailing dot). Use `https://<that-name>` as the origin when generating `.env` above.
2. Start the companion and check its local health before opening ingress.
3. Start the public proxy:

   ```sh
   tailscale funnel --bg --https=443 http://127.0.0.1:3000
   tailscale funnel status
   ```

4. Verify that Funnel reports the exact configured origin and that `/health/ready` works from a device outside the tailnet. Do not disable TLS verification. Verify Plex login, watch pairing, and an actual audio sync through this URL.

Use the current [Funnel CLI reference](https://tailscale.com/docs/reference/tailscale-cli/funnel) if a command differs on your installation. To close this ingress, run `tailscale funnel --https=443 off` and check status. Do not run a blanket reset on a host with unrelated routes. Tailscale availability and policy are dependencies of this route; a working browser alone does not validate Garmin TLS or sustained audio downloads.

## Assign the owner

The first Plex account to finish signing in owns the installation. Afterwards only that account can manage it, and other accounts are refused before any session is issued. Sign in as the owner before exposing an installation beyond your home network, so nobody else can claim it first.

An installation upgraded from a version without owner authentication loses its previous browser sessions and keeps its library data and watch credentials; the next Plex sign-in claims it. To give an installation to a different person, delete its data from **Settings** or create a fresh installation.

Verify `/health/ready` externally, that anonymous management is denied, that a different Plex account cannot manage the installation, and that the watch can sync. Record physical-watch tests separately from container health.

## Back up and restore

Take consistent backups while the companion is stopped. Store backups outside the checkout, encrypt them at rest, and restrict access: they contain Plex credentials. The `.env` secret must accompany the data. These commands apply to the current checkout/project only:

```sh
umask 077
backup_dir="$HOME/syncandrun-backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
cp .env "$backup_dir/environment"
git rev-parse HEAD > "$backup_dir/source-commit"
docker compose stop companion
docker compose run --rm --no-deps -T --entrypoint tar companion -C /data -czf - . > "$backup_dir/data.tgz"
docker compose start companion
```

Check command exit codes. If backup fails, restart the stopped service and resolve the failure before upgrading. Keep a known-good image tag as well as the source commit. Test restores in a separate installation with ingress disabled before trusting your backup.

Restore into a **new, empty project volume**, never over a running database. Restore the saved environment privately, preserving its secret but changing `COMPOSE_PROJECT_NAME` and local port to avoid collision with a running instance. Use the recorded source version and local image. Create the container/volume without starting it and restore the trusted archive:

```sh
docker compose create companion
docker compose run --rm --no-deps -T --entrypoint tar companion -C /data -xzf - < "$backup_dir/data.tgz"
docker compose up -d --wait --wait-timeout 120
```

The restore runs as the container's node user so restored files remain accessible without extra container capabilities. Check local health and owner access before routing ingress to the restored project. Do not run two copies of the same public installation during recovery.

## Update, roll back, or reset ownership

1. Back up data and `.env` as above; note the current commit and image tag.
2. Fetch the public repository's release tags; review release notes and migration warnings. Check out the specific release in a clean checkout. Update `SYNCANDRUN_IMAGE` in `.env` to a new version-specific local tag, then run `docker compose build companion`.
3. Run `docker compose up -d --wait --wait-timeout 120`, check health, owner login, and sync. Keep the previous image and backup until validated. Do not run image pruning during the rollback window.
4. To roll back, stop ingress and the new service. Restore the pre-upgrade environment/data into a new project using the old image and matching source, then validate and switch ingress. Simply running old code against a migrated database is not a supported rollback.

To transfer ownership, disable ingress, back up the old installation, stop it, and create a fresh project with a fresh secret and empty volume. The new owner signs in first; pair watches again. Do not delete volumes as a troubleshooting shortcut. Intentional retirement can remove the old project's data only after the administrator has decided the backup is sufficient.
