# SyncAndRun for Garmin

Sync existing Plex music playlists to a Garmin Forerunner 955 / Solar, then listen through Garmin's native player without a phone or network. The companion runs on your own hardware and is managed in a browser.

**Preview:** physical-watch acceptance for this source version is incomplete. This is not a stable release or a Connect IQ Store listing. See [validation and limitations](docs/VALIDATION.md).

## Quick start

On a computer on your home network that is always on, with Docker installed:

```sh
git clone https://github.com/ryancummings/syncandrun.git
cd syncandrun
docker compose up -d --build
```

Then:

1. Open `http://<that computer's IP address>` in a browser, for example `http://192.168.1.20`.
2. Select **Sign in with Plex**. The first Plex account to sign in owns this SyncAndRun; only that account can manage it afterwards.
3. Choose your playlists, then select **Next: pair your watch** and follow the three steps shown. They include the exact address and code to enter on the watch.

Nothing else needs configuring. The companion answers on port 80 over plain HTTP, which suits a home network: anyone on that network could read the traffic. To use another port, run `SYNCANDRUN_PORT=8080 docker compose up -d --build`; the Watch page then shows the address with its port. The [deployment guide](docs/DEPLOYMENT.md) also covers HTTPS, public domains, reverse proxies, backups, and upgrades.

Each installation serves its owner’s one Plex account, server, and music library, and can pair multiple watches belonging to that owner. [Agent deployment instructions](docs/AGENT_DEPLOYMENT.md) cover preparation, checks, recovery, and handoff without maintainer-private tools.

Watch builds and development sideloading are described in [DEVELOPMENT.md](docs/DEVELOPMENT.md). No prebuilt watch package or published container image is required: build from a reviewed source revision.

## What it does

- Select existing Plex audio playlists in a browser.
- Choose Compact (64 kbps), Balanced (96 kbps), or High (128 kbps) MP3 audio.
- Synchronize over Wi-Fi, reuse unchanged audio, and deduplicate shared tracks.
- View observed synchronization progress and manage paired watches.
- Play cached audio through Bluetooth headphones with the phone and network absent.

Plex remains the playlist editor. Album/artist/track browsing, playlist editing, streaming playback, a phone app, and billing are outside this preview. Service operation for other people is outside the product scope. The development target is `fr955`; other watches are not claimed as supported.

## Contribute

Use [GitHub Issues](https://github.com/ryancummings/syncandrun/issues) and pull requests. Start with [CONTRIBUTING.md](CONTRIBUTING.md), [development setup](docs/DEVELOPMENT.md), and [architecture](docs/ARCHITECTURE.md). The source includes the complete watch and companion; self-hosting has no feature gates.

The [source completeness audit](docs/SOURCE_COMPLETENESS.md) records the comparison with the legacy archive and where useful development knowledge was preserved.

```text
watch/       Garmin Connect IQ Audio Content Provider (Monkey C)
companion/   Fastify, TypeScript, SQLite, React browser interface
deploy/     HTTPS proxy examples
docs/       Deployment, development, architecture, protocol, validation
```

## Security and privacy

Plex credentials stay in the companion and are encrypted using the operator secret. The watch holds a revocable companion credential. Audio streams through the companion without a persistent audio cache. Protect the secret and database backups together. Read [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md) before exposing an installation.

The default home installation uses plain HTTP, which exposes browser sessions, watch credentials, and media in transit to others on the same network; the deployment guide covers HTTPS. SyncAndRun includes no analytics, advertising, or telemetry. Third-party Plex, Garmin, and optional tunnel services have their own data handling.

## License

SyncAndRun is free software under GPL-3.0, derived from [SubMusic](https://github.com/memen45/SubMusic) at `3f6830d`. The public history preserves that upstream ancestry and adds the sanitized SyncAndRun source. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md), including bundled font licenses.

This project is unofficial and is not affiliated with Plex, Garmin, or SubMusic's maintainers.
