# SyncAndRun for Garmin

Sync existing Plex music playlists to a Garmin Forerunner 955 / Solar, then listen through Garmin's native player without a phone or network. The companion runs on your own hardware and is managed in a browser.

**Preview:** physical-watch acceptance for this source version is incomplete. This is not a stable release or a Connect IQ Store listing. See [validation and limitations](docs/VALIDATION.md).

## Deploy

Follow [the deployment guide](docs/DEPLOYMENT.md) for Linux amd64 or arm64 with Docker Compose. It covers a domain with Caddy and an optional Tailscale Funnel route that needs no domain purchase or router changes. Tunnel audio compatibility remains subject to physical-watch testing.

The setup helper generates a private encryption secret. The service binds to loopback behind HTTPS. An operator-created, single-use invitation assigns the installation owner; later management requires that owner's Plex account.

Each installation serves one Plex account, server, and music library. You can host separate installations for guests, with independent credentials and data. Guests must trust the host administrator. [Agent deployment instructions](docs/AGENT_DEPLOYMENT.md) cover preparation, checks, recovery, and handoff without maintainer-private tools.

Watch builds and development sideloading are described in [DEVELOPMENT.md](docs/DEVELOPMENT.md). No prebuilt watch package or published container image is required: build from a reviewed source revision.

## What it does

- Select existing Plex audio playlists in a browser.
- Choose Compact (64 kbps), Balanced (96 kbps), or High (128 kbps) MP3 audio.
- Synchronize over Wi-Fi, reuse unchanged audio, and deduplicate shared tracks.
- View observed synchronization progress and manage paired watches.
- Play cached audio through Bluetooth headphones with the phone and network absent.

Plex remains the playlist editor. Album/artist/track browsing, playlist editing, streaming playback, a phone app, billing, and a shared multi-account service are outside this preview. The development target is `fr955`; other watches are not claimed as supported.

## Contribute

Use [GitHub Issues](https://github.com/ryancummings/syncandrun/issues) and pull requests. Start with [CONTRIBUTING.md](CONTRIBUTING.md), [development setup](docs/DEVELOPMENT.md), and [architecture](docs/ARCHITECTURE.md). The source includes the complete watch and companion; self-hosting has no feature gates.

```text
watch/       Garmin Connect IQ Audio Content Provider (Monkey C)
companion/   Fastify, TypeScript, SQLite, React browser interface
deploy/     HTTPS proxy examples
docs/       Deployment, development, architecture, protocol, validation
```

## Security and privacy

Plex credentials stay in the companion and are encrypted using the operator secret. The watch holds a revocable companion credential. Audio streams through the companion without a persistent audio cache. Protect the secret and database backups together. Read [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md) before exposing an installation.

Use trusted HTTPS for deployment. The watch's HTTP option is for development and exposes credentials and media in transit. SyncAndRun includes no analytics, advertising, or telemetry. Third-party Plex, Garmin, and optional tunnel services have their own data handling.

## License

SyncAndRun is free software under GPL-3.0, derived from [SubMusic](https://github.com/memen45/SubMusic) at `3f6830d`. The public history preserves that upstream ancestry and adds the sanitized SyncAndRun source. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md), including bundled font licenses.

This project is unofficial and is not affiliated with Plex, Garmin, or SubMusic's maintainers.
