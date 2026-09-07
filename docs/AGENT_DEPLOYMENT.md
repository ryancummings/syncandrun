# Deployment runbook for agents

Use [DEPLOYMENT.md](DEPLOYMENT.md) for the complete operator procedure. This runbook requires no private tools, infrastructure, or accounts belonging to the maintainers.

## Inputs and boundaries

Obtain the owner's target host, reviewed source revision, installation name, local port, HTTPS origin, and chosen ingress method. One installation has one owner and may pair multiple watches belonging to that owner. For a domain-free installation the owner must authenticate Tailscale and authorize Funnel; do not reuse unrelated tunnel credentials.

Permission to prepare source/configuration does not imply permission to expose a new public endpoint. Follow the user's deployment authorization. Prepare and validate locally before the ingress step. Keep the setup link with the owner.

## Procedure

1. Inspect the host architecture, `docker version`, `docker compose version`, disk capacity, and existing Compose projects/ports. Confirm Plex is reachable from that host. If Docker or another prerequisite is missing, identify it and install only within the user's authorization; never claim a skipped check passed.
2. Use a clean checkout of the reviewed source. Generate a new `.env` with `python3 scripts/setup-deployment.py --origin <https-origin> --project <unique-name> --port <unused-port>`. Refuse to overwrite existing credentials. Keep secret values out of tool output, shell tracing, chat, and version control.
3. Run `docker compose config --quiet`. Run `docker compose up -d --build --wait --wait-timeout 120`. Check `/health/ready` on the chosen loopback port. On failure inspect only necessary logs and redact credentials before reporting them.
4. Configure host Caddy or Tailscale Funnel as documented. Verify the exact public HTTPS origin from outside the host/tailnet with certificate verification enabled. Keep the companion bound to loopback. Never turn off TLS verification to make a watch test pass.
5. Create the setup link with `docker compose exec companion node companion/dist/operator.js setup-link --output /tmp/setup-link.txt`. Copy it into a private local file using the operator procedure. Give the owner the file location, not its secret contents. Setup links expire after 30 minutes and are consumed when the PIN flow starts; reissue with a new output filename if necessary.
6. Verify anonymous management is rejected. Ask the owner to complete Plex authentication, playlist selection, and pairing. A health endpoint is not proof of owner authentication or watch support. Complete the physical-watch acceptance checklist with the owner, or explicitly mark it awaiting the owner. Test actual music download through a tunnel, not just its landing page.
7. Perform a stopped-service backup and validate a restore into an isolated project before declaring recovery verified. Record the backup location and source/image revision without disclosing secret contents. Schedule updates only if requested.

## Handoff

Report the source revision, local image tag, installation/project name, public origin, health result, authentication verification result, backup/restore result, and the next concrete owner action. Distinguish executed checks from pending ones. Record whether physical-watch acceptance and Funnel audio compatibility passed or remain unverified. Never include Plex tokens, `.env` contents, setup-link URLs, authentication cookies, or a database in the handoff.

For upgrades or failures, follow the documented stopped-backup and restore rollback procedure. Keep the prior data intact until recovery is verified. Never run `docker compose down --volumes`, remove a data volume, replace the encryption secret, or reset Tailscale routes to solve an unexplained failure.
