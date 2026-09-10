import { campaignPassesCategoryFilter } from "./categories";
import { evaluateCampaignFarming } from "./campaignFarming";
import type { CampaignFilterKey, DropCampaign, DropReward, EngineSettings, ExtensionSettings } from "./models";
import { campaignHasSubscriptionRewards, canClaimReward, isRewardDeadlineFeasible, isRewardRelevantNow } from "./rewards";

export function isCampaignExpired(campaign: DropCampaign): boolean {
  if (campaign.status === "expired") return true;
  // The engine also treats these eligibility values as lifecycle states, so the
  // display categorisation must agree or a campaign the engine considers ended
  // could still slip past a showExpired: false filter. All three are non-farmable
  // (isEligible rejects any eligibility !== "eligible"), so aligning display to
  // them can never hide a campaign the engine would farm.
  if (campaign.eligibility === "expired") return true;
  return hasCampaignEnded(campaign);
}

// Shared with the scheduler so "has this ended" has one definition.
export function hasCampaignEnded(campaign: DropCampaign): boolean {
  if (!campaign.endsAt) return false;
  const endsAt = Date.parse(campaign.endsAt);
  return !Number.isNaN(endsAt) && endsAt < Date.now();
}

export function isCampaignFinished(campaign: DropCampaign): boolean {
  if (campaign.status === "completed") return true;
  // Mirror the engine's lifecycle view (see isCampaignExpired): a "completed"
  // eligibility is a finished campaign even when status is still "active". Also
  // non-farmable, so this cannot hide a farmable campaign.
  if (campaign.eligibility === "completed") return true;
  return campaign.rewards.length > 0 && campaign.rewards.every((reward) => reward.status === "claimed");
}

// Whether the campaign is upcoming — not yet started, nothing earnable now. The
// engine treats both status "upcoming" and eligibility "upcoming" as such, so
// the display categorisation matches. Non-farmable, so filtering it cannot hide
// a farmable campaign.
export function isCampaignUpcoming(campaign: DropCampaign): boolean {
  return campaign.status === "upcoming" || campaign.eligibility === "upcoming";
}

export function campaignFilterCategories(campaign: DropCampaign, excludedIds: ReadonlySet<string>): CampaignFilterKey[] {
  const categories: CampaignFilterKey[] = [];
  if (excludedIds.has(campaign.id)) categories.push("excluded");
  if (campaign.accountLinked === false) categories.push("notLinked");
  if (campaignHasSubscriptionRewards(campaign)) categories.push("subscription");
  if (isCampaignFinished(campaign)) categories.push("finished");
  else if (isCampaignExpired(campaign)) categories.push("expired");
  else if (isCampaignUpcoming(campaign)) categories.push("upcoming");
  return categories;
}

// What the engine asks: is this campaign's class allowed to be farmed? Reads
// only the two eligibility flags; excludedCampaignIds is handled separately in
// isEligible, so it is not consulted here. Threading exclusions through would
// imply this filter has an opinion about them.
export function campaignPassesFarmingEligibility(
  campaign: DropCampaign,
  farmingEligibility: EngineSettings["farmingEligibility"],
): boolean {
  if (campaign.accountLinked === false && !farmingEligibility.farmUnlinkedCampaigns) return false;
  if (campaignHasSubscriptionRewards(campaign) && !farmingEligibility.farmSubscriptionCampaigns) return false;
  return true;
}

// Whether a single reward is farmable right now: not yet claimed, its earn/claim
// preconditions are met, it is within its claim or earn window, and — for a
// still-earning watch reward — its deadline is feasible under the user's
// skip-unfinishable-rewards policy. Shared by campaignFarmable (below) and the
// scheduler, so "should the engine spend a tick on this reward" has one
// definition instead of drifting between the two.
export function isRewardFarmableNow(
  campaign: Pick<DropCampaign, "endsAt" | "platform">,
  reward: DropReward,
  settings: Pick<EngineSettings, "skipUnfinishableRewards" | "deadlineSafetyMarginMinutes">,
): boolean {
  if (reward.status === "claimed") return false;
  if (reward.preconditionsMet === false) return false;
  if (!isRewardRelevantNow(reward)) return false;
  return canClaimReward(reward)
    || isRewardDeadlineFeasible(campaign, reward, settings.skipUnfinishableRewards, settings.deadlineSafetyMarginMinutes);
}

// Whether a campaign's CLASS could ever be farmed, ignoring the moment-to-moment
// timing of any individual reward (deadline feasibility, preconditions). This is
// everything campaignFarmable checks except the final per-reward relevance
// check, replaced with the much looser "has something left to earn or claim at
// all". Deliberately separate from campaignFarmable: the popup's visibility
// (isCampaignVisible) keys off THIS, not full farmability, because a campaign
// that is momentarily un-farmable for reward-timing reasons (an infeasible
// deadline under skipUnfinishableRewards, an unmet precondition on a locked
// follow-up reward) is not a dead campaign — the user may want to see it, ease
// the deadline margin, or (in "priority list only" mode) drag it into their
// priority list, which is the ONLY way to make such a campaign farmable there.
// Priority ordering is built from the currently-visible list (prioritiesFromOrder
// in popup-ui), so hiding a campaign for a reward-timing reason would make it
// permanently un-prioritizable — a real regression, not a stricter invariant.
export function campaignEligibleClass(campaign: DropCampaign, settings: EngineSettings): boolean {
  if (campaign.status !== "active") return false;
  if (hasCampaignEnded(campaign)) return false;
  if (campaign.eligibility && campaign.eligibility !== "eligible") return false;
  if (settings.excludedCampaignIds.includes(campaign.id)) return false;
  if (!campaignPassesFarmingEligibility(campaign, settings.farmingEligibility)) return false;
  if (!campaignPassesCategoryFilter(campaign, settings.platform[campaign.platform])) return false;
  // Twitch cannot earn drops until the account is linked, so an unlinked Twitch
  // campaign is never farmable regardless of farmUnlinkedCampaigns. Kick DOES
  // accrue watch progress before linking (the link is only required to claim).
  if (campaign.platform !== "kick" && campaign.accountLinked === false) return false;
  return campaign.rewards.some((reward) => reward.status !== "claimed");
}

// The single definition of "is this campaign farmable right now" — everything
// the engine's isEligible checks EXCEPT settings.priorityMode. Priority-list-only
// mode is a farming-strategy choice, not a fact about the campaign itself: a
// campaign the user hasn't prioritized yet must stay eligible-class here (and
// visible in isCampaignVisible below) so they can add it to the list, which is
// why the scheduler layers that check on top of this rather than folding it in.
// Strictly narrower than campaignEligibleClass — see that function for why
// isCampaignVisible deliberately does NOT use this one.
export function campaignFarmable(campaign: DropCampaign, settings: EngineSettings): boolean {
  return evaluateCampaignFarming(campaign, settings).farmable;
}

// What the popup asks. A claimable reward always stays visible so the user can
// claim it, independent of farmability — claiming doesn't require the engine to
// be actively farming the campaign. Everything else derives from
// campaignEligibleClass (NOT the stricter campaignFarmable — see its comment):
// if the campaign's class could ever be farmed, it's visible (the invariant
// below); if not, visible only when a display flag explicitly says to show that
// class of non-farmable campaign anyway.
//
// INVARIANT: a campaign that will be farmed is always visible here. This holds
// because campaignFarmable is strictly narrower than campaignEligibleClass (same
// checks, plus a reward-timing requirement) — so campaignFarmable-true implies
// campaignEligibleClass-true, and the eligible-class check returns visible
// immediately, before any filter flag is consulted. If a future change breaks
// that subset relationship, the binding test in campaignFilters.test.ts fails.
export function isCampaignVisible(
  campaign: DropCampaign,
  settings: ExtensionSettings,
  excludedIds: ReadonlySet<string>,
): boolean {
  if (campaign.rewards.some((reward) => reward.status === "claimable")) return true;
  if (campaignEligibleClass(campaign, settings)) return true;
  // The category filter has no display-flag override anywhere, so it is
  // checked first, ahead of every other bucket below — it wins even over a
  // campaign that is ALSO excluded/finished/expired/upcoming/not-linked/
  // subscription-gated with its matching display flag on. A category filtered
  // out by include or exclude mode is gone from the Drops list, full stop, not
  // just gone from farming. Same helper as campaignEligibleClass above, so the
  // two can never disagree about what a mode means.
  if (!campaignPassesCategoryFilter(campaign, settings.platform[campaign.platform])) return false;
  // Not in a farmable class for some other reason. Bucket by why, and consult
  // that class's display flag — the only way it can still be shown.
  const filter = settings.dropsListFilter;
  if (excludedIds.has(campaign.id)) return filter.showExcluded;
  if (isCampaignFinished(campaign)) return filter.showFinished;
  if (isCampaignExpired(campaign)) return filter.showExpired;
  if (isCampaignUpcoming(campaign)) return filter.showUpcoming;
  if (campaign.accountLinked === false) return filter.showNotLinked;
  if (campaignHasSubscriptionRewards(campaign)) return filter.showSubscription;
  // An ordinary active campaign that campaignEligibleClass rejected for a reason
  // with no display flag (reward-independent — every branch above is covered)
  // has none to fall back on: hidden.
  return false;
}
