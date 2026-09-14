# Source completeness

SyncAndRun contains the complete development and runtime source exported from the legacy private archive. Source completeness does not establish everyday hardware readiness: the current build still requires the [physical acceptance run](VALIDATION.md) against the owner's Plex server and chosen HTTPS deployment.

## Compared baseline

The comparison used committed file contents at these revisions, before subsequent public development:

| Item | Result |
|---|---|
| Public source revision | `c61f70d7f2a8d0eea1d66e59c870f52fa6759543` |
| Legacy archive revision | `841406cfc8f0f1ad3585c27cd08572a00527a237` |
| Archive tracked files | 211 |
| Public tracked files | 191 |
| Common paths with identical contents | 189 |
| Common paths with intentional replacement contents | 2 |
| Archive-only tracked files | 20 |
| Missing or mismatched files after applying export mappings | 0 |

The two replaced paths are `AGENTS.md` and `.gitleaks.toml`; both exactly match the archive's explicitly prepared public variants. All `watch/`, `companion/`, `deploy/`, and `docs/protocol/` files match. The build tooling, frozen dependency lockfile, CI, Compose, deployment scripts, README, contributor guide, architecture, development, agent deployment, and validation guides also match. No materially newer private implementation was found.

For reproduction, compare Git blobs rather than timestamps, then apply the legacy exporter's two public-file mappings before comparing its allowlisted tree. Its snapshot digest algorithm hashes each lexicographically ordered UTF-8 path, a NUL byte, and the SHA-256 digest of that file's contents. The public baseline digest is `fc614dbfea3330190561b2f67b80cc4d17d4d02444b2665f4dc5fc155de31745`.

Both worktrees were also inspected recursively, excluding `.git` and `node_modules`. The archive contained 93 ignored generated files, all under `companion/dist`; no additional private source, environment file, database, signing key, or watch-state file was found within that scope. Generated output is rebuilt from source. The initial public tree contained the same generated-output paths and one browser-test result file. Git internals and dependencies were outside this filesystem comparison.

## Disposition of archive-only files

| Paths | Count | Disposition |
|---|---:|---|
| `.project` | 1 | Legacy Eclipse project metadata naming SubMusic. Current builds use the retained Makefile and Monkey C project files; this is not required. |
| `changelog.md`, `images/.gitkeep`, four inherited screenshots | 6 | Historical SubMusic material, not referenced by the current application. Upstream history and licensing remain preserved. |
| `docs/V1_SPEC.md` | 1 | Detailed requirements. The retained protocol owns the API; useful storage, callback, and cache invariants are now in [ARCHITECTURE.md](ARCHITECTURE.md). |
| `docs/OPERATIONS.md` | 1 | Older deployment procedures are superseded by [DEPLOYMENT.md](DEPLOYMENT.md). Useful watch setup, recovery, and MTP instructions are preserved in [WATCH_TROUBLESHOOTING.md](WATCH_TROUBLESHOOTING.md). |
| `docs/ACCEPTANCE.md` | 1 | Historical private operational and hardware evidence. It is not evidence for the current artifact; retain privately if that provenance is wanted. Public physical acceptance requirements remain in [VALIDATION.md](VALIDATION.md). |
| `docs/IMPLEMENTATION_PLAN.md`, `docs/OPEN_SOURCE_AND_HOSTED_RELEASE_PLAN.md` | 2 | Historical execution and export plans. They are not ongoing build dependencies. |
| `docs/NAME_CLEARANCE_BRIEF.md` | 1 | Historical naming decision and screening limitations. Retain privately if wanted; not needed to develop or run the software. |
| Three `docs/agents/` guides, `skills-lock.json` | 4 | Optional private agent workflow. Public contributor and agent instructions are self-contained. |
| `public-release/AGENTS.md`, `public-release/gitleaks.toml` | 2 | Already present under their mapped public root paths. |
| `scripts/export-public.py` | 1 | One-time sanitizing exporter. Ongoing changes can be developed directly in the public repository. |

## Development and operational verification

The following evidence was recorded on 2026-09-13 for public code revision `59e2467`. The export comparison above remains tied to its original baseline.

| Requirement | Evidence and remaining gate |
|---|---|
| Companion installs and runs locally | Frozen installation succeeded with Node 22.23.2 and pnpm 10.15.1. The documented fake-Plex demo was started and its health checked. It supports browser development with synthetic metadata and placeholder media; live Plex authentication and transcoding were not verified. |
| Automated checks, including `fr955` | Lint and builds passed, with 152 companion tests across 26 files, 24 protocol fixtures, and two Playwright journeys. Four Python verifier regression tests passed using a stub SDK; these verify failure handling, not Garmin compilation. The current host lacks the Garmin SDK, Java, and signing key, so `fr955` compilation, simulator tests, and memory profiles were not run. |
| Working Compose deployment | Isolated native container build, loopback reachability, browser security headers, restart persistence, and stopped-service backup/restore passed after the Fastify and listener fixes. Local cross-architecture verification was not run because Buildx is absent. No owner installation, live Plex connection, or trusted HTTPS ingress was configured or validated. |
| CI green on main | [CI for `59e2467`](https://github.com/ryancummings/syncandrun/actions/runs/34796719373) passed all four jobs: companion, native amd64 container, native arm64 container, and secrets. The companion job includes the dependency audit, four verifier regression tests, builds, companion tests, protocol fixtures, and browser journeys. The secrets job scanned history reachable from this revision's HEAD. Local HEAD/tree secret scans passed earlier and are separate evidence. |
| Cold contributor onboarding | README, CONTRIBUTING, development, architecture, deployment, and security guidance were reviewed together; all 43 local Markdown links checked resolved. The fake-Plex workflow is documented, and real-Plex development now documents loopback binding and local owner invitation. |
| Needed archive-only material retained | All 191 export-mapped files match at the compared baseline. Useful watch invariants, pairing, MTP, and troubleshooting knowledge were ported as listed above; no missing implementation remains. |

For subsequent changes, check CI for the exact code revision:

```sh
gh run list --repo ryancummings/syncandrun --branch main --workflow ci.yml \
  --json headSha,status,conclusion,url
```

Select the run whose `headSha` matches the revision being assessed and inspect its jobs. A successful CI run does not include Garmin or physical-watch qualification. No physical Forerunner 955, live Plex server, or chosen HTTPS endpoint was validated in this verification; those remain required before claiming everyday use is proven.

## Retiring the archive

There is no missing source-code dependency requiring development to continue in the private archive. Before deleting its checkout, preserve any desired private historical evidence and confirm local branches, tags, stash, and unpushed commits have durable copies. Matching source trees does not back up an installation, its database, encryption secret, signing key, or a known-good watch artifact. Keep those separately under the operator's control.

Do not infer a hardware pass from this comparison, historical evidence, or a successful simulator run. Complete current companion, container, CI, and watch checks and record unavailable prerequisites explicitly. The source audit does not delete or authorize deletion of any repository.
