# Twitch Channel Points Alarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claim Twitch channel-points bonuses every minute for managed and recent manual-watch channels without coupling the work to campaign discovery.

**Architecture:** A browser-free Twitch URL parser records safe manual channel identity in scheduler state. A dedicated extension alarm dispatches a claim-only controller method which resolves the manual or managed channel and runs under the existing Twitch platform lock; the normal scheduler claim remains unchanged as a CLI and resilience fallback.

**Tech Stack:** TypeScript 7, WXT browser alarms/runtime sender metadata, Vitest, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-12-09-twitch-channel-points-alarm-design.md`

## Global Constraints

- Use `TWITCH_CHANNEL_POINTS_ALARM_NAME = "lurkloot.twitch-channel-points"` with a fixed `periodInMinutes: 1`.
- Create the alarm only when Twitch and `platform.twitch.autoClaimChannelPoints` are enabled; do not add a user-facing setting.
- Reuse `PlatformAdapter.claimChannelPoints` and its existing Client-Integrity recovery.
- Keep diagnostics as English literals; do not add locale keys, activity events, or notifications.
- Keep the scheduler-based claim and CLI behavior unchanged.
- Do not refresh campaigns/authentication, select targets, prepare or stop tabs, send heartbeats, run handoff, alter session/backoff state, add permissions, or store credentials in the claim-only path.
- Never navigate, mute, close, reload, or adopt a user-owned manual-watch tab.
- Follow red-green-refactor for every behavioral change.

---

### Task 1: Parse safe Twitch channel URLs

**Files:**
- Create: `packages/core/src/platforms/twitch/channelUrl.ts`
- Modify: `packages/core/package.json`
- Modify: `packages/shared/src/models.ts`
- Create: `packages/extension/tests/twitchChannelUrl.test.ts`

**Interfaces:**
- Produces: `twitchChannelFromUrl(url: string | undefined): ChannelCandidate | undefined` exported as `@lurkloot/core/twitch/channelUrl`.
- Produces: optional `ManualWatchState.channel?: ChannelCandidate` for persisted manual-watch identity.

- [ ] **Step 1: Write failing URL parser tests**

Cover canonical `https://www.twitch.tv/Creator_1`, bare `twitch.tv`, query/fragment removal, uppercase normalization, reserved single-segment routes, `/creator/videos`, empty paths, HTTP, malformed URLs, subdomains, and deceptive suffix/userinfo hosts. Assert the successful candidate exactly:

```ts
expect(twitchChannelFromUrl("https://www.twitch.tv/Creator_1?ref=x#chat")).toEqual({
  platform: "twitch",
  username: "creator_1",
  url: "https://www.twitch.tv/creator_1",
});
```

- [ ] **Step 2: Run the parser test and verify RED**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/twitchChannelUrl.test.ts`

Expected: FAIL because `@lurkloot/core/twitch/channelUrl` is not exported.

- [ ] **Step 3: Implement the minimal browser-free parser and model field**

Implement a reserved-route `Set`, exact HTTPS host check, exactly-one-segment check, and `/^[a-z0-9_]{1,25}$/i` login validation. Normalize the login to lowercase and produce the canonical `www.twitch.tv` URL. Add the package export and optional model field.

```ts
export function twitchChannelFromUrl(url: string | undefined): ChannelCandidate | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !TWITCH_HOSTS.has(parsed.hostname.toLowerCase())) return undefined;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length !== 1) return undefined;
    const username = segments[0].toLowerCase();
    if (!TWITCH_LOGIN.test(username) || RESERVED_ROUTES.has(username)) return undefined;
    return { platform: "twitch", username, url: `https://www.twitch.tv/${username}` };
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/twitchChannelUrl.test.ts && pnpm --filter @lurkloot/core typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the parser boundary**

```bash
git add packages/core/src/platforms/twitch/channelUrl.ts packages/core/package.json packages/shared/src/models.ts packages/extension/tests/twitchChannelUrl.test.ts
git commit -m "feat(twitch): parse manual watch channel urls"
```

### Task 2: Persist manual-watch channel identity from sender metadata

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/extension/tests/backgroundController.test.ts`
- Modify: `packages/extension/tests/backgroundEntrypoint.test.ts`

**Interfaces:**
- Consumes: `twitchChannelFromUrl(sender.tab.url)` and `ManualWatchState.channel` from Task 1.
- Changes: `handleMessage(message, sender?: { tab?: { id?: number; url?: string } })`.
- Changes: private `recordPlaybackTelemetry(..., senderTabId?, senderTabUrl?)` and `recordManualWatchTelemetry(..., senderTabId, senderTabUrl?)`.

- [ ] **Step 1: Write failing controller telemetry tests**

Extend the existing manual-watch cases to send trusted sender metadata:

```ts
await env.controller.handleMessage(playbackTelemetry("twitch", true), {
  tab: { id: 91, url: "https://www.twitch.tv/FirstCreator" },
});
expect(env.state.manualWatch?.twitch?.channel?.username).toBe("firstcreator");
```

Then send active telemetry from tab 91 with `/SecondCreator` and assert replacement. Send `/directory`, assert `channel` is absent, then cover inactive telemetry, stale state, and tab removal without changing the existing manual-pause assertions.

- [ ] **Step 2: Run the focused controller tests and verify RED**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts -t "manual watch"`

Expected: FAIL because sender URLs are ignored and manual state has no channel.

- [ ] **Step 3: Pass sender URL through and recompute identity on every report**

Import the parser into the controller, extend the sender type, and assign `channel` only for Twitch telemetry:

```ts
manualWatch[message.platform] = {
  platform: message.platform,
  tabId: senderTabId,
  checkedAt: new Date().toISOString(),
  active,
  ...(message.platform === "twitch"
    ? { channel: twitchChannelFromUrl(senderTabUrl) }
    : {}),
};
```

Do not retain a previous channel when the current sender URL is invalid. Preserve the current multiple-tab arbitration and `manualWatchStarted` behavior.

- [ ] **Step 4: Prove the extension runtime forwards native sender metadata unchanged**

Update the behavioral background entrypoint test controller mock to capture `handleMessage`, invoke the registered runtime listener with `{ tab: { id: 91, url: "https://www.twitch.tv/creator" } }`, and assert both fields reach the controller. Do not add URL data to the content-script message body.

- [ ] **Step 5: Run focused tests and typechecks**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts tests/backgroundEntrypoint.test.ts -t "manual watch|sender" && pnpm --filter @lurkloot/core typecheck && pnpm --filter @lurkloot/extension typecheck`

Expected: PASS.

- [ ] **Step 6: Commit telemetry identity**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts packages/extension/tests/backgroundEntrypoint.test.ts
git commit -m "feat(twitch): retain manual watch channel identity"
```

### Task 3: Reconcile and dispatch the dedicated alarm

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/extension/tests/backgroundController.test.ts`
- Modify: `packages/extension/tests/backgroundEntrypoint.test.ts`

**Interfaces:**
- Produces: `TWITCH_CHANNEL_POINTS_ALARM_NAME` constant.
- Produces: public `runTwitchChannelPointsClaim(): Promise<void>` on the controller/alarm interface (stubbed until Task 4 behavior).
- Produces: private `reconcileTwitchChannelPointsAlarm(settings: EngineSettings): Promise<void>`.

- [ ] **Step 1: Write failing alarm dispatch and lifecycle tests**

Assert the named listener calls `runTwitchChannelPointsClaim` only for `lurkloot.twitch-channel-points`. In controller tests assert:

```ts
expect(env.deps.createAlarm).toHaveBeenCalledWith(
  TWITCH_CHANNEL_POINTS_ALARM_NAME,
  { periodInMinutes: 1 },
);
```

Cover install and startup with an otherwise 60-minute scheduler interval, enabling/disabling Twitch, enabling/disabling `autoClaimChannelPoints`, repeated reconciliation, reset, and shutdown. Assert disabled states call `clearAlarm(TWITCH_CHANNEL_POINTS_ALARM_NAME)` and never create it.

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts tests/backgroundEntrypoint.test.ts -t "channel points alarm|named-alarm"`

Expected: FAIL because the constant, lifecycle helper, and dispatch branch do not exist.

- [ ] **Step 3: Implement alarm reconciliation and dispatch**

Add the constant and listener branch. Implement:

```ts
async function reconcileTwitchChannelPointsAlarm(settings: EngineSettings): Promise<void> {
  if (settings.platform.twitch.enabled && autoClaimChannelPointsFor(settings, "twitch")) {
    await deps.createAlarm(TWITCH_CHANNEL_POINTS_ALARM_NAME, { periodInMinutes: 1 });
  } else {
    await deps.clearAlarm?.(TWITCH_CHANNEL_POINTS_ALARM_NAME);
  }
}
```

Call it after loading/persisting the authoritative settings in install, startup, and `updateStoredSettings`. Clear the alarm best-effort during reset and shutdown. Keep `WATCH_ALARM_NAME` untouched.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts tests/backgroundEntrypoint.test.ts -t "alarm|settings|reset|shutdown" && pnpm --filter @lurkloot/core typecheck`

Expected: PASS.

- [ ] **Step 5: Commit alarm lifecycle**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts packages/extension/tests/backgroundEntrypoint.test.ts
git commit -m "feat(twitch): schedule channel points claims"
```

### Task 4: Implement the serialized claim-only path

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: `ManualWatchState.channel`, session `channel`, `MANUAL_WATCH_TTL_MS`, `isTimestampStale`, `autoClaimChannelPointsFor`, and `PlatformAdapter.claimChannelPoints`.
- Produces: `eligibleTwitchChannelPointsChannel(state: SchedulerState, now?: number): ChannelCandidate | undefined` or an equivalently focused private selector.
- Completes: `runTwitchChannelPointsClaim(): Promise<void>`.

- [ ] **Step 1: Write failing target-selection and positive-path tests**

Add tests that put auth health in `healthy` state and assert claims for:

- a recent active manual channel while the session remains `paused` with `reasonCode: "manual_watch"`;
- the new manual channel after same-tab navigation;
- a managed visible-tab `watching` session;
- a tabless `watching` session.

For manual precedence, populate both manual and managed channels and assert only the manual candidate is passed:

```ts
expect(twitch.claimChannelPoints).toHaveBeenCalledOnce();
expect(twitch.claimChannelPoints).toHaveBeenCalledWith(
  expect.objectContaining({ username: "manual-creator" }),
);
expect(env.state.sessions.twitch).toEqual(beforeSession);
```

- [ ] **Step 2: Run positive-path tests and verify RED**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts -t "claim-only|manual channel points|managed channel points"`

Expected: FAIL because `runTwitchChannelPointsClaim` does not claim.

- [ ] **Step 3: Implement eligibility and minimal claim behavior**

Resolve recent active manual state first; otherwise accept only a `watching` session with a channel. Under `withPlatformLock("twitch", ...)`, load settings/state, apply enabled/auto-claim/healthy checks, construct only the Twitch adapter, and call `claimChannelPoints`. Emit `Claimed channel points for <name>` only for `true`.

- [ ] **Step 4: Write failing negative and side-effect tests**

Use table-driven tests for Twitch disabled, auto-claim disabled, unhealthy/unknown auth, stale manual telemetry, inactive telemetry, unidentified manual route, paused managed session, and no channel. Assert `claimChannelPoints`, `refreshCampaigns`, `prepareWatchTab`, `stopWatchTab`, watcher heartbeat/start, and handoff-related work are not called.

Make `claimChannelPoints` reject and assert a warning diagnostic is reported while the state deep-equals its pre-call snapshot, especially `errorChecks`, `retryAfter`, `heartbeatChecks`, `lastHeartbeatOk`, and `tablessFallback`. Make it resolve `false` and assert no success/warning diagnostic.

- [ ] **Step 5: Run negative tests and verify RED where behavior is missing**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts -t "claim-only"`

Expected: FAIL until errors are contained and all guards are implemented.

- [ ] **Step 6: Implement best-effort diagnostics and strict no-op guards**

Catch adapter construction/claim errors inside the Twitch lock, report one English warning diagnostic through the existing event collector, and do not persist scheduler state. Preserve abort/shutdown semantics by checking `controllerShutdown` before admission and again inside the lock.

- [ ] **Step 7: Write and pass the concurrency regression**

Block the first `claimChannelPoints` call with a deferred promise, start a Twitch scheduler/manual controller mutation, and assert the second operation does not enter its adapter work until the first settles. Also fire the dedicated operation twice and assert `maxConcurrentClaims === 1`; allow the second queued result to be a quiet `false` no-op.

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts -t "serializes channel points"`

Expected: PASS with the existing Twitch platform lock and no new mutex.

- [ ] **Step 8: Run controller regressions and commit**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts tests/scheduler.test.ts tests/adapters.test.ts`

Expected: PASS, including existing scheduler channel-points coverage.

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(twitch): claim points outside scheduler ticks"
```

### Task 5: Verify the combined feature and prepare the PR

**Files:**
- Verify all files changed in Tasks 1-4.
- Modify only if verification exposes a feature-scoped defect.

**Interfaces:**
- Verifies the complete #407/#471 behavior and unchanged CLI fallback.

- [ ] **Step 1: Run formatting-free repository checks**

Run: `pnpm check`

Expected: all script tests, workspace typechecks, extension tests, and site build pass.

- [ ] **Step 2: Run production browser builds**

Run: `pnpm build && pnpm build:firefox`

Expected: Chromium and Firefox production extension builds succeed.

- [ ] **Step 3: Inspect the final diff and commits**

Run: `git status --short && git diff --check && git diff origin/develop...HEAD --stat && git log --oneline origin/develop..HEAD`

Expected: clean status, no whitespace errors, only the spec/plan and scoped implementation/tests, with conventional commits.

- [ ] **Step 4: Request code review and resolve findings**

Use `superpowers:requesting-code-review`, address only verified in-scope findings through fresh red-green cycles, and rerun affected focused tests.

- [ ] **Step 5: Re-run final verification after review changes**

Run: `pnpm verify`

Expected: complete check plus both browser builds pass.

- [ ] **Step 6: Push and open one PR against `develop`**

```bash
git push -u origin feat/twitch-channel-points-alarm
gh pr create --base develop --head feat/twitch-channel-points-alarm --title "feat(twitch): claim channel points on a dedicated alarm" --body-file /tmp/lurkloot-channel-points-pr.md
```

The PR body must summarize the dedicated claim-only alarm, safe manual channel identity, scheduler/CLI fallback, and verification results, and include `Closes #407` and `Closes #471`.
