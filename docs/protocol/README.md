# Watch protocol v1

`openapi.yaml` is the authoritative browser-independent contract between the
self-hosted companion and the Garmin watch. JSON fixtures are sanitized and
shared by companion route tests and watch parser tests.

All watch requests use HTTPS. After pairing, the watch sends its revocable
device credential as `Authorization: Bearer <device-token>` for JSON and audio
requests. Connect IQ SDK 9.2 supports custom headers on
`Communications.makeWebRequest` with audio response content, so long-lived
credentials are never placed in URLs. `makeImageRequest` cannot attach that
header, so each manifest artwork location instead carries a six-hour HMAC
capability scoped to one track and artwork identity. It may be a relative path
on the companion origin or an absolute HTTPS URL on a separately configured
artwork-only origin. Capability signatures are
redacted from request logs.
When desired artwork is still missing, the watch intentionally omits its
manifest `If-None-Match` header so the next traversal receives fresh expiring
capabilities while reusing all matching cached audio.

Pages contain at most ten items. Cursors are opaque, strings are bounded by the
OpenAPI schemas, and clients must reject a protocol version other than `1`
before changing local desired state.

## Manifest revision

The companion calculates the installation manifest revision as lowercase
SHA-256 over canonical UTF-8 JSON containing, in order:

1. Protocol version.
2. Transcode profile id.
3. Selected playlist ids sorted lexicographically.
4. For each selected playlist: its source revision and ordered tracks.
5. For each ordered track: stable id and source/profile content fingerprint.

Object keys are sorted recursively, arrays retain the order stated above,
numbers use their JSON decimal representation, and no insignificant
whitespace is emitted. Playlist order is never sorted; only the installation's
set of selected playlist ids is sorted for determinism.

Run `make contract-test` to validate OpenAPI and every canonical fixture.
