# Deploy your own companion

This is a preview. Automated tests do not establish physical-watch compatibility. Complete the watch acceptance run in [VALIDATION.md](VALIDATION.md), including offline audio playback, before relying on it. Tunnel/watch compatibility remains unverified until that run succeeds with your endpoint.

Each installation is for one Plex owner on hardware they control. It supports multiple watches belonging to that owner. Hosting for other people is outside the product scope.

## Requirements

Use a Linux amd64 or arm64 host with Docker Engine and the Compose v2 plugin, Git, Python 3, and enough persistent storage. Build on the target architecture. Plex Media Server must be reachable from the container and able to serve/transcode the owner's music. `localhost` inside a container is the container, not the Plex host: use Plex's reachable LAN address or DNS name. Keep Plex authentication enabled.

The watch requires trusted HTTPS on port 443. A private tailnet-only URL cannot be accessed directly by a Garmin watch. Choose either a public domain with a host reverse proxy, or the optional Tailscale Funnel route below. Neither route requires making Plex itself anonymously accessible.

## Prepare one installation

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

Compose binds the companion to host loopback. Its non-root container has a read-only root filesystem and writable persistent `/data` volume. Do not change the bind address to expose plaintext port 3000. The optional inherited `artwork-public` profile is not needed for this deployment: leave it disabled and leave `SYNCANDRUN_ARTWORK_BASE_URL` empty to use the canonical origin.

## HTTPS with a domain

Point your domain's DNS at your host and route TCP 80/443 to it. Install Caddy on the host using its [official installation instructions](https://caddyserver.com/docs/install). Adapt `deploy/Caddyfile.example` with your actual hostname and local port, validate the configuration with `caddy validate --config /etc/caddy/Caddyfile`, and reload Caddy using your host's service manager. Caddy must be able to obtain a trusted certificate. Keep the proxy on the same host so it can reach loopback.

Leave access logging disabled for authentication/setup routes. Do not add proxy rules that cache authenticated responses. Keep `SYNCANDRUN_TRUST_PROXY=false` unless you have identified and restricted the actual proxy source address; broad trust lets forged forwarded headers defeat IP rate limits. With false, clients share the proxy's rate-limit identity, which may reduce throughput under repeated authentication attempts.

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

The initial unauthenticated visitor cannot claim the service. The owner creates a private, single-use setup link from inside the container:

```sh
docker compose exec companion node companion/dist/operator.js setup-link --output /tmp/setup-link.txt
```

Retrieve `/tmp/setup-link.txt` to a private local file (mode 0600) using an owner-controlled terminal. For example:

```sh
umask 077
container_id=$(docker compose ps -q companion)
docker cp "$container_id:/tmp/setup-link.txt" ./setup-link.txt
chmod 600 ./setup-link.txt
```

The link expires after 30 minutes. The owner opens it and connects their Plex account, then selects server, library, playlists, and transcode quality and pairs one or more watches. Subsequent management requires the same Plex identity. Delete both copies of the link after use. A new setup link is refused after an owner exists. Do not put setup links in public issues or automated logs.

For an existing installation upgraded from a version without owner authentication, prior browser sessions are invalidated. The trusted administrator must issue the setup link to the original Plex account owner before management resumes. Existing library data and watch credentials are retained. To assign a different person, create a fresh installation instead.

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

To transfer ownership, disable ingress, back up the old installation, stop it, and create a fresh project with a fresh secret and empty volume. Issue a new setup link and pair watches again. Do not delete volumes as a troubleshooting shortcut. Intentional retirement can remove the old project's data only after the administrator has decided the backup is sufficient.
