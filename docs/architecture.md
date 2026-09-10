# Architecture

Lurkloot is a WXT browser extension that farms Twitch and Kick drops through normal logged-in browser sessions. Visible muted tabs are the default watch path; optional tabless low-resource mode sends platform watch heartbeats and falls back to tabs when unhealthy. The extension avoids asking for credentials, exporting cookies, or bypassing platform page detection.

## Repository Layout

The repository is a pnpm workspace whose root `package.json` is a pure orchestrator (delegating `dev`/`build`/`test`/`typecheck`/`verify` scripts to packages via `pnpm --filter`). All code lives under `packages/`:

- `packages/extension` — the WXT extension shell (`entrypoints/`, browser-specific `src/`, `wxt.config.ts`, `public/`, `tests/`). Builds to `packages/extension/.output/{chrome-mv3,firefox-mv2}`.
- `packages/core` — the browser-free farming engine (`@lurkloot/core`): scheduler, background controller, platform adapters/parsers, tab/watch abstractions, tabless watch logic, and Twitch integrity helpers. It is consumed by both the extension and CLI.
- `packages/cli` — the headless Node/Docker runtime (`@lurkloot/cli`) with auth, config, storage, and HTTP/impersonation transports around `@lurkloot/core`.
- `packages/locales` — the localized message catalogs and async catalog loader (`@lurkloot/locales`), used by extension code and shared UI.
- `packages/popup-ui` — the shared React popup UI (`@lurkloot/popup-ui`), consumed by both the extension and the site.
- `packages/shared` — framework-agnostic models, messages, settings, i18n, and logging (`@lurkloot/shared`).
- `packages/site` — the Astro marketing/landing page, which imports the real popup UI for its demo.

Package-qualified paths below are written as `packages/<package>/...` when ownership matters. Bare extension paths such as `entrypoints/...` are relative to `packages/extension/`.

## Runtime Components

- `entrypoints/background.ts` registers extension lifecycle hooks, alarms, tab-removal handling, runtime message handling, and browser-specific adapters around `@lurkloot/core`.
- `packages/core/src/background/controller.ts` coordinates settings/state persistence, scheduler ticks, popup messages, notifications, manual reward claims, and playback-control authorization.
- `packages/core/src/core/scheduler.ts` owns platform-independent campaign selection, Idle Watchlist fallback selection, auto-claiming, retry/backoff, session state, manual-watch pauses, and watch-mode lifecycle decisions.
- `packages/core/src/platforms/adapter.ts` defines the `PlatformAdapter` contract. `packages/core/src/platforms/twitch/index.ts` and `packages/core/src/platforms/kick/index.ts` implement platform-specific discovery, progress, candidate, validation, claim, and tab preparation behavior.
- `packages/core/src/core/tabs.ts` contains shared tab-management and page-context-fetch abstractions; `packages/extension/src/core/tabs.ts` binds those abstractions to live WXT/browser tab and cookie APIs.
- `entrypoints/twitch.content.ts` and `entrypoints/kick.content.ts` start shared playback telemetry/control on platform pages.
- `entrypoints/popup/` adapts WXT/browser APIs to the shared React popup UI in `packages/popup-ui`, which talks only to the background controller through runtime messages.

State and normalized settings are loaded and saved through `packages/extension/src/core/storage.ts` in the extension and through `packages/cli/src/storage.ts` in the CLI. The scheduler stores independent `WatchSession`, campaign, manual-watch, and managed-tab state for `twitch` and `kick`; diagnostics and activity events are emitted through the reporter outside `SchedulerState`. A short-lived Twitch Client-Integrity bundle is stored separately so claim mutations can replay page-issued Twitch headers while the token is valid.

### Scheduler admission

The shared controller reserves one active scheduler tick and at most one pending
follow-up per platform, before loading settings or beginning tick diagnostics.
Overlapping callers share the pending result promise. Twitch and Kick have
independent lanes; extension alarms and CLI intervals request each platform
separately. The CLI also shares result observers so repeated intervals cannot
accumulate reporting continuations behind the same pending tick.

Pending triggers merge by their existing selection semantics: `manual_tick`,
`manual_resume`, and `claim_handoff` force selection and bypass backoff; `startup`
forces selection without bypassing backoff. Other user actions, including
settings and automation toggles, retain their persisted mutations through fresh
settings/state loads. Ordinary alarms and discovery signals do not override a
higher-priority trigger. Equal-priority triggers retain the first reason, while
diagnostics count every merged reason. Valid discovery signals share an already
pending scheduler follow-up instead of requesting another cycle afterward.

Each executed follow-up reloads current settings/state and selects from the
latest committed discovery revision. Disablement discards obsolete pending work;
shutdown and host reset cancel it and abort active ticks. Reset also closes
admission until cleanup finishes. Discovery signal controller/generation checks
remain in force. Tick start/finish timing covers executed work only; separate
diagnostics report merged or discarded trigger counts. Heartbeat admission and
its fixed cadence remain independent of scheduler admission.

### Discovery work

The shared collector evaluates campaign farmability using the refresh's settings
and one timestamp before listing channels. Completed, expired, excluded,
infeasible and statically disallowed campaigns stay in the inventory with empty
channel observations. Claimable rewards and uncertain channel eligibility retain
their existing behavior. This gate uses the same evaluator as selection.

Kick checks eligible campaigns through an optional adapter batch contract. Three
workers process independent campaigns; each campaign checks candidates in order
and stops at its first valid channel. This avoids speculative requests after an
early match. Idle Watchlist checks are independent jobs and all remain observed.
Raw API/page responses are shared by URL only within that discovery revision;
each candidate retains its own campaign, ACL metadata and category expectation.
The next revision fetches fresh evidence. A single campaign's candidate chain
remains sequential, trading its latency for the existing early-match request
budget. Campaign and candidate result ordering never depends on completion order.

Missing Kick inventory/progress, malformed general-channel directories, missing
required category evidence, cancellation or failed checks do not replace the
last coherent snapshot. On failure, workers stop taking new work and drain active
requests before returning. The collector also drains paired inventory and
followed-channel operations. Strict Kick discovery awaits stale followed-cache
refreshes, including an existing refresh, before cycle-level fetch observation is
consumed. This adds the followed lookup's latency once per five-minute cache
expiry, while fresh-cache reads remain immediate. HTTP 429 never retries through a different
execution context. Discovery diagnostics report duration, inventory count,
campaigns skipped before channel work, candidate observations and unique channel
checks. Failed attempts without counters report that work metrics are unavailable
rather than reporting zero work. The attribution fields contain only counts;
strict missing-evidence failures use fixed messages. Both extension and CLI run
this collector and the same Kick adapter.

## Runtime Messages

The popup and content scripts do not call adapters directly. They send typed runtime messages from `@lurkloot/shared/messages`:

- Popup messages: `getSnapshot`, `saveSettings`, `setRunning`, `setPlatformEnabled`, `setAutomation`, `tickNow`, and `claimReward`.
- Content-script messages: `getPlaybackControl` and `playbackTelemetry`.

`getPlaybackControl` is intentionally gated in the background controller. A content script may only control page video elements when its sender tab is the current watch tab for that platform. This prevents normal user-opened Twitch/Kick tabs from being modified.

## Settings Model

`mergeSettings` in `@lurkloot/shared/settings` is the source of truth for defaults and persisted-setting normalization. It fills missing keys from `DEFAULT_SETTINGS`, clamps numeric values, normalizes channel/category/campaign lists, and removes duplicate list entries. It reads only current property names; legacy shapes are handled beforehand by the migration registry (see [Settings Migrations](#settings-migrations)).

Important setting groups:

- Global automation: `running`, `autoStartDropFarming`, per-platform `enabled`.
- Farming behavior: `autoClaim`, `autoClaimChannelPoints`, `idleWatchlistFallbackOnly`, `priorityMode`, `campaignPriorities`, `excludedCampaignIds`, `farmingEligibility`.
- Platform preferences: `platform[platform].idleWatchlistChannels`, `platform[platform].excludedChannels`, `platform[platform].categoryMode`, and `platform[platform].categories`.

`categoryMode` is `"all"`, `"include"` or `"exclude"`, and one stored `categories`
list serves all three: `all` farms everything and leaves the list inactive,
`include` farms only the listed categories (an empty list farms nothing) with
list order supplying category priority, and `exclude` farms everything except the
listed categories (an empty list is equivalent to `all`) with list order carrying
no scheduling meaning. Switching mode never rewrites the array, so returning to
`include` restores the ordering the user had set. Both questions — does a
campaign pass, and what is its category priority — are answered only by
`campaignPassesCategoryFilter` and `categoryPriorityScore` in
`@lurkloot/shared/categories`, so farming eligibility, Drops-list visibility,
scheduler rejection reasons and priority scoring cannot disagree.
- Tab/playback behavior: `tablessMode`, `muteFarmingTabs`, `keepFarmingVideosUnmuted`, `pauseOnManualWatch`, `autoCloseFinishedDrops`, `offlineRetryLimit`.
- Notifications: `notifyRewardEarned`, `notifyNoDropsLeft`.

The popup normalizes snapshots before rendering and normalizes patches before saving, so older stored settings get current defaults before they drive UI toggles.

## Settings Migrations

`packages/shared/src/settingsSchema.ts` is the only place legacy settings shapes
are transformed. Both hosts call `migrateSettings(raw)` on the raw persisted
payload and pass the result to normalization (`mergeSettings` in the extension,
`parseCliSettings` in the CLI). Migration and normalization are deliberately
separate: clamping and defaulting would erase the raw property information the
deprecation diagnostics depend on.

A stored document carries a reserved `schemaVersion`; an unversioned document is
version 0. `migrateSettings` applies every migration from the stored version up
to `CURRENT_SETTINGS_SCHEMA_VERSION`, returning the migrated payload, a `changed`
flag, and structured diagnostics. A version newer than this build supports throws
`UnsupportedSettingsVersionError`, and neither host writes after that error.

Extension storage is upgraded automatically: `loadSettings` writes the canonical
envelope once when `changed` is true, under the settings lock. The CLI's JSONC
file is never rewritten, so its diagnostics surface as startup warnings that
repeat until the user edits the file.

To add version N+1:

1. Increment `CURRENT_SETTINGS_SCHEMA_VERSION`.
2. Add exactly one pure `N` → `N+1` entry to `MIGRATIONS`. It receives a deep
   clone it owns outright, so it may mutate that object freely, but it must not
   reach outside it or log.
3. Emit a diagnostic for every deprecated or removed property it recognizes,
   with the full dotted path and the replacement path when one exists.
4. When an old and a current representation coexist, the current one wins and
   the deprecated one still produces a diagnostic. Migrations never inspect
   value types, so a wrong-typed current value is left for normalization to
   default rather than falling back to the legacy value.
5. Add fixtures to `packages/extension/tests/settingsMigrations.test.ts` for
   version N input, mixed old/current input, and the fully migrated output.
6. Update `defaultConfigJsonc()` in `packages/cli/src/config.ts` when public
   property names change.

Released migrations are never edited except to fix a data-loss defect. A later
semantic change gets a new version and a new migration.

Migration 1 consolidates every legacy shape that predates the registry: the Idle
Watchlist rename, the pre-split top-level channel-points toggle, and the
`verboseLogging` rename.

Migration 2 replaces the old `campaignVisibility` record, which in every shipped
release was display-only — it decided what the popup's Drops list showed and
never affected farming. The new split puts two settings on opposite sides of the
engine/extension boundary: `EngineSettings.farmingEligibility`
(`farmUnlinkedCampaigns`, `farmSubscriptionCampaigns`), which the scheduler and
CLI honour, and `ExtensionSettings.dropsListFilter`
(`showUpcoming`/`showExpired`/`showFinished`/`showExcluded`), a popup-only view
preference the CLI rejects as extension-only. Farming eligibility and list
visibility are independent: hiding a campaign from the Drops list never stops it
being farmed, and skipping a campaign class never hides it.

The migration carries over only the four lifecycle display keys into
`dropsListFilter`. It deliberately does NOT derive `farmingEligibility` from the
old record: `campaignVisibility.notLinked` and `.subscription` were list-display
preferences that never meant anything about farming, so mapping them into the new
farming gates would silently reduce farming for anyone who had merely hidden
those campaigns. Both farming flags therefore default to on and are never derived
from the old setting, so farming behaviour is unchanged for every profile. A
profile that had hidden unlinked or subscription campaigns from its list will see
them reappear in the Drops list, because those campaigns are farmed and the tool
guarantees anything it farms is visible.

## Scheduler Flow

Each scheduler tick runs enabled platforms independently:

1. Pause and clean up the platform if recent manual watch activity is detected, global automation is disabled, or that platform is disabled.
2. Skip the platform while it is in exponential backoff after repeated platform errors.
3. Discover campaigns through the adapter and merge progress.
4. Auto-claim claimable rewards when enabled.
5. Select the best eligible campaign channel, or an Idle Watchlist fallback when no eligible campaign channel is available.
6. Decide whether to keep the current target by checking channel liveness/category and recent playback or heartbeat telemetry.
7. Use tabless watching when enabled and supported, or open, reuse, retarget, or stop the watch tab through the adapter.
8. Claim channel points when enabled and supported by the adapter.
9. Persist sessions, campaigns, managed-tab registrations, and backoff state, then publish activity records through the host event sink.

Campaign ordering is shared across platforms: explicit campaign priority, platform game priority, campaign priority field, optional lowest-availability mode, ending soonest, then campaign name. Channel ordering within the selected campaign is also shared: allow-listed channels first, then channels the user has a relationship with (an Idle Watchlist entry ahead of a followed channel, via the adapter's optional `listFollowedChannels`), then viewer count. That preference only picks between channels that already qualify for the campaign, so it never changes what is farmed. `preferKnownChannels` (on by default) gates the whole thing; off, ordering is allow-list then viewer count only, and `listFollowedChannels` is never called. Per-platform excluded drop channels filter campaign candidates only; they do not suppress Idle Watchlist fallback channels. `farmingEligibility` also narrows eligibility, through its two farming flags (`farmUnlinkedCampaigns`, `farmSubscriptionCampaigns`); the separate `dropsListFilter` is a popup view preference that affects nothing the engine does.

For exactly how a campaign's farmability (`campaignFarmable`, feeding `isEligible`) and its popup visibility (`isCampaignVisible`) are decided — and why they deliberately diverge on reward timing — see [`campaign-farmability-visibility.md`](campaign-farmability-visibility.md).

## Same-Origin Fetching

In the extension, most platform calls go through the page-context fetch helpers wired by `packages/extension/src/core/tabs.ts` onto abstractions from `@lurkloot/core/tabs`. They find or open a temporary tab on the platform origin, then execute `fetch` in the page `MAIN` world. This keeps requests inside the browser's normal logged-in session and any page clearance context.

For Kick, `pageFetchJson` reads `session_token` from the Kick page context and adds it as a bearer token for `web.kick.com` API calls. For Twitch, GraphQL requests use Twitch's public web client id and normal browser credentials unless a public channel check explicitly passes `credentials: "omit"`. Twitch claim mutations also replay a short-lived Client-Integrity bundle captured from page-origin Twitch GraphQL traffic.

Temporary page-context tabs are reference-counted per origin and removed after the fetches complete when the extension created them. Existing user tabs reused for page-context fetches are not closed.

## Twitch Integration

`TwitchAdapter` uses Twitch GraphQL at `https://gql.twitch.tv/gql` with persisted query hashes and the public Twitch web client id.

- Campaign discovery calls `Inventory` and `ViewerDropsDashboard`, then fetches campaign details for active/upcoming connected campaigns.
- Progress refresh re-reads `Inventory`; while watching, it also queries `DropCurrentSessionContext` to update the current reward's watched minutes.
- Candidate discovery prefers campaign allowed-channel data. If none exists, it queries `GameDirectory` with the DropsEnabled tag and sorts by viewer count.
- Followed channels come from an inline `FollowedLiveChannels` query (`currentUser.followedLiveUsers`), cached for 5 minutes in `TwitchDiscoveryState` (injected, so the cache survives the extension reconstructing `TwitchAdapter` every tick). A tick never blocks on this: a cached value, even a stale one, is returned immediately and refreshed in the background; only the very first lookup ever (nothing cached yet) awaits the request. A signed-out session or a failed lookup answers with an empty list, and selection falls back to viewer count.
- Channel validation calls `StreamInfo` with an inline public query and anonymous credentials to avoid logged-in integrity-token failures. For live category matches, it briefly caches `DropsHighlightService_AvailableDrops` results to confirm the selected campaign; unavailable or malformed confirmation data falls back to the live/category result. If `StreamInfo` fails, validation falls back to parsing channel page HTML.
- Reward claiming calls `DropsPage_ClaimDropRewards`.
- Channel points claiming checks `ChannelPointsContext` and submits `ClaimCommunityPoints` when a claim is available.
- Tabless watching sends Twitch's `sendSpadeEvents` minute-watched mutation once per watch alarm while the selected stream is live.

## Kick Integration

`KickAdapter` uses Kick JSON APIs from the Kick page context.

- Campaign discovery fetches `https://web.kick.com/api/v1/drops/campaigns`.
- Progress refresh fetches `https://web.kick.com/api/v1/drops/progress`.
- Candidate discovery prefers campaign allowed-channel data. Otherwise it queries `https://web.kick.com/api/v1/livestreams` with `category_id`, sorted by viewer count.
- Followed channels come from `https://kick.com/api/v1/user/livestreams`, which Kick itself filters to the account's live follows (no pagination of the full follow list), cached for five minutes in `KickDiscoveryState`. Strict discovery awaits stale refreshes to keep fetch lifecycle observation inside its cycle; standalone callers can still read stale values immediately. A signed-out session or a failed lookup answers with an empty list, and selection falls back to viewer count.
- Channel validation calls `https://kick.com/api/v2/channels/{username}` and checks live state plus category id. If that fails, it falls back to parsing channel page HTML.
- Reward claiming posts to `https://web.kick.com/api/v1/drops/claim` with campaign, reward, and claim identifiers.
- Tabless watching exchanges the Kick session for a viewer WebSocket token, opens Kick's viewer socket, and sends watch livestream events while the channel remains live and in the expected category.

## Watch Tabs

Both adapters use the shared `openPinnedMutedTab` and `stopWatchTab` helpers.

Watch-tab preparation:

- Reuses a registered extension-managed tab when possible.
- Reuses a user tab only when the current session was already using a non-managed user tab.
- Retargets stale/wrong URLs to the selected channel.
- Pins the tab and applies browser-level tab muting according to `muteFarmingTabs`.
- Briefly activates newly created, retargeted, missing-telemetry, stale-telemetry, or unhealthy-playback tabs when `keepFarmingVideosUnmuted` is enabled, then restores the previously active tab. This primes players that defer loading until foregrounded.
- Stores extension-managed tab ids in scheduler state so stale managed tabs can be cleaned up without closing arbitrary matching user tabs.

When a managed watch tab is manually closed, `background.ts` notifies the controller, which triggers a fresh scheduler tick if automation is running.

Stopping behavior depends on ownership and settings:

- Extension-managed watch tabs are closed when `autoCloseFinishedDrops` allows it.
- Reused user tabs are unmuted, unpinned, and left open.

## Tabless Watch

When `tablessMode` is enabled, supported adapters create a `TablessWatchController` instead of opening a watch tab. Twitch sends minute-watched GraphQL events. Kick maintains a viewer WebSocket and sends watch livestream events. The one-minute watch alarm records heartbeat health in the platform session; repeated failures mark the target for fallback to a visible muted tab.

## Playback Telemetry and Control

Content scripts run on all Twitch/Kick pages, but only the current watch tab is authorized to mutate video state or update farming playback health. Non-managed tabs send passive telemetry only so the background can detect manual watching when `pauseOnManualWatch` is enabled.

Every five seconds, and after visibility/focus/player mutations, the content script asks the background for `PlaybackControl`:

- If `managed` is false, it reports passive telemetry and does not change page video state.
- If `managed` is true and `keepVideosUnmuted` is true, it removes page-level video muting, sets nonzero video volume, attempts `video.play()`, and listens for later `volumechange`/`pause` events so platform player state changes can be corrected. The content script suppresses the `volumechange`/`pause` events its own mutations trigger to avoid a self-feeding control loop.
- Some browsers (notably Firefox) refuse to unmute media in a tab that has had no user gesture and pause the element instead. The content script only attempts to unmute once the document reports sticky user activation (`navigator.userActivation.hasBeenActive`), so a background watch tab stays muted-but-playing without logging warnings. As a safety net, if an unmute is still blocked it re-mutes and replays the video so playback keeps progressing (counted in blocked playback count); watch time is credited even while muted.
- It reports telemetry including video count, muted/unmuted video count, playing video count, blocked playback count, document visibility, ready state, current time, and duration.

The scheduler treats playback as healthy when recent telemetry shows at least one video and at least one playing video — muted or not, since the browser may keep a background video muted. The browser tab can still be muted; the platform-visible page video state is intentionally separate from browser tab audio output.

Repeated offline, category mismatch, unhealthy playback checks, or unhealthy tabless heartbeats cause the scheduler to switch channels or fall back according to `offlineRetryLimit`.

## Popup and Manual Actions

The popup is a controller UI, not a platform client. It requests snapshots and sends setting/action messages to the background controller. Manual reward claims are routed through the platform adapter so state updates, notifications, and event logging stay consistent with automated claims.

The popup exposes platform-specific idle watchlists, excluded drop channels, game order, campaign priorities, notifications, and advanced playback settings. Changes that can affect the active scheduler target can request a targeted tick for the affected platform.

## Activity and diagnostics

The controller emits causally ordered batches of typed activity and diagnostic records through a host-provided reporter. Farming starts, stops with a stable reason, successful claims, and actionable interruptions are activity; request, playback, tab, and scheduler detail is diagnostic. Unchanged periodic decisions are not emitted repeatedly. Hosts format and retain these records at that reporter boundary rather than reconstructing prose from scheduler state.

Activity records are structured (`code` plus `data`) and localized by the host at render time. Diagnostic records carry a literal English `message` and are never translated, in any locale, because they are the surface a user pastes into a bug report and a maintainer greps: `packages/core` imports no message catalog, and the popup renders a diagnostic body verbatim. Only activity entries and OS notification copy are localized, the latter through the `translate` callback the host injects into the controller.

Every activity event therefore also emits a diagnostic mirror. `packages/core/src/core/activityDiagnostics.ts` wraps the controller's event collector — the one choke point all engine emitters funnel through — and restates each activity event in English with the context the localized sentence drops: campaign and reward ids, raw reason codes, claim method, session detail. Emit sites do not hand-write a matching diagnostic.

The extension stores activity in a bounded IndexedDB database owned by the background and queries it from the popup through runtime messages. Normal activity is always retained; diagnostic persistence is extension-only and opt-in, so hosts with diagnostics disabled drop the mirrors when they filter by category. Each category has its own record budget, so mirrors never evict activity history. Activity database failures are isolated from farming state mutations.

The popup shows one category at a time. The activity/diagnostics switch selects a view rather than interleaving both, since the mirror means a merged list would state everything twice.

The CLI has no activity store. Its output is already English, so it logs mirrored diagnostics at `debug` — their ids and reason codes stay available under `--log debug` without repeating each activity line at its own level. It formats each activity variant directly, passes diagnostic messages through, and routes each batch in its original order through the existing `--log`-filtered stderr logger. Retention belongs to Docker, systemd, Loki, or another external collector; `state.json` never contains new event data, and legacy event fields disappear after the state is loaded and saved.

Kick fetch diagnostics keep individual initial-route, fallback, recovery, and
lifecycle-update-failure evidence. Unchanged successes use fixed counters for
`kick.com`, `web.kick.com`, `websockets.kick.com`, and one unknown-host bucket,
split into background/page routes. Drained auth, discovery, scheduler, manual
action, and watcher operations flush a `kick_fetch_summary` diagnostic with
numeric counts and an English message usable in exports and CLI debug logs.
No URL path, query value, arbitrary host, header, credential, or payload is kept.
The last announced route lives in host-owned `KickDiscoveryState`, so adapter
reconstruction does not repeat it; restarting the runtime begins a new history.
Counters are fetcher-local and refuse to flush while a request or lifecycle
callback is active. They never consume page-context recovery observations:
successful HTTP counts also describe failed scheduler operations and must not be
interpreted as committed recovery cycles. Transport evidence survives scheduler
rollback, while activity-event mirroring and publication rules remain unchanged.
