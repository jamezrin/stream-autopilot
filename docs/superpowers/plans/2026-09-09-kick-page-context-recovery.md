# Kick Page-Context Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close an extension-owned Kick fallback page after 1–10 distinct successful scheduler cycles, defaulting to three, without counting individual requests or closing user tabs.

**Architecture:** A cycle-local observer in the Kick fetcher records background success and fallback evidence. The controller consumes that evidence once after a current Kick tick commits, and an optional browser-host callback updates persisted page-context recovery state and closes the managed tab at the configured threshold. The setting remains extension-only.

**Tech Stack:** TypeScript, Vitest, React popup settings registry, WXT browser adapters, JSON locale catalogs.

**Spec:** `docs/superpowers/specs/2026-09-09-kick-page-context-recovery-design.md`

## Global Constraints

- The recovery threshold is an integer from 1 through 10 and defaults to 3.
- One scheduler cycle can add at most one recovery success regardless of request count.
- Any fallback in the cycle wins and resets recovery.
- Only extension-owned managed page-context tabs may be closed.
- Diagnostics are English literals; only UI copy and structured activity are localized.
- No credentials, headers, URLs with paths/query strings, or raw payloads are persisted or logged.
- CLI behavior and configuration remain unchanged.

---

### Task 1: Extension-only recovery threshold

**Files:**
- Modify: `packages/shared/src/models.ts`
- Modify: `packages/shared/src/settings.ts`
- Modify: `packages/popup-ui/src/settingsRegistry.tsx`
- Modify: `packages/locales/messages/*.json`
- Test: `packages/extension/tests/settings.test.ts`
- Test: `packages/extension/tests/settingsView.test.tsx`
- Test: `packages/extension/tests/settingsSearchView.test.tsx`

**Interfaces:**
- Produces: `ExtensionSettings.kickPageContextRecoverySuccesses: number`.
- Produces: normalized default `3`, clamped to `1..10`.

- [ ] Add failing normalization tests for missing, low, high, and valid threshold values.
- [ ] Run `pnpm --filter @lurkloot/extension test -- settings.test.ts` and confirm the new assertions fail.
- [ ] Add the extension-only property, default, and normalization without adding it to `EngineSettings` or CLI settings.
- [ ] Add a General → Advanced `NumberSettingRow` with `min={1}`, `max={10}`, and Kick-enabled gating.
- [ ] Add English source copy and translated catalog entries following the existing locale catalog structure.
- [ ] Update popup settings fixtures and assert the control renders, searches, disables, and saves correctly.
- [ ] Run the focused settings and popup tests until they pass.
- [ ] Commit with `feat(settings): configure Kick page-context recovery`.

### Task 2: Cycle-local Kick route observation

**Files:**
- Modify: `packages/core/src/platforms/kick/index.ts`
- Modify: `packages/core/src/platforms/adapter.ts`
- Test: `packages/extension/tests/adapters.test.ts`

**Interfaces:**
- Produces: `KickPageContextCycleObservation` containing `backgroundHosts`, `fallbackHosts`, and consume-once lifecycle identity.
- Produces: optional adapter method `consumePageContextCycleObservation()` returning one immutable observation or `undefined`.

- [ ] Add failing tests proving forty successes consume as one cycle observation, fallback wins over success, host values contain hostnames only, and a second consume is empty.
- [ ] Run the focused adapter tests and confirm failure.
- [ ] Implement a cycle-local observer owned by each Kick adapter/fetcher construction.
- [ ] Record direct success and fallback outcomes without changing fetch behavior.
- [ ] Expose consume-once evidence through the optional platform-adapter capability.
- [ ] Run `pnpm --filter @lurkloot/extension test -- adapters.test.ts` until it passes.
- [ ] Commit with `feat(kick): observe page-context routes per cycle`.

### Task 3: Browser recovery reconciliation

**Files:**
- Modify: `packages/core/src/core/tabs.ts`
- Modify: `packages/extension/src/core/tabs.ts`
- Test: `packages/extension/tests/tabs.test.ts`

**Interfaces:**
- Consumes: `KickPageContextCycleObservation` and threshold `1..10`.
- Produces: `reconcileManagedPageContextRecoveryWithBrowser(browserApi, platform, observation, requiredSuccesses, emit, lifecycle)`.

- [ ] Replace request-count tests with failing cycle tests for thresholds 1, 3, and 10; fallback reset; mixed-cycle fallback precedence; different host; already-gone tab; and exact extension-owned tab removal.
- [ ] Add a failing restart/hydration regression showing the recovery counter survives and stale state cannot resurrect a closed context.
- [ ] Run `pnpm --filter @lurkloot/extension test -- tabs.test.ts` and confirm failure.
- [ ] Remove the hard-coded ten-minute minimum and request-level success increment.
- [ ] Apply one observation atomically to the current retained context, updating one success or resetting on fallback.
- [ ] Delete registry ownership before `tabs.remove`, emit `page_context_closed/background_recovered`, and safely forget already-gone tabs.
- [ ] Preserve immediate disable/stop/reset/manual-watch cleanup and user-tab protection.
- [ ] Run the focused tabs tests until they pass.
- [ ] Commit with `fix(kick): close recovered page contexts by cycle`.

### Task 4: Controller commit boundary and host wiring

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/extension/entrypoints/background.ts`
- Modify: `packages/extension/src/core/tabs.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`
- Test: `packages/extension/tests/backgroundEntrypoint.test.ts`

**Interfaces:**
- Consumes: adapter `consumePageContextCycleObservation()`.
- Consumes: optional dependency `reconcilePageContextRecovery(platform, observation, settings, lifecycle)`.
- Guarantees: reconciliation occurs once only after a current committed Kick tick.

- [ ] Add failing controller tests for one reconciliation after commit and none after failed, aborted, stale, discarded, or duplicate/coalesced work.
- [ ] Add failing overlap tests proving adapter replacement and old lifecycle evidence cannot advance recovery.
- [ ] Add an entrypoint test proving the browser callback receives the normalized extension threshold.
- [ ] Run focused controller/entrypoint tests and confirm failure.
- [ ] Extend `TickAdapterHandle` to consume observation from the exact adapter used by the committed cycle.
- [ ] Invoke the optional host callback only after a current Kick platform commit; isolate callback failures as safe diagnostics.
- [ ] Wire the extension callback to browser reconciliation with `settings.kickPageContextRecoverySuccesses`.
- [ ] Run the focused tests until they pass.
- [ ] Commit with `fix(controller): reconcile Kick page recovery after commit`.

### Task 5: Regression and documentation gate

**Files:**
- Modify if needed: `docs/architecture.md`
- Test: all files touched above.

**Interfaces:**
- Validates the complete setting → observation → committed cycle → browser closure path.

- [ ] Add an end-to-end controller fixture: fallback creates/retains a context, forty successes in each of three committed cycles count as three, and only the third cycle closes it.
- [ ] Assert a fallback between cycles resets the sequence.
- [ ] Assert Twitch integrity/page contexts and CLI configuration are unchanged.
- [ ] Update architecture documentation to describe cycle-confirmed Kick page-context recovery and the configurable threshold.
- [ ] Run focused tests for settings, adapters, tabs, controller, entrypoint, and popup UI.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm verify` and inspect all output.
- [ ] Commit with `test(kick): cover cycle-confirmed page recovery` or fold documentation/tests into the final implementation commit when no standalone behavior remains.
