# Twitch Channel Points Alarm Design

## Goal

Implement GitHub issues #407 and #471 together: claim Twitch channel-points bonuses on a dedicated fixed one-minute alarm, including while campaign farming is paused because the user is watching a Twitch channel manually.

## Scope

The browser extension gains a dedicated `lurkloot.twitch-channel-points` alarm and a lightweight controller operation that claims channel points without running campaign discovery or watch maintenance. The existing scheduler claim remains as a safe fallback and continues to serve the CLI, which has no browser alarm.

This change does not add settings, permissions, activity events, notifications, credentials, campaign work, heartbeat work, or post-claim handoff behavior.

## Architecture

### Alarm lifecycle

`packages/core/src/background/controller.ts` will export `TWITCH_CHANNEL_POINTS_ALARM_NAME` and teach `createBackgroundAlarmListener` to dispatch it to a new public controller method, `runTwitchChannelPointsClaim`.

The controller will reconcile this alarm through one idempotent helper:

- Create it with `periodInMinutes: 1` only when Twitch is enabled and Twitch channel-points auto-claiming is enabled.
- Clear it otherwise.
- Invoke reconciliation during install, startup, and persisted settings changes.
- Clear the alarm during host reset and controller shutdown, alongside the other controller-owned alarms.

The one-minute cadence is fixed and independent of `pollIntervalMinutes`. The existing Twitch/Kick scheduler alarms and `lurkloot.watch` heartbeat alarm retain their current responsibilities.

### Claim-only controller operation

`runTwitchChannelPointsClaim` will execute under the existing Twitch platform mutation lock. This serializes it with scheduler ticks, manual reward claims, authentication transitions, reset, and shutdown without creating a second concurrency mechanism.

Inside the lock, the operation will:

1. Return if the controller is shut down.
2. Load current settings and scheduler state.
3. Return unless Twitch and Twitch channel-points auto-claiming are enabled.
4. Return unless persisted Twitch authentication health is `healthy`.
5. Resolve an eligible Twitch channel from current state.
6. Construct the Twitch adapter through the normal compatibility and integrity dependency path.
7. Call the existing `adapter.claimChannelPoints(channel)` operation.
8. Emit the existing English success diagnostic only when a bonus was claimed.

The claim-only operation will not refresh authentication or campaigns, select a campaign target, prepare or stop tabs, start or send a tabless heartbeat, alter the watch session, enter scheduler backoff, or start post-claim handoff.

An absent or already-claimed bonus is a quiet successful no-op. Lookup or claim errors produce a best-effort English warning diagnostic and leave scheduler state unchanged. Existing Twitch Client-Integrity acquisition and bounded retry behavior remains encapsulated in `claimChannelPoints`.

### Eligible channel resolution

Channel resolution uses this precedence:

1. A recent, active manual-watch Twitch channel.
2. The current Twitch session channel when the session is actively `watching` in visible-tab or tabless mode.

Manual watch takes precedence because the user-owned visible playback is the authoritative current target while `pauseOnManualWatch` is active. A manual entry is eligible only when it is active, its timestamp is within the existing `MANUAL_WATCH_TTL_MS`, and it includes a safely identified Twitch channel.

The managed session fallback preserves dedicated-alarm claiming for normal visible-tab and tabless farming. Paused, idle, error, stale, or channel-less sessions are not eligible.

### Manual-watch channel identity

`ManualWatchState` will gain an optional `channel` field using the shared `ChannelCandidate` contract. Making the field optional preserves compatibility with previously persisted state, which is treated as unidentified and therefore ineligible for manual channel-point claiming.

The background message boundary will pass the sender tab URL alongside its existing tab ID. A focused Twitch URL parser in the browser-free core will derive a normalized channel candidate only when all of these conditions hold:

- The URL uses HTTPS.
- The hostname is exactly `twitch.tv` or `www.twitch.tv`.
- The path contains exactly one non-empty route segment representing a plausible Twitch login.
- The login uses Twitch-compatible login characters and length.
- The segment is not a known non-channel route such as `directory`, `downloads`, `drops`, `inventory`, `jobs`, `login`, `messages`, `payments`, `search`, `settings`, `subscriptions`, `turbo`, or `videos`.

Query strings and fragments do not affect identity. Malformed URLs, deceptive hosts, multi-segment routes, and reserved routes return no channel.

Every telemetry report from a user-owned tab recomputes the channel from the current sender URL. Navigating the same tab from one channel to another therefore replaces the stored target. If the new route cannot be identified, the stored manual-watch entry has no channel rather than retaining the previous one. Inactive telemetry remains recorded with `active: false`, making it immediately ineligible; stale active telemetry becomes ineligible through the existing TTL check. Tab removal continues to remove the associated manual-watch state.

The URL is observational input only. This flow never navigates, reloads, mutes, closes, adopts, or otherwise mutates the user-owned tab.

## Data flow

On telemetry, the Twitch content script sends its existing playback message. The extension runtime listener supplies WXT's trusted `sender.tab.id` and `sender.tab.url` metadata to the core controller. The controller stores the active/inactive manual-watch observation and its parsed channel candidate.

On the dedicated alarm, the extension's single alarm listener dispatches to `runTwitchChannelPointsClaim`. The controller reads current state under the Twitch lock, resolves manual or managed session identity, constructs the normal Twitch adapter, and performs only the channel-points lookup/claim request.

The normal scheduler continues to pause campaign farming before discovery when recent manual playback is active. No channel-points call is added to that early-return branch; the dedicated claim path owns the timely manual-watch behavior while the scheduler fallback remains unchanged for normal managed sessions and CLI operation.

## Error handling and concurrency

- All eligibility checks are quiet no-ops.
- Adapter construction and claim failures are caught inside the claim-only operation and reported as English diagnostics.
- Failures never update `WatchSession.errorChecks`, `retryAfter`, authentication state, heartbeat health, or tabless fallback state.
- The Twitch platform lock prevents overlap with all other Twitch controller mutations. Multiple alarm callbacks queue rather than overlap; after the first claim succeeds, the next sees no available bonus and exits quietly.
- Reset and shutdown close admission, clear the alarm, and serialize cleanup with in-flight work through existing controller lifecycle mechanisms.

## Testing

Focused tests will cover:

- Twitch URL parsing for canonical channels, normalization, reserved routes, malformed URLs, deceptive hosts, and multi-segment routes.
- Manual telemetry storing and replacing the current Twitch channel after same-tab navigation.
- Inactive, stale, unidentified, and removed-tab manual state becoming ineligible.
- Dedicated alarm creation at one minute when both relevant settings are enabled, independent of a 60-minute scheduler interval.
- Alarm clearing when Twitch or channel-points auto-claiming is disabled and during reset/shutdown.
- Idempotent install, startup, settings-change, reset, and shutdown reconciliation.
- Alarm listener dispatch and ignoring unrelated alarms.
- Claiming for recent manual playback while the Twitch session remains paused with `reasonCode: "manual_watch"`.
- Claiming for managed visible-tab and tabless sessions.
- Quiet no-ops for disabled settings, unhealthy auth, and missing eligible channels.
- Best-effort failure diagnostics without state mutation or scheduler backoff.
- Serialization with normal Twitch work and non-overlapping repeated alarm callbacks.
- Absence of campaign discovery, selection, tab preparation/teardown, heartbeat, and handoff side effects.
- Existing scheduler-based and CLI channel-points behavior remaining unchanged.

All behavioral implementation follows test-driven development: each production change is preceded by a focused failing test and verified with the relevant test file before the full repository verification suite.
