# Kick discovery performance implementation plan

> Execute inline with systematic debugging, TDD, and verification-before-completion; no subagents or publication.

**Goal:** Meet issue #498 by avoiding statically unnecessary Kick discovery and bounding/deduplicating the remaining channel requests.

**Architecture:** Keep inventory in the shared snapshot collector, evaluate static farmability before candidate enumeration using the captured settings and time, and add an optional adapter bulk-check boundary. Kick owns a revision-local response cache and three workers; each worker processes one campaign's candidates sequentially until the first valid match, with independent idle checks as separate jobs. Each campaign still derives its own category check and candidate metadata. Results remain ordered; all workers settle before publication or failure.

**Base:** Explicit stack on #497's scheduler branch, branch `perf/kick-discovery-performance`. Audited all open PRs on 2026-09-09. #500 modifies cycle observation around the Kick fetcher; preserve its lifecycle and ensure workers drain before discovery returns. #490 is an independent heartbeat-publication fix and is not carried by this stack. Other open PRs affect dependencies/UI/release integration.

**Constraints:** Shared extension/CLI core; preserve inventory, priority, unknown campaign eligibility, abort propagation and coherent snapshots. No permissions or sensitive diagnostics. Cache raw provider evidence only within one revision, then apply each request's campaign/category separately. Stop admitting work after failure; await active work. HTTP 429 must not generate page-fallback retries.

## Task 1: Pre-discovery gate

- [x] Add table-driven collector tests with completed, expired, excluded, unlinked-disallowed, subscription-disallowed, category-filtered, infeasible and blocked reward fixtures; assert inventory unchanged and no channel listing/checks. Include eligible/unlinked-allowed/claimable positive controls.
- [x] Observe red with `pnpm --filter @lurkloot/extension exec vitest run tests/kickDiscoveryPerformance.test.ts`.
- [x] Add optional settings to `collectDiscoverySnapshot`; use `evaluateCampaignFarming(campaign, settings, { includePriorityMode: true, now })` before retained observations/listing. Pass settings from controller; count skipped campaigns in metrics and diagnostics.
- [x] Repeat focused suite to green; commit gate changes.

## Task 2: Revision-local bounded Kick checks

- [x] Write real Kick-adapter tests using controlled PageFetcher responses: duplicate channel across same/different categories, metadata preservation, fresh evidence on the next revision, three active workers and deterministic output, cancellation/failure with active-worker drain, rate-limit no fallback.
- [x] Observe red before adding optional `checkChannels(requests, options)` adapter capability returning ordered checks and unique check count.
- [x] Collector accumulates eligible campaign/idle candidates and invokes bulk checks once. Kick uses three workers and a scoped raw-response promise cache; apply channel metadata independently. Existing single checks retain their behavior.
- [x] Require complete progress/evidence for snapshot refreshes; failed bulk/progress refresh keeps the old snapshot.
- [x] Run focused tests to green; commit bulk changes.

## Task 3: Integration, diagnostics and verification

- [x] Add controlled-latency and request-count coverage for idle, retained watch, and target switch through real Kick adapter, collector and snapshot selection; assert diagnostics carry campaign/skipped/unique counts and duration.
- [x] Run focused controller/adapter/discovery/baseline tests; fix regressions with observed failing cases.
- [x] Document the new discovery contract in `docs/architecture.md`.
- [x] Run fresh `pnpm verify`, self-review diff and acceptance criteria, commit final coverage/docs. Report base, commits, verification and #500 integration concerns without pushing.

## Observed verification evidence

- Baseline: 566 adapter/discovery/controller tests passed.
- Gate red: 18 failures; green: 388 gate/discovery/controller tests passed.
- Bulk red: five missing-capability/coherence failures; green: 231 focused tests passed.
- Safety red: three rate-limit/ambiguous-evidence/logging failures, followed by green.
- Lazy-budget red: eager implementation fetched three channels where first-match behavior needed one; lazy worker chains pass with one shared request across two campaigns.
- Integration budgets (100ms transport fixture): idle is two requests/100ms; retained and switch are three requests/200ms with only one channel request. Six independent 90–100ms checks complete in 190ms, with at most three requests active, versus 560ms serial.
- Inventory completeness red: three missing-envelope/undrained-progress failures; green: 590 focused tests passed and extension typecheck passed.
- Diagnostic red: missing unique-channel count; green: controller diagnostic contains all four attribution fields.
- Fresh `pnpm verify` passed: script tests, all workspace typechecks/tests, Astro site build, Chrome MV3 build and Firefox MV2 build. Existing large-chunk build warnings remain. `git diff --check` passed.
- Self-review: all #498 acceptance criteria covered. #500 must retain the added HTTP-429 early exit when integrating its adjacent fetcher lifecycle changes; channel workers and paired inventory/progress requests now drain before returning. No merge/rebase/push/PR performed.

## Review corrections

- Observed four failing lane tests for malformed directory envelopes/records and missing live page-category evidence, plus a separate failing live API-category test. Strict directory options now propagate; recognized empty directory arrays remain valid. Live API/page evidence must include a category when the campaign or idle candidate expects one; offline/no-category checks and explicit mismatches remain valid.
- Observed five failing delayed-follow cases across cold, stale and already-refreshing caches. The collector now drains both initial operations with `Promise.allSettled`. Strict Kick discovery awaits `refreshOnce` when stale, including a refresh started by a standalone caller. Existing stale values remain usable for preference; the refresh cannot update cycle observation after return. Fresh cache hits remain immediate; a stale cycle pays one followed-request latency every five minutes, with no extra request count.
- Observed a failing diagnostic test where a channel failure after listing was logged as zero campaigns/candidates. Missing attempt counters now render `work metrics=unavailable`.
- Focused review validation: 618 tests passed across performance, adapters, snapshot collector and controller suites. Rechecked #500 at `c8737826`; its consume-once observation remains compatible because cycle-owned initial operations, stale follow refreshes and workers all settle before return.
- Fresh post-review `pnpm verify` passed: 1,868 extension tests, 193 CLI tests, 10 site tests, 95 release/store script tests, workspace typechecks, site build and Chrome/Firefox builds. Existing chunk-size warnings only. Self-review and `git diff --check` passed.
