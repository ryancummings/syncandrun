# Deployment runbook for agents

Use [DEPLOYMENT.md](DEPLOYMENT.md) for the complete operator procedure. This runbook requires no private tools, infrastructure, or accounts belonging to the maintainers.

## Inputs and boundaries

Obtain the owner's target host, reviewed source revision, installation name, local port, HTTPS origin, and chosen ingress method. One installation has one owner and may pair multiple watches belonging to that owner. For a domain-free installation the owner must authenticate Tailscale and authorize Funnel; do not reuse unrelated tunnel credentials.

Permission to prepare source/configuration does not imply permission to expose a new public endpoint. Follow the user's deployment authorization. Prepare and validate locally before the ingress step. Keep the setup link with the owner.

## Procedure

1. Inspect the host architecture, `docker version`, `docker compose version`, disk capacity, and existing Compose projects/ports. Confirm Plex is reachable from that host. If Docker or another prerequisite is missing, identify it and install only within the user's authorization; never claim a skipped check passed.
2. Use a clean checkout of the reviewed source. Run `python3 scripts/deploy-local.py --origin <https-origin> --project <unique-name> --port <unused-port> --state-dir <private-directory-outside-checkout>`. It creates credentials once, rejects conflicting identity/resources, and reuses an existing image for the same source revision and architecture. Keep secret values out of tool output, shell tracing, chat, and version control.
3. Confirm the helper reports readiness and anonymous-management rejection. It records source/image identity and checks in the private deployment receipt. Use the same command for repeat startup; back up before changing revisions, then explicitly pass `--upgrade-after-backup`. For subsequent manual Compose operations, pass its private `companion.env` explicitly as described in [DEPLOYMENT.md](DEPLOYMENT.md). On failure inspect only necessary logs and redact credentials before reporting them.
4. Configure host Caddy or Tailscale Funnel as documented. Verify the exact public HTTPS origin from outside the host/tailnet with certificate verification enabled. Keep the companion bound to loopback. Never turn off TLS verification to make a watch test pass.
5. Create the setup link with `docker compose --env-file <state-dir>/companion.env -f docker-compose.yml -p <instance> exec companion node companion/dist/operator.js setup-link --output /tmp/setup-link.txt`. Copy it into a private local file using the operator procedure. Give the owner the file location, not its secret contents. Setup links expire after 30 minutes and are consumed when the PIN flow starts; reissue with a new output filename if necessary.
6. Verify anonymous management is rejected. Ask the owner to complete Plex authentication, playlist selection, and pairing. A health endpoint is not proof of owner authentication or watch support. Complete the physical-watch acceptance checklist with the owner, or explicitly mark it awaiting the owner. Test actual music download through a tunnel, not just its landing page.
7. Perform a stopped-service backup and validate a restore into an isolated project before declaring recovery verified. Record the backup location and source/image revision without disclosing secret contents. Schedule updates only if requested.

## Handoff

Report the source revision, local image tag, installation/project name, public origin, health result, authentication verification result, backup/restore result, and the next concrete owner action. Distinguish executed checks from pending ones. Record whether physical-watch acceptance and Funnel audio compatibility passed or remain unverified. Never include Plex tokens, `.env` contents, setup-link URLs, authentication cookies, or a database in the handoff.

For upgrades or failures, follow the documented stopped-backup and restore rollback procedure. Keep the prior data intact until recovery is verified. Never run `docker compose down --volumes`, remove a data volume, replace the encryption secret, or reset Tailscale routes to solve an unexplained failure.
