# Self-Hosted macOS DMG Release

This guide explains how the official Open Design repository produces macOS DMGs and how a fork can periodically merge upstream and build its own DMG without depending on the official release storage.

## What the official pipeline does

The official repository uses GitHub Actions release workflows under `.github/workflows/`:

- `release-stable.yml` handles `nightly` and `stable`.
- `release-beta.yml` handles the public beta lane.
- `release-preview.yml` handles preview builds.
- `release-beta-s.yml` is a self-hosted beta lane for the maintainers' own S3-compatible storage.

The stable and beta workflows are intentionally official-repo only. Their metadata jobs are guarded with `github.repository == 'nexu-io/open-design'`, then the build jobs use the metadata outputs to produce platform artifacts.

For macOS, the important path is:

1. Install Node `24` and `pnpm@10.33.2`.
2. Run `pnpm install --frozen-lockfile`.
3. Build through the packaging control plane, not by calling Electron Builder directly:

   ```bash
   pnpm exec tools-pack mac build \
     --dir "$RUNNER_TEMP/tools-pack" \
     --namespace <release-namespace> \
     --portable \
     --app-version <release-version> \
     --mac-compression normal \
     --to all \
     --require-vela-cli \
     --json \
     --signed
   ```

4. For signed release builds, decode `APPLE_SIGNING_CERTIFICATE_BASE64` into a `.p12`, export `CSC_LINK` and `CSC_KEY_PASSWORD`, then pass `--signed`.
5. For notarized builds, also provide `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`, then pass `--notarize`.
6. Smoke the packaged runtime through `e2e/scripts/release-smoke.ts`.
7. Prepare release assets and publish platform manifests/updater metadata to the official Cloudflare R2 release bucket.

The key point: `tools-pack mac build` owns the app assembly, resource copying, workspace builds, Electron Builder configuration, DMG finalization, and release-artifact paths. A fork should reuse that command instead of duplicating packaging logic.

## Fork workflow

Forks can use `.github/workflows/self-hosted-mac-dmg.yml`.

The workflow does four things:

1. Checks out the fork branch.
2. Fetches `nexu-io/open-design` and merges the selected upstream ref.
3. Pushes the merged fork branch when the merge succeeds.
4. Builds a macOS arm64 DMG with `tools-pack mac build`, uploads it as a workflow artifact, and optionally creates or updates a GitHub Release.

The workflow is skipped in the official `nexu-io/open-design` repository so it cannot interfere with official release lanes.

## Schedule and manual runs

The workflow has a daily schedule:

```yaml
cron: "17 18 * * *"
```

That means GitHub runs it once per day from the fork's default branch. Fork owners can change or remove the schedule.

You can also run it manually from GitHub Actions and override:

- `upstream_repository`: defaults to `nexu-io/open-design`.
- `upstream_ref`: defaults to `main`.
- `target_branch`: defaults to `main`.
- `release_version`: empty means `<apps/packaged version>-selfhost.<run number>`.
- `namespace`: defaults to `self-hosted`.
- `mac_sign_mode`: `no`, `sign-only`, or `notarize`.
- `smoke_mode`: `skip`, `core`, or `full`.
- `require_vela_cli`: whether packaging must fail if the optional Vela CLI cannot be bundled.
- `create_release`: whether to create/update a GitHub Release with the DMG.

If the upstream merge conflicts, the workflow fails before pushing. Resolve the conflict locally, push the target branch, then rerun the workflow.

## Signing and notarization

Unsigned builds need no Apple secrets and are suitable for internal testing. macOS users may need to bypass Gatekeeper manually.

For `sign-only`, configure these repository secrets:

- `APPLE_SIGNING_CERTIFICATE_BASE64`: base64-encoded Developer ID Application `.p12`.
- `APPLE_SIGNING_CERTIFICATE_PASSWORD`: password for the `.p12`.

For `notarize`, also configure:

- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

The workflow passes those values to `.github/workflow/scripts/release/build-platform.sh`, which prepares signing/notarization and then invokes `tools-pack mac build`.

## Outputs

Every successful run uploads a workflow artifact named `open-design-self-hosted-mac-arm64` containing:

- `Open-Design-self-hosted-<version>-mac-arm64.dmg`
- `mac-arm64-build.json`

When `create_release` is true, the same files are attached to a GitHub Release tagged:

```text
self-hosted-mac-v<version>-<short-commit>
```

This release is only for the fork. It does not publish updater metadata to `releases.open-design.ai` or the official R2 bucket.

