# Adapter Bundle Reuse Implementation Plan

**Goal:** Reuse one platform adapter construction throughout each scheduler tick while preserving phase-local event collection and lifecycle isolation.

**Architecture:** Introduce a tick-owned adapter handle per requested platform. Its stable emitter is routed only while a phase is actively using the adapter. Thread the handle through authentication, discovery, selection/scheduler execution, claims, and watcher reconciliation. Extend discovery-lane requests with an optional typed request context so a tick can lend its own handle without introducing controller-global adapter state.

**Tech Stack:** TypeScript, Vitest, pnpm workspace.

### Task 1: Lock the construction contract

- Update extension and CLI deterministic baseline expectations from three adapter constructions to one for single-provider ticks.
- Add controller coverage for phase-local event routing and overlapping platform ticks.
- Run the focused baseline/controller tests and confirm they fail for the expected construction count.

### Task 2: Add tick-owned adapter handles

- Add a small controller-local handle that constructs once and routes adapter events to the currently active phase collector.
- Report compatibility once at construction through the active collector.
- Ensure a handle cannot be shared across ticks or platforms.

### Task 3: Thread handles through discovery and commit

- Make `DiscoverySnapshotLane` request contexts generic and associate each queued refresh with its request context.
- Pass the tick handle to auth refresh, discovery refresh, scheduler execution, claim observation, and watcher reconciliation.
- Preserve existing standalone auth/discovery/message paths by falling back to ordinary construction when no tick handle exists.

### Task 4: Verify lifecycle and host parity

- Run focused discovery, controller, extension baseline, and CLI baseline tests.
- Run `pnpm verify`.
- Review the diff for credential, payload, permission, and host-specific behavior changes.
