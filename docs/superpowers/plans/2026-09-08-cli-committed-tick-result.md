# CLI Committed Tick Result Plan

**Goal:** Let the CLI consume the exact final state committed by its tick without reloading `state.json`.

**Architecture:** Add a host-neutral optional committed-state result to `tickAndHandOff`. Capture state at the controller's successful persistence boundary, scope the capture to the invocation, and thread it through post-claim handoff ticks. The CLI uses that result for subscription-wait reporting and falls back to storage only when a successful invocation produces no commit.

### Tasks

1. Change deterministic CLI expectations from four state loads to three and add success/failure/handoff/overlap contract coverage.
2. Capture exact merged state at successful platform persistence without publishing aborted or stale attempts.
3. Return the last commit owned by the current tick-and-handoff invocation.
4. Consume the result in the CLI and preserve disabled-platform cleanup and subscription-wait behavior.
5. Run focused tests, `pnpm verify`, independent review, then open a PR stacked on #486.
