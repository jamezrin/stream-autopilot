# Scheduler Tick Baseline Design

## Purpose

Establish a reproducible, credential-free scheduler tick baseline for the complete supported runtime matrix: extension/Twitch, extension/Kick, CLI/Twitch, and CLI/Kick. Use that evidence to remove only redundant work that can be safely eliminated without pre-empting the planned architecture sequence #336 → #394 → #395 → #337.

PR #450 merged into `develop` as commit `a5e22d74` and closed #339. Its Twitch campaign-details read-through cache is therefore part of this baseline, not a proposed optimization or a historical comparison point.

## Measurement boundary

The baseline exercises the real shared background controller and scheduler path with deterministic host and provider doubles. It does not use live credentials, captured cookies, raw authenticated responses, or payload recordings.

Each cell varies two dimensions:

- host behavior: extension-style alarm/storage integration or CLI-style timer/file-storage integration;
- provider behavior: Twitch or Kick adapter capabilities and request shapes.

All cells share the same normalized scenarios where meaningful:

- idle with no eligible campaign;
- stable active watch with unchanged campaign data;
- discovery refresh;
- retained target without a switch;
- target switch or claim handoff;
- unavailable higher-priority candidate;
- slow or failed provider response;
- overlapping timer, manual, or settings triggers.

If a provider cannot represent a scenario, the report records the capability limitation instead of fabricating equivalent evidence. In particular, Kick is not given Twitch-specific channel availability semantics.

## Reproducible harness

Add focused test utilities under the existing test packages rather than a production benchmark subsystem. The harness wraps synthetic adapters, storage callbacks, event publication, watchers, and host drivers with counters. A fake clock advances only at declared work boundaries, making phase and total duration assertions deterministic.

The measurement record contains aggregate numeric data only:

- provider request count;
- campaign discovery calls;
- candidate listing and channel validation calls;
- campaigns and candidates evaluated during selection;
- watcher reconciliation and heartbeat calls;
- adapter construction count;
- state and settings load count;
- state save count;
- event publication count;
- controlled-clock durations for discovery, selection, watcher reconciliation, persistence, and the total tick.

The harness must not model or retain credential fields. Synthetic responses use the smallest normalized domain objects required by the scheduler rather than raw provider payloads.

## Host equivalence

Extension and CLI fixtures drive the same `createBackgroundController()` and `runSchedulerTick()` implementation. Their wrappers differ only where the real hosts differ: alarm versus timer triggering and storage/event adapters. Assertions compare core work counts for equivalent scenarios and separately account for unavoidable host wrapper work.

The CLI wrapper must not be reduced to a renamed extension fixture. It exercises the CLI run-loop boundary sufficiently to detect duplicated timer ticks, extra state reads, or host-specific adapter reconstruction. The extension wrapper similarly covers named per-platform alarms and publication behavior.

## Provider independence and controlled timing

Blocked-promise tests prove Twitch and Kick ticks can make progress independently. Fake timers prove overlapping triggers do not create unbounded queued work and expose the current coalescing behavior without relying on wall-clock thresholds.

The baseline records current behavior even where it does not yet meet the final #452 criteria. Heartbeat isolation belongs to #336, discovery snapshots to #394, snapshot-driven selection to #395, and Twitch negative-search backoff to #337. Baseline tests may characterize those gaps, but this change must not implement their architecture early.

## Evidence-backed reductions

After recording the initial four-cell counts, audit:

- duplicated extension alarms or CLI timers;
- repeated state/settings loads and unconditional saves;
- adapter reconstruction;
- unchanged-state event publication;
- repeated provider discovery, candidate enumeration, channel validation, parsing, or liveness work.

A reduction may be bundled only when it is small, shared where appropriate, behavior-preserving, and directly supported by a failing count assertion. Every production change follows test-driven development: establish the before count, write the expected reduced count, observe the failure, then make the minimal change.

Material work with its own cache policy, invalidation model, concurrency boundary, or provider semantics becomes a focused v1.13.0 GitHub issue linked to #361 and #452. Such issues must preserve the sequence #336 → #394 → #395 → #337 and must not duplicate those scopes.

## Reporting

Repository artifacts contain the deterministic harness, assertions, and instructions for reproducing counts. Environment-specific before/after results live in issue #452 so measured snapshots do not become stale committed fixtures.

The final #452 update includes:

- PR #450/#339 merge status and baseline commit;
- a before/after table for all four cells and supported scenarios;
- controlled-clock phase timing and work/request counts;
- reductions implemented in this branch;
- remaining unavoidable work and rationale;
- provider/account limitations for any unavailable live observation;
- focused v1.13.0 issues created or linked;
- confirmation that no credentials or raw authenticated payloads were recorded;
- verification results.

#361 may be updated to mark #339 complete and link newly justified work. No sequence item is reordered.

## Verification

Focused tests cover the harness itself, count regressions, host equivalence, provider independence, controlled timing, and any bundled reduction. The completed branch must pass `pnpm verify`.

The acceptance boundary is deterministic evidence, not a claimed universal wall-clock speedup. Live authenticated diagnostics may corroborate a finding, but are optional and must remain aggregate, ephemeral, and credential-free.
