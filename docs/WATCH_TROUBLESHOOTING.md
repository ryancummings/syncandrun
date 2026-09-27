# Watch setup and troubleshooting

Build and sideload using [DEVELOPMENT.md](DEVELOPMENT.md), and configure the chosen route using [DEPLOYMENT.md](DEPLOYMENT.md). These procedures preserve useful development knowledge; they do not establish that the current build has passed the [physical acceptance run](VALIDATION.md).

## Enter the companion and pair

Open SyncAndRun from the watch's Music menu. Garmin opens its own player first; if it shows **No media**, hold **UP (Menu)** to reach the SyncAndRun menu. A watch that is not paired shows only **Set up watch**, **How it works**, and **Settings**. Playlists, Play All, Storage, and Sync now appear once the watch is paired and has music.

Choose **Set up watch** and follow the two steps. Each step opens the next one on its own:

1. **Server address.** Enter the address from the companion's Watch page, not the Plex server address. Four digit wheels start at `192.168.1.0`: UP/DOWN changes the underlined digit, START moves to the next digit, and BACK returns to the previous one. A review screen follows. START saves the address on the standard HTTP port 80; UP or DOWN on the review screen changes the port first.
2. **Pairing code.** Create a fresh code on the Watch page and enter its six digits the same way. START on the last digit saves the code, pairs over Wi-Fi, and starts the first sync. Codes expire after ten minutes.

If setup stops part-way, **Set up watch** reopens at the next unfinished step. **Settings -> Server address** and **Settings -> Pair watch** change either value later. **Settings -> Test connection** checks that the companion answers. A new address requires pairing again and keeps cached audio.

For an HTTPS, named, or other non-default address, use **Settings -> Advanced -> Other address**. Native text entry edits the hostname or IPv4 address and optional port, and a hostname defaults to HTTPS. Paths, query strings, fragments, and embedded credentials are not accepted. The address and code can also be entered in the Connect IQ app settings on the phone; values entered on the watch take precedence.

## Diagnose synchronization

| Symptom | Check or recovery |
|---|---|
| Companion not ready or unreachable | Check local `/health/ready`, then the configured origin. Readiness establishes companion startup, not Plex reachability. For HTTPS, verify DNS and certificate trust from the watch's network; for LAN HTTP, verify the watch and proxy are on the same reachable home network. |
| Pairing rejected | Generate a fresh code and confirm browser and watch point to the same installation. After revocation, pair again. Cached playback remains available. |
| Plex unavailable or authorization expired | Reconnect Plex through the companion Settings screen and check that the container can reach the selected Plex server. |
| Interrupted transfer | Retry synchronization; completed Garmin media references are retained. The companion's completed HTTP request count can exceed the watch's durable download count. |
| Insufficient storage | Select fewer playlists or remove unneeded content through Garmin's storage controls. Watch **Storage -> Remove All** destroys cached audio; reserve it for an intentional cache reset. Older affected builds could orphan media after late callbacks, and the current prevention cannot recover references already lost. |
| Artwork missing while audio works | Artwork runs after the audio commit and is optional. Retry to obtain fresh signed capabilities. Garmin's image service needs to reach the artwork origin; a private LAN address can prevent this even when watch audio succeeds. Test artwork on hardware before relying on LAN-only access. |
| Artwork absent from the native player | Check during an active Bluetooth playback session. Artwork need not appear while no audio output/session is active. |
| Playback or sync fails immediately after sideloading | Fully restart the watch before testing. Retest with the exact staged artifact and keep a known-good locally signed build for rollback. |

Before sharing diagnostics, remove credentials and real library metadata. Never upload watch state files, the companion database, setup links, signed artwork URLs, or raw request logs. Record the source commit, watch model/firmware, artifact SHA-256, deployment method, and sanitized results.

## USB and MTP sideloading

The Forerunner 955 uses MTP and may not appear as a mounted disk, especially on macOS. Close other MTP clients, including Garmin Express, before opening a session. A USB device that enumerates but fails with `libusb_claim_interface() = -3` may have its interface held by another application. If it does not enumerate at all, check the cable and direct USB connection first.

Use an MTP-capable file manager to place the development PRG inside the watch's `GARMIN/Apps` folder. The optional [libmtp helper](../scripts/garmin-mtp-send.c) resolves that folder's current object and storage identifiers; passing a slash-containing destination to a generic upload utility may instead create an incorrectly named object.

For macOS developers with libmtp installed through Homebrew, build the helper with:

```sh
mkdir -p build/tools
libmtp_prefix="$(brew --prefix libmtp)"
cc -Wall -Wextra -I"$libmtp_prefix/include" \
  scripts/garmin-mtp-send.c -L"$libmtp_prefix/lib" -lmtp \
  -o build/tools/garmin-mtp-send
build/tools/garmin-mtp-send build/watch/SyncAndRun-fr955.prg SyncAndRun-fr955.PRG
```

Before replacing a known-good build, retain that PRG and its checksum outside the checkout. If backing up watch application state, keep it private: it can contain device credentials and is not a portable restore format. Rediscover MTP object IDs for each connection. Read the uploaded PRG back using its reported object ID and compare it byte-for-byte with the local artifact before disconnecting; a successful upload message alone does not prove the correct bytes were staged. Disconnect, wait for ingestion, then fully restart the watch before playback or sync testing.
