# Releasing Lurkloot

Label a pull request into `main`, inspect the candidate, and merge that pull request normally. A
generated release pull request carrying the version bump then opens against `main`; merging it starts
publication automatically, pausing for approval on the `production` environment. Do not create or
move tags by hand.

## Before you start: write the changelog

Release notes are rendered only from `packages/site/src/changelog.json`. Add the entry for the new
version to the branch being released before applying the label. Put it at the top and omit `date`;
Prepare release stamps it:

```json
{ "version": "1.6.0", "changes": [
  { "kind": "new", "text": "Added a feature." }
] }
```

Valid change kinds are `new`, `improved`, and `fixed`. If no entry exists, preparation creates an
empty entry. That intentionally permits build-only releases, but produces an empty release body.

## Normal release flow

1. Open the intended source pull request into `main`. For a normal release this is the `develop` to
   `main` promotion pull request.
2. Apply exactly one of `release/patch`, `release/minor`, or `release/major`. The label validates the
   version and builds a candidate. It does not modify the pull request it is applied to.
3. Candidate automation verifies the labelled head, publishes the signed extension artifacts as the
   mutable `vX.Y.Z` GitHub **prerelease**, pushes GHCR `candidate-X.Y.Z`, and deploys the site to
   `next.lurkloot.pages.dev`.
4. Review and merge that pull request normally, with a **merge commit**.
5. Prepare release then cuts `release/X.Y.Z` from the resulting merge commit on `main`, commits the
   version in all seven workspace manifests, dates the changelog, opens a generated pull request into
   `main`, copies the release label to it, and rebuilds the candidate from the release branch. The
   generated pull request's diff is only the version bump and changelog date.
6. Review and merge the generated `release/X.Y.Z` pull request with a **merge commit**. Squash and
   rebase are blocked on `main`; the original `develop` commit SHAs remain in `main` history.
7. Release runs from the merged `main` commit. Approve its `production` publication job. It promotes
   the `vX.Y.Z` prerelease to the latest release, publishing the extension artifacts it already
   carries rather than rebuilding them, retags the verified `candidate-X.Y.Z` GHCR manifest by
   digest, then publishes the Chrome Web Store and the production site.
8. A separate `sync` job then merges `main` directly into `develop` with the dedicated
   synchronization App, after verifying the merged tree. It is also gated on `production`, so it
   asks for a second approval. That separation is deliberate: it verifies a tree that is not the one
   being released, and a failure there must leave a completed release plus one retryable job rather
   than wedge publication.

`workflow_dispatch` remains on **Release** only for idempotent recovery. A successful release does
not require a manual dispatch.

## Label lifecycle

- No recognized label means ordinary pull-request behavior.
- More than one recognized release label blocks preparation and posts an explanatory comment.
- Removing one label while another remains prepares the remaining selection.
- Removing the final release label comments that merging will no longer cut a release. Any candidate
  already published is left in place, because it may already be under review.
- The release branch is cut only when a labelled pull request merges. Closing one unmerged cuts
  nothing.
- Generated `release/*` pull requests carry their release label for promotion validation but are
  ignored as new preparation sources.
- Fork pull requests cannot prepare releases. In this public repository, native GitHub roles limit
  label application to users with triage-or-higher access; currently only `jamezrin` has that access.

## Candidate behavior

Candidate pointers are deliberately mutable:

- GitHub tag/release: `vX.Y.Z`, published as a prerelease
- GHCR image: `candidate-X.Y.Z`
- Site: `https://next.lurkloot.pages.dev`

Every push to a labelled head rebuilds and refreshes those targets, as does every generated
release-branch push, so the candidate always describes the commit that would be released rather
than whichever commit was current when the label went on. Ownership metadata binds
the candidate release to its pull request. While the candidate release object still exists, its tag
is moved to the commit being built — that is what makes the candidate mutable. A tag left behind
with no release object is recovered only when it points at the exact commit being published; at any
other commit it is rejected. Automation never modifies a stable release through the candidate path:
promotion clears the prerelease flag, and every later candidate build against that tag fails.

The candidate and the stable release are the same object. `vX.Y.Z` is created during candidacy at the
release branch head and is never moved; merging the release pull request flips it from prerelease to
latest and publishes the artifacts it already carries. Because `vX.Y.Z` exists while the release is
still under review, it is a moving tag until promotion — it stays out of `releases/latest` while it
is a prerelease, but anyone pinning the raw tag during that window gets a pre-release commit.

The candidate pipeline writes all five required contexts directly to the generated release PR head:
the four build/verification contexts plus `release candidate / ready`. This is necessary because
GitHub intentionally suppresses new workflow events caused by the `GITHUB_TOKEN` that opens the PR.

Only the most recently completed site candidate matters. Concurrent candidates therefore share the
`next` deployment and the last successful deployment wins.

## Parallel hotfix and normal candidates

Different versions may be prepared concurrently. For example, with `1.5.0` stable:

```text
release/1.5.1  <- patch candidate from a hotfix branch based on main
release/1.6.0  <- minor candidate from a develop snapshot
```

If `1.5.1` publishes first, `1.6.0` remains the correct minor version, but its old candidate does
not contain the hotfix. Merge the updated `main` into `release/1.6.0`, resolve manifest or changelog
conflicts by keeping version `1.6.0` and both changelog entries, and push. Do not rebase: merging
preserves the original development commit SHAs. The push rebuilds the candidate before it can merge.

If `1.6.0` publishes first, a pending `1.5.1` is invalid because releases cannot go backwards.
Re-prepare the hotfix as `1.6.1`.

Two pull requests may not own the same candidate version. The second preparation fails instead of
force-pushing over the first release branch.

## Stable publication

Stable publication operates on the exact merged commit and is idempotent:

- `vX.Y.Z` is created once and is never moved.
- The signed CRX, Chrome ZIP, Firefox ZIP, Firefox source ZIP, and checksums are uploaded to the
  stable GitHub release.
- The GHCR `candidate-X.Y.Z` manifest built during candidacy is promoted by digest: the approved
  production job retags that exact manifest as `X.Y.Z`, `X.Y`, `X`, and `latest`, so the published
  image is the one the required checks passed against. Nothing is rebuilt on the normal path, and an
  existing `X.Y.Z` digest is never replaced.
- If that candidate image no longer exists, the approved job falls back to rebuilding checksummed
  OCI archives from the merged commit. A rebuild is not bit-identical, so when `X.Y.Z` is already
  published the published digest stays authoritative and only the moving aliases are re-pointed.
- Build provenance is attested during candidacy, for the signed extension assets and for the CLI
  image digest, and stable publication ships those same bytes. Verify a downloaded asset with
  `gh attestation verify <file> --repo jamezrin/lurkloot`, and the image with
  `gh attestation verify oci://ghcr.io/jamezrin/lurkloot-cli:X.Y.Z --repo jamezrin/lurkloot`.
- Chrome Web Store receives the Chrome ZIP with `DEFAULT_PUBLISH`; Google publishes it automatically
  after review approval.
- The production site deploys to `https://lurkloot.jamezrin.com`.
- The owned mutable candidate release and tag are removed after the stable release exists.
- `main` is merged directly into `develop` after local `pnpm verify` succeeds, in the separate
  `sync` job. The release is complete before it runs; nothing it does can unpublish anything.

Firefox Add-ons publication remains manual. Upload the Firefox and source ZIPs from the GitHub
release to AMO.

## Branch model

- Ordinary feature and fix pull requests into `develop` use squash merge.
- Release and hotfix pull requests into `main` use merge commits.
- Rebase merging is disabled repository-wide.
- Force pushes and deletions remain blocked on both protected branches.
- The dedicated synchronization App may bypass only the `develop` pull-request requirement so it
  can fast-forward or merge `main` directly after publication.
- The general GitHub Actions App is not a bypass actor.

The direct synchronization is a fast-forward when `develop` has not advanced. When it has advanced,
the sync creates a merge commit, verifies the combined tree, and pushes it. A conflict aborts before
any remote update.

## Environments and credentials

There are exactly two environments:

| Environment | Approval | Credentials and purpose |
| --- | --- | --- |
| `preview` | none | `CRX_PRIVATE_KEY`; candidate signing, candidate GHCR, preview site |
| `production` | `jamezrin` | CWS credentials and sync App credentials; stable publication and the `develop` synchronization, approved separately |

Repository secrets used from both channels remain `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. Variables are `CWS_PUBLISHER_ID` and `CWS_EXTENSION_ID`.

Move `CRX_PRIVATE_KEY` to `preview` and `CWS_SERVICE_ACCOUNT_JSON` to `production` when their
plaintext values are available. Never delete the repository copy until the environment copy has
been written successfully. Losing the CRX key changes the extension ID.

The production environment additionally requires:

- `RELEASE_SYNC_APP_ID`
- `RELEASE_SYNC_APP_PRIVATE_KEY`

## One-time dedicated App setup

The settings template is `docs/github-apps/release-sync-manifest.json`. GitHub requires the owner to
authorize App registration; a workflow cannot create this identity for itself.

1. In GitHub, open **Settings -> Developer settings -> GitHub Apps -> New GitHub App**.
2. Use the template name and URL, disable the webhook, keep the App private, grant repository
   `Contents: Read and write`, and subscribe to no events.
3. Install the App only on `jamezrin/lurkloot`.
4. Record the numeric App ID and generate one private key PEM.
5. Store them on the protected environment:

   ```sh
   gh secret set RELEASE_SYNC_APP_ID --env production --body "APP_ID"
   gh secret set RELEASE_SYNC_APP_PRIVATE_KEY --env production < release-sync.private-key.pem
   ```

6. Preview the ruleset migration, then apply it using the App ID:

   ```sh
   export GITHUB_REPOSITORY=jamezrin/lurkloot
   export GH_TOKEN="$(gh auth token)"
   node scripts/release/cli.mjs configure-repository --sync-app-id "APP_ID"
   node scripts/release/cli.mjs configure-repository --sync-app-id "APP_ID" --apply true
   ```

Apply mode enables merge+squash, disables rebase, creates and reads back both active rulesets, and
only then removes the conflicting classic protections. It refuses to run without a positive App ID.

## Repository policy after migration

`main release history` targets `main` and requires:

- pull requests merged with `merge` only;
- `verify`, `extension / build`, and both Docker architecture checks;
- `release candidate / ready`, reported against the PR head by trusted workflow code;
- branches up to date with `main` before merge;
- no deletion or force push;
- no bypass actors.

`develop squash history` targets `develop` and requires:

- pull requests merged with `squash` only for ordinary actors;
- the four ordinary validation/build checks and strict up-to-date policy;
- no deletion or force push;
- only the Lurkloot Release Sync App as an always-allowed bypass actor.

The repository default workflow token remains read-only.

Third-party actions (`pnpm/*`, `docker/*`, `cloudflare/*`) are pinned to a commit SHA with the
version in a trailing comment. GitHub-owned `actions/*` stay tag-pinned. Renovate updates the pinned
SHAs; do not replace one with a floating tag.

## Recovery

- Preparation failure: fix the cause and remove/reapply the release label.
- Candidate failure: re-run the failed workflow or push the corrected release branch.
- Stable failure after merge: fix the external/configuration problem and manually dispatch
  **Release** on `main`. Matching completed steps are no-ops.
- Release merged but never approved, then re-cut: dispatch **Release**, do not re-apply a release
  label. `main` already carries the bump, so preparation has an empty commit and no pull request to
  open; it detects that and comments with this instruction. The tag is fine — a still-prerelease tag
  is moved rather than rejected — and a dispatch resolves the merged release commit and publishes
  from it.
- Existing stable tag at another SHA: stop and prepare a new version. Never move it.
- Sync failure, including a `develop` tree that no longer passes `pnpm verify`: the release itself
  is complete. Fix `develop`, then rerun the failed `sync` job alone; publication is not repeated.
- Sync conflict: merge `main` into `develop` locally, run `pnpm verify`, and push with the dedicated
  App credential; alternatively use a one-off reviewed synchronization PR. Do not disable branch
  protection.
- Missing App configuration: the credential check is the first step of publication, so the job
  fails before anything is published. Add the two production secrets and rerun Release.

The Chrome Web Store intentionally trails the GitHub release while Google reviews the submission.
There is no polling, cancellation, or rollback workflow.
