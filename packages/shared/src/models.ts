import type { CriticalHealthState } from "./criticalHealth";

export type Platform = "twitch" | "kick";

export type PlatformAuthStatus = "checking" | "healthy" | "missing_credentials" | "invalid_credentials" | "blocked" | "unavailable";

export type PlatformAuthReasonCode = "credentials_missing" | "credentials_rejected" | "security_policy_blocked" | "credential_lookup_failed" | "platform_unavailable" | "network_unavailable";

export type PlatformAuthMessageKey = "authChecking" | "authHealthy" | "authMissingCredentials" | "authInvalidCredentials" | "authSecurityPolicyBlocked" | "authCredentialLookupFailed" | "authPlatformUnavailable" | "authNetworkUnavailable";

export interface PlatformAuthMessage {
  key: PlatformAuthMessageKey;
  values?: Partial<Record<"reference", string | number>>;
}

export interface PlatformAuthHealth {
  status: PlatformAuthStatus;
  checkedAt?: string;
  reasonCode?: PlatformAuthReasonCode;
  message?: PlatformAuthMessage;
}

export type CampaignStatus = "active" | "upcoming" | "expired" | "completed";

export type RewardStatus = "locked" | "in_progress" | "claimable" | "claimed";

export type RewardRequirementType = "watch" | "subscription" | "action";

export interface ClaimGuidance {
  kind: "link_required";
  url: string;
}

// Lifecycle of the one-time Chrome Web Store rate/review nudge. "pending" until
// the user either rates or dismisses it, after which it never shows again.
export type RateNudgeStatus = "pending" | "rated" | "dismissed";

// Lifecycle of the one-time GitHub star nudge. "pending" until the user either
// stars or dismisses it, after which it never shows again.
export type GithubStarNudgeStatus = "pending" | "starred" | "dismissed";

export interface DropReward {
  id: string;
  name: string;
  imageUrl?: string;
  benefitIds?: string[];
  benefitType?: "UNKNOWN" | "BADGE" | "EMOTE" | "DIRECT_ENTITLEMENT" | string;
  requiredMinutes: number;
  requiredSubs?: number;
  isWatchBased?: boolean;
  requirement?: RewardRequirementType;
  watchedMinutes: number;
  status: RewardStatus;
  claimId?: string;
  availableFrom?: string;
  availableUntil?: string;
  claimUntil?: string;
  preconditionRewardIds?: string[];
  preconditionsMet?: boolean;
  isCurrentReward?: boolean;
  claimGuidance?: ClaimGuidance;
}

export interface DropCampaign {
  id: string;
  platform: Platform;
  name: string;
  slug?: string;
  gameName?: string;
  gameImageUrl?: string;
  categoryId?: string;
  startsAt?: string;
  endsAt?: string;
  status: CampaignStatus;
  rewards: DropReward[];
  allowedChannels?: string[];
  connectionUrls?: string[];
  isGeneralDrop?: boolean;
  accountLinked?: boolean;
  accountLinkUrl?: string;
  claimGuidance?: ClaimGuidance;
  eligibility?: "eligible" | "account_not_linked" | "waiting_for_subscription" | "upcoming" | "expired" | "completed" | "no_rewards";
  eligibilityReason?: string;
  priority?: number;
  url?: string;
}

export interface ChannelCandidate {
  platform: Platform;
  username: string;
  displayName?: string;
  url: string;
  campaignId?: string;
  categoryId?: string;
  categoryName?: string;
  isAclMatch?: boolean;
  viewerCount?: number;
  title?: string;
  live?: boolean;
  profileImageUrl?: string;
  // Identifiers the tabless watcher needs to send watch heartbeats without a
  // tab. Populated by checkChannel when available: broadcastId is the Twitch
  // stream id (or Kick livestream id), channelId is the channel's user id.
  broadcastId?: string;
  channelId?: string;
}

export interface ChannelCheck {
  live: boolean;
  categoryMatches: boolean;
  // Undefined when the platform cannot confirm campaign availability. A
  // definitive false rejects the candidate; soft failures keep the existing
  // live/category validation path usable.
  campaignMatches?: boolean;
  reason?: string;
  candidate: ChannelCandidate;
}

export interface WatchSession {
  platform: Platform;
  tabId?: number;
  tabManagedByExtension?: boolean;
  channel?: ChannelCandidate;
  campaignId?: string;
  rewardId?: string;
  startedAt?: string;
  // When the current watch tab was opened (or re-opened / re-navigated). Playback
  // telemetry only becomes meaningful once the page has had time to attach a
  // player, so the scheduler grants a grace period from this instant before it
  // starts counting unhealthy playback checks.
  watchTabOpenedAt?: string;
  lastCheckedAt?: string;
  offlineChecks: number;
  playbackChecks?: number;
  // Consecutive verification windows in which a healthy, category-matching watch
  // accrued no additional minutes, plus the reading they are compared against.
  // Trusting a discovery source means nothing else rejects such a channel, so
  // this is what rotates off one that never pays out (#400).
  noProgressChecks?: number;
  lastWatchedMinutes?: number;
  errorChecks?: number;
  retryAfter?: string;
  status: "idle" | "starting" | "watching" | "paused" | "error";
  message?: string;
  reasonCode?: WatchReasonCode;
  playback?: PlaybackTelemetry;
  // How the current channel is being watched. "tabless" sends API watch
  // heartbeats with no tab (low-resource mode); "tab" is the classic visible
  // muted tab. Absent means tab-based, preserving prior behavior.
  watchMode?: "tab" | "tabless";
  // True when tabless mode was wanted but we opened a tab anyway (because the
  // heartbeat kept failing). Keeps the channel on its tab until it switches.
  tablessFallback?: boolean;
  // Health of the tabless heartbeat. lastHeartbeatOk is whether the last watch
  // signal was accepted; heartbeatChecks counts consecutive unhealthy checks so
  // the scheduler can fall back to a real tab after tablessFallbackFailureLimit.
  lastHeartbeatAt?: string;
  lastHeartbeatOk?: boolean;
  heartbeatChecks?: number;
  tablessHeartbeat?: TablessHeartbeatCadence;
}

export interface TablessHeartbeatCadence {
  generation: number;
  contextKey: string;
  nextDueAt: string;
}

export type WatchReasonCode =
  | "eligible_campaign"
  | "idle_watchlist_selected"
  | "no_eligible_channel"
  | "no_existing_session"
  | "manual_watch"
  | "manual_tab_close"
  | "automation_disabled"
  | "platform_disabled"
  | "authentication_unhealthy"
  | "platform_backoff"
  | "platform_error"
  | "campaign_ineligible"
  | "channel_excluded"
  | "channel_offline"
  | "channel_mismatch"
  | "watch_unhealthy"
  | "no_progress"
  | "higher_priority_reward"
  | "higher_priority_idle_watchlist"
  | "keeping_current_watch"
  | "keeping_idle_watchlist"
  | "watch_requirement_completed"
  | "runtime_restart"
  | "target_changed"
  | "critical_failure";

export interface ManagedWatchTab {
  platform: Platform;
  tabId: number;
  channelUrl: string;
  ownedByExtension: true;
}

export interface ManagedPageContextTab {
  platform: Platform;
  tabId: number;
  originUrl: string;
  origin: string;
  ownedByExtension: true;
  lastFallbackAt?: string;
  fallbackHost?: string;
  backgroundSuccesses?: number;
}

// Recorded when the user closes an extension-owned watch tab. Closing the
// window LurkLoot opened is the most direct "stop" gesture available, so the
// scheduler treats it as an explicit per-platform pause until the user resumes
// from the popup. It never touches the user's enabled/running settings.
export interface ManualClosePauseState {
  platform: Platform;
  closedAt: string;
  channelUrl?: string;
}

export interface ManualWatchState {
  platform: Platform;
  tabId: number;
  checkedAt: string;
  active: boolean;
  channel?: ChannelCandidate;
}

export type PriorityMode = "ending_soonest" | "lowest_availability" | "priority_list_only";

// Visibility categories for the Drops list. A campaign in one of these states is
// only shown when its toggle is on; campaigns in none of them are always shown.
// Filter keys that gate farming: the engine's isEligible consults exactly these.
export type FarmingFilterKey = "notLinked" | "subscription";
// Filter keys that only decide what the Drops list shows. `excluded` is here
// deliberately: exclusion is already enforced for farming by excludedCampaignIds,
// so a farming key named `excluded` would have to mean "farm what I excluded".
export type DisplayFilterKey = "upcoming" | "expired" | "excluded" | "finished";
export type CampaignFilterKey = FarmingFilterKey | DisplayFilterKey;

export interface PlaybackTelemetry {
  platform: Platform;
  checkedAt: string;
  videoCount: number;
  mutedVideoCount: number;
  unmutedVideoCount: number;
  playingVideoCount: number;
  blockedPlaybackCount: number;
  documentHidden: boolean;
  adActive?: boolean;
  readyState?: number;
  currentTime?: number;
  duration?: number;
}

// How aggressively the managed watch tab is brought to focus while an ad is
// rolling, so the ad countdown (driven by requestAnimationFrame, which the
// browser throttles in background tabs/windows) keeps progressing.
export type AdFocusMode = "none" | "tab" | "window";

export type SupportedLocale = "en" | "es" | "fr" | "it" | "ru" | "de" | "zh_CN" | "hi" | "pt_BR" | "ar" | "tr";

export type LanguageOverride = "browser" | SupportedLocale;

// A category (Twitch/Kick call it a game/category) the user has picked to farm.
// We store the name alongside the id because a picked category may not appear in
// any current campaign, so the UI must render it without one. `id` matches the
// platform's category/game id; `name` is matched too as a fallback.
export interface CategorySelection {
  id: string;
  name: string;
  imageUrl?: string;
}

// How `categories` is interpreted. One list serves all three modes, so the
// user's selection survives every mode switch untouched:
// - "all": every category is farmable; the list is retained but inactive.
// - "include": only listed categories are farmed (an empty list farms nothing).
//   List order sets farming priority (see categoryPriorityScore).
// - "exclude": every category except the listed ones is farmed (an empty list
//   is equivalent to "all"). List order has no scheduling effect.
export type CategoryMode = "all" | "include" | "exclude";

export interface PlatformSettings {
  enabled: boolean;
  idleWatchlistChannels: string[];
  excludedChannels?: string[];
  categoryMode: CategoryMode;
  categories: CategorySelection[];
}

// Per-platform settings carry the claim toggles that only make sense on that
// platform, so the type never advertises a knob the platform ignores.
export interface TwitchPlatformSettings extends PlatformSettings {
  autoClaimChannelPoints: boolean;
  // Advanced: require DropsHighlightService_AvailableDrops to list a campaign
  // before farming it on a channel. Off by default — see #400 and
  // TwitchAdapterOptions.strictCampaignAvailability.
  strictCampaignAvailability: boolean;
}

export interface KickPlatformSettings extends PlatformSettings {
  autoClaimChallenges: boolean;
}

export interface PlatformSettingsByPlatform {
  twitch: TwitchPlatformSettings;
  kick: KickPlatformSettings;
}

export interface TwitchCompatibilitySettings {
  profile: string;
  heartbeatTransport: string;
  inventoryQueryVersion: string;
}

export interface KickCompatibilitySettings {
  profile: string;
  claimLinkHandling: string;
}

export interface CompatibilitySettings {
  twitch: TwitchCompatibilitySettings;
  kick: KickCompatibilitySettings;
}

// The universal settings contract the farming engine (packages/core) consumes.
// Host-agnostic: every field here does something during a scheduler tick on any
// host (extension or CLI). Host-only knobs (browser tab policy, popup UI) live on
// ExtensionSettings below, never here.
export interface EngineSettings {
  // There is deliberately no global `running` flag. Farming is active for a
  // platform when that platform is enabled, and nothing else — see
  // isFarmingActive(). A separate master switch used to drift out of step with
  // the per-platform flags (the popup rendered `running && enabled`, so a
  // cleared master hid still-enabled platforms and re-enabling one resurrected
  // the others), and autoStartDropFarming now expresses "do not resume on
  // restart" by clearing the per-platform flags instead.
  autoClaim: boolean;
  // Low-resource mode: farm by sending watch signals instead of opening a
  // video tab. Twitch uses API heartbeats; Kick uses a viewer WebSocket. Falls
  // back to a tab automatically if heartbeats stop earning.
  tablessMode: boolean;
  pauseOnManualWatch: boolean;
  notifyRewardEarned: boolean;
  notifyNoDropsLeft: boolean;
  autoStartDropFarming: boolean;
  idleWatchlistFallbackOnly: boolean;
  // Ranks Idle Watchlist and followed channels ahead of anonymous directory
  // channels when picking who to farm a campaign on (see chooseCampaignDecision
  // in the scheduler). Off reverts to viewer-count-only ordering and skips the
  // adapter's followed-channel lookup entirely, so a platform/account that never
  // wants the extra request can turn it off.
  preferKnownChannels: boolean;
  priorityMode: PriorityMode;
  platform: PlatformSettingsByPlatform;
  compatibility: CompatibilitySettings;
  campaignPriorities: Record<string, number>;
  excludedCampaignIds: string[];
  // Which campaigns are eligible to farm. Both default true; turning one off
  // skips that class in the scheduler's isEligible. Distinct from the popup's
  // dropsListFilter (display-only) so "don't farm" never implies "don't show".
  farmingEligibility: {
    // off: skip campaigns with no linked account (real on Kick, which accrues
    // watch progress before linking).
    farmUnlinkedCampaigns: boolean;
    // off: skip campaigns that require a subscription.
    farmSubscriptionCampaigns: boolean;
  };
  offlineRetryLimit: number;
  // Consecutive failed tabless heartbeats before falling back to a watch tab.
  tablessFallbackFailureLimit: number;
  pollIntervalMinutes: number;
  // Bounded post-claim handoff. After a reward is claimed, re-run discovery for
  // that platform on this cadence until the next eligible reward appears, then
  // transmit immediately instead of waiting for the fixed one-minute watch
  // alarm. Only platforms whose adapter sets supportsPostClaimHandoff use it.
  postClaimHandoff: boolean;
  postClaimHandoffIntervalSeconds: number;
  postClaimHandoffMaxSeconds: number;
  skipUnfinishableRewards: boolean;
  deadlineSafetyMarginMinutes: number;
  // Kill switch for the critical-failure detector and its popup prompt. On by
  // default; thresholds themselves are fixed constants in core.
  criticalFailurePromptEnabled: boolean;
}

// The browser extension's full settings schema: the engine contract plus the
// host-only knobs the engine never reads. Tab policy (mute / ad focus / auto-close
// / keep-unmuted) is supplied to the engine through the injected WatchTabPort and
// applyAdFocus, not read from settings by the engine; popup UI state (i18n, rate
// nudge) is pure host state.
export interface ExtensionSettings extends EngineSettings {
  // Number of committed Kick scheduler cycles using direct background fetches
  // required before an extension-owned fallback page is closed.
  kickPageContextRecoverySuccesses: number;
  muteFarmingTabs: boolean;
  keepFarmingVideosUnmuted: boolean;
  autoCloseFinishedDrops: boolean;
  // Which campaigns appear in the Drops list. Pure display prefs: the engine
  // never reads it, so it lives on ExtensionSettings, not the contract. The
  // farming axis (farmingEligibility) is entirely separate. showNotLinked/
  // showSubscription only ever hide a class that is NOT being farmed —
  // not-linked/subscription campaigns stay visible while farmed regardless of
  // these two flags (the visibility invariant, enforced in isCampaignVisible).
  dropsListFilter: {
    showUpcoming: boolean;     // default true
    showExpired: boolean;      // default false
    showFinished: boolean;     // default true
    showExcluded: boolean;     // default false
    showNotLinked: boolean;    // default true
    showSubscription: boolean; // default true
  };
  adFocusMode: AdFocusMode;
  languageOverride: LanguageOverride;
  rateNudgeStatus: RateNudgeStatus;
  githubStarNudgeStatus: GithubStarNudgeStatus;
  showTips: boolean;
  // Extension-only persistence policy. Normal farming activity is always
  // recorded; this opt-in adds lower-level technical diagnostics.
  diagnosticLogging: boolean;
  // Shows a Lurkloot button on twitch.tv/kick.com that opens the popup in a
  // draggable panel on the page. On by default, despite injecting UI into a
  // site the user did not ask us to change: the feature exists for people who
  // do not pin the extension and find the toolbar popup awkward to reach, and
  // gating it behind a toggle *inside that popup* would only ever reach the
  // people who already open it comfortably.
  showInPagePanel: boolean;
}

export interface SchedulerState {
  sessions: Record<Platform, WatchSession>;
  authHealth: Record<Platform, PlatformAuthHealth>;
  // Per-platform critical-failure detection. Persisted so the flag survives an
  // MV3 service-worker restart; its counters are reset on restore.
  criticalHealth?: Partial<Record<Platform, CriticalHealthState>>;
  managedWatchTabs?: Partial<Record<Platform, ManagedWatchTab>>;
  managedPageContextTabs?: Partial<Record<Platform, ManagedPageContextTab>>;
  manualWatch?: Partial<Record<Platform, ManualWatchState>>;
  // Platforms paused because the user manually closed their managed watch tab.
  // Cleared only by an explicit resume from the popup/CLI host.
  manualClosePause?: Partial<Record<Platform, ManualClosePauseState>>;
  // Last time each platform's account-level gamification endpoints were polled.
  // Persisted because adapters are rebuilt every tick, so an in-memory throttle
  // would never survive to the next one.
  gamification?: Partial<Record<Platform, { lastCheckedAt: string }>>;
  campaignSearchBackoffs?: Partial<Record<Platform, CampaignSearchBackoff>>;
  campaigns: Record<Platform, DropCampaign[]>;
  deadlineInfeasibleRewardIds?: Partial<Record<Platform, string[]>>;
  lastTickAt?: string;
  // ISO timestamp recorded once by the background on install; drives the
  // time-based rate/review nudge. Undefined means "unknown" (pre-feature state).
  installedAt?: string;
}

export interface CampaignSearchBackoff {
  campaignId: string;
  retryAt: string;
  fingerprint: string;
}

export interface WatchDecision {
  platform: Platform;
  action: "watch" | "fallback" | "idle";
  campaign?: DropCampaign;
  reward?: DropReward;
  channel?: ChannelCandidate;
  reason: string;
  reasonCode: WatchReasonCode;
}
