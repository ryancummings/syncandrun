# Security policy

## Report privately

Use GitHub's [private vulnerability reporting](https://github.com/ryancummings/syncandrun/security/advisories/new) for this repository. Do not open a public issue with an exploit or credentials. Include the affected commit, deployment shape, reproduction steps using synthetic data, and sanitized logs. Never attach a real database, setup link, Plex token, watch credential, signing key, or private media metadata.

If the private reporting form is unavailable, open a minimal issue requesting a private contact without vulnerability details. Keep the report private until a channel is available. There is no guaranteed response time.

## Supported scope

Security fixes target the current preview development line. There is no stable release or long-term-support branch yet. Do not expose an older build that lacks installation-owner authentication. Review changes and back up before updating.

Each installation has one owner. Only an operator-created, single-use setup link can start initial ownership setup, and subsequent access must match that owner's Plex identity. Disconnect does not transfer ownership. The owner may pair multiple watches, each with its own revocable credential.

Expose only trusted HTTPS through the intended proxy. Keep the application port on loopback, restrict trusted proxy addresses, and avoid proxy access logs that retain sensitive requests. The optional Funnel route depends on the provider's availability and bandwidth policy. Never disable TLS verification to work around certificate failures.

## Protect and recover

The database contains encrypted Plex credentials and sensitive library metadata. Its encryption secret is held separately in `.env`; possession of both permits decryption. Protect backups, setup-link files, host access, and signing keys. Keep `.env` out of logs and repositories.

Use [the deployment guide](docs/DEPLOYMENT.md) for backup, restore, upgrade, and ownership reset. Changing the encryption secret alone is not a safe rotation procedure. If the secret is compromised, revoke Plex authorization, retire the installation, and reconnect in a fresh installation with new credentials; invalidate affected backups according to your retention policy.

A watch revocation prevents new synchronization but cannot erase audio already on an offline watch. Reset the watch locally when removing that content is required. For a suspected compromise, close ingress, preserve private evidence, revoke affected credentials, and restore service only after the cause is resolved.
