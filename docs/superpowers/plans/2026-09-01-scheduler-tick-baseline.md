# Scheduler Tick Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish deterministic scheduler tick measurements for extension/Twitch, extension/Kick, CLI/Twitch, and CLI/Kick, then remove only redundant work proven by those measurements.

**Architecture:** A credential-free test harness drives the real shared controller with host-specific wrappers and provider-specific counting adapters. Controlled work delays produce deterministic phase timing, while aggregate counters expose requests, discovery, selection, watcher reconciliation, persistence, publication, and adapter construction. Baseline evidence gates small optimizations; architectural findings are filed as focused v1.13.0 issues instead of bypassing #336 → #394 → #395 → #337.

**Tech Stack:** TypeScript, Vitest fake timers, `@lurkloot/core`, WXT alarm adapters, Node timer adapters, pnpm, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-09-01-scheduler-tick-baseline-design.md`

## Global Constraints

- Start from `origin/develop` including merged PR #450 / closed issue #339.
- Cover extension/Twitch, extension/Kick, CLI/Twitch, and CLI/Kick.
- Record no credentials, cookies, tokens, or raw authenticated provider payloads.
- Use deterministic work/request counts and controlled-clock timing; use no flaky real-time thresholds.
- Keep provider behavior behind `PlatformAdapter`; do not force Kick to emulate Twitch availability evidence.
- Preserve the planned sequence #336 → #394 → #395 → #337.
- Add no browser permissions and persist no raw provider payloads.
- Keep environment-specific measured tables in issue #452 rather than committing stale result snapshots.
- `pnpm verify` must pass before completion.

---

### Task 1: Build the credential-free measurement vocabulary

**Files:**
- Create: `packages/extension/tests/helpers/tickBaseline.ts`
- Create: `packages/extension/tests/tickBaseline.test.ts`

**Interfaces:**
- Produces: `TickBaselineCounts`, a flat aggregate count record.
- Produces: `ControlledTickClock.advance(phase, milliseconds): Promise<void>` and `ControlledTickClock.duration(phase): number`.
- Produces: `createCountingAdapter(platform, scenario, recorder): PlatformAdapter`.
- Consumes: normalized `DropCampaign`, `ChannelCandidate`, `PlatformAdapter`, and controller dependency contracts only.

- [ ] **Step 1: Write the failing vocabulary test**

Define the intended public shapes in the test before the helper exists:

```ts
it("records aggregate work without credential or payload fields", async () => {
  const recorder = createTickBaselineRecorder();
  recorder.count("adapterOperations");
  await recorder.clock.advance("discovery", 40);

  expect(recorder.snapshot()).toEqual({
    counts: expect.objectContaining({ adapterOperations: 1 }),
    durationsMs: expect.objectContaining({ discovery: 40 }),
  });
  expect(JSON.stringify(recorder.snapshot())).not.toMatch(
    /credential|cookie|token|authorization|payload/i,
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- tickBaseline.test.ts`

Expected: FAIL because `createTickBaselineRecorder` and its types do not exist.

- [ ] **Step 3: Implement the minimal recorder and controlled clock**

Use fixed keys so reports remain comparable:

```ts
export interface TickBaselineCounts {
  adapterOperations: number;
  campaignDiscovery: number;
  candidateListings: number;
  channelChecks: number;
  campaignsEvaluated: number;
  candidatesEvaluated: number;
  watcherReconciliations: number;
  adapterConstructions: number;
  settingsLoads: number;
  stateLoads: number;
  stateSaves: number;
  eventPublications: number;
}

export type TickPhase = "discovery" | "selection" | "watcher" | "persistence" | "total";
```

The fake clock increments an internal millisecond value and calls `vi.setSystemTime()`; it performs no real sleep.

- [ ] **Step 4: Add counting adapters built from normalized domain objects**

Implement Twitch and Kick variants whose methods increment counts and return minimal campaigns/candidates. Scenario inputs select `idle`, `stable`, `refresh`, `retained`, `switch`, `higherPriorityUnavailable`, `slow`, or `failed`. Do not include headers, cookies, tokens, raw JSON response bodies, or provider GraphQL/REST payload shapes.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `pnpm --filter @lurkloot/extension test -- tickBaseline.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the measurement vocabulary**

```bash
git add packages/extension/tests/helpers/tickBaseline.ts packages/extension/tests/tickBaseline.test.ts
git commit -m "test(core): add scheduler tick measurement harness"
```

### Task 2: Establish the extension/Twitch and extension/Kick baselines

**Files:**
- Modify: `packages/extension/tests/helpers/tickBaseline.ts`
- Modify: `packages/extension/tests/tickBaseline.test.ts`
- Modify: `packages/core/src/core/scheduler.ts`

**Interfaces:**
- Produces: `runExtensionBaselineCell(platform, scenario): Promise<TickBaselineResult>`.
- Consumes: `createBackgroundController()`, `createBackgroundAlarmListener()`, named per-platform alarms, and `runSchedulerTick()` metrics.
- Extends: scheduler metrics callback with aggregate watcher/persistence phase boundaries only if those values cannot be measured at the controller dependency boundary.

- [ ] **Step 1: Write failing four-scenario extension matrix tests**

Use `it.each(["twitch", "kick"] as const)` for idle, stable retained target, target switch, and failed response. Assert exact work counts and phase durations from one alarm-driven tick. Add separate tests for discovery refresh and unavailable higher-priority candidate because their expected provider calls differ.

- [ ] **Step 2: Verify RED against the unmeasured controller path**

Run: `pnpm --filter @lurkloot/extension test -- tickBaseline.test.ts`

Expected: FAIL because no extension cell runner maps alarms, storage, events, adapters, and scheduler metrics into one result.

- [ ] **Step 3: Implement the extension host runner**

Construct the real controller with counting dependencies, trigger exactly one `TWITCH_ALARM_NAME` or `KICK_ALARM_NAME`, await controller background settlement, and snapshot counts. Increment `stateLoads`, `stateSaves`, `settingsLoads`, `eventPublications`, and `adapterConstructions` in dependency wrappers rather than production code.

- [ ] **Step 4: Add controlled phase boundaries**

Reuse the existing discovery and selection diagnostic boundaries. Advance the fake clock inside adapter methods and persistence callbacks so the emitted aggregate durations equal declared costs. If watcher reconciliation has no observable boundary, add a narrow optional scheduler metrics callback rather than a production global counter.

- [ ] **Step 5: Add overlap and provider-independence characterization**

Block Twitch discovery with a deferred promise, trigger Kick, and assert Kick reaches persistence before Twitch resolves. Trigger two alarms for one platform while its first tick is blocked and assert the measured number of active and pending ticks, documenting current behavior without implementing #394.

- [ ] **Step 6: Verify extension matrix GREEN**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tickBaseline.test.ts backgroundEntrypoint.test.ts scheduler.test.ts
pnpm typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit the extension baseline**

```bash
git add packages/extension/tests/helpers/tickBaseline.ts packages/extension/tests/tickBaseline.test.ts packages/core/src/core/scheduler.ts
git commit -m "test(extension): baseline scheduler tick work"
```

### Task 3: Establish CLI/Twitch and CLI/Kick host-equivalence baselines

**Files:**
- Create: `packages/cli/tests/helpers/tickBaseline.ts`
- Modify: `packages/cli/src/runtime/run.ts`
- Modify: `packages/cli/tests/run.test.ts`
- Modify: `packages/extension/tests/tickBaseline.test.ts`

**Interfaces:**
- Produces: `runCliBaselineCell(platform, scenario): Promise<TickBaselineResult>`.
- Consumes: the same counting adapter behavior and `TickBaselineResult` shape used by extension tests.

- [ ] **Step 1: Write a failing CLI one-shot measurement test**

Run a single-platform CLI configuration through `runLoop({ once: true })` and assert exact adapter construction, discovery, selection, and normalized adapter-operation counts.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @lurkloot/cli test -- run.test.ts`

Expected: FAIL because the CLI baseline runner does not exist.

- [ ] **Step 3: Keep the production run-loop API unchanged**

Measure normalized controller work through counting transport adapters and use Vitest's controlled clock for the real interval driver. Do not add test-only callbacks to `RunOptions`.

- [ ] **Step 4: Implement the CLI baseline runner**

Use a temporary state file containing normalized `SchedulerState`, a silent logger, counting transport adapters, and fake timers. Enable only the measured platform so the result describes one matrix cell.

- [ ] **Step 5: Assert host equivalence and unavoidable wrapper differences**

For equivalent normalized scenarios, compare discovery, selection, watcher, and adapter-operation counts between CLI and extension. Keep real HTTP request counts in focused adapter tests.

- [ ] **Step 6: Characterize timer overlap deterministically**

Block a refresh, advance the fake clock through another interval, and assert that provider work remains serialized while each elapsed interval queues a later tick. This records current behavior without implementing #336 or #394.

- [ ] **Step 7: Verify CLI and cross-host matrix GREEN**

Run:

```bash
pnpm --filter @lurkloot/cli test -- run.test.ts
pnpm --filter @lurkloot/extension test -- tickBaseline.test.ts
pnpm typecheck
```

Expected: all pass.

- [ ] **Step 8: Commit the CLI baseline**

```bash
git add packages/cli/tests/helpers/tickBaseline.ts packages/cli/src/runtime/run.ts packages/cli/tests/run.test.ts packages/extension/tests/tickBaseline.test.ts
git commit -m "test(cli): baseline scheduler tick work"
```

### Task 4: Audit and implement bounded redundant-work reductions

**Files:**
- Modify: `packages/extension/tests/tickBaseline.test.ts`
- Modify: `packages/cli/tests/run.test.ts`
- Modify only when justified: `packages/core/src/background/controller.ts`
- Modify only when justified: `packages/core/src/core/scheduler.ts`
- Modify only when justified: `packages/cli/src/runtime/run.ts`
- Modify only when justified: `packages/extension/entrypoints/background.ts`

**Interfaces:**
- Consumes: exact before counts from Tasks 2 and 3.
- Produces: reduced count assertions for behavior-preserving work eliminated in this branch.
- Excludes: independent heartbeat ownership, discovery snapshots, snapshot-driven selection, and negative-search policy.

- [ ] **Step 1: Produce the before table from deterministic test output**

Run the matrix with `LURKLOOT_TICK_BASELINE=1` so tests print JSON results only when explicitly requested. Save the command output in the working notes used to compose issue #452; do not commit generated measurements.

- [ ] **Step 2: Audit each counted boundary**

For every matrix cell, trace nonzero adapter constructions, settings/state loads, state saves, event publications, discovery calls, candidate listings, channel checks, watcher reconciliations, and host timer triggers to a source line. Classify each as required, safely removable now, or owned by #336/#394/#395/#337.

- [ ] **Step 3: Write one failing count assertion per safely removable operation**

Change only the expected count for the selected operation and verify the test fails with the old count. The assertion name must identify the eliminated work, for example `does not reload CLI state after a tick when the completed state is already available` or `does not publish an empty unchanged batch`.

- [ ] **Step 4: Implement the minimal reduction**

Change the narrowest host or shared-core boundary that eliminates the counted operation. Preserve state transition events, auth-health persistence, claim handoff behavior, and per-platform concurrency. Do not add a cache or concurrency model whose invalidation belongs in a later sequence issue.

- [ ] **Step 5: Verify each reduction before starting the next**

Run the single failing test until GREEN, then run the complete `tickBaseline.test.ts`, `run.test.ts`, `backgroundController.test.ts`, and `scheduler.test.ts` set. Reprint the opted-in baseline and confirm only intended counts changed.

- [ ] **Step 6: Commit each independently reviewable reduction**

Use a Conventional Commit subject naming the actual removed work, such as:

```bash
git commit -m "perf(cli): reuse completed scheduler state"
```

Do not create an empty optimization commit if the audit finds no safe reduction outside the planned sequence.

### Task 5: File focused findings and update the performance trackers

**Files:**
- Modify: `docs/superpowers/plans/2026-09-01-scheduler-tick-baseline.md` only if implementation discoveries require correcting this plan.

**Interfaces:**
- Produces: focused GitHub issues assigned to milestone `v1.13.0` for material unbundled findings.
- Produces: a findings comment on #452 and status correction on #361.
- Consumes: deterministic before/after results and source-backed audit classifications.

- [ ] **Step 1: Draft each material follow-up locally**

Each draft must contain observed counts, affected matrix cells, source locations, desired behavior, deterministic acceptance tests, relationship to #361/#452, and why it is not bundled. Explicitly state its ordering dependency relative to #336, #394, #395, and #337.

- [ ] **Step 2: Create only non-duplicate v1.13.0 issues**

Search open and closed issues by the finding's source symbol and behavior. Create an issue only when no existing issue owns it, add milestone `v1.13.0`, and link #361 and #452. Never create separate host issues for shared-core work.

- [ ] **Step 3: Update #361 bookkeeping**

Edit or comment on #361 to mark #339 / PR #450 complete and link any newly created focused issues. Preserve the published execution order exactly.

- [ ] **Step 4: Post the #452 findings report**

Include the baseline commit, four-cell before/after tables, scenario limitations, controlled-clock phase durations, request/work counts, bundled reductions, remaining unavoidable work, linked follow-ups, and the statement that no credentials or raw authenticated payloads were recorded.

- [ ] **Step 5: Verify issue links and milestone assignments**

Read #361, #452, and each created issue back through `gh issue view`; confirm links, milestone `v1.13.0`, scope, and sequence language.

### Task 6: Final verification and handoff

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-scheduler-tick-baseline-design.md` only if the implemented public behavior differs from the approved design.

**Interfaces:**
- Consumes: all implementation commits and GitHub findings.
- Produces: verified branch ready for review.

- [ ] **Step 1: Run formatting and diff safety checks**

Run:

```bash
git diff --check origin/develop...HEAD
git status --short
```

Expected: no whitespace errors and only intentional tracked changes.

- [ ] **Step 2: Run the full repository verification**

Run: `pnpm verify`

Expected: script tests, all workspace typechecks, CLI tests, extension tests, site build/tests, and Chromium/Firefox builds pass.

- [ ] **Step 3: Re-run the opted-in baseline report**

Run the documented `LURKLOOT_TICK_BASELINE=1` commands for extension and CLI. Compare output with the #452 comment and correct any transcription mismatch.

- [ ] **Step 4: Review repository and GitHub scope**

Confirm no credentials, raw payloads, new browser permissions, or implementation from #336/#394/#395/#337 entered the diff. Confirm #452 and #361 link every material deferred finding.

- [ ] **Step 5: Commit final documentation corrections if needed**

```bash
git add docs/superpowers/specs/2026-09-01-scheduler-tick-baseline-design.md docs/superpowers/plans/2026-09-01-scheduler-tick-baseline.md
git commit -m "docs(core): finalize scheduler tick baseline"
```

Skip this commit when neither document changed.
