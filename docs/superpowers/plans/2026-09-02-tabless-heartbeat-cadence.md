# Tabless Heartbeat Cadence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Twitch and Kick tabless heartbeats on an anchored 60-second cadence that is independent of discovery locks in both the extension and CLI.

**Architecture:** The shared controller owns one per-provider heartbeat lane with an immutable normalized context, narrow watcher/context synchronization, one in-flight reservation, and generation-authoritative result commits. Pure cadence helpers calculate due/next-due values, while host drivers only wake the shared controller; heartbeat transport I/O runs outside discovery and lane locks.

**Tech Stack:** TypeScript 7, pnpm workspaces, Vitest controlled clocks, WXT browser alarms, Node timers.

**Spec:** `docs/superpowers/specs/2026-09-02-tabless-heartbeat-cadence-design.md`

## Global Constraints

- Start from `origin/develop` commit `9c133769`, including PR #459 and the #452 four-cell harness.
- The target interval is exactly `60_000` milliseconds and is anchored to the previous scheduled due time.
- Persist only normalized cadence/context metadata; never persist watcher instances, provider payloads, credentials, cookies, authorization values, or transport state.
- Context generation authorizes both health-result commits and fallback initiation; stale failures cannot affect or fall back a newer target.
- Heartbeat transport I/O must run outside the existing provider discovery/state-mutation locks and outside the narrow lane lock.
- Late timers make one attempt and skip missed slots; concurrent calls coalesce per provider.
- Preserve existing health counters, recovery/failure reporting, page-context persistence, bounded fallback, and immediate heartbeat behavior.
- Emit one aggregate English diagnostic per provider attempt with due time, attempt time, lateness, synchronization delay, coalesced-call count, outcome, and stale-result status. Add no locale keys and do not change activity events.
- Keep visible-tab behavior, #394 discovery snapshots, and #395 target selection out of scope.
- Every production change follows a witnessed red-green-refactor cycle.

## File Map

- Create `packages/core/src/core/heartbeatCadence.ts`: pure normalized context-key and anchored-cadence calculations.
- Modify `packages/shared/src/models.ts`: persisted normalized `TablessHeartbeatCadence` metadata on `WatchSession`.
- Modify `packages/core/src/core/scheduler.ts`: clear or retain cadence metadata consistently with tabless target identity.
- Modify `packages/core/src/background/controller.ts`: per-provider lanes, atomic context/watcher handoff, isolated attempts, generation-safe commits, fallback gating, restart recovery, and aggregate diagnostics.
- Modify `packages/cli/src/runtime/run.ts`: independent anchored 60-second heartbeat driver and shutdown cleanup.
- Create `packages/extension/tests/heartbeatCadence.test.ts`: pure cadence contract tests.
- Modify `packages/extension/tests/backgroundController.test.ts`: focused concurrency, coalescing, handoff, recovery, diagnostics, and health/fallback tests.
- Modify `packages/cli/tests/run.test.ts`: independent CLI driver and restart behavior.
- Modify `packages/extension/tests/helpers/tickBaseline.ts`, `packages/extension/tests/tickBaseline.test.ts`, `packages/cli/tests/helpers/tickBaseline.ts`, and `packages/cli/tests/run.test.ts`: #452 four-cell before/after evidence.
- Modify `docs/scheduler-tick-baseline.md`: reproduction command and expected heartbeat-isolation evidence.

---

### Task 1: Persisted Cadence Contract and Pure Anchoring

**Files:**
- Create: `packages/core/src/core/heartbeatCadence.ts`
- Modify: `packages/shared/src/models.ts`
- Modify: `packages/core/src/core/scheduler.ts`
- Create: `packages/extension/tests/heartbeatCadence.test.ts`

**Interfaces:**
- Produces: `HEARTBEAT_INTERVAL_MS = 60_000`.
- Produces: `heartbeatContextKey(session: WatchSession): string | undefined`.
- Produces: `nextHeartbeatDueAt(previousDueAt: number, attemptAt: number): number`.
- Produces: `TablessHeartbeatCadence { generation: number; contextKey: string; nextDueAt: string }` on `WatchSession.tablessHeartbeat`.

- [ ] **Step 1: Write failing pure cadence tests**

Add tests that name the production failures explicitly:

```ts
it("anchors the next heartbeat to the previous due time", () => {
  expect(nextHeartbeatDueAt(1_000, 66_250)).toBe(121_000);
});

it("skips every missed slot after a late timer", () => {
  expect(nextHeartbeatDueAt(1_000, 190_000)).toBe(241_000);
});

it("keys the complete normalized watch target", () => {
  const session = tablessSession({ campaignId: "campaign", rewardId: "reward" });
  expect(heartbeatContextKey(session)).toContain("campaign");
  expect(heartbeatContextKey(session)).toContain("reward");
  expect(heartbeatContextKey({ ...session, channel: undefined })).toBeUndefined();
});
```

- [ ] **Step 2: Run the focused test and witness RED**

Run: `pnpm --filter @lurkloot/extension test -- heartbeatCadence.test.ts`

Expected: FAIL because `@lurkloot/core/heartbeat-cadence` and the cadence model do not exist.

- [ ] **Step 3: Add the normalized model and pure functions**

Add to `models.ts`:

```ts
export interface TablessHeartbeatCadence {
  generation: number;
  contextKey: string;
  nextDueAt: string;
}

// Add immediately after WatchSession.heartbeatChecks:
tablessHeartbeat?: TablessHeartbeatCadence;
```

Implement the helper without provider objects or payloads:

```ts
export const HEARTBEAT_INTERVAL_MS = 60_000;

export function nextHeartbeatDueAt(previousDueAt: number, attemptAt: number): number {
  const elapsed = Math.max(0, attemptAt - previousDueAt);
  return previousDueAt
    + (Math.floor(elapsed / HEARTBEAT_INTERVAL_MS) + 1) * HEARTBEAT_INTERVAL_MS;
}

export function heartbeatContextKey(session: WatchSession): string | undefined {
  const channel = session.channel;
  if (session.watchMode !== "tabless" || !channel || !session.campaignId || !session.rewardId) return undefined;
  return JSON.stringify([
    session.platform,
    channel.url,
    channel.username,
    channel.broadcastId ?? "",
    channel.channelId ?? "",
    session.campaignId,
    session.rewardId,
  ]);
}
```

Export the helper through the existing `@lurkloot/core` subpath pattern. Update scheduler session construction/reset branches so `tablessHeartbeat` is retained only when `heartbeatContextKey(previous) === heartbeatContextKey(next)` and cleared for visible-tab, stopped, fallback, or changed-target sessions.

- [ ] **Step 4: Run focused cadence and scheduler tests GREEN**

Run: `pnpm --filter @lurkloot/extension test -- heartbeatCadence.test.ts scheduler.test.ts`

Expected: PASS; no existing session-reset assertion regresses.

- [ ] **Step 5: Commit the cadence contract**

```bash
git add packages/shared/src/models.ts packages/core/src/core/heartbeatCadence.ts packages/core/src/core/scheduler.ts packages/extension/tests/heartbeatCadence.test.ts packages/core/package.json
git commit -m "feat(core): define anchored heartbeat cadence"
```

### Task 2: Atomic Per-Provider Lane and Discovery Isolation

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: `heartbeatContextKey`, `HEARTBEAT_INTERVAL_MS`, and `TablessHeartbeatCadence` from Task 1.
- Produces internally: `CommittedHeartbeatContext`, `HeartbeatLane`, `withHeartbeatLane()`, and `commitHeartbeatContext()`.
- Preserves public controller method: `runWatchHeartbeat(): Promise<void>`.

- [ ] **Step 1: Write failing two-direction isolation tests for both providers**

For each platform, use deferred promises to block `refreshCampaigns()` after a persisted tabless session and committed watcher exist. Start `controller.tick([platform])`, wait until discovery is blocked, invoke `controller.runWatchHeartbeat()`, and assert the watcher attempts before discovery resolves. Add the inverse case: block `watcher.tick()`, invoke a scoped discovery tick, and assert `refreshCampaigns()` runs before the heartbeat resolves.

```ts
it.each(["twitch", "kick"] as const)(
  "attempts a due %s heartbeat while discovery holds the platform lock",
  async (platform) => {
    const blocked = deferred<DropCampaign[]>();
    const env = await establishedTablessEnv(platform);
    env.adapters[platform].refreshCampaigns = vi.fn(() => blocked.promise);
    const discovery = env.controller.tick([platform]);
    await vi.waitFor(() => expect(env.adapters[platform].refreshCampaigns).toHaveBeenCalled());

    const heartbeat = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(env.watchers[platform].tick).toHaveBeenCalled());

    blocked.resolve([]);
    await Promise.all([discovery, heartbeat]);
  },
);
```

- [ ] **Step 2: Run focused controller tests and witness RED**

Run: `pnpm --filter @lurkloot/extension test -- backgroundController.test.ts`

Expected: FAIL because `runPlatformWatchHeartbeat()` queues behind `withStateLock()` and discovery queues behind heartbeat transport.

- [ ] **Step 3: Introduce lane state and atomic context publication**

Add controller-local immutable types:

```ts
interface CommittedHeartbeatContext {
  readonly generation: number;
  readonly contextKey: string;
  readonly session: Readonly<WatchSession>;
  readonly watcher: TablessWatchController;
}

interface HeartbeatLane {
  mutation: Promise<unknown>;
  committed?: CommittedHeartbeatContext;
  inFlight?: HeartbeatAttempt;
  coalescedWithoutAttempt: number;
}
```

Create one lane per platform and a `withHeartbeatLane(platform, operation)` promise-chain lock. Refactor `reconcileTablessWatchers()` to construct/start/switch the watcher, then publish one complete frozen context under `withHeartbeatLane`. On stop, atomically remove the committed context and watcher ownership, then perform watcher cleanup without holding discovery locks longer than current scheduler reconciliation already does.

Refactor `runPlatformWatchHeartbeat()` so it does not call `withStateLock()`, does not reconcile discovery-signal controllers, and does not run discovery. It may load normalized persisted state for restart recovery, capture/reserve a context under `withHeartbeatLane`, and must release the lane before calling `watcher.tick()`.

- [ ] **Step 4: Run isolation tests GREEN and retain platform independence tests**

Run: `pnpm --filter @lurkloot/extension test -- backgroundController.test.ts`

Expected: PASS for Twitch and Kick in both blocking directions, including the existing “Kick heartbeat while Twitch pending” case.

- [ ] **Step 5: Commit the independent lane boundary**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "refactor(core): isolate heartbeat delivery lanes"
```

### Task 3: Exact Cadence, Late Coalescing, and Aggregate Diagnostics

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: `nextHeartbeatDueAt()` and per-provider `HeartbeatLane`.
- Produces internally: `HeartbeatAttempt { generation; contextKey; dueAt; attemptAt; synchronizationDelayMs; coalescedCalls; promise }`.
- Produces one English diagnostic formatted from a completed attempt.

- [ ] **Step 1: Write failing controlled-clock cadence tests**

Add separate tests proving:

- an attempt due at `12:01:00` and completed at `12:01:07` stores `12:02:00`, not `12:02:07`;
- a wake at `12:04:15` for a `12:01:00` due time sends once and stores `12:05:00`;
- three concurrent calls invoke `watcher.tick()` once and report `coalescedCalls=2`;
- a call before due time performs no transport I/O;
- the attempt emits exactly one line containing all required timing/result fields.

```ts
expect(aggregateDiagnostics(env, platform)).toEqual([
  expect.stringMatching(
    /scheduledDueAt=.*actualAttemptAt=.*latenessMs=195000.*synchronizationDelayMs=\d+.*coalescedCalls=2.*outcome=ok.*staleResult=false/,
  ),
]);
```

- [ ] **Step 2: Run focused tests and witness RED**

Run: `pnpm --filter @lurkloot/extension test -- backgroundController.test.ts -t "heartbeat cadence|coalesces|aggregate heartbeat timing"`

Expected: FAIL because every alarm currently attempts immediately, concurrent calls serialize, and no aggregate diagnostic exists.

- [ ] **Step 3: Reserve attempts and persist the anchored next due time**

Under `withHeartbeatLane`, capture `requestedAt`, measure synchronization delay when the reservation is acquired, reject non-due scheduled calls, fold calls into `lane.inFlight.coalescedCalls`, or reserve a new attempt. Advance `nextDueAt` from the captured due time and `attemptAt`, never from completion time.

The attempt promise performs `watcher.tick()` outside locks and reports once after the generation-aware commit:

```ts
const message = [
  "Tabless heartbeat timing",
  `scheduledDueAt=${new Date(attempt.dueAt).toISOString()}`,
  `actualAttemptAt=${new Date(attempt.attemptAt).toISOString()}`,
  `latenessMs=${Math.max(0, attempt.attemptAt - attempt.dueAt)}`,
  `synchronizationDelayMs=${attempt.synchronizationDelayMs}`,
  `coalescedCalls=${attempt.coalescedCalls}`,
  `outcome=${outcome}`,
  `staleResult=${stale}`,
].join(" ");
```

When a no-attempt path consumes `coalescedWithoutAttempt` and no future attempt can carry it because the context was cleared, emit one standalone English diagnostic; otherwise retain the folded count for the next attempt.

- [ ] **Step 4: Run focused tests GREEN**

Run: `pnpm --filter @lurkloot/extension test -- backgroundController.test.ts heartbeatCadence.test.ts`

Expected: PASS with exact fake-clock values and one aggregate diagnostic per attempt.

- [ ] **Step 5: Commit cadence execution and diagnostics**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(core): coalesce anchored heartbeat attempts"
```

### Task 4: Generation-Safe Health Commits and Fallback

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: captured `generation` and `contextKey` from `HeartbeatAttempt`.
- Produces internally: `commitHeartbeatResult(...): Promise<{ stale: boolean; fallback: boolean }>`.

- [ ] **Step 1: Write failing stale-result and health-preservation tests**

Block an old target's successful and failed heartbeat separately, switch to a complete new channel/campaign/reward context, then resolve the old attempt. Assert the new session receives no old timestamp, success flag, counter change, recovery event, or fallback. Add current-generation cases preserving first failure, recovery, page-context merge, and fallback at the configured limit.

```ts
expect(env.state.sessions[platform]).toMatchObject({
  channel: newTarget.channel,
  campaignId: newTarget.campaignId,
  rewardId: newTarget.rewardId,
  heartbeatChecks: 0,
});
expect(env.adapters[platform].prepareWatchTab).not.toHaveBeenCalled();
expect(lastAggregateDiagnostic(env, platform)).toContain("staleResult=true");
```

- [ ] **Step 2: Run stale-result tests and witness RED**

Run: `pnpm --filter @lurkloot/extension test -- backgroundController.test.ts -t "stale heartbeat|heartbeat fallback|heartbeat recovered"`

Expected: FAIL because the current result commit writes into whichever session is latest and returns fallback without generation authority.

- [ ] **Step 3: Implement merge-safe generation validation**

Implement `commitHeartbeatResult()` inside `withStateCommit()`: reload state, compare `tablessHeartbeat.generation` and `heartbeatContextKey(current)` with the captured attempt, and merge only heartbeat-owned fields plus current page-context registry metadata. If validation fails, save no health fields and return `{ stale: true, fallback: false }`.

For a current failed result, calculate `heartbeatChecks`, persist it, and return fallback eligibility. Before invoking `tick([platform], "tabless_fallback")`, reacquire the lane briefly and reload/validate the same generation and context key. Skip fallback when either changed.

- [ ] **Step 4: Run focused and scheduler fallback tests GREEN**

Run: `pnpm --filter @lurkloot/extension test -- backgroundController.test.ts scheduler.test.ts`

Expected: PASS; current health behavior is unchanged and stale failures cannot initiate fallback.

- [ ] **Step 5: Commit generation-authoritative persistence**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "fix(core): reject stale heartbeat results"
```

### Task 5: Immediate Attempt Deduplication and Restart Recovery

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: the common attempt reservation with `kind: "scheduled" | "immediate"`.
- Produces: restart reconstruction from `WatchSession.tablessHeartbeat` plus normalized session fields.

- [ ] **Step 1: Write failing immediate/restart tests**

Add controlled cases proving:

- a new or switched target gets one immediate attempt and next due is exactly 60 seconds after its attempt anchor;
- an alarm concurrent with that immediate attempt coalesces instead of duplicating it;
- a recent old-generation heartbeat never suppresses a new-generation immediate attempt;
- a fresh controller reconstructs Twitch and Kick watchers from persisted normalized sessions without `refreshCampaigns()`;
- restart before due makes no attempt, while restart after due makes one late attempt and preserves the old anchor.

- [ ] **Step 2: Run focused tests and witness RED**

Run: `pnpm --filter @lurkloot/extension test -- backgroundController.test.ts -t "immediate heartbeat|service-worker restart|persisted cadence"`

Expected: FAIL because immediate delivery uses a separate state-locked path and restart does not enforce persisted due time.

- [ ] **Step 3: Route immediate and recovered attempts through the lane**

Replace `sendImmediateHeartbeat()` transport logic with `requestPlatformHeartbeat(platform, settings, "immediate", session)`. Publish the new committed context before reserving the immediate attempt. Initialize its anchor at `Date.now()` and store `nextDueAt = attemptAt + 60_000` through the generation-safe commit.

When the lane has no context, `runPlatformWatchHeartbeat()` loads the persisted session, verifies enabled/healthy/tabless state and `contextKey`, creates/starts the watcher under narrow lane synchronization, restores generation and due time, then releases synchronization before any `tick()`. Do not call `reconcileDiscoverySignalControllers()` from heartbeat recovery; Kick discovery signals remain owned by scheduler/startup reconciliation rather than the latency-critical lane.

- [ ] **Step 4: Run focused tests GREEN**

Run: `pnpm --filter @lurkloot/extension test -- backgroundController.test.ts`

Expected: PASS for immediate deduplication, both-provider restart recovery, existing watcher diagnostics, and existing page-context lifecycle tests.

- [ ] **Step 5: Commit unified immediate/recovery behavior**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(core): recover heartbeat lanes after restart"
```

### Task 6: Independent CLI Heartbeat Driver

**Files:**
- Modify: `packages/cli/src/runtime/run.ts`
- Modify: `packages/cli/tests/run.test.ts`

**Interfaces:**
- Consumes: `controller.runWatchHeartbeat()` as the same shared provider-neutral contract used by extension alarms.
- Produces: separate discovery and heartbeat timers, both cleared during shutdown.

- [ ] **Step 1: Write failing CLI controlled-timer tests**

Use fake timers with `pollIntervalMinutes: 7`, a persisted active tabless session, and a fake watcher. Assert heartbeat attempts at 60-second targets while `refreshCampaigns()` remains at its initial count. Block discovery and prove the heartbeat still attempts; block heartbeat and prove the seven-minute discovery timer still runs. Assert both timers stop before transport disposal on SIGTERM.

```ts
await vi.advanceTimersByTimeAsync(60_000);
await vi.waitFor(() => expect(watcher.tick).toHaveBeenCalledTimes(1));
expect(adapter.refreshCampaigns).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Run CLI tests and witness RED**

Run: `pnpm --filter @lurkloot/cli test -- run.test.ts -t "heartbeat driver"`

Expected: FAIL because CLI currently has only the configurable discovery interval.

- [ ] **Step 3: Add the dedicated heartbeat driver**

Retain the existing discovery `setInterval(tickOnce, periodMs)` and add a 60-second wake-up driver calling a guarded `heartbeatOnce()` that catches/logs errors independently. The controller owns exact due-time semantics, so the host timer does not calculate cadence or queue catch-up sends.

```ts
const heartbeatTimer = setInterval(
  () => void heartbeatOnce(),
  HEARTBEAT_INTERVAL_MS,
);
// shutdown:
clearInterval(discoveryTimer);
clearInterval(heartbeatTimer);
controller.shutdown();
await transport.dispose();
```

Import the shared constant rather than duplicating `60_000`. Preserve `once: true` as one discovery tick with no background interval.

- [ ] **Step 4: Run CLI tests GREEN**

Run: `pnpm --filter @lurkloot/cli test -- run.test.ts`

Expected: PASS, including the prior interval-queuing baseline and new heartbeat independence assertions.

- [ ] **Step 5: Commit the CLI host driver**

```bash
git add packages/cli/src/runtime/run.ts packages/cli/tests/run.test.ts
git commit -m "feat(cli): drive heartbeats independently"
```

### Task 7: Extend the #452 Four-Cell Harness and Record Evidence

**Files:**
- Modify: `packages/extension/tests/helpers/tickBaseline.ts`
- Modify: `packages/extension/tests/tickBaseline.test.ts`
- Modify: `packages/cli/tests/helpers/tickBaseline.ts`
- Modify: `packages/cli/tests/run.test.ts`
- Modify: `docs/scheduler-tick-baseline.md`

**Interfaces:**
- Extends baseline records with normalized heartbeat/discovery overlap counts and controlled timing only.
- Keeps `LURKLOOT_TICK_BASELINE=1` JSON output credential-free.

- [ ] **Step 1: Write failing four-cell evidence assertions**

Add `heartbeatAttempts`, `heartbeatBlockedByDiscovery`, and `discoveryBlockedByHeartbeat` numeric fields to the test-only baseline result. For extension/Twitch, extension/Kick, CLI/Twitch, and CLI/Kick, run controlled overlap scenarios and expect one attempt with both blocked flags equal to zero. Preserve existing discovery, selection, persistence, adapter-operation, and request counts.

- [ ] **Step 2: Run opt-in baseline tests and witness RED**

Run:

```bash
LURKLOOT_TICK_BASELINE=1 pnpm --filter @lurkloot/extension test -- tickBaseline.test.ts
LURKLOOT_TICK_BASELINE=1 pnpm --filter @lurkloot/cli test -- run.test.ts -t "baseline"
```

Expected: FAIL because the new overlap fields/scenarios are absent; retain the emitted pre-change JSON as local before evidence without committing environment-specific output.

- [ ] **Step 3: Extend harness adapters/watchers and documentation**

Count only normalized operations at declared controlled-clock boundaries. Do not add credential, cookie, token, authorization, payload, or raw response fields. Add reproduction commands and explain that `blockedBy... = 0` proves progress ordering, not universal production latency.

- [ ] **Step 4: Run four-cell baselines GREEN and compare unchanged work**

Run the two opt-in commands above.

Expected: all four cells report one due heartbeat attempt, zero cross-lane blocking, and unchanged discovery/selection counts outside the new heartbeat scenario.

- [ ] **Step 5: Commit deterministic before/after evidence**

```bash
git add packages/extension/tests/helpers/tickBaseline.ts packages/extension/tests/tickBaseline.test.ts packages/cli/tests/helpers/tickBaseline.ts packages/cli/tests/run.test.ts docs/scheduler-tick-baseline.md
git commit -m "test(core): baseline isolated heartbeat lanes"
```

### Task 8: Full Verification and Scope Audit

**Files:**
- Review: all files changed by Tasks 1–7

**Interfaces:**
- Verifies the issue #336 acceptance criteria and guards #394/#395 boundaries.

- [ ] **Step 1: Run focused regression suites**

Run:

```bash
pnpm --filter @lurkloot/extension test -- heartbeatCadence.test.ts backgroundController.test.ts scheduler.test.ts tickBaseline.test.ts
pnpm --filter @lurkloot/cli test -- run.test.ts
```

Expected: PASS with no unhandled rejections, timer leaks, or warning output introduced by the change.

- [ ] **Step 2: Run repository verification**

Run: `pnpm verify`

Expected: script tests, all workspace typechecks, CLI and extension tests, site build/tests, Chromium build, and Firefox build all pass.

- [ ] **Step 3: Audit diagnostics and persistence boundaries**

Run:

```bash
git diff origin/develop...HEAD -- packages/locales packages/extension/wxt.config.ts
rg -n "credential|cookie|authorization|providerPayload|transportState" packages/shared/src/models.ts packages/core/src/core/heartbeatCadence.ts
rg -n "Tabless heartbeat timing" packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
```

Expected: no locale or permission changes; no sensitive/provider transport fields in persisted metadata; one aggregate diagnostic construction and its assertions.

- [ ] **Step 4: Audit scope and diff quality**

Run:

```bash
git diff --check origin/develop...HEAD
git diff --stat origin/develop...HEAD
git status --short
```

Expected: clean whitespace, only issue #336/spec/plan/harness files changed, and no #394/#395 discovery-snapshot or target-selection implementation.

- [ ] **Step 5: Commit any verification-only corrections**

If verification required a source correction, first add a focused regression test that fails for it, then implement the correction and commit only those files:

```bash
git add packages/core/src/background/controller.ts packages/core/src/core/heartbeatCadence.ts packages/core/src/core/scheduler.ts packages/shared/src/models.ts packages/extension/tests/backgroundController.test.ts packages/extension/tests/heartbeatCadence.test.ts packages/extension/tests/scheduler.test.ts packages/cli/src/runtime/run.ts packages/cli/tests/run.test.ts
git commit -m "fix(core): address heartbeat cadence verification"
```

If no correction was needed, do not create an empty commit.
