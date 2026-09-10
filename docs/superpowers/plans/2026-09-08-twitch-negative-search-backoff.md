# Twitch Negative Search Backoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Avoid repeating an exhaustive, authoritative Twitch search for the same unavailable higher-priority campaign on every tick while a lower-priority current watch remains healthy.

**Architecture:** Pure snapshot selection owns the backoff policy and returns the next compact persisted record alongside its decision. The controller supplies the prior record and explicit-trigger bypass flag; the scheduler atomically commits the returned record with the selected watch context. A stable fingerprint of material campaign inventory and relevant selection settings invalidates obsolete records without persisting provider payloads.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo

**Spec:** GitHub issue #337 (`https://github.com/jamezrin/lurkloot/issues/337`)

## Global Constraints

- Twitch only; Kick behavior must remain unchanged.
- Cache only complete, authoritative misses; ambiguous or incomplete evidence must not create a backoff.
- Retry is bounded to five minutes.
- Manual refresh/resume, material selection settings, inventory changes, and unhealthy/invalid current watches bypass or invalidate the record.
- Persist only campaign id, retry timestamp, and material fingerprint; never raw provider payloads.
- Diagnostics are English literals and aggregate per campaign search.

---

### Task 1: Persisted backoff contract and pure policy

**Files:**
- Modify: `packages/shared/src/models.ts`
- Modify: `packages/core/src/core/defaults.ts`
- Modify: `packages/core/src/core/scheduler.ts`
- Test: `packages/extension/tests/scheduler.test.ts`

**Interfaces:**
- Consumes: committed `DiscoverySnapshot`, healthy current `WatchSession`, sorted campaigns, `EngineSettings`
- Produces: `CampaignSearchBackoff`, `SnapshotSelectionInput.previousBackoff`, `SnapshotSelectionInput.bypassBackoff`, and `SnapshotSelectionResult.backoff`

- [x] **Step 1: Write failing deterministic tests** for initial authoritative miss creation, skip before deadline, retry after expiry, ambiguity exclusion, current-watch failure bypass, inventory/settings invalidation, and Kick non-participation.
- [x] **Step 2: Run the scheduler tests and verify failures** are caused by the missing backoff contract/policy.
- [x] **Step 3: Add the compact shared model and default state** with a five-minute exported retry constant.
- [x] **Step 4: Implement the minimal pure selection policy**: validate the prior record, omit its campaign only while the current lower-priority watch is healthy, and create a record only when a complete Twitch snapshot proves every observed candidate for the higher campaign unusable.
- [x] **Step 5: Run scheduler tests and refactor while green.**

### Task 2: Controller trigger and atomic commit integration

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/core/src/background/platformState.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`
- Test: `packages/extension/tests/platformState.test.ts`

**Interfaces:**
- Consumes: `SchedulerState.campaignSearchBackoffs`, controller `TickTrigger`, `SnapshotSelectionResult.backoff`
- Produces: selection input populated with prior record and explicit-trigger bypass, plus platform-isolated merge/persistence

- [x] **Step 1: Write failing controller tests** proving ordinary ticks skip, manual refresh/resume and claim handoff bypass, and a persisted record survives controller restart.
- [x] **Step 2: Write a failing platform-state merge test** proving one provider cannot overwrite the other provider's record.
- [x] **Step 3: Run focused tests and verify the expected failures.**
- [x] **Step 4: Wire prior/bypass inputs into selection and atomically commit returned records** while preserving stale-generation publication guards.
- [x] **Step 5: Extend platform-state merging and run focused tests green.**

### Task 3: Diagnostics, host regression coverage, and verification

**Files:**
- Modify: `packages/extension/tests/backgroundController.test.ts`
- Modify: `packages/cli/tests/run.test.ts`

**Interfaces:**
- Consumes: selection result diagnostics and shared controller lifecycle
- Produces: deterministic fresh-search/skipped-search diagnostics with remaining milliseconds and host parity assertions

- [x] **Step 1: Add failing diagnostic assertions** for fresh authoritative miss and skipped search with remaining backoff time.
- [x] **Step 2: Add CLI regression assertions** that both providers retain their expected provider-call counts and Twitch restart state remains serializable.
- [x] **Step 3: Implement aggregate diagnostic text and run focused extension/CLI tests.**
- [x] **Step 4: Run `pnpm typecheck`, `pnpm verify`, and `git diff --check`.**
- [x] **Step 5: Request code review, address concrete findings, commit, push, and open a stacked PR targeting `refactor/snapshot-driven-selection`.**
