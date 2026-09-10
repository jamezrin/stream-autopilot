import { campaignPassesCategoryFilter } from "./categories";
import type { DropCampaign, DropReward, EngineSettings } from "./models";
import {
  campaignHasSubscriptionRewards,
  canClaimReward,
  isRewardAvailableToEarn,
  isSubscriptionReward,
  isWatchReward,
  rewardFeasibility,
} from "./rewards";

export type CampaignFarmingRejectionCode =
  | "excluded"
  | "upcoming"
  | "expired"
  | "completed"
  | "unlinked_campaigns_disabled"
  | "twitch_link_required"
  | "subscription_campaigns_disabled"
  | "category_filtered"
  | "priority_not_selected"
  | "no_rewards"
  | "no_unclaimed_rewards"
  | "reward_prerequisites_unmet"
  | "reward_not_started"
  | "reward_window_ended"
  | "insufficient_time"
  | "subscription_required"
  | "action_required"
  | "no_farmable_reward";

export type CampaignFarmingEvaluation =
  | { farmable: true }
  | {
      farmable: false;
      code: CampaignFarmingRejectionCode;
      rewardId?: string;
      rewardName?: string;
      deadline?: string;
      remainingMinutes?: number;
      availableMinutes?: number;
      marginMinutes?: number;
    };

export interface CampaignFarmingEvaluationOptions {
  includePriorityMode?: boolean;
  now?: number;
}

type Rejection = Extract<CampaignFarmingEvaluation, { farmable: false }>;

function rejected(code: CampaignFarmingRejectionCode): Rejection {
  return { farmable: false, code };
}

function rewardRejected(code: CampaignFarmingRejectionCode, reward: DropReward): Rejection {
  return { farmable: false, code, rewardId: reward.id, rewardName: reward.name };
}

function parsedTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

export function evaluateCampaignFarming(
  campaign: DropCampaign,
  settings: EngineSettings,
  options: CampaignFarmingEvaluationOptions = {},
): CampaignFarmingEvaluation {
  const now = options.now ?? Date.now();
  if (settings.excludedCampaignIds.includes(campaign.id)) return rejected("excluded");
  if (campaign.status === "upcoming" || campaign.eligibility === "upcoming") return rejected("upcoming");
  if (campaign.status === "expired" || campaign.eligibility === "expired") return rejected("expired");
  const campaignEndsAt = parsedTime(campaign.endsAt);
  if (campaignEndsAt !== undefined && campaignEndsAt < now) return rejected("expired");
  if (campaign.status === "completed" || campaign.eligibility === "completed") return rejected("completed");
  const accountUnlinked = campaign.accountLinked === false || campaign.eligibility === "account_not_linked";
  if (accountUnlinked && !settings.farmingEligibility.farmUnlinkedCampaigns) {
    return rejected("unlinked_campaigns_disabled");
  }
  if (campaignHasSubscriptionRewards(campaign) && !settings.farmingEligibility.farmSubscriptionCampaigns) {
    return rejected("subscription_campaigns_disabled");
  }
  if (campaign.platform === "twitch" && accountUnlinked) return rejected("twitch_link_required");
  if (!campaignPassesCategoryFilter(campaign, settings.platform[campaign.platform])) {
    return rejected("category_filtered");
  }
  if (options.includePriorityMode && settings.priorityMode === "priority_list_only" && settings.campaignPriorities[campaign.id] == null) {
    return rejected("priority_not_selected");
  }
  if (campaign.rewards.length === 0 || campaign.eligibility === "no_rewards") return rejected("no_rewards");
  const unclaimed = campaign.rewards.filter((reward) => reward.status !== "claimed");
  if (unclaimed.length === 0) return rejected("no_unclaimed_rewards");

  const blockers: Rejection[] = [];
  for (const reward of unclaimed) {
    if (reward.preconditionsMet === false) {
      blockers.push(rewardRejected("reward_prerequisites_unmet", reward));
      continue;
    }
    const startsAt = parsedTime(reward.availableFrom);
    if (startsAt !== undefined && now < startsAt) {
      blockers.push(rewardRejected("reward_not_started", reward));
      continue;
    }
    const endsAt = parsedTime(reward.availableUntil);
    if (endsAt !== undefined && now >= endsAt) {
      blockers.push(rewardRejected("reward_window_ended", reward));
      continue;
    }
    if (canClaimReward(reward, now)) return { farmable: true };
    if (isWatchReward(reward) && isRewardAvailableToEarn(reward, now)) {
      const feasibility = rewardFeasibility(
        campaign,
        reward,
        settings.skipUnfinishableRewards,
        settings.deadlineSafetyMarginMinutes,
        now,
      );
      if (feasibility.kind !== "insufficient_time") return { farmable: true };
      blockers.push({
        ...rewardRejected("insufficient_time", reward),
        deadline: feasibility.deadline,
        remainingMinutes: feasibility.remainingMinutes,
        availableMinutes: feasibility.availableMilliseconds / 60_000,
        marginMinutes: feasibility.marginMinutes,
      });
      continue;
    }
    blockers.push(rewardRejected(
      isSubscriptionReward(reward) ? "subscription_required" : "action_required",
      reward,
    ));
  }

  const precedence: CampaignFarmingRejectionCode[] = [
    "reward_prerequisites_unmet",
    "reward_not_started",
    "reward_window_ended",
    "insufficient_time",
    "subscription_required",
    "action_required",
  ];
  return precedence.flatMap((code) => blockers.filter((blocker) => blocker.code === code))[0]
    ?? rejected("no_farmable_reward");
}
