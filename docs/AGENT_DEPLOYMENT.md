# Package and release guide for agents

Use this guide when you package the native app or publish a GitHub Release. The [README](../README.md#download-and-install) is the setup guide for users. SyncAndRun has no server to deploy.

1. Make sure that the workspace version, README package names, and release notes agree.
2. Run the checks in [Development](DEVELOPMENT.md). Record results against the source commit.
3. Build the Mac DMG on Apple Silicon. Launch the packaged app with an isolated profile.
4. Build the Linux archive on Ubuntu 24.04 x86_64. Run its installer in a temporary prefix.
5. Record each artifact hash and the physical watch checks that remain open.
6. Merge the checked pull request to `main`.
7. Push a version tag, such as `v0.2.0`, on the merge commit. The release workflow builds and uploads both packages.
8. Confirm that the GitHub Release lists both packages and `SHA256SUMS`. Download and check each asset.

The release workflow refuses a tag whose version differs from `Cargo.toml` or whose commit is outside `main`. It uses an ad hoc Mac signature. Apple notarization needs a separate signing setup and is not part of this workflow. Keep credentials, profiles, real music, and signing keys out of the release.

Put the source commit, package hashes, verification results, and next action in the pull request or release handoff. Do not claim physical watch playback from automated tests.
