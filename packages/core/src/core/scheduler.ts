import type { PlatformAdapter } from "../platforms/adapter";
import type {
  ChannelCandidate,
  CampaignSearchBackoff,
  DropCampaign,
  DropReward,
  EngineSettings,
  Platform,
  PlaybackTelemetry,
  SchedulerState,
  WatchDecision,
  WatchReasonCode,
  WatchSession,
} from "@lurkloot/shared/models";
import { campaignPassesCategoryFilter, categoryPriorityScore } from "@lurkloot/shared/categories";
import { evaluateCampaignFarming, type CampaignFarmingEvaluation, type CampaignFarmingRejectionCode } from "@lurkloot/shared/campaignFarming";
import { campaignFarmable, campaignPassesFarmingEligibility, hasCampaignEnded } from "@lurkloot/shared/campaignFilters";
import {
  canClaimReward,
  isRewardAvailableToEarn,
  isRewardDeadlineFeasible,
  isSubscriptionReward,
  reconcileCampaignAfterClaims,
  rewardFeasibility,
} from "@lurkloot/shared/rewards";
import { autoClaimChallengesFor, autoClaimChannelPointsFor, isFarmingActive } from "@lurkloot/shared/settings";
import type { EngineEvent, EventEmitter, FarmingStopReason, PageContextCloseReason } from "@lurkloot/shared/events";
import { currentManagedPageContextTabs, currentManagedPageContextTabsRevision, forgetManagedPageContextTabs, hydrateManagedPageContextTabs, syncManagedTabBreakers, type SchedulerManagedPageContexts } from "./tabs";
import type { LogLevel } from "@lurkloot/shared/logging";
import { authHealthFromError, isSafeFetchError } from "./fetchError";
import { applyPlatformAuthHealth } from "./authHealth";
import type { CriticalHealthObservation } from "./criticalHealth";
import { isManagedTabBreakerOpen, observeCriticalHealth, recordManagedTabOpen } from "./criticalHealth";
import { isTimestampStale, PLAYBACK_TELEMETRY_MAX_AGE_MS } from "./timestamps";
import { heartbeatContextKey, validTablessHeartbeatCadence } from "./heartbeatCadence";
import { selectionAdapterFromDiscoverySnapshot, type DiscoverySnapshot } from "./discoverySnapshot";

const PLATFORMS: Platform[] = ["twitch", "kick"];
const MAX_PLATFORM_BACKOFF_MINUTES = 30;
export const MANUAL_WATCH_TTL_MS = 20_000;

// Kick's daily challenge window is hours long, so a ten-minute poll is far more
// than responsive enough while keeping the request count negligible.
const CHALLENGE_POLL_INTERVAL_MS = 10 * 60 * 1000;

function challengePollDue(state: SchedulerState, platform: Platform, now: number): boolean {
  const lastCheckedAt = state.gamification?.[platform]?.lastCheckedAt;
  if (!lastCheckedAt) return true;
  const last = Date.parse(lastCheckedAt);
  // A stamp in the future means the clock moved backwards (NTP correction, a
  // suspended VM). Treat it as stale rather than letting it suppress claiming
  // until the clock catches up.
  if (!Number.isFinite(last) || last > now) return true;
  return now - last >= CHALLENGE_POLL_INTERVAL_MS;
}

function activeReward(campaign: DropCampaign, settings: EngineSettings): DropReward | undefined {
  const earnable = campaign.rewards.filter((reward) =>
    reward.preconditionsMet !== false
    && isRewardAvailableToEarn(reward)
    && isRewardDeadlineFeasible(campaign, reward, settings.skipUnfinishableRewards, settings.deadlineSafetyMarginMinutes));
  return earnable.find((reward) => reward.status === "in_progress")
    ?? earnable.find((reward) => reward.status === "locked");
}

// Decides whether to farm this channel without a tab. Off unless tabless mode is
// enabled and the platform supports it; falls back to a tab (returns false) when
// we deliberately switched to a tab for this same channel, or when tabless
// heartbeats have been failing past the tabless fallback limit.
function chooseTablessWatch(
  previous: WatchSession,
  settings: EngineSettings,
  adapter: Pick<PlatformAdapter, "supportsTabless">,
  sameChannel: boolean,
): boolean {
  if (!settings.tablessMode || !adapter.supportsTabless) return false;
  if (sameChannel && previous.watchMode === "tab" && previous.tablessFallback) return false;
  if (sameChannel && previous.watchMode === "tabless" && (previous.heartbeatChecks ?? 0) >= settings.tablessFallbackFailureLimit) return false;
  return true;
}

function isEligible(campaign: DropCampaign, settings: EngineSettings): boolean {
  // campaignFarmable is the single shared definition of "is this campaign
  // farmable" (shared with the popup's isCampaignVisible, so display and
  // farming never drift apart). "Priority list only" is the one farming-
  // strategy layer on top of it: it farms exclusively the campaigns the user
  // explicitly reordered (campaignPriorities), which is deliberately NOT part
  // of campaignFarmable — a deprioritized campaign must stay farmable-shaped
  // for display so the user can still add it to the list.
  if (!campaignFarmable(campaign, settings)) return false;
  if (settings.priorityMode === "priority_list_only" && !isInPriorityList(campaign, settings)) return false;
  return true;
}

// Reason codes that mean the watch stopped accruing for an explainable reason
// rather than because the extension is broken. The detector treats them as
// evidence the platform is NOT in a continuous no-value episode, so a channel
// going offline or a target switch never counts towards the critical prompt.
const ACCRUAL_PRECONDITION_BREAK_REASONS = new Set<WatchReasonCode>([
  "channel_offline",
  "channel_mismatch",
  "watch_unhealthy",
  "manual_watch",
  "target_changed",
  "higher_priority_reward",
  "higher_priority_idle_watchlist",
]);

function preconditionBreakObservation(): CriticalHealthObservation {
  return { at: Date.now(), failing: false, progressed: false, preconditionBroke: true };
}

// The tick reached no conclusion about this platform. Not "healthy": it carries no
// watchedMinutes and no record, it only keeps the detector's clock and its
// time-based pruning running.
function neutralObservation(): CriticalHealthObservation {
  return { at: Date.now(), failing: false, progressed: false, preconditionBroke: false };
}

// A failing observation with a breadcrumb built from a SafeFetchError when the
// error is one, and from the plain message otherwise.
function apiErrorObservation(error: unknown): CriticalHealthObservation {
  const failure = isSafeFetchError(error) ? error.failure : undefined;
  return {
    at: Date.now(),
    failing: true,
    progressed: false,
    preconditionBroke: false,
    record: {
      kind: "api_error",
      code: failure?.kind ?? "unknown_error",
      ...(failure?.status === undefined ? {} : { status: failure.status }),
      detail: error instanceof Error ? error.message : String(error),
    },
  };
}

// The reward the session claims to be watching, if it is still present in the
// freshly-read campaign list. Returns undefined when nothing is being farmed,
// which the detector reads as "no watch session sustained".
function activeRewardFor(campaigns: readonly DropCampaign[], session: WatchSession): DropReward | undefined {
  if (session.status !== "watching" || !session.campaignId || !session.rewardId) return undefined;
  const campaign = campaigns.find((candidate) => candidate.id === session.campaignId);
  return campaign?.rewards.find((reward) => reward.id === session.rewardId);
}

function isInPriorityList(campaign: DropCampaign, settings: EngineSettings): boolean {
  return settings.campaignPriorities[campaign.id] != null;
}

function availabilityScore(campaign: DropCampaign): number {
  if (campaign.allowedChannels?.length) return campaign.allowedChannels.length;
  return Number.MAX_SAFE_INTEGER;
}

function endScore(campaign: DropCampaign): number {
  return campaign.endsAt ? Date.parse(campaign.endsAt) : Number.MAX_SAFE_INTEGER;
}

export function sortCampaigns(campaigns: DropCampaign[], settings: EngineSettings): DropCampaign[] {
  return [...campaigns].sort((left, right) => {
    const leftPriority = settings.campaignPriorities[left.id] ?? left.priority;
    const rightPriority = settings.campaignPriorities[right.id] ?? right.priority;
    if (leftPriority != null && rightPriority != null && leftPriority !== rightPriority) return rightPriority - leftPriority;
    if (leftPriority != null && rightPriority == null) return -1;
    if (rightPriority != null && leftPriority == null) return 1;

    const categoryOrder = categoryPriorityScore(left, settings.platform[left.platform])
      - categoryPriorityScore(right, settings.platform[right.platform]);
    if (categoryOrder !== 0) return categoryOrder;

    const normalizedLeftPriority = leftPriority ?? 0;
    const normalizedRightPriority = rightPriority ?? 0;
    if (normalizedLeftPriority !== normalizedRightPriority) return normalizedRightPriority - normalizedLeftPriority;

    if (settings.priorityMode === "lowest_availability") {
      const availability = availabilityScore(left) - availabilityScore(right);
      if (availability !== 0) return availability;
    }

    const ends = endScore(left) - endScore(right);
    if (ends !== 0) return ends;
    return left.name.localeCompare(right.name);
  });
}

// Ranks candidates the user has a relationship with above anonymous directory
// channels: an explicit Idle Watchlist entry first, then a followed channel.
// Purely a tie-break among channels that already qualify for the campaign, so it
// never changes *what* is farmed, only *where* it is farmed.
function channelPreferenceScore(
  candidate: ChannelCandidate,
  idleWatchlist: ReadonlySet<string>,
  followed: ReadonlySet<string>,
): number {
  const username = candidate.username.toLowerCase();
  if (idleWatchlist.has(username)) return 0;
  if (followed.has(username)) return 1;
  return 2;
}

export async function chooseCampaignDecision(
  platform: Platform,
  campaigns: DropCampaign[],
  settings: EngineSettings,
  adapter: Pick<PlatformAdapter, "listCandidateChannels" | "selectCandidateChannel" | "checkChannel" | "listFollowedChannels">,
  signal?: AbortSignal,
  reportMetrics?: (metrics: { campaignsChecked: number; candidatesChecked: number }) => void,
  // Lowercased usernames to pass over this tick because they just failed to earn
  // progress. Advisory, not an exclusion: a campaign whose only candidate is
  // skipped keeps it, since rotating to nothing is worse than a slow channel.
  skipChannels?: ReadonlySet<string>,
): Promise<WatchDecision> {
  const sorted = sortCampaigns(campaigns.filter((campaign) => isEligible(campaign, settings)), settings);
  const noCampaignReason = noEligibleCampaignReason(campaigns, settings);
  const waitingForSubscription = onlyWaitingSubscriptionCampaigns(campaigns, settings);
  const subscriptionOnly = onlySubscriptionCampaigns(campaigns, settings);
  let campaignsChecked = 0;
  let candidatesChecked = 0;
  const generalCandidatesByCategory = new Map<string, ChannelCandidate[]>();
  const idleWatchlist = settings.preferKnownChannels
    ? new Set(settings.platform[platform].idleWatchlistChannels
      .map((username) => username.trim().toLowerCase())
      .filter(Boolean))
    : new Set<string>();
  // Resolved at most once per decision (campaigns are looped, and the follow list
  // does not change between them) and only when a candidate list is long enough
  // for the preference to matter. A platform without the capability, or a failed
  // lookup, degrades to no preference rather than losing the tick. When the
  // setting is off, the adapter method is never called at all — not just
  // ignored — so a user who disables it pays no extra request for it.
  let followedChannels: ReadonlySet<string> | undefined;
  const resolveFollowedChannels = async (): Promise<ReadonlySet<string>> => {
    if (followedChannels) return followedChannels;
    followedChannels = new Set<string>();
    if (!settings.preferKnownChannels || !adapter.listFollowedChannels) return followedChannels;
    try {
      const logins = await adapter.listFollowedChannels({ signal });
      followedChannels = new Set(logins.map((login) => login.trim().toLowerCase()).filter(Boolean));
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    return followedChannels;
  };
  const finish = (decision: WatchDecision): WatchDecision => {
    reportMetrics?.({ campaignsChecked, candidatesChecked });
    return decision;
  };

  for (const campaign of sorted) {
    const reward = activeReward(campaign, settings);
    if (!reward) continue;
    campaignsChecked += 1;

    const excludedChannels = settings.platform[platform].excludedChannels ?? [];
    signal?.throwIfAborted();
    const reusableDirectoryKey = campaign.allowedChannels?.length
      ? undefined
      : campaign.categoryId ?? campaign.slug;
    let listedCandidates = reusableDirectoryKey
      ? generalCandidatesByCategory.get(reusableDirectoryKey)
      : undefined;
    if (!listedCandidates) {
      listedCandidates = await adapter.listCandidateChannels(campaign, { signal });
      if (reusableDirectoryKey && listedCandidates.length > 0) {
        generalCandidatesByCategory.set(reusableDirectoryKey, listedCandidates);
      }
    }
    const deduplicated = [...new Map(
      listedCandidates
        .filter((candidate) => !excludedChannels.includes(candidate.username.toLowerCase()))
        .map((candidate) => ({
          ...candidate,
          campaignId: campaign.id,
          categoryId: campaign.categoryId ?? candidate.categoryId,
          categoryName: campaign.gameName ?? candidate.categoryName,
        }))
        .map((candidate) => [candidate.username.toLowerCase(), candidate] as const),
    ).values()];
    // Channels that just stalled go last rather than being dropped. Validation
    // below can reject every other candidate — all offline, wrong category — and
    // a stalled channel still beats no channel, so they stay reachable as a last
    // resort instead of costing the campaign the whole tick.
    const skipped = skipChannels?.size
      ? deduplicated.filter((candidate) => skipChannels.has(candidate.username.toLowerCase()))
      : [];
    const preferred = skipped.length > 0
      ? deduplicated.filter((candidate) => !skipChannels?.has(candidate.username.toLowerCase()))
      : deduplicated;
    // Only worth asking the platform who the user follows when more than one
    // candidate could win the campaign.
    const followed = deduplicated.length > 1
      ? await resolveFollowedChannels()
      : followedChannels ?? new Set<string>();
    const rank = (list: ChannelCandidate[]) => list
      .sort((left, right) => {
        // ACL stays the strongest key: for an ACL-restricted campaign a followed
        // channel outside the allow list cannot earn the drop at all.
        if (left.isAclMatch !== right.isAclMatch) return left.isAclMatch ? -1 : 1;
        const preference = channelPreferenceScore(left, idleWatchlist, followed)
          - channelPreferenceScore(right, idleWatchlist, followed);
        if (preference !== 0) return preference;
        return (right.viewerCount ?? 0) - (left.viewerCount ?? 0);
      });

    const countCheck = () => {
      candidatesChecked += 1;
    };
    // Stalled channels are only validated once everything else has failed, so
    // the common case still costs exactly one selection pass.
    const channel = await firstValidCandidate(rank(preferred), campaign, adapter, signal, countCheck)
      ?? (skipped.length > 0
        ? await firstValidCandidate(rank(skipped), campaign, adapter, signal, countCheck)
        : undefined);
    if (channel) {
      return finish({
        platform,
        action: "watch",
        campaign,
        reward,
        channel,
        reason: "Eligible campaign selected",
        reasonCode: "eligible_campaign",
      });
    }
  }

  if (subscriptionOnly) {
    return finish({
      platform,
      action: "idle",
      reason: noCampaignReason,
      reasonCode: "campaign_ineligible",
    });
  }

  const fallbackCandidates = settings.platform[platform].idleWatchlistChannels
    .map((username) => username.trim().toLowerCase())
    .filter(Boolean)
    .map((username) => fallbackChannel(platform, username));
  const fallback = await firstValidCandidate(fallbackCandidates, undefined, adapter, signal, () => {
    candidatesChecked += 1;
  });

  if (fallback) {
    return finish({
      platform,
      action: "fallback",
      channel: fallback,
      reason: `${noCampaignReason}; Idle Watchlist channel selected`,
      reasonCode: "idle_watchlist_selected",
    });
  }

  return finish({
    platform,
    action: "idle",
    reason: `${noCampaignReason} and no Idle Watchlist channels`,
    reasonCode: waitingForSubscription ? "campaign_ineligible" : "no_eligible_channel",
  });
}

function noEligibleCampaignReason(campaigns: DropCampaign[], settings: EngineSettings): string {
  if (campaigns.length === 0) return "No campaigns discovered";
  const notExcluded = campaigns.filter((campaign) => !settings.excludedCampaignIds.includes(campaign.id));
  if (notExcluded.length === 0) return "All campaigns are excluded";
  if (notExcluded.every((campaign) => campaign.status === "upcoming" || campaign.eligibility === "upcoming")) {
    return "Only upcoming campaigns are available";
  }
  if (notExcluded.every((campaign) => campaign.status === "expired" || campaign.eligibility === "expired")) {
    return "Only expired campaigns are available";
  }
  if (notExcluded.every((campaign) => campaign.status === "completed" || campaign.eligibility === "completed")) {
    return "All campaigns are completed";
  }
  if (onlyWaitingSubscriptionCampaigns(campaigns, settings)) {
    return "Waiting for a qualifying subscription";
  }
  if (notExcluded.every((campaign) => campaign.eligibility === "no_rewards" || campaign.rewards.length === 0)) {
    return "Campaigns have no time-based rewards";
  }
  // Placed before the account-linked reason so a user who turned
  // farmUnlinkedCampaigns off is told about their eligibility setting rather
  // than about the link state that setting keys off. With the flag on, unlinked
  // campaigns pass this predicate and the more specific reason below still wins.
  if (notExcluded.every((campaign) => !campaignPassesFarmingEligibility(campaign, settings.farmingEligibility))) {
    return "All campaigns are skipped by your farming eligibility settings";
  }
  if (notExcluded.every((campaign) => campaign.accountLinked === false || campaign.eligibility === "account_not_linked")) {
    return "Campaign accounts are not linked";
  }
  if (notExcluded.every((campaign) => !campaignPassesCategoryFilter(campaign, settings.platform[campaign.platform]))) {
    return "No campaigns match the categories filter";
  }
  if (settings.priorityMode === "priority_list_only" && !notExcluded.some((campaign) => isInPriorityList(campaign, settings))) {
    return "No prioritized campaigns are eligible";
  }
  const relevantCampaigns = notExcluded.filter((campaign) => campaign.status === "active" && !hasCampaignEnded(campaign));
  if (relevantCampaigns.length > 0 && relevantCampaigns.every((campaign) =>
    campaign.rewards.some((reward) => reward.preconditionsMet !== false && isRewardAvailableToEarn(reward))
    && !campaign.rewards.some((reward) =>
      reward.preconditionsMet !== false
      && isRewardAvailableToEarn(reward)
      && isRewardDeadlineFeasible(campaign, reward, settings.skipUnfinishableRewards, settings.deadlineSafetyMarginMinutes)))) {
    return "Available rewards cannot be completed before their deadline";
  }
  return "No eligible campaigns";
}

function onlyWaitingSubscriptionCampaigns(campaigns: DropCampaign[], settings: EngineSettings): boolean {
  const notExcluded = campaigns.filter((campaign) => !settings.excludedCampaignIds.includes(campaign.id));
  return notExcluded.length > 0 && notExcluded.every((campaign) =>
    campaign.eligibility === "waiting_for_subscription"
    && campaign.rewards.length > 0
    && campaign.rewards.every(isSubscriptionReward));
}

function onlySubscriptionCampaigns(campaigns: DropCampaign[], settings: EngineSettings): boolean {
  const notExcluded = campaigns.filter((campaign) => !settings.excludedCampaignIds.includes(campaign.id));
  return notExcluded.length > 0 && notExcluded.every((campaign) => {
    const remainingRewards = campaign.rewards.filter((reward) =>
      reward.status !== "claimed" && reward.status !== "claimable");
    return remainingRewards.length > 0 && remainingRewards.every(isSubscriptionReward);
  });
}

async function firstValidCandidate(
  candidates: ChannelCandidate[],
  campaign: DropCampaign | undefined,
  adapter: Pick<PlatformAdapter, "selectCandidateChannel" | "checkChannel">,
  signal?: AbortSignal,
  onCheck?: () => void,
): Promise<ChannelCandidate | undefined> {
  if (adapter.selectCandidateChannel) {
    const selection = await adapter.selectCandidateChannel(candidates, campaign, { signal });
    for (let index = 0; index < selection.checked; index += 1) onCheck?.();
    return selection.channel;
  }
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    onCheck?.();
    const check = await adapter.checkChannel(candidate, { campaign, signal });
    if (check.live && check.categoryMatches && check.campaignMatches !== false) {
      return channelFromCheck(candidate, check);
    }
  }
  return undefined;
}

function channelFromCheck(candidate: ChannelCandidate, check: { live: boolean; candidate: ChannelCandidate }): ChannelCandidate {
  return {
    ...candidate,
    live: check.live,
    displayName: check.candidate.displayName ?? candidate.displayName,
    categoryId: check.candidate.categoryId ?? candidate.categoryId,
    categoryName: check.candidate.categoryName ?? candidate.categoryName,
    viewerCount: check.candidate.viewerCount ?? candidate.viewerCount,
    title: check.candidate.title ?? candidate.title,
    profileImageUrl: check.candidate.profileImageUrl ?? candidate.profileImageUrl,
    broadcastId: check.candidate.broadcastId ?? candidate.broadcastId,
    channelId: check.candidate.channelId ?? candidate.channelId,
  };
}

function fallbackChannel(platform: Platform, username: string): ChannelCandidate {
  const host = platform === "twitch" ? "https://www.twitch.tv" : "https://kick.com";
  return {
    platform,
    username,
    displayName: username,
    url: `${host}/${username}`,
  };
}

function sessionForDecision(
  decision: WatchDecision,
  previous: WatchSession,
  keepStatus?: { keep: boolean; playbackChecks: number },
): WatchSession {
  if (decision.action === "idle") {
    return {
      ...previous,
      status: "idle",
      channel: undefined,
      campaignId: undefined,
      rewardId: undefined,
      tabId: undefined,
      tabManagedByExtension: undefined,
      message: decision.reason,
      reasonCode: decision.reasonCode,
      playback: undefined,
      playbackChecks: 0,
      watchTabOpenedAt: undefined,
      watchMode: undefined,
      tablessFallback: undefined,
      heartbeatChecks: 0,
      lastHeartbeatAt: undefined,
      lastHeartbeatOk: undefined,
      tablessHeartbeat: undefined,
    };
  }

  const sameChannel = previous.channel?.url === decision.channel?.url && previous.status === "watching";
  const keepPlayback = sameChannel && keepStatus?.keep === true;
  const next: WatchSession = {
    ...previous,
    status: "watching",
    channel: decision.channel,
    campaignId: decision.campaign?.id,
    rewardId: decision.reward?.id,
    startedAt: keepPlayback ? previous.startedAt : new Date().toISOString(),
    message: decision.reason,
    reasonCode: decision.reasonCode,
    playback: keepPlayback ? previous.playback : undefined,
    playbackChecks: keepStatus?.playbackChecks ?? 0,
  };
  return retainTablessHeartbeat(previous, next);
}

function retainTablessHeartbeat(previous: WatchSession, next: WatchSession): WatchSession {
  const previousContextKey = heartbeatContextKey(previous);
  const nextContextKey = heartbeatContextKey(next);
  if (
    previous.status !== "watching"
    || next.status !== "watching"
    || previousContextKey === undefined
    || previousContextKey !== nextContextKey
    || validTablessHeartbeatCadence(previous) === undefined
  ) {
    return { ...next, tablessHeartbeat: undefined };
  }
  return next;
}

export interface WatchRetention {
  keep: boolean;
  offlineChecks: number;
  playbackChecks: number;
  noProgressChecks?: number;
  lastWatchedMinutes?: number;
  reason: string;
  reasonCode: WatchReasonCode;
  channel?: ChannelCandidate;
}

export interface SnapshotSelectionResult {
  decision: WatchDecision;
  retention: WatchRetention;
  campaignsChecked: number;
  candidatesChecked: number;
  fastPath: boolean;
  backoff?: CampaignSearchBackoff;
  backoffSkippedMs?: number;
}

export const TWITCH_NEGATIVE_SEARCH_BACKOFF_MS = 5 * 60 * 1000;

/** Pure provider-I/O-free selection when paired with a committed snapshot adapter. */
async function selectWatchTarget(
  platform: Platform,
  previous: WatchSession,
  campaigns: DropCampaign[],
  settings: EngineSettings,
  adapter: Pick<PlatformAdapter, "listCandidateChannels" | "selectCandidateChannel" | "checkChannel" | "listFollowedChannels">,
  signal?: AbortSignal,
): Promise<SnapshotSelectionResult> {
  const currentWatch = await evaluatePreferredCurrentWatch(previous, campaigns, settings, adapter, signal);
  let decision: WatchDecision;
  let retention: WatchRetention;
  let campaignsChecked = 0;
  let candidatesChecked = 0;
  if (currentWatch?.keep.keep) {
    decision = currentWatch.decision;
    retention = currentWatch.keep;
    candidatesChecked = 1;
  } else {
    const stalled = currentWatch?.keep.reasonCode === "no_progress" && previous.channel
      ? new Set([previous.channel.username.toLowerCase()])
      : undefined;
    decision = await chooseCampaignDecision(
      platform,
      campaigns,
      settings,
      adapter,
      signal,
      (metrics) => {
        campaignsChecked = metrics.campaignsChecked;
        candidatesChecked = metrics.candidatesChecked;
      },
      stalled,
    );
    retention = currentWatch?.keep
      ?? await shouldKeepWatching(previous, decision, campaigns, settings, adapter, signal);
  }
  if (retention.keep && previous.channel) {
    decision = {
      platform,
      action: previous.campaignId ? "watch" : "fallback",
      campaign: campaigns.find((campaign) => campaign.id === previous.campaignId),
      reward: campaigns
        .find((campaign) => campaign.id === previous.campaignId)
        ?.rewards.find((reward) => reward.id === previous.rewardId),
      channel: retention.channel ?? previous.channel,
      reason: retention.reason,
      reasonCode: retention.reasonCode,
    };
  } else if (previous.status === "watching" && previous.channel && retention.reason !== "No existing watch session") {
    decision = { ...decision, reason: retention.reason, reasonCode: retention.reasonCode };
  }
  return { decision, retention, campaignsChecked, candidatesChecked, fastPath: currentWatch?.keep.keep === true };
}

export interface SnapshotSelectionInput {
  snapshot: DiscoverySnapshot;
  previous: WatchSession;
  previousCampaigns: DropCampaign[];
  settings: EngineSettings;
  signal?: AbortSignal;
  previousBackoff?: CampaignSearchBackoff;
  bypassBackoff?: boolean;
}

function stableHash(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function campaignSearchFingerprint(
  campaign: DropCampaign,
  settings: EngineSettings,
): string {
  return stableHash({
    campaign,
    settings: {
      campaignPriorities: settings.campaignPriorities,
      excludedCampaignIds: settings.excludedCampaignIds,
      priorityMode: settings.priorityMode,
      farmingEligibility: settings.farmingEligibility,
      platform: settings.platform.twitch,
    },
  });
}

export function campaignSearchBackoffApplies(
  campaign: DropCampaign,
  settings: EngineSettings,
  session: WatchSession,
  backoff: CampaignSearchBackoff | undefined,
  bypass = false,
  currentCampaign?: DropCampaign,
): boolean {
  return campaign.platform === "twitch"
    && !bypass
    && session.status === "watching"
    && isSessionHealthy(session)
    && (session.noProgressChecks ?? 0) < settings.offlineRetryLimit
    && currentCampaign !== undefined
    && isEligible(currentCampaign, settings)
    && activeReward(currentCampaign, settings)?.id === session.rewardId
    && backoff?.campaignId === campaign.id
    && backoff.fingerprint === campaignSearchFingerprint(campaign, settings)
    && Date.parse(backoff.retryAt) > Date.now();
}

function authoritativeUnavailableCampaign(
  snapshot: DiscoverySnapshot,
  campaigns: DropCampaign[],
  previous: WatchSession,
  settings: EngineSettings,
): DropCampaign | undefined {
  if (snapshot.platform !== "twitch" || previous.status !== "watching" || !isSessionHealthy(previous)) return undefined;
  const eligible = sortCampaigns(campaigns.filter((campaign) => isEligible(campaign, settings)), settings);
  const currentIndex = eligible.findIndex((campaign) => campaign.id === previous.campaignId);
  if (currentIndex <= 0) return undefined;
  return eligible.slice(0, currentIndex).find((campaign) => {
    const observation = snapshot.campaigns.find(({ campaign: candidate }) => candidate.id === campaign.id);
    return observation !== undefined
      && observation.candidates.length > 0
      && observation.candidates.every((candidate) => !candidate.live || !candidate.categoryMatches || candidate.eligible === false);
  });
}

export async function selectWatchTargetFromSnapshot({
  snapshot,
  previous,
  previousCampaigns,
  settings,
  signal,
  previousBackoff,
  bypassBackoff = false,
}: SnapshotSelectionInput): Promise<SnapshotSelectionResult> {
  const campaigns = preserveClaimedRewards(
    snapshot.campaigns.map(({ campaign }) => campaign),
    previousCampaigns,
  );
  const backedOffCampaign = previousBackoff
    ? snapshot.campaigns.find(({ campaign }) => campaign.id === previousBackoff.campaignId)?.campaign
    : undefined;
  const currentCampaign = snapshot.campaigns.find(({ campaign }) => campaign.id === previous.campaignId)?.campaign;
  const retryAt = previousBackoff ? Date.parse(previousBackoff.retryAt) : Number.NaN;
  const mayReuseBackoff = snapshot.platform === "twitch"
    && !bypassBackoff
    && backedOffCampaign !== undefined
    && campaignSearchBackoffApplies(backedOffCampaign, settings, previous, previousBackoff, bypassBackoff, currentCampaign);
  const selectionCampaigns = mayReuseBackoff
    ? campaigns.filter((campaign) => campaign.id !== previousBackoff?.campaignId)
    : campaigns;
  const result = await selectWatchTarget(
    snapshot.platform,
    previous,
    selectionCampaigns,
    settings,
    selectionAdapterFromDiscoverySnapshot(snapshot, previous),
    signal,
  );
  if (mayReuseBackoff) {
    return { ...result, backoff: previousBackoff, backoffSkippedMs: retryAt - Date.now() };
  }
  const unavailable = authoritativeUnavailableCampaign(snapshot, campaigns, previous, settings);
  if (!unavailable || result.decision.campaign?.id !== previous.campaignId) return result;
  return {
    ...result,
    backoff: {
      campaignId: unavailable.id,
      retryAt: new Date(Date.now() + TWITCH_NEGATIVE_SEARCH_BACKOFF_MS).toISOString(),
      fingerprint: campaignSearchFingerprint(
        snapshot.campaigns.find(({ campaign }) => campaign.id === unavailable.id)?.campaign ?? unavailable,
        settings,
      ),
    },
  };
}

function retainHealthyWatchOnAmbiguousDiscovery(
  previous: WatchSession,
  campaigns: DropCampaign[],
): SnapshotSelectionResult | undefined {
  if (previous.status !== "watching" || !previous.channel || !isSessionHealthy(previous)) return undefined;
  const campaign = campaigns.find((candidate) => candidate.id === previous.campaignId);
  const reward = campaign?.rewards.find((candidate) => candidate.id === previous.rewardId);
  const decision: WatchDecision = {
    platform: previous.platform,
    action: previous.campaignId ? "watch" : "fallback",
    campaign,
    reward,
    channel: previous.channel,
    reason: "Keeping healthy current watch while discovery is incomplete",
    reasonCode: "keeping_current_watch",
  };
  return {
    decision,
    retention: {
      keep: true,
      offlineChecks: previous.offlineChecks,
      playbackChecks: previous.playbackChecks ?? 0,
      noProgressChecks: previous.noProgressChecks,
      lastWatchedMinutes: previous.lastWatchedMinutes,
      channel: previous.channel,
      reason: decision.reason,
      reasonCode: decision.reasonCode,
    },
    campaignsChecked: 0,
    candidatesChecked: 0,
    fastPath: true,
  };
}

export interface SchedulerTickResult {
  state: SchedulerState;
  decisions: WatchDecision[];
  events: EngineEvent[];
}

// Closing managed page-context tabs is browser-bound, so it is injected. The
// default forgets them from state only (no tab API) — enough for headless and
// test runs; the extension injects the browser-backed variant that also removes
// the real tabs.
export type StopPageContextTabs = (
  contexts: SchedulerManagedPageContexts,
  options?: { platforms?: Platform[]; reason?: PageContextCloseReason; emit?: EventEmitter },
) => Promise<SchedulerManagedPageContexts> | SchedulerManagedPageContexts;

export interface SchedulerTickOptions {
  platforms?: Platform[];
  stopPageContextTabs?: StopPageContextTabs;
  waitingClaimRewardIds?: Partial<Record<Platform, Set<string>>>;
  emit?: EventEmitter;
  signal?: AbortSignal;
  // Mutable, instance-owned diagnostic cache. The background controller keeps
  // it in memory so unchanged minute ticks stay quiet, while a worker restart
  // naturally emits a fresh snapshot for the next exported diagnostic log.
  campaignEvaluationFingerprints?: Partial<Record<Platform, string>>;
  discovery?: Partial<Record<Platform, {
    campaigns: DropCampaign[];
    complete: boolean;
  }>>;
  selections?: Partial<Record<Platform, SnapshotSelectionResult>>;
  selectionIsCurrent?: Partial<Record<Platform, () => boolean>>;
}

const CAMPAIGN_REJECTION_LABELS: Record<CampaignFarmingRejectionCode, string> = {
  excluded: "excluded",
  upcoming: "upcoming",
  expired: "expired",
  completed: "completed",
  unlinked_campaigns_disabled: "unlinked campaigns disabled",
  twitch_link_required: "Twitch account linking required",
  subscription_campaigns_disabled: "subscription campaigns disabled",
  category_filtered: "category filtered",
  priority_not_selected: "not in priority list",
  no_rewards: "no rewards",
  no_unclaimed_rewards: "no unclaimed rewards",
  reward_prerequisites_unmet: "reward prerequisites unmet",
  reward_not_started: "reward not started",
  reward_window_ended: "reward window ended",
  insufficient_time: "insufficient time",
  subscription_required: "subscription required",
  action_required: "action required",
  no_farmable_reward: "no currently farmable reward",
};

function campaignEvaluationFingerprint(
  evaluations: ReadonlyArray<{ campaign: DropCampaign; evaluation: CampaignFarmingEvaluation }>,
): string {
  return evaluations
    .map(({ campaign, evaluation }) => evaluation.farmable
      ? `${campaign.id}:farmable`
      : [campaign.id, evaluation.code, evaluation.rewardId, evaluation.deadline, evaluation.remainingMinutes, evaluation.marginMinutes].join(":"))
    .sort()
    .join("|");
}

function emitCampaignEvaluationDiagnostics(
  emit: EventEmitter,
  platform: Platform,
  campaigns: readonly DropCampaign[],
  settings: EngineSettings,
  fingerprints: Partial<Record<Platform, string>> | undefined,
): void {
  const evaluations = campaigns.map((campaign) => ({
    campaign,
    evaluation: evaluateCampaignFarming(campaign, settings, { includePriorityMode: true }),
  }));
  const fingerprint = campaignEvaluationFingerprint(evaluations);
  if (fingerprints?.[platform] === fingerprint) return;
  if (fingerprints) fingerprints[platform] = fingerprint;

  const counts = new Map<"farmable" | CampaignFarmingRejectionCode, number>();
  for (const { evaluation } of evaluations) {
    const key = evaluation.farmable ? "farmable" : evaluation.code;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [`${campaigns.length} discovered`];
  const farmable = counts.get("farmable") ?? 0;
  parts.push(`${farmable} farmable`);
  for (const [code, label] of Object.entries(CAMPAIGN_REJECTION_LABELS) as Array<[CampaignFarmingRejectionCode, string]>) {
    const count = counts.get(code) ?? 0;
    if (count > 0) parts.push(`${count} ${label}`);
  }
  emitDiagnostic(emit, platform, "debug", `Campaign farming evaluation: ${parts.join(", ")}`);

  for (const { campaign, evaluation } of evaluations) {
    if (evaluation.farmable || ["upcoming", "expired", "completed"].includes(evaluation.code)) continue;
    const reward = evaluation.rewardId
      ? `, reward=${evaluation.rewardName ?? evaluation.rewardId} (${evaluation.rewardId})`
      : "";
    const deadline = evaluation.deadline
      ? `, deadline=${evaluation.deadline}, remaining=${evaluation.remainingMinutes}m, available=${evaluation.availableMinutes}m, margin=${evaluation.marginMinutes}m`
      : "";
    emitDiagnostic(
      emit,
      platform,
      "debug",
      `Campaign rejected: ${campaign.name} (${campaign.id}), reason=${evaluation.code}${reward}${deadline}`,
    );
  }
}

export async function runSchedulerTick(
  state: SchedulerState,
  settings: EngineSettings,
  adapters: Record<Platform, PlatformAdapter>,
  options: SchedulerTickOptions = {},
): Promise<SchedulerTickResult> {
  options.signal?.throwIfAborted();
  const stopPageContextTabs = options.stopPageContextTabs ?? forgetManagedPageContextTabs;
  const platforms = options.platforms ?? PLATFORMS;
  const pageContextRevision = currentManagedPageContextTabsRevision();
  hydrateManagedPageContextTabs(state.managedPageContextTabs ?? {}, platforms, pageContextRevision);
  let nextState: SchedulerState = {
    ...state,
    campaigns: { ...state.campaigns },
    sessions: { ...state.sessions },
    managedWatchTabs: { ...state.managedWatchTabs },
    managedPageContextTabs: { ...state.managedPageContextTabs },
    deadlineInfeasibleRewardIds: { ...state.deadlineInfeasibleRewardIds },
    lastTickAt: new Date().toISOString(),
  };
  const decisions: WatchDecision[] = [];
  const events: EngineEvent[] = [];
  const emit: EventEmitter = (event) => {
    events.push(event);
    options.emit?.(event);
  };

  async function suspendPlatformForAuthentication(
    platform: Platform,
    previous: WatchSession,
    adapter: PlatformAdapter,
  ): Promise<void> {
    try {
      await adapter.stopWatchTab?.(previous, { signal: options.signal });
    } catch (error) {
      emitDiagnostic(emit, platform, "warn", error instanceof Error ? error.message : "Could not stop watch tab");
    }
    nextState.sessions[platform] = {
      ...previous,
      status: "paused",
      channel: undefined,
      campaignId: undefined,
      rewardId: undefined,
      tabId: undefined,
      tabManagedByExtension: undefined,
      playback: undefined,
      playbackChecks: 0,
      retryAfter: undefined,
      message: "Authentication unavailable",
      reasonCode: "authentication_unhealthy",
      watchMode: undefined,
      tablessFallback: undefined,
      heartbeatChecks: 0,
      lastHeartbeatAt: undefined,
      lastHeartbeatOk: undefined,
      tablessHeartbeat: undefined,
    };
    nextState.campaigns[platform] = [];
    nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
    try {
      nextState.managedPageContextTabs = await stopPageContextTabs(nextState.managedPageContextTabs ?? {}, {
        platforms: [platform],
        reason: "authentication_unhealthy",
        emit,
      });
    } catch (error) {
      emitDiagnostic(emit, platform, "warn", error instanceof Error ? error.message : "Could not stop page context");
      nextState.managedPageContextTabs = forgetManagedPageContextTabs(nextState.managedPageContextTabs ?? {}, {
        platforms: [platform],
        reason: "authentication_unhealthy",
        emit,
      });
    }
  }

  // Page-context creation lives several layers deep in tabs.ts with no access to
  // scheduler state, so the breaker flags are mirrored into a module registry
  // once per tick — and again after every observation, since an observation can
  // release the breaker.
  //
  // When the kill switch is off the registry is cleared instead of mirrored.
  // Otherwise a breaker latched before the switch was flipped would keep blocking
  // page-context creation forever: observations no longer run to release it, and
  // the popup no longer renders the panel that would dismiss it.
  syncManagedTabBreakers(
    settings.criticalFailurePromptEnabled ? nextState : {},
    platforms,
  );

  for (const platform of platforms) {
    options.signal?.throwIfAborted();
    const previous = nextState.sessions[platform];
    const platformSettings = settings.platform[platform];
    const adapter = adapters[platform];
    // Seeded neutral so every exit — including the paths that never reach the
    // farming work — still applies a truthful observation. That matters because
    // observeCriticalHealth is what prunes the tab-churn window and releases the
    // managed-tab breaker: a platform that only ever takes an early exit (signed
    // out, disabled) must still be able to recover from an open breaker.
    // Overwritten below as the tick learns what actually happened.
    let observation: CriticalHealthObservation = neutralObservation();
    // Runs in the `finally` below, so every exit — early `continue`, thrown
    // error, or normal completion — reaches the detector exactly once.
    const applyObservation = (): void => {
      if (!settings.criticalFailurePromptEnabled) return;
      const transition = observeCriticalHealth(nextState, platform, observation);
      nextState = transition.state;
      syncManagedTabBreakers(nextState, [platform]);
      // This runs inside a `finally`, so a throwing listener here would replace
      // the in-flight error and abort the remaining platforms. Health reporting
      // is never worth that.
      if (transition.event) {
        try {
          emit(transition.event);
        } catch {
          // Ignored on purpose: see above.
        }
      }
    };

    try {
      // The user closed the watch tab LurkLoot opened. That is an explicit stop
      // gesture, so stay paused until they resume from the popup rather than
      // recovering on this (or any later) tick. Checked before every other gate
      // so nothing re-opens a tab behind the user's back.
      if (nextState.manualClosePause?.[platform]) {
        await adapter.stopWatchTab?.(previous, { signal: options.signal });
        nextState.sessions[platform] = {
          ...previous,
          status: "paused",
          channel: undefined,
          campaignId: undefined,
          rewardId: undefined,
          tabId: undefined,
          tabManagedByExtension: undefined,
          playback: undefined,
          playbackChecks: 0,
          errorChecks: 0,
          retryAfter: undefined,
          message: "Farming tab closed",
          reasonCode: "manual_tab_close",
          watchMode: undefined,
          tablessFallback: undefined,
          heartbeatChecks: 0,
          lastHeartbeatAt: undefined,
          lastHeartbeatOk: undefined,
          tablessHeartbeat: undefined,
        };
        nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
        nextState.managedPageContextTabs = await stopPageContextTabs(nextState.managedPageContextTabs ?? {}, { platforms: [platform], reason: "manual_tab_close", emit });
        emitDiagnostic(emit, platform, "info", "Farming tab was closed manually; staying paused until the user resumes");
        continue;
      }
      if (settings.pauseOnManualWatch && hasRecentManualWatch(nextState, platform)) {
        await adapter.stopWatchTab?.(previous, { signal: options.signal });
        nextState.sessions[platform] = {
          ...previous,
          status: "paused",
          channel: undefined,
          campaignId: undefined,
          rewardId: undefined,
          tabId: undefined,
          tabManagedByExtension: undefined,
          playback: undefined,
          playbackChecks: 0,
          errorChecks: 0,
          retryAfter: undefined,
          message: "Manual watch detected",
          reasonCode: "manual_watch",
          watchMode: undefined,
          tablessFallback: undefined,
          heartbeatChecks: 0,
          lastHeartbeatAt: undefined,
          lastHeartbeatOk: undefined,
          tablessHeartbeat: undefined,
        };
        nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
        nextState.managedPageContextTabs = await stopPageContextTabs(nextState.managedPageContextTabs ?? {}, { platforms: [platform], reason: "manual_watch", emit });
        observation = preconditionBreakObservation();
        emitDiagnostic(emit, platform, "info", "Manual watch detected; pausing farming for this platform");
        continue;
      }
      if (!platformSettings.enabled) {
        // With no master switch, "automation is off" simply means no platform is
        // enabled; this one being off while the other still farms stays a
        // platform-scoped stop. Both reason codes remain meaningful.
        const automationOff = !isFarmingActive(settings);
        await adapter.stopWatchTab?.(previous, { signal: options.signal });
        nextState.campaigns[platform] = [];
        nextState.sessions[platform] = {
          ...previous,
          status: "paused",
          channel: undefined,
          campaignId: undefined,
          rewardId: undefined,
          tabId: undefined,
          tabManagedByExtension: undefined,
          playback: undefined,
          playbackChecks: 0,
          errorChecks: 0,
          retryAfter: undefined,
          message: "Automation disabled",
          reasonCode: automationOff ? "automation_disabled" : "platform_disabled",
          watchMode: undefined,
          tablessFallback: undefined,
          heartbeatChecks: 0,
          lastHeartbeatAt: undefined,
          lastHeartbeatOk: undefined,
          tablessHeartbeat: undefined,
        };
        nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
        nextState.managedPageContextTabs = await stopPageContextTabs(nextState.managedPageContextTabs ?? {}, {
          platforms: [platform],
          reason: automationOff ? "automation_disabled" : "platform_disabled",
          emit,
        });
        emitDiagnostic(emit, platform, "info", automationOff ? "Automation disabled" : "Platform disabled");
        continue;
      }

      if (nextState.authHealth[platform].status !== "healthy") {
        await suspendPlatformForAuthentication(platform, previous, adapter);
        continue;
      }

      // Account-level, so it runs whether or not this platform ends up watching:
      // the watch-time threshold is usually met by a session that has already
      // stopped. Failures are swallowed — gamification is strictly additive to
      // farming and must never fail the tick or trip the error backoff.
      if (autoClaimChallengesFor(settings, platform) && adapter.claimChallenges && challengePollDue(nextState, platform, Date.now())) {
        // Stamped on attempt, not on success, so a persistently failing endpoint
        // is retried on the next interval instead of on every tick.
        nextState.gamification = {
          ...nextState.gamification,
          [platform]: { lastCheckedAt: new Date().toISOString() },
        };
        try {
          for (const challenge of await adapter.claimChallenges({ signal: options.signal })) {
            emit({
              category: "activity",
              code: "challenge_claimed",
              level: "info",
              platform,
              data: { challengeId: challenge.id, rarity: challenge.rarity, recurrence: challenge.recurrence },
            });
          }
        } catch (error) {
          options.signal?.throwIfAborted();
          if (authHealthFromError(error)) throw error;
          emitDiagnostic(emit, platform, "warn", error instanceof Error ? error.message : "Challenge claim failed");
        }
      }

      if (isInBackoff(previous)) {
        nextState.sessions[platform] = {
          ...previous,
          status: "error",
          lastCheckedAt: new Date().toISOString(),
          message: `Waiting until ${previous.retryAfter} before retrying after platform errors`,
          reasonCode: "platform_backoff",
          tablessHeartbeat: undefined,
        };
        observation = {
          at: Date.now(),
          failing: true,
          progressed: false,
          preconditionBroke: false,
          record: { kind: "api_error", code: "platform_backoff" },
        };
        emitDiagnostic(emit, platform, "warn", nextState.sessions[platform].message ?? "Platform retry deferred");
        continue;
      }

      let campaigns: DropCampaign[];
      let discoveryFailed = false;
      const committedDiscovery = options.discovery?.[platform];
      if (committedDiscovery) {
        campaigns = preserveClaimedRewards(committedDiscovery.campaigns, state.campaigns[platform]);
        discoveryFailed = !committedDiscovery.complete;
      } else try {
        const refreshStartedAt = Date.now();
        campaigns = await adapter.refreshCampaigns(previous, { signal: options.signal });
        emitDiagnostic(
          emit,
          platform,
          "debug",
          `Campaign refresh finished in ${Date.now() - refreshStartedAt}ms (${countLabel(campaigns.length, "campaign")})`,
        );
        campaigns = preserveClaimedRewards(campaigns, state.campaigns[platform]);
      } catch (error) {
        options.signal?.throwIfAborted();
        if (authHealthFromError(error)) throw error;
        if (!hasIdleWatchlistChannels(settings, platform)) throw error;
        // Nothing is farmable this tick, so the decision logic below runs
        // against an empty list and the Idle Watchlist channel wins. State
        // keeps the campaigns from the last good discovery — same retention the
        // rethrow path gets for free — so a transient outage does not blank the
        // popup until the next successful tick.
        campaigns = [];
        discoveryFailed = true;
        observation = apiErrorObservation(error);
        const message = error instanceof Error ? error.message : "Drop discovery failed";
        emitDiagnostic(emit, platform, "warn", `${message}; checking Idle Watchlist fallback`);
        emitDiagnostic(emit, platform, "debug", `Drop discovery error (Idle Watchlist fallback): ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
      if (!discoveryFailed) {
        nextState.campaigns[platform] = campaigns;
        emitCampaignEvaluationDiagnostics(
          emit,
          platform,
          campaigns,
          settings,
          options.campaignEvaluationFingerprints,
        );
        // The accrual arm. Fresh progress data is in hand, so record the active
        // reward's watched minutes and compare them with the last observation.
        //
        // Its value is `watchedMinutes`: persisting it as `lastWatchedMinutes`
        // puts "was this platform actually accruing?" in the failure report, which
        // is what whoever triages the issue needs. `progressed` itself is inert —
        // this is the only producer and it always reports `failing: false`, which
        // resets on its own, so the flag can never change the outcome.
        //
        // That is deliberate. The prompt fires only on sustained API failure or
        // managed-tab churn, the cases we can be certain about; a healthy API that
        // accrues nothing belongs to the stuck detector (#53), not here. Do NOT
        // make a healthy tick report `failing: true` to "activate" this.
        const activeWatchReward = activeRewardFor(campaigns, nextState.sessions[platform]);
        const previousWatchedMinutes = nextState.criticalHealth?.[platform]?.lastWatchedMinutes;
        const watchedMinutes = activeWatchReward?.watchedMinutes;
        observation = {
          at: Date.now(),
          failing: false,
          progressed: watchedMinutes !== undefined
            && previousWatchedMinutes !== undefined
            && watchedMinutes > previousWatchedMinutes,
          preconditionBroke: false,
          watchedMinutes,
        };
        if (campaignDiagnosticFingerprint(campaigns) !== campaignDiagnosticFingerprint(state.campaigns[platform])) {
          emitDiagnostic(emit, platform, "debug", `Campaign inventory changed (${campaigns.length} discovered)`);
          const eligibleCount = campaigns.filter((campaign) => isEligible(campaign, settings)).length;
          emitDiagnostic(emit, platform, "debug", `${eligibleCount} of ${campaigns.length} campaigns eligible after filtering`);
        }
      }

      const previousInfeasibleRewardIds = new Set(state.deadlineInfeasibleRewardIds?.[platform]);
      const currentInfeasibleRewardIds: string[] = [];
      for (const campaign of campaigns) {
        for (const reward of campaign.rewards) {
          const feasibility = rewardFeasibility(
            campaign,
            reward,
            settings.skipUnfinishableRewards,
            settings.deadlineSafetyMarginMinutes,
          );
          if (feasibility.kind !== "insufficient_time") continue;
          const diagnosticId = `${campaign.id}:${reward.id}`;
          currentInfeasibleRewardIds.push(diagnosticId);
          if (previousInfeasibleRewardIds.has(diagnosticId)) continue;
          const availableMinutes = feasibility.availableMilliseconds / 60_000;
          emit({
            category: "diagnostic",
            platform,
            level: "info",
            code: "reward_insufficient_time",
            message: `${campaign.name} / ${reward.name} has insufficient time: ${feasibility.remainingMinutes} watch minutes remain, ${availableMinutes.toFixed(2)} minutes are available before ${feasibility.deadline}, margin ${feasibility.marginMinutes} minutes`,
            data: {
              campaignId: campaign.id,
              rewardId: reward.id,
              remainingMinutes: feasibility.remainingMinutes,
              availableMinutes,
              deadline: feasibility.deadline,
              marginMinutes: feasibility.marginMinutes,
            },
          });
        }
      }
      nextState.deadlineInfeasibleRewardIds = {
        ...nextState.deadlineInfeasibleRewardIds,
        [platform]: currentInfeasibleRewardIds,
      };

      if (settings.autoClaim) {
        const claimResult = await claimReadyRewards(
          adapter,
          campaigns,
          options.waitingClaimRewardIds?.[platform] ?? new Set<string>(),
          options.signal,
        );
        campaigns = claimResult.campaigns;
        if (!discoveryFailed) {
          nextState.campaigns[platform] = campaigns;
        }
        for (const event of claimResult.events) {
          if (event.claimed) {
            emit({
              category: "activity",
              platform,
              level: "info",
              code: "reward_claimed",
              data: {
                campaignId: event.campaignId,
                campaignName: event.campaignName,
                rewardId: event.rewardId,
                rewardName: event.rewardName,
                ...(event.rewardImageUrl ? { rewardImageUrl: event.rewardImageUrl } : {}),
                ...(event.campaignUrl ? { campaignUrl: event.campaignUrl } : {}),
                method: "automatic",
              },
            });
          } else {
            emitDiagnostic(emit, platform, event.level, event.message);
          }
        }
      }

      const selectionStartedAt = Date.now();
      const selection = options.selections?.[platform]
        ?? (discoveryFailed ? retainHealthyWatchOnAmbiguousDiscovery(previous, campaigns) : undefined)
        ?? await selectWatchTarget(platform, previous, campaigns, settings, adapter, options.signal);
      let { decision } = selection;
      const shouldKeep = selection.retention;
      if (options.selectionIsCurrent?.[platform]?.() === false) {
        emitDiagnostic(emit, platform, "debug", "Snapshot selection discarded after target health changed");
        continue;
      }
      const campaignSearchBackoffs = { ...nextState.campaignSearchBackoffs };
      if (selection.backoff) campaignSearchBackoffs[platform] = selection.backoff;
      else delete campaignSearchBackoffs[platform];
      nextState.campaignSearchBackoffs = campaignSearchBackoffs;
      if (selection.fastPath) {
        emitDiagnostic(
          emit,
          platform,
          "debug",
          `Campaign selection fast path retained current watch in ${Date.now() - selectionStartedAt}ms (${countLabel(selection.candidatesChecked, "candidate")} checked)`,
        );
      } else {
        emitDiagnostic(
          emit,
          platform,
          "debug",
          `Campaign selection finished in ${Date.now() - selectionStartedAt}ms (${countLabel(selection.campaignsChecked, "campaign")} checked, ${countLabel(selection.candidatesChecked, "candidate")} checked)`,
        );
      }
      // The single site where a stop reason is decided for an existing watch, so
      // the precondition-break arm is set here rather than at every consumer.
      if (!shouldKeep.keep && previous.status === "watching" && ACCRUAL_PRECONDITION_BREAK_REASONS.has(shouldKeep.reasonCode)) {
        observation = preconditionBreakObservation();
      }
      if (!shouldKeep.keep && previous.status === "watching") {
        emitDiagnostic(
          emit,
          platform,
          "debug",
          `Switching watch target (${shouldKeep.reason}); ${previous.watchMode === "tabless" ? "heartbeat" : "playback"} ${isSessionHealthy(previous) ? "healthy" : "unhealthy"}`,
        );
      }
      const decisionChanged = previous.campaignId !== decision.campaign?.id
        || previous.rewardId !== decision.reward?.id
        || previous.channel?.url !== decision.channel?.url
        || actionForSession(previous) !== decision.action
        || normalizedPreviousReasonCode(previous, decision) !== decision.reasonCode;

      decisions.push(decision);
      if (decisionChanged) {
        const decisionLevel = decision.action === "idle" || ["channel_offline", "watch_unhealthy", "platform_error"].includes(decision.reasonCode)
          ? "warn"
          : "debug";
        emitDiagnostic(
          emit,
          platform,
          decisionLevel,
          `Campaign decision: ${decision.action}${decision.channel ? ` → ${decision.channel.displayName ?? decision.channel.username}` : ""} (${decision.reason})`,
        );
        emitDiagnostic(emit, platform, decisionLevel, decision.reason);
      }
      if (decision.action === "idle") {
        await adapter.stopWatchTab?.(previous, { signal: options.signal });
        nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
      }
      const session = sessionForDecision(decision, previous, shouldKeep);
      if (decision.channel && decision.action !== "idle") {
        // The breaker is open: a managed tab kept reopening for this platform.
        // Opening another is exactly the user-hostile loop we detected, so the
        // platform is parked rather than switched to tabless — the product
        // decision is to pause, not to change watch modes behind the user's back.
        // The `finally` on this loop still applies the tick's observation, which
        // is what prunes the churn window and eventually releases the breaker.
        if (settings.criticalFailurePromptEnabled && isManagedTabBreakerOpen(nextState, platform)) {
          await adapter.stopWatchTab?.(previous, { signal: options.signal });
          nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
          nextState.sessions[platform] = {
            ...session,
            status: "idle",
            lastCheckedAt: new Date().toISOString(),
            message: "Paused after repeated tab reopening",
            reasonCode: "critical_failure",
            tabId: undefined,
            tabManagedByExtension: undefined,
            watchMode: undefined,
            tablessHeartbeat: undefined,
          };
          emitDiagnostic(emit, platform, "warn", "Paused: a managed tab kept reopening");
          continue;
        }
        const sameChannel = previous.channel?.url === decision.channel.url;
        const useTabless = chooseTablessWatch(previous, settings, adapter, sameChannel);
        session.offlineChecks = shouldKeep.keep ? shouldKeep.offlineChecks : 0;
        session.playbackChecks = useTabless ? 0 : shouldKeep.playbackChecks;
        // Both reset when the watch moves, so a fresh channel never inherits the
        // previous one's stall count or its minutes baseline.
        session.noProgressChecks = shouldKeep.keep && sameChannel ? shouldKeep.noProgressChecks ?? 0 : 0;
        session.lastWatchedMinutes = shouldKeep.keep && sameChannel ? shouldKeep.lastWatchedMinutes : undefined;

        if (useTabless) {
          // Tabless: no video tab. Close any tab we previously opened for this
          // platform; the controller starts/keeps the heartbeat watcher.
          await adapter.stopWatchTab?.(previous, { signal: options.signal });
          nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
          session.watchMode = "tabless";
          session.tablessFallback = false;
          session.tabId = undefined;
          session.watchTabOpenedAt = undefined;
          session.tabManagedByExtension = undefined;
          // Carry heartbeat health across the same channel; reset on a switch.
          session.heartbeatChecks = sameChannel ? previous.heartbeatChecks ?? 0 : 0;
          session.lastHeartbeatAt = sameChannel ? previous.lastHeartbeatAt : undefined;
          session.lastHeartbeatOk = sameChannel ? previous.lastHeartbeatOk : undefined;
          if (!sameChannel || previous.watchMode !== "tabless") {
            emitDiagnostic(emit, platform, "debug", `Tabless watch armed for ${decision.channel.displayName ?? decision.channel.username}`);
          }
        } else {
          // Tab policy (mute / keep-unmuted / auto-close) is owned by the host's
          // injected WatchTabPort, not the engine; the scheduler only forwards the
          // managed-tab handle it tracks in state.
          const watchTabOptions = nextState.managedWatchTabs?.[platform]
            ? { managedTab: nextState.managedWatchTabs[platform] }
            : {};
          const previousManagedTabId = nextState.managedWatchTabs?.[platform]?.tabId;
          const prepared = await adapter.prepareWatchTab(
            decision.channel,
            previous,
            { ...watchTabOptions, signal: options.signal },
          );
          if (options.selectionIsCurrent?.[platform]?.() === false) {
            if (prepared.managedByExtension && prepared.tabId !== previousManagedTabId) {
              await adapter.stopWatchTab?.({
                ...previous,
                status: "watching",
                channel: decision.channel,
                tabId: prepared.tabId,
                tabManagedByExtension: true,
              }, { signal: options.signal });
            }
            emitDiagnostic(emit, platform, "debug", "Snapshot selection discarded after target health changed");
            continue;
          }
          // Only a genuinely NEW extension-managed tab counts as churn evidence.
          // Reusing the tab we already track happens on every ordinary tick, and
          // counting it would trip the breaker during completely normal farming.
          if (settings.criticalFailurePromptEnabled && prepared.managedByExtension && prepared.tabId !== previousManagedTabId) {
            const opened = recordManagedTabOpen(nextState, platform, Date.now(), { source: "watch_tab" });
            nextState = opened.state;
            if (opened.event) emit(opened.event);
          }
          session.tabId = prepared.tabId;
          session.tabManagedByExtension = prepared.managedByExtension;
          // Mark a deliberate fallback so the next tick stays on the tab for this
          // channel instead of flipping back to a failing tabless heartbeat.
          session.watchMode = "tab";
          session.tablessFallback = Boolean(settings.tablessMode && adapter.supportsTabless);
          session.tablessHeartbeat = undefined;
          // A new tab id, a different channel, or a switch out of tabless all mean
          // the page starts from scratch: restart the playback grace window (#250).
          const freshTab = !sameChannel || previous.watchMode !== "tab" || previous.tabId !== prepared.tabId;
          session.watchTabOpenedAt = freshTab ? new Date().toISOString() : previous.watchTabOpenedAt;
          // The counter describes the tab we just replaced, not this one.
          if (freshTab) session.playbackChecks = 0;
          if (freshTab) {
            emitDiagnostic(emit, platform, "debug", `Watch tab ready (tab ${prepared.tabId}, ${prepared.managedByExtension ? "extension-managed" : "user tab"}) for ${decision.channel.displayName ?? decision.channel.username}`);
          }
          if (prepared.managedByExtension) {
            nextState.managedWatchTabs = {
              ...nextState.managedWatchTabs,
              [platform]: prepared.managedTab ?? {
                platform,
                tabId: prepared.tabId,
                channelUrl: decision.channel.url,
                ownedByExtension: true as const,
              },
            };
          } else {
            nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
          }
        }
        if (autoClaimChannelPointsFor(settings, platform) && adapter.claimChannelPoints) {
          try {
            const claimed = await adapter.claimChannelPoints(decision.channel, { signal: options.signal });
            if (claimed) {
              emitDiagnostic(emit, platform, "info", `Claimed channel points for ${decision.channel.displayName ?? decision.channel.username}`);
            }
          } catch (error) {
            options.signal?.throwIfAborted();
            if (authHealthFromError(error)) throw error;
            emitDiagnostic(
              emit,
              platform,
              "warn",
              error instanceof Error ? error.message : "Channel points claim failed",
            );
          }
        }
      }
      session.lastCheckedAt = new Date().toISOString();
      session.errorChecks = 0;
      session.retryAfter = undefined;
      nextState.sessions[platform] = session;
      nextState.managedPageContextTabs = currentManagedPageContextTabs();
    } catch (error) {
      const authHealth = authHealthFromError(error);
      if (authHealth) {
        const transition = applyPlatformAuthHealth(nextState, platform, authHealth);
        nextState = transition.state;
        if (transition.event) emit(transition.event);
        await suspendPlatformForAuthentication(platform, previous, adapter);
        continue;
      }
      // The tick died somewhere in the farming work. Without this the accrual
      // observation set earlier (failing: false) would be what `finally` applies,
      // so a platform failing every tick after a successful discovery would reset
      // its own evidence forever and could never flag.
      observation = apiErrorObservation(error);
      const message = error instanceof Error ? error.message : "Platform scheduler failed";
      const errorChecks = (previous.errorChecks ?? 0) + 1;
      nextState.sessions[platform] = {
        ...previous,
        status: "error",
        lastCheckedAt: new Date().toISOString(),
        errorChecks,
        retryAfter: nextRetryAfter(errorChecks),
        message,
        reasonCode: "platform_error",
        tablessHeartbeat: undefined,
      };
      nextState.managedPageContextTabs = currentManagedPageContextTabs();
      emitDiagnostic(emit, platform, "error", `${message}; retry after ${nextState.sessions[platform].retryAfter}`);
      emitDiagnostic(emit, platform, "debug", `Tick failed from status "${previous.status}" (error #${errorChecks}); ${error instanceof Error && error.stack ? error.stack : message}`);
    } finally {
      applyObservation();
    }
  }

  nextState.managedPageContextTabs = currentManagedPageContextTabs();
  return { state: nextState, decisions, events };
}

function hasRecentManualWatch(state: SchedulerState, platform: Platform): boolean {
  const manualWatch = state.manualWatch?.[platform];
  if (!manualWatch?.active) return false;
  return !isTimestampStale(manualWatch.checkedAt, MANUAL_WATCH_TTL_MS, Date.now());
}

function hasIdleWatchlistChannels(settings: EngineSettings, platform: Platform): boolean {
  return settings.platform[platform].idleWatchlistChannels.some((username) => username.trim());
}

function withoutManagedWatchTab(
  managedWatchTabs: SchedulerState["managedWatchTabs"],
  platform: Platform,
): SchedulerState["managedWatchTabs"] {
  const next = { ...managedWatchTabs };
  delete next[platform];
  return next;
}

function isInBackoff(session: WatchSession): boolean {
  if (session.status !== "error" || !session.retryAfter) return false;
  const retryAt = Date.parse(session.retryAfter);
  return !Number.isNaN(retryAt) && Date.now() < retryAt;
}

function nextRetryAfter(errorChecks: number): string {
  const minutes = Math.min(MAX_PLATFORM_BACKOFF_MINUTES, 2 ** Math.max(0, errorChecks - 1));
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

type ClaimReadyRewardEvent = {
  level: "info";
  message: string;
  claimed: true;
  campaignId: string;
  campaignName: string;
  rewardId: string;
  rewardName: string;
  rewardImageUrl?: string;
  campaignUrl?: string;
} | {
  level: "info" | "warn" | "error";
  message: string;
  claimed?: false;
};

async function claimReadyRewards(
  adapter: PlatformAdapter,
  campaigns: DropCampaign[],
  previouslyWaitingRewardIds: Set<string>,
  signal?: AbortSignal,
): Promise<{ campaigns: DropCampaign[]; events: ClaimReadyRewardEvent[] }> {
  const events: ClaimReadyRewardEvent[] = [];
  const updated: DropCampaign[] = [];
  const stillWaitingRewardIds = new Set<string>();

  for (const campaign of campaigns) {
    const rewards: DropReward[] = [];
    for (const reward of campaign.rewards) {
      signal?.throwIfAborted();
      if (reward.status === "claimable" && canClaimReward(reward)) {
        if (adapter.isClaimReady && !adapter.isClaimReady(reward)) {
          // Watched to completion, but the platform hasn't released the claim
          // yet (e.g. Twitch hasn't returned the drop-instance id). Defer; the
          // next tick re-checks once progress data catches up.
          rewards.push(reward);
          stillWaitingRewardIds.add(reward.id);
          if (!previouslyWaitingRewardIds.has(reward.id)) {
            events.push({
              level: "info",
              message: `${reward.name} watched-complete; waiting for ${campaign.name} claim to be released`,
            });
          }
          continue;
        }
        try {
          const claimed = await adapter.claimReward(campaign, reward, { signal });
          rewards.push(claimed ? { ...reward, status: "claimed", watchedMinutes: reward.requiredMinutes } : reward);
          if (claimed) {
            events.push({
              level: "info",
              message: `Claimed ${reward.name} from ${campaign.name}`,
              claimed: true,
              campaignId: campaign.id,
              campaignName: campaign.name,
              rewardId: reward.id,
              rewardName: reward.name,
              ...(reward.imageUrl ? { rewardImageUrl: reward.imageUrl } : {}),
              ...(campaign.url ? { campaignUrl: campaign.url } : {}),
            });
          } else {
            events.push({
              level: "warn",
              message: `Could not claim ${reward.name} from ${campaign.name}`,
            });
          }
        } catch (error) {
          rewards.push(reward);
          events.push({
            level: "error",
            message: error instanceof Error ? error.message : `Claim failed for ${reward.name}`,
          });
        }
      } else {
        rewards.push(reward);
      }
    }
    updated.push(reconcileCampaignAfterClaims(campaign, rewards));
  }

  previouslyWaitingRewardIds.clear();
  for (const rewardId of stillWaitingRewardIds) previouslyWaitingRewardIds.add(rewardId);

  return { campaigns: updated, events };
}

export function preserveClaimedRewards(
  campaigns: DropCampaign[],
  previousCampaigns: readonly DropCampaign[],
): DropCampaign[] {
  const previouslyClaimed = new Map<string, DropReward>();
  for (const campaign of previousCampaigns) {
    for (const reward of campaign.rewards) {
      if (reward.status === "claimed" && reward.claimId) {
        previouslyClaimed.set(reward.claimId, reward);
      }
    }
  }

  return campaigns.map((campaign) => {
    let changed = false;
    const rewards = campaign.rewards.map<DropReward>((reward) => {
      const previous = reward.claimId ? previouslyClaimed.get(reward.claimId) : undefined;
      if (!previous || previous.id !== reward.id) return reward;
      changed = true;
      return {
        ...reward,
        status: "claimed",
        watchedMinutes: Math.max(reward.watchedMinutes, reward.requiredMinutes),
      };
    });
    return changed ? reconcileCampaignAfterClaims(campaign, rewards) : campaign;
  });
}

function campaignDiagnosticFingerprint(campaigns: readonly DropCampaign[]): string {
  return campaigns
    .map((campaign) => `${campaign.id}:${campaign.status}:${campaign.rewards.map((reward) => `${reward.id}:${reward.status}`).sort().join(",")}`)
    .sort()
    .join("|");
}

function hasHigherExplicitCampaignPriority(
  candidate: DropCampaign,
  current: DropCampaign,
  settings: EngineSettings,
): boolean {
  const candidatePriority = settings.campaignPriorities[candidate.id];
  if (candidatePriority == null) return false;
  const currentPriority = settings.campaignPriorities[current.id];
  return currentPriority == null || candidatePriority > currentPriority;
}

async function evaluatePreferredCurrentWatch(
  previous: WatchSession,
  campaigns: readonly DropCampaign[],
  settings: EngineSettings,
  adapter: Pick<PlatformAdapter, "checkChannel">,
  signal?: AbortSignal,
): Promise<{
  decision: WatchDecision;
  keep: Awaited<ReturnType<typeof shouldKeepWatching>>;
} | undefined> {
  if (previous.status !== "watching" || !previous.channel || !previous.campaignId || !previous.rewardId) {
    return undefined;
  }
  const preferredCampaign = sortCampaigns(
    campaigns.filter((campaign) => isEligible(campaign, settings)),
    settings,
  ).find((campaign) => activeReward(campaign, settings));
  let retainedCampaign = preferredCampaign;
  let retainedReward = preferredCampaign ? activeReward(preferredCampaign, settings) : undefined;
  if (retainedCampaign?.id !== previous.campaignId || retainedReward?.id !== previous.rewardId) {
    // Automatic ranking chooses the next reward to start; it must not discard
    // progress already earned on a healthy, still-eligible reward. An explicit
    // user priority remains an intentional override.
    const currentCampaign = campaigns.find((campaign) => campaign.id === previous.campaignId);
    const currentReward = currentCampaign?.rewards.find((reward) => reward.id === previous.rewardId);
    const currentActiveReward = currentCampaign && isEligible(currentCampaign, settings)
      ? activeReward(currentCampaign, settings)
      : undefined;
    const shouldRetainProgress = currentCampaign != null
      && currentReward?.status === "in_progress"
      && currentActiveReward?.id === currentReward.id
      && (preferredCampaign == null
        || !hasHigherExplicitCampaignPriority(preferredCampaign, currentCampaign, settings));
    if (!shouldRetainProgress) return undefined;
    retainedCampaign = currentCampaign;
    retainedReward = currentReward;
  }
  const decision: WatchDecision = {
    platform: previous.platform,
    action: "watch",
    campaign: retainedCampaign,
    reward: retainedReward,
    channel: previous.channel,
    reason: retainedCampaign?.id === preferredCampaign?.id
      ? "Current campaign remains highest priority"
      : "Current reward is already in progress",
    reasonCode: "keeping_current_watch",
  };
  const keep = await shouldKeepWatching(previous, decision, campaigns, settings, adapter, signal);
  return { decision, keep };
}

async function shouldKeepWatching(
  previous: WatchSession,
  nextDecision: WatchDecision,
  campaigns: readonly DropCampaign[],
  settings: EngineSettings,
  adapter: Pick<PlatformAdapter, "checkChannel">,
  signal?: AbortSignal,
): Promise<{ keep: boolean; offlineChecks: number; playbackChecks: number; noProgressChecks?: number; lastWatchedMinutes?: number; reason: string; reasonCode: WatchReasonCode; channel?: ChannelCandidate }> {
  if (!previous.channel || previous.status !== "watching") {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: "No existing watch session", reasonCode: "no_existing_session" };
  }
  const previousCampaign = campaigns.find((campaign) => campaign.id === previous.campaignId);
  const previousReward = previousCampaign?.rewards.find((reward) => reward.id === previous.rewardId);
  if (previousReward?.status === "claimable" || previousReward?.status === "claimed") {
    return {
      keep: false,
      offlineChecks: 0,
      playbackChecks: 0,
      reason: "Current reward completed; switching farming target",
      reasonCode: "watch_requirement_completed",
    };
  }
  if (nextDecision.action === "idle") {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: nextDecision.reason, reasonCode: nextDecision.reasonCode };
  }
  if (previous.campaignId && nextDecision.action !== "watch") {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: "Current campaign is no longer eligible", reasonCode: "campaign_ineligible" };
  }
  if (previous.campaignId && settings.platform[previous.platform].excludedChannels?.includes(previous.channel.username.toLowerCase())) {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: "Current channel is excluded from drops", reasonCode: "channel_excluded" };
  }
  if (previous.rewardId && nextDecision.reward?.id !== previous.rewardId) {
    const replacement = classifyRewardSwitch(nextDecision);
    return { keep: false, offlineChecks: 0, playbackChecks: 0, ...replacement };
  }
  // Tabless sessions have no playback telemetry; their health is the heartbeat,
  // which the controller tracks and falls back to a tab on. Here we only keep or
  // switch the channel based on liveness/category, so skip playback retries.
  const isTabless = previous.watchMode === "tabless";
  if (!settings.idleWatchlistFallbackOnly && !previous.campaignId && nextDecision.action === "watch") {
    const fallbackCheck = await adapter.checkChannel(previous.channel, { signal });
    const fallbackOfflineChecks = fallbackCheck.live ? 0 : previous.offlineChecks + 1;
    if (fallbackCheck.live && fallbackCheck.categoryMatches) {
      const fallbackPlaybackChecks = nextPlaybackChecks(previous, isTabless);
      if (fallbackPlaybackChecks < settings.offlineRetryLimit) {
        return {
          keep: true,
          offlineChecks: fallbackOfflineChecks,
          playbackChecks: fallbackPlaybackChecks,
          channel: channelFromCheck(previous.channel, fallbackCheck),
          reason: "Keeping current Idle Watchlist tab",
          reasonCode: "keeping_idle_watchlist",
        };
      }
    }
  }

  const changedTarget = nextDecision.channel?.url !== previous.channel.url;
  const differentCampaignAvailable = changedTarget
    && nextDecision.action === "watch"
    && nextDecision.campaign?.id !== previous.campaignId;
  if (differentCampaignAvailable) {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: "Higher priority eligible campaign available", reasonCode: "higher_priority_reward" };
  }

  // When watching an Idle Watchlist fallback, a different selection means a
  // higher-priority idle watchlist channel is now live (e.g. after reordering the
  // watchlist or one coming online), so switch to it instead of staying put.
  const differentFallbackAvailable = changedTarget
    && nextDecision.action === "fallback"
    && !previous.campaignId;
  if (differentFallbackAvailable) {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: "Higher priority Idle Watchlist channel available", reasonCode: "higher_priority_idle_watchlist" };
  }

  const check = await adapter.checkChannel(previous.channel, { campaign: previousCampaign, signal });
  const offlineChecks = check.live ? 0 : previous.offlineChecks + 1;
  if (offlineChecks >= settings.offlineRetryLimit) {
    return { keep: false, offlineChecks, playbackChecks: 0, reason: check.reason ?? "Channel offline retry limit reached", reasonCode: "channel_offline" };
  }

  if (!check.categoryMatches) {
    return { keep: false, offlineChecks, playbackChecks: 0, reason: check.reason ?? "Channel category no longer matches", reasonCode: "channel_mismatch" };
  }
  if (check.campaignMatches === false) {
    return { keep: false, offlineChecks, playbackChecks: 0, reason: check.reason ?? "Channel no longer offers the current campaign", reasonCode: "campaign_ineligible" };
  }

  const playbackChecks = nextPlaybackChecks(previous, isTabless);
  if (playbackChecks >= settings.offlineRetryLimit) {
    return {
      keep: false,
      offlineChecks,
      playbackChecks,
      reason: "Watch tab playback did not become active",
      reasonCode: "watch_unhealthy",
    };
  }

  // Checked after playback health so an unhealthy tab reports watch_unhealthy
  // rather than being misread as a channel that does not pay out.
  //
  // Trusting Twitch's discovery sources means no availability check rejects a
  // channel any more, so without this a healthy stream that never accrues a
  // minute would be watched forever (#400). Ticks are at least a minute apart
  // (pollIntervalMinutes has a floor of 1) and watched minutes have one-minute
  // granularity, so consecutive equal readings are real stalls, not sampling
  // artefacts.
  const progress = watchProgress(campaigns, previous);
  const noProgressChecks = progress.observable
    ? progress.advanced ? 0 : (previous.noProgressChecks ?? 0) + 1
    // Subscription-only rewards and adapters that cannot read progress must
    // never rotate on this path, so the counter is carried forward untouched.
    : previous.noProgressChecks ?? 0;
  if (progress.observable && noProgressChecks >= settings.offlineRetryLimit) {
    return {
      keep: false,
      offlineChecks,
      playbackChecks,
      noProgressChecks,
      lastWatchedMinutes: progress.watchedMinutes,
      reason: `Channel accrued no drop progress across ${noProgressChecks} checks`,
      reasonCode: "no_progress",
    };
  }

  return {
    keep: true,
    offlineChecks,
    playbackChecks,
    noProgressChecks,
    lastWatchedMinutes: progress.watchedMinutes ?? previous.lastWatchedMinutes,
    channel: channelFromCheck(previous.channel, check),
    reason: "Keeping current watch tab",
    reasonCode: "keeping_current_watch",
  };
}

// Whether the session's active watch reward accrued since the last check.
// `observable` is false when there is no active watch reward or the platform
// could not read its minutes — the only safe reading is "no evidence", never
// "no progress".
function watchProgress(
  campaigns: readonly DropCampaign[],
  previous: WatchSession,
): { observable: boolean; advanced: boolean; watchedMinutes?: number } {
  const reward = activeRewardFor(campaigns, previous);
  const watchedMinutes = reward?.isWatchBased === false ? undefined : reward?.watchedMinutes;
  if (watchedMinutes === undefined) return { observable: false, advanced: false };
  const previousMinutes = previous.lastWatchedMinutes;
  if (previousMinutes === undefined) return { observable: false, advanced: false, watchedMinutes };
  return { observable: true, advanced: watchedMinutes > previousMinutes, watchedMinutes };
}

// Playing — muted or not — is what indicates farming is working. The browser
// can block element-level unmuting in a background tab, so the content script
// may keep the video muted; that is still healthy as long as it plays.
export function isPlaybackTelemetryHealthy(telemetry: Pick<PlaybackTelemetry, "videoCount" | "playingVideoCount">): boolean {
  return telemetry.videoCount > 0 && telemetry.playingVideoCount > 0;
}

function isPlaybackHealthy(session: WatchSession): boolean {
  const playback = session.playback;
  if (!playback) return false;
  if (isTimestampStale(playback.checkedAt, PLAYBACK_TELEMETRY_MAX_AGE_MS, Date.now())) return false;
  return isPlaybackTelemetryHealthy(playback);
}

// A page that has just been opened or navigated has no player attached yet, so
// its telemetry legitimately reads "0 videos" for a while. Counting those ticks
// as failures makes the scheduler destroy the tab and open an equally cold
// replacement, which is self-sustaining churn (#250). The window is measured
// from tab creation rather than a tick count because health ticks also run
// off-cycle (tab closed, telemetry arriving), so a count is not a duration.
//
// 90s is one full default poll interval (pollIntervalMinutes: 1) plus slack, so
// a freshly opened tab is never condemned by its first scheduled evaluation
// even on a slow/high-latency connection. A tab that genuinely never plays is
// still replaced after offlineRetryLimit further checks.
export const WATCH_TAB_PLAYBACK_GRACE_MS = 90 * 1000;

function isWithinPlaybackGrace(session: WatchSession): boolean {
  if (!session.watchTabOpenedAt) return false;
  const openedAt = Date.parse(session.watchTabOpenedAt);
  if (Number.isNaN(openedAt)) return false;
  const elapsed = Date.now() - openedAt;
  return elapsed >= 0 && elapsed < WATCH_TAB_PLAYBACK_GRACE_MS;
}

// Unhealthy playback only accumulates once the tab has had its grace period.
// A healthy reading (or the grace window) resets the counter to zero, so a tab
// that dips and recovers is never condemned by stale counters.
function nextPlaybackChecks(session: WatchSession, isTabless: boolean): number {
  if (isTabless || isPlaybackHealthy(session) || isWithinPlaybackGrace(session)) return 0;
  return (session.playbackChecks ?? 0) + 1;
}

// Health of the current watch, regardless of mode: a tabless session is healthy
// when its last heartbeat was accepted recently; a tab session relies on
// playback telemetry.
function isSessionHealthy(session: WatchSession): boolean {
  return session.watchMode === "tabless" ? isHeartbeatHealthy(session) : isPlaybackHealthy(session);
}

function isHeartbeatHealthy(session: WatchSession): boolean {
  if (!session.lastHeartbeatOk || !session.lastHeartbeatAt) return false;
  const at = Date.parse(session.lastHeartbeatAt);
  if (Number.isNaN(at)) return false;
  return Date.now() - at < 3 * 60 * 1000;
}

function classifyRewardSwitch(
  nextDecision: WatchDecision,
): { reason: string; reasonCode: FarmingStopReason } {
  if (nextDecision.action !== "watch") {
    return {
      reason: "Current campaign is no longer eligible",
      reasonCode: "campaign_ineligible",
    };
  }
  return {
    reason: "Higher priority eligible reward available",
    reasonCode: "higher_priority_reward",
  };
}

function actionForSession(session: WatchSession): WatchDecision["action"] {
  if (session.status !== "watching") return "idle";
  return session.campaignId ? "watch" : "fallback";
}

function normalizedPreviousReasonCode(previous: WatchSession, decision: WatchDecision): WatchReasonCode | undefined {
  if (decision.reasonCode === "keeping_current_watch" && previous.reasonCode === "eligible_campaign") {
    return "keeping_current_watch";
  }
  if (decision.reasonCode === "keeping_idle_watchlist" && previous.reasonCode === "idle_watchlist_selected") {
    return "keeping_idle_watchlist";
  }
  return previous.reasonCode;
}

function emitDiagnostic(
  emit: EventEmitter,
  platform: Platform,
  level: LogLevel,
  message: string,
): void {
  emit({ category: "diagnostic", platform, level, message });
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
