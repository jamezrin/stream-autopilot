# Scheduler tick baseline

Issue #452 is measured with credential-free, deterministic controller fixtures. The fixtures use normalized campaign and channel models; they contain no cookies, tokens, authorization headers, or raw authenticated provider payloads.

Run the focused extension and CLI matrices from the repository root:

```bash
LURKLOOT_TICK_BASELINE=1 pnpm --filter @lurkloot/extension test -- tickBaseline.test.ts
LURKLOOT_TICK_BASELINE=1 pnpm --filter @lurkloot/cli test -- run.test.ts -t "baseline"
pnpm --filter @lurkloot/extension exec vitest run tests/twitchCampaignDetailsReuse.test.ts --reporter=dot
pnpm --filter @lurkloot/extension exec vitest run tests/adapters.test.ts --reporter=dot
```

To stream every opted-in JSON record even when its test passes, run the focused files directly:

```bash
LURKLOOT_TICK_BASELINE=1 pnpm --filter @lurkloot/extension exec vitest run tests/tickBaseline.test.ts --disableConsoleIntercept --reporter=dot
LURKLOOT_TICK_BASELINE=1 pnpm --filter @lurkloot/cli exec vitest run tests/run.test.ts -t "baseline" --disableConsoleIntercept --reporter=dot
```

Each `TICK_BASELINE` line is JSON containing the host, provider, scenario, aggregate work counts, and controlled-clock durations. Normal test runs do not print these records.

The controlled clock assigns fixed costs to observable boundaries:

- discovery request: 30 ms, or 300 ms in the slow-response scenario;
- candidate listing and channel validation: 10 ms each, or 100 ms each in the slow-response scenario;
- watcher preparation: 5 ms;
- each extension persisted state commit: 5 ms. CLI persistence is intentionally not assigned a synthetic duration because the production run loop no longer exposes test-only hooks.

These values are not production latency claims. They prove that phase attribution and total duration remain deterministic when work counts change. Environment-specific before/after tables and live limitations belong in issue #452 so the repository does not preserve stale timing snapshots.

The four-cell matrix covers idle, stable retained watch, real target switch, a higher-priority target that is unavailable followed by retention of the current watch, failed discovery, and slow discovery/selection for Twitch and Kick in both hosts.

The `heartbeatOverlap` row additionally drives the real shared controller through each host wrapper: the extension's named alarm dispatcher and the CLI's recurring discovery and heartbeat timers. A seeded normalized tabless session is due for one heartbeat while campaign refresh and the watcher heartbeat are held at test-owned deferred boundaries. The harness releases discovery, then heartbeat, on consecutive controlled-clock steps and derives the two blocking counters from the observed milestone order:

- `heartbeatAttempts` counts normalized `TablessWatchController.tick` calls;
- `heartbeatBlockedByDiscovery` is `1` when heartbeat start is observed only after discovery reaches channel validation;
- `discoveryBlockedByHeartbeat` is `1` when discovery reaches channel validation only after heartbeat transport finishes.

Therefore `heartbeatAttempts: 1`, `heartbeatBlockedByDiscovery: 0`, and `discoveryBlockedByHeartbeat: 0` demonstrate progress ordering for this controlled overlap. They do not claim universal production latency, network performance, or an absence of unrelated host scheduling delay.

Related scheduler entry paths and concurrency boundaries remain pinned by focused deterministic tests rather than duplicated inside every matrix cell:

- extension alarm dispatch: `backgroundEntrypoint.test.ts` asserts Twitch and Kick alarm names dispatch targeted `alarm` ticks;
- manual/settings overlap: `backgroundController.test.ts` covers a pending manual claim while the sibling scheduler completes, settings patches during active work, and non-overlapping settings reconciliation;
- heartbeat isolation: `backgroundController.test.ts` blocks Twitch heartbeat work and proves Kick heartbeat and persistence complete independently;
- claim handoff: `backgroundController.test.ts` covers independent cross-platform handoffs, immediate post-claim heartbeats, and duplicate-handoff suppression;
- discovery-signal overlap: `backgroundController.test.ts` proves bursts coalesce into one non-overlapping follow-up.

The CLI interval baseline blocks one refresh across another elapsed interval. Provider discovery is now single-flight per platform: elapsed intervals coalesce into at most one follow-up refresh instead of queuing every missed interval. Twitch and Kick own separate lanes, so either provider can publish while the other is blocked.

## Counting semantics

- `adapterOperations` counts calls across the normalized `PlatformAdapter` boundary, including the authentication probe and discovery/selection operations. It deliberately does not claim to count HTTP requests: an adapter operation may issue zero, one, or several transport requests. Provider transport request counts belong in focused adapter tests.
- `watcherReconciliations` counts observable watcher preparation, not a no-op traversal of the controller's watcher map.
- The overlap blocking counters are calculated from observed controller milestones. The harness never assigns zero merely because it released a deferred operation.
- `eventPublications` counts non-empty aggregate batches passed to the host reporter, not individual diagnostic or activity records.
- Authentication health is saved before scheduler work so a later failure cannot erase the health observation. That makes two state saves per measured tick intentional.
- `observedControllerMs` is parsed from the controller's emitted refresh, selection, and tick-completion diagnostics; assertions therefore verify the production timing instrumentation rather than only the fixture clock.
- Snapshot candidate enumeration and validation are attributed to the controller's discovery duration. The legacy scheduler still performs its selection pass, but reads the committed normalized observations through an in-memory adapter view; #395 will make that selection lifecycle independently triggered and coalesced.
- Real Twitch transport counts are pinned in `twitchCampaignDetailsReuse.test.ts`: the three-campaign cold refresh performs three `fetchJson` calls, while the following warm refresh adds only inventory and dashboard (five cumulative). `adapters.test.ts` pins a Kick refresh at two concurrent transport calls (campaigns and progress). The host matrix does not relabel adapter calls as HTTP requests.

## v1.13.0 final gate

The final deterministic gate was recorded from the stacked v1.13.0 implementation after #336, #394, #395, #337, #457, and #458. Twitch and Kick have identical normalized counts in both hosts for each single-provider scenario.

| Scenario | Adapter operations | Discovery | Candidate lists | Channel checks | Watcher reconciliations | Adapter constructions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| idle / failed | 2 | 1 | 0 | 0 | 0 | 1 |
| stable retained | 4 | 1 | 1 | 1 | 1 | 1 |
| switch | 4 | 1 | 1 | 1 | 1 | 1 |
| higher priority unavailable | 6 | 1 | 2 | 2 | 1 | 1 |
| slow provider | 4 | 1 | 1 | 1 | 1 | 1 |

| Host cells | State loads | State saves | Persistence attribution |
| --- | ---: | ---: | ---: |
| extension/Twitch and extension/Kick | 5 | 2 | 10 ms |
| CLI/Twitch and CLI/Kick | 5 | 2 | not synthetically timed |

The original baseline used three extension state loads and four CLI state loads. Snapshot-owned discovery and short commit boundaries make five shared-engine loads explicit in the final architecture; #458 removes the additional CLI-only post-tick load, restoring host parity. Two saves remain deliberate: authentication health is durable before fallible discovery, then the scheduler result is committed independently. Adapter construction falls from two per single-provider tick to one.

| Scenario | Before total (extension / CLI) | Final total (extension / CLI) |
| --- | ---: | ---: |
| idle / failed | 40 / 30 ms | 40 / 30 ms |
| stable retained | 55 / 45 ms | 65 / 55 ms |
| switch | 65 / 55 ms | 65 / 55 ms |
| higher priority unavailable | 95 / 85 ms | 85 / 75 ms |
| slow provider | 515 / 505 ms | 515 / 505 ms |

The stable path now spends an attributable extra 10 ms enumerating the coherent discovery snapshot; selection itself performs no provider work and unchanged decisions are reused. The unavailable-priority path removes one redundant channel check and 10 ms. Controlled values remain structural test costs rather than production latency claims.

The heartbeat-overlap cells record one heartbeat attempt with both blocking counters at zero for all four host/provider combinations. Extension and CLI therefore exercise the same platform-scoped controller lanes and fixed heartbeat contract; neither Twitch nor Kick waits for its sibling. CLI startup recovery performs additional intentional constructions and discovery passes outside the isolated single-provider tick, which the overlap row records separately.

Remaining work is unavoidable under the published safety contract: every normal tick probes auth, refreshes authoritative campaign data, commits auth health before fallible work, and merges the platform result against the latest persisted state. Provider caches remain inside adapters. No duplicated host timer, redundant unchanged-state publication, repeated target-selection provider call, or cross-provider blocking was found after the focused v1.13.0 changes, so this audit creates no additional performance issue.

All measurements use normalized synthetic data. No credentials, cookies, tokens, authorization headers, raw authenticated payloads, or new browser permissions are recorded or introduced. Authenticated live timing was not required because the gate measures deterministic work ownership and controlled phase attribution, not provider latency.

PR #450 / issue #339 merged before this baseline. Its Twitch campaign-details reuse is part of the starting behavior.
