# Kick route diagnostics implementation plan

> **For agentic workers:** Execute inline with superpowers:executing-plans, strict red/green tests, and no subagents, as requested for this sequential stack.

**Goal:** Replace request-proportional Kick success diagnostics with operation summaries while preserving routing failures and transitions (#499).

**Architecture:** Keep the last route per allowlisted host in host-owned `KickDiscoveryState`, shared across adapter reconstruction. Fetcher-local counters collect successful background/page requests; a separate flush hook publishes English diagnostic events at drained auth, discovery, and scheduler-operation boundaries. Never consume page-context recovery observations to obtain diagnostic counts.

**Tech stack:** TypeScript, pnpm, Vitest, existing engine event collectors and reporters.

**Design:** The existing fetcher emits every success and creates a fresh announcement map. Removing repeat events alone would lose volume evidence; retaining raw events until reporting would retain the memory cost. Fixed host/route counters preserve volume with bounded memory. Transition state survives adapter construction but intentionally resets when the runtime restarts. Counts describe successful requests, not successful scheduler publication. Failed/aborted operations must not masquerade as committed recovery cycles.

## Constraints and dependency audit

- Branch `perf/kick-route-diagnostics` from reviewed `9b4be632`, stacking #497 and #498; no push, merge, rebase, or PR.
- Current `origin/develop` is `8f58c2b1`; its newer wrangler dependency change is unrelated.
- Resumption audit (2026-09-10): `origin/develop` advanced to `3c4e3ac6` via dependency PR #493. New open PRs #515/#516 concern in-page panel documentation/UI only. #500 remains at `c8737826`; #490 remains independently scoped to heartbeat publication gates. Keep the exact reviewed stack base.
- Open PR #500 introduces consume-once page-context observations. Keep the summary flush API independent and call it only after active requests drain. #498 already drains batch and followed-channel work.
- PR #490 changes heartbeat/discovery persistence; preserve existing publication semantics. Other open PRs (#514, #513, #493, #466, #451, #283) are dependency or release work outside this scope.
- English diagnostics only; no activity mirroring changes, network-policy changes, paths, query values, credentials, headers, payloads, or unbounded host cardinality.
- Extension export and CLI event formatters consume ordinary diagnostic events without custom parsing.

## Task 1: Transport aggregation

Files: `packages/core/src/platforms/kick/index.ts`, new `routeDiagnostics.ts`, `packages/core/src/platforms/adapter.ts`, `packages/extension/tests/kickRouteDiagnostics.test.ts`.

- [x] Write deterministic tests: thousands of requests emit only initial transitions before flush; flush emits exact host/route totals; reconstruction with shared state produces no new info transition; fallback/recovery/lifecycle failures retain individual evidence; unsafe URL material never enters output; in-flight flush cannot publish incomplete counts.
- [x] Run `pnpm --filter @lurkloot/extension test tests/kickRouteDiagnostics.test.ts` and observe missing summary behavior fail.
- [x] Implement fixed host/route counters and separate `flushRouteDiagnostics(emit)` hook. Preserve original request/abort/429 behavior and lifecycle callbacks.
- [x] Repeat focused tests and existing adapter/discovery tests until green.

## Task 2: Hosts and operation boundaries

Files: extension background factory, CLI transport factory, controller, controller tests, CLI transport tests, architecture documentation.

Additional owned integration files: `packages/core/src/platforms/kick/watch.ts`
and `packages/extension/tests/tablessWatch.test.ts`. Retained watchers outlive
their creating tick, so their event drain must flush reconnect/target-refresh
counts, including the existing `websockets.kick.com` token host. Standalone
category search and manual claim handlers also flush before reporting.

- [x] Add failing integration tests using real Kick fetchers/adapters: fresh controller-created adapters across many ticks, complete discovery counts, no early flush of delayed workers, and useful CLI debug messages.
- [x] Inject shared route state in both factories; CLI uses the background route without adding page fallback.
- [x] Flush drained discovery/auth/tick operations, preserve route evidence during scheduler rollback, and leave PR #500's lifecycle consumption independent.
- [x] Run controller, adapters, discovery, CLI transport, and event-reporting tests.

## Task 3: Verification and handoff

- [x] Self-review issue criteria, bounded event/memory growth, concurrent work, privacy, and #500 merge touchpoints.
- [x] Run fresh `pnpm verify` and CLI tests. Record exact outcomes here.
- [x] Commit focused Conventional Commits; return branch/base, commits, tests, and dependency decisions without pushing.

## Verification and review record

- Strict red/green: five initial route tests failed on missing aggregation and
  repeated announcements; controller and CLI integration tests then failed on
  missing flushes; rollback, watcher reconnect, and manual-operation regressions
  each failed before their fixes.
- Final focused run: 635 extension tests in five files and 14 CLI transport tests
  passed. The long deterministic run covers 66,000 successful requests over 660
  fresh fetchers: exactly 660 summaries and two initial host transitions.
- Fresh `pnpm verify` on 2026-09-10 exited 0: 17 CWS tests, 78 release tests,
  workspace typechecks, complete extension and CLI suites, Astro site build,
  Chromium MV3 build, and Firefox MV2 build. Existing large-chunk build warnings
  remain informational. `git diff --check` passed.
- Fixed-size routing state has at most four host entries; counters at most eight
  host/route entries. Request/lifecycle promises must settle before flush.
- PR #500 is not included in this stack. Its recovery observation method remains
  independent: do not replace it with summary counts or invoke it from a flush.
  When combining the overlapping fetcher edits, retain #498's 429 guard and
  drained workers plus #500's background/fallback host observations. Combined
  #500 runtime behavior has not been tested on this branch.
- PR #490's publication guards are untouched. No locale, permission, activity
  mirror, network-policy, or release changes are part of this implementation.

## Review follow-up (2026-09-10)

The review identified two discarded-evidence paths: route events were still
gated by operational publication, and an auth deadline could abandon a flush
while its lifecycle callback remained active. CLI `discover` also constructed
its adapters without an emitter.

- [x] Reproduce scheduler abort after drain, stale publication rejection, auth
  abort, stale auth generation, and late lifecycle completion/failure with real
  Kick fetchers in controller tests. Six initial regressions failed as expected.
- [x] Report only the three safe transport diagnostic codes independently of
  operational collectors, retaining tick correlation. Close collectors/handles
  to discard late activity. Track reporting promises without awaiting unfinished
  HTTP/lifecycle work or changing auth deadlines.
- [x] Defer an active flush until the last request/lifecycle callback settles;
  reset the pending flush before emitting to prevent duplicate summaries.
- [x] Add a failing built-CLI command regression, then construct CLI discovery
  adapters with their operation emitter and flush/report before disposal.
- [x] Extend late-completion coverage to both standalone auth and tick-owned
  adapters, and verify a later valid generation does not reannounce the route.
- [x] Run fresh focused tests and `pnpm verify`, self-review, and commit.

Review verification: the five focused extension files passed 643 tests; CLI
command and transport suites passed 50 tests. Fresh `pnpm verify` exited 0,
including 1,884 extension tests in 84 files, 195 CLI tests in 12 files, 10 site
tests, 17 CWS tests, 78 release tests, all workspace typechecks, the site build,
and both browser builds. Self-review confirmed that late transport reporting
retains tick correlation without retaining an operational collector, summaries
are emitted only once after active work drains, and discarded activities are not
published. `git diff --check` passed.

Overlap re-audit: `origin/develop` remains `3c4e3ac6`; #500 remains `c8737826`.
The open PR set and the previously recorded independent scope decisions are
unchanged. No branch integration or recovery-observation consumption is added.

Final correlation follow-up: a real Kick watcher startup regression first failed
because immediate route reporting bypassed the collector's later tick-ID
decoration. The scheduler collector now passes its current tick context to that
reporting boundary; standalone and auth collectors are unchanged. The regression
asserts both startup host transitions and the drained summary carry distinct
global/platform tick IDs (2/1). All 398 tests in the three focused controller,
route, and watcher suites passed. Fresh `pnpm verify` exited 0 with 1,885 extension
tests, 195 CLI tests, 10 site tests, 17 CWS tests, 78 release tests, all typechecks,
and the site/Chromium/Firefox builds. Self-review and `git diff --check` passed;
the summary/recovery observation separation is unchanged.

Cross-platform reporting follow-up: four deterministic regressions first failed
with a stalled Kick summary preventing Twitch discovery or a due heartbeat's
provider call, for both standalone-auth and tick-owned Kick summaries. Collectors
and tick adapter handles now own separate report sets; only explicit
`settleBackgroundWork()` drains the controller-wide registry. The regressions
verify Twitch finishes while Kick's owning operation and explicit report
settling remain pending until the summary is released. All 648 tests in five
focused suites passed, including late auth completion, discarded activity, and
tick-correlation regressions. Fresh `pnpm verify` exited 0: 1,889 extension tests,
195 CLI tests, 10 site tests, 17 CWS tests, 78 release tests, all typechecks, and
the site/Chromium/Firefox builds. Self-review and `git diff --check` passed.
No PR #500 changes or recovery-observation consumption are included.
