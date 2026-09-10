# Tabless Heartbeat Cadence Design

## Purpose

Isolate Twitch and Kick tabless watch maintenance from campaign discovery and scheduler state-mutation locks in both the extension and CLI. Each provider maintains an exact 60-second target cadence even when discovery, transport, persistence, or host timers are slow, while preserving current watch health, recovery, and bounded tab-fallback behavior.

This design starts from `origin/develop` at `9c133769`, including the four-cell scheduler baseline from issue #452 and PR #459. Campaign discovery snapshots (#394) and snapshot-driven target selection (#395) remain out of scope.

## Selected Architecture

The shared background controller owns one heartbeat lane per provider. A lane has three distinct responsibilities:

- an immutable committed watch-context snapshot used by heartbeat delivery;
- narrow synchronization for atomically replacing that snapshot and transferring watcher ownership;
- independent attempt and cadence bookkeeping that never queues behind the provider discovery lock.

Discovery and scheduler work continue to select targets through the existing path. When that path starts, switches, or stops a tabless watch, it atomically publishes a complete committed heartbeat context. Heartbeat work captures one immutable committed context under the narrow lane synchronization, then performs provider transport I/O after releasing synchronization. It never performs campaign refresh, candidate validation, target ranking, claim work, notification work, auth probing, or target reconsideration.

The committed context contains only normalized domain metadata needed to identify and maintain the current watch: provider, channel identity and normalized channel fields required by the watcher, campaign id, reward id, a monotonically changing context generation, and cadence metadata. Watcher instances, provider payloads, credentials, cookies, authorization values, and transport state are never persisted.

## Atomic Context and Watcher Handoff

Each provider lane exposes a committed context as one immutable value. Replacing the target constructs the entire new value before publishing it, so a heartbeat observes either the complete old context or the complete new context. It cannot combine an old channel or broadcast id with a new campaign or reward id.

The lane's narrow synchronization protects only:

- reading or replacing the committed context;
- creating, starting, switching, stopping, or selecting the watcher instance owned by that context;
- reserving an attempt or folding a concurrent invocation into it;
- updating in-memory cadence bookkeeping after a merge-safe persisted commit.

Provider heartbeat network I/O, diagnostics publication, and ordinary state persistence do not hold the lane synchronization. Discovery and scheduler mutation never acquire the lane synchronization while awaiting provider work. Lock ordering must not create a path where heartbeat delivery waits for the existing per-platform discovery lock or where discovery waits for heartbeat transport I/O.

The generation captured with an attempt is authoritative for every result. A health update is committed only if the current persisted session and committed context still represent that generation. A failed stale attempt cannot increment failure counters, emit recovery/failure activity for the newer target, or initiate fallback. Fallback eligibility is checked again against the same generation immediately before scheduling the scoped fallback tick.

## Cadence Semantics

The cadence interval is exactly 60,000 milliseconds. The persisted cadence records the scheduled due time for the current committed context and enough normalized context identity and generation information to validate it after restart.

For a scheduled attempt with due time `D`, the next due time is the first point on the same 60-second sequence strictly after the attempt time `A`:

`nextDue = D + (floor(max(0, A - D) / 60,000) + 1) * 60,000`

This anchors future attempts to the previous due time instead of adding transport or persistence duration. If a host timer fires late by multiple intervals, exactly one attempt is made and missed slots are skipped. No catch-up burst is emitted.

An invocation before the persisted due time performs no scheduled attempt. Concurrent invocations for a provider coalesce into the reserved in-flight attempt rather than starting parallel attempts or queuing duplicates. Their count is folded into the eventual attempt diagnostic.

## Immediate Attempts and Deduplication

Starting or switching a tabless target retains the existing immediate-heartbeat behavior. The immediate attempt uses the newly committed generation and participates in the same per-provider reservation and cadence state as scheduled attempts.

When an immediate attempt is reserved, its scheduled anchor is the immediate attempt time and its next due time is 60 seconds later. A watch alarm arriving concurrently or shortly afterward observes the reservation or persisted next due time and coalesces or exits, so it cannot duplicate the immediate send. A target switch always permits an immediate attempt for the new generation even if the old generation recently sent a heartbeat.

If an immediate request races an already-reserved scheduled attempt for the same generation, it coalesces into that attempt. If the generation changed, the old result becomes stale and the new context may reserve its own immediate attempt without waiting for old provider I/O to finish.

## Restart Recovery

On a Manifest V3 service-worker restart or a fresh CLI controller, the in-memory lanes and watcher instances are empty. The first heartbeat-driver invocation loads settings and persisted normalized state, reconstructs the committed context, recreates and starts the provider watcher, and evaluates the persisted due time without running discovery.

If the persisted due time is absent for a valid tabless session, recovery treats the current invocation as immediately due and establishes a new anchor. If it is in the future, recovery waits for that due point. If it is in the past, recovery makes exactly one late attempt and advances to the first future point on the original sequence.

Persisted cadence metadata is cleared when the platform is disabled, the session stops being an authenticated tabless watch, visible-tab fallback starts, or the target context is removed. Invalid, incomplete, or mismatched persisted metadata is ignored and reconstructed from the normalized session rather than used with mixed identities.

## Merge-Safe Result Persistence

Heartbeat results use the controller's short state-commit serialization rather than the per-platform discovery lock. The commit reloads current state, validates the captured context generation and normalized identity, merges only heartbeat-owned fields, and saves without overwriting concurrent discovery, settings, page-context, campaign, or session target changes.

Heartbeat-owned persisted fields are:

- last attempt time and success value;
- consecutive heartbeat failure count;
- scheduled next-due time;
- normalized context identity and generation needed for validation and recovery.

Page-context lifecycle metadata generated by a Twitch heartbeat remains merge-safe and is retained. Existing first-failure, recovery, and fallback diagnostics and activity semantics remain intact. A stale result records no health transition and cannot cause fallback.

## Host Drivers

The extension keeps the existing named one-minute watch alarm and requires no new permission. Browser alarms are wake-up hints: the controller always derives eligibility and lateness from persisted cadence state instead of assuming the alarm fired on time.

The CLI gains a dedicated heartbeat driver with a 60-second target sequence independent of `pollIntervalMinutes`. Discovery continues on its configurable interval. Both drivers invoke the same provider-neutral controller heartbeat contract. CLI shutdown clears both host timers, shuts down the controller, and disposes transport resources through the existing lifecycle.

## Aggregate Timing Diagnostics

Each provider attempt emits exactly one aggregate English diagnostic. It includes:

- scheduled due time;
- actual attempt time;
- timer lateness in milliseconds;
- internal synchronization delay in milliseconds;
- number of concurrent calls coalesced into the attempt;
- outcome;
- whether result persistence was rejected as stale.

Individual timing measurements do not emit separate events. Calls coalesced without starting an attempt fold their count into the eventual attempt diagnostic. A standalone English diagnostic is emitted only when no attempt will occur and the coalescing information would otherwise be lost.

These are diagnostic events with English literal bodies. Activity events remain unchanged and no locale keys are added.

## Health and Fallback Preservation

Successful and failed current-generation attempts preserve the existing `lastHeartbeatAt`, `lastHeartbeatOk`, and `heartbeatChecks` behavior. Recovery is reported when a successful attempt follows failures. The first failure retains its warning behavior. Reaching `tablessFallbackFailureLimit` initiates the existing scoped scheduler fallback only after revalidating the context generation.

Watcher-produced diagnostics continue to drain once through the owning operation. Twitch page-context lifecycle changes remain persisted. Kick's persistent WebSocket semantics remain provider-specific behind `PlatformAdapter`; it receives the same cadence, coalescing, atomic-context, and result-validation contract without being forced to emulate Twitch requests.

Visible-tab playback and its existing scheduler behavior are unchanged.

## Test-First Evidence

Implementation follows red-green-refactor cycles. Focused controlled-clock tests cover:

- blocked Twitch discovery while a due Twitch heartbeat attempts and completes independently;
- blocked Kick discovery with equivalent independent watch-lane progress;
- discovery progress while Twitch or Kick heartbeat transport is blocked, proving isolation in both directions;
- exact 60-second anchoring without transport or persistence drift;
- one attempt after a timer fires several intervals late;
- concurrent scheduled calls coalescing per provider;
- atomic target handoff using either the complete old or complete new context;
- stale success and failure result rejection, including prevention of stale fallback;
- immediate start/switch delivery and scheduled-attempt deduplication;
- extension restart recovery from normalized persisted cadence/context metadata without discovery;
- CLI startup recovery and a 60-second heartbeat cadence when `pollIntervalMinutes` differs;
- preservation of failure counters, recovery reporting, watcher diagnostics, page-context metadata, and bounded fallback;
- one aggregate timing diagnostic per attempt with folded coalescing counts.

The issue #452 deterministic harness supplies before/after evidence for extension/Twitch, extension/Kick, CLI/Twitch, and CLI/Kick. The comparison records controlled timing and work counts without credentials, raw authenticated payloads, or production latency claims. It demonstrates that discovery and heartbeat work no longer wait on one another while discovery and selection counts otherwise remain unchanged.

## Scope Boundaries

This change does not implement periodic discovery snapshots (#394), snapshot-driven target selection (#395), target ranking changes, provider transport canaries, end-to-end accrual detection, new browser permissions, credential storage, raw provider-payload persistence, or visible-tab changes.

## Verification

Focused tests must first fail for the missing independent-lane behavior and pass after each minimal implementation step. Final verification runs the four-cell #452 harness, all workspace tests and typechecks, the site build, and Chromium and Firefox production builds through `pnpm verify`.
