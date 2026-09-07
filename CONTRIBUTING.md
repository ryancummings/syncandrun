# Contributing to SyncAndRun

SyncAndRun welcomes bug reports, documentation improvements, and focused pull requests. This is a preview: physical watch validation is incomplete, and the Forerunner 955 / Solar is the only supported development target.

## Report a problem

Use [GitHub Issues](https://github.com/ryancummings/syncandrun/issues) for reproducible bugs and deployment questions. Include the source commit, host architecture, deployment method, expected behavior, and sanitized reproduction steps. For watch problems, include the watch model and firmware. Never upload a database, setup link, token, signing key, real media file, or unedited network trace. Report vulnerabilities through [SECURITY.md](SECURITY.md).

Discuss substantial changes in an issue before implementation. The current product selects existing Plex music playlists, synchronizes them to the owner's watches, and plays them offline. A phone app, billing system, and operation for other users are outside the product scope.

## Make a change

1. Fork the repository and create a branch from `main`.
2. Follow [development setup](docs/DEVELOPMENT.md).
3. Keep the change focused and preserve upstream copyright notices.
4. Add regression coverage for behavior changes, especially authentication, synchronization, and persistence.
5. Run the checks relevant to your change and state their results in the pull request.
6. Describe the problem, resulting behavior, compatibility impact, and any checks you could not run.

Companion-only contributors do not need Garmin hardware or a signing key. A watch change needs a successful `fr955` build and simulator tests before merge. Maintainers coordinate physical testing when needed. Never describe a simulator result as a physical-watch result.

## Review and licensing

The repository owner reviews and merges changes. Security and data integrity take priority over feature breadth. Changes to the watch protocol must update its OpenAPI definition, fixtures, and both consumers together. Database migrations must preserve existing installations or document a tested recovery path.

Contributions are distributed under the repository's GPL-3.0 license. Submit only work you have the right to contribute. Keep dependency and bundled-asset licenses with their files. No separate contributor agreement is required.

Agent-assisted contributions follow the same review and testing rules. The submitting person remains responsible for the patch and its provenance. Public instructions are in [AGENTS.md](AGENTS.md); no personal task tracker or private tools are required.

Be respectful, critique the work rather than the person, and avoid harassment or disclosure of private information. Maintainers can close disruptive discussions and remove abusive content. Support is community-based, with no promised response time.
