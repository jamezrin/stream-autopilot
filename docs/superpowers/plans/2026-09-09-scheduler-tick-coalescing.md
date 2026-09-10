# Scheduler tick coalescing implementation plan

**Goal:** Satisfy #497 by bounding scheduler admission independently for Twitch and Kick.

**Architecture:** Reserve one active and one pending request before loading settings or emitting tick lifecycle diagnostics. Pending requests share one result promise and merge trigger precedence; executed work alone owns persistence callbacks and claim handling. Lifecycle invalidation discards obsolete pending requests. Discovery signals enter the same admission lane.

**Tech stack:** TypeScript, pnpm, Vitest; browser-free shared controller used by extension alarms and CLI intervals.

**Spec:** GitHub issue #497 and its acceptance criteria.

## Constraints and overlap

- Keep heartbeat admission and cadence independent.
- Preserve committed tick results and reload state/settings when pending work executes.
- Precedence: backoff-bypassing manual/claim triggers > startup (forced selection) > settings/toggles/fallback/manual-watch > ordinary alarm/discovery signals. All reasons remain in diagnostic counts. Settings/toggles already persist and invalidate selection before requesting ticks.
- PR #500 reconciles Kick recovery after scheduler persistence; keep that integration point unchanged. PR #490 changes publication revision checks and #496 adds a separate claim alarm; neither is a dependency. Remaining open PRs affect UI/dependencies or develop-to-main integration.
- Work only in `.worktrees/scheduler-tick-coalescing`; no push, rebase, merge, or PR creation.

## Task 1: Bounded scheduler requests

- [x] Add deterministic alarm burst regression: block Twitch discovery, advance multiple one-minute intervals, prove one running tick and one follow-up while Kick progresses.
- [x] Run `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts` and observe red.
- [x] Add synchronous per-platform admission and coalesced count/reason diagnostics; execute pending work with fresh settings/state.
- [x] Prove manual/claim trigger force and backoff overrides survive an ordinary pending request; cover shared committed results, failures, disable/reset/shutdown, and discovery signal merging.
- [x] Update existing discovery-overlap expectation to scheduler admission behavior; run controller and heartbeat tests.

## Task 2: CLI and final verification

- [x] Strengthen CLI interval regression to hold discovery across multiple intervals and count executed ticks/auth probes, not only provider coalescing.
- [x] Observe red then green; label CLI interval requests as alarms.
- [x] Document semantics in architecture documentation.
- [x] Run `pnpm verify`, inspect the complete diff and `git diff --check`, then commit the focused implementation and tests.

## Verification evidence

- Initial controller baseline: 344 tests passed.
- Alarm burst failed with six executed starts instead of one, then passed with one active and one pending execution.
- Reset/shutdown cancellation, shared result promises, discovery-signal/alarm merging, coalesced diagnostic counts, and latest multi-platform committed-result ordering each had observed failing regressions before their fixes.
- CLI shared-result observation and continuous all-disabled cleanup had observed red-green cycles. The interval regression checks five elapsed intervals, six independent Kick refreshes, and exactly three Twitch executions (initial, blocked interval, coalesced follow-up).
- `pnpm verify` passed on 2026-09-09: script tests, all workspace typechecks, all package tests (including 193 CLI tests), site production build, Chromium MV3 build, and Firefox MV2 build. Existing bundle-size warnings remain.
- Complete implementation/test/documentation diff self-reviewed; `git diff --check` passed.
- Open-PR recheck: #500 remains `c8737826` and its post-persistence recovery hook is unchanged by this work. #490 publication validity and #496 dedicated claim alarms remain independent. #504 merged while work was paused; its settings UI changes do not require rebasing this branch before review.

## Review follow-up: discovery signal lifecycle identity

The review identified that a signal paused during its settings read could enter
the scheduler's pending slot after an alarm acquired the platform. Admission
discarded the signal controller/generation, so later auth invalidation could not
cancel that contribution.

- [x] Reproduce the paused-settings-read race with no other pending reason, and with independent alarm/manual reasons.
- [x] Carry signal controller, generation, and count through private tick admission. Strip stale signal counts at lifecycle invalidation and again before execution; recompute the effective trigger and preserve all independent reasons.
- [x] Run focused controller/heartbeat and CLI suites, then `pnpm verify`; inspect the complete follow-up diff and commit.

Observed red: signal-only work refreshed twice instead of once; signal+alarm
executed with the stale signal trigger. All three regression variants then
passed. Focused controller/heartbeat tests passed (367), as did all CLI tests
(193). Fresh full `pnpm verify` passed after the interruption: 1,816 extension
tests, 193 CLI tests, 10 site tests, 95 script tests, workspace typechecks, site
build, and Chromium/Firefox builds. Existing bundle-size warnings remain.
The follow-up diff was self-reviewed and `git diff --check` passed. Current
develop includes the independent #496 and #504 changes; no signal-admission
interface changed, and read-only merge inspection found no conflict markers.
