import { describe, expect, it } from "vitest";
import {
  campaignFarmable,
  campaignFilterCategories,
  campaignPassesFarmingEligibility,
  isCampaignVisible,
} from "@lurkloot/shared/campaignFilters";
import { mergeSettings } from "@lurkloot/shared/settings";
import type { DropCampaign, EngineSettings, ExtensionSettings, PlatformSettings } from "@lurkloot/shared/models";

const ELIGIBLE_ALL: EngineSettings["farmingEligibility"] = {
  farmUnlinkedCampaigns: true,
  farmSubscriptionCampaigns: true,
};

const FARM_ALL_CATEGORIES: Pick<PlatformSettings, "categoryMode" | "categories"> = {
  categoryMode: "all",
  categories: [],
};

const SHOW_ALL: ExtensionSettings["dropsListFilter"] = {
  showUpcoming: true,
  showExpired: true,
  showFinished: true,
  showExcluded: true,
  showNotLinked: true,
  showSubscription: true,
};

// Every display flag off — including the two class flags — so any campaign that
// stays visible does so because farming forces it, not because a flag is on.
const ALL_OFF: ExtensionSettings["dropsListFilter"] = {
  showUpcoming: false,
  showExpired: false,
  showFinished: false,
  showExcluded: false,
  showNotLinked: false,
  showSubscription: false,
};

// Builds a full ExtensionSettings so isCampaignVisible/campaignFarmable — which
// both now read one settings object — can be exercised with the same terse
// per-axis overrides the old piecemeal-argument tests used.
function settings(overrides: {
  dropsListFilter?: ExtensionSettings["dropsListFilter"];
  farmingEligibility?: EngineSettings["farmingEligibility"];
  excludedCampaignIds?: string[];
  categorySelection?: Pick<PlatformSettings, "categoryMode" | "categories">;
} = {}): ExtensionSettings {
  const base = mergeSettings(undefined);
  const categorySelection = overrides.categorySelection ?? FARM_ALL_CATEGORIES;
  return {
    ...base,
    dropsListFilter: overrides.dropsListFilter ?? SHOW_ALL,
    farmingEligibility: overrides.farmingEligibility ?? ELIGIBLE_ALL,
    excludedCampaignIds: overrides.excludedCampaignIds ?? [],
    platform: {
      twitch: { ...base.platform.twitch, ...categorySelection },
      kick: { ...base.platform.kick, ...categorySelection },
    },
  };
}

function visible(campaign: DropCampaign, overrides: Parameters<typeof settings>[0] = {}): boolean {
  const s = settings(overrides);
  return isCampaignVisible(campaign, s, new Set(s.excludedCampaignIds));
}

function campaign(overrides: Partial<DropCampaign> = {}): DropCampaign {
  return {
    id: "campaign",
    platform: "kick",
    name: "Campaign",
    status: "active",
    rewards: [{
      id: "reward",
      name: "Reward",
      requiredMinutes: 30,
      requirement: "watch",
      isWatchBased: true,
      watchedMinutes: 0,
      status: "locked",
    }],
    connectionUrls: [],
    ...overrides,
  } as DropCampaign;
}

// A campaign that requires a subscription (mixed subscription/watch).
function subscriptionCampaign(overrides: Partial<DropCampaign> = {}): DropCampaign {
  return campaign({
    rewards: [{
      id: "sub",
      name: "Subscriber reward",
      requiredMinutes: 0,
      requirement: "subscription",
      requiredSubs: 1,
      watchedMinutes: 0,
      status: "locked",
    }],
    ...overrides,
  });
}

describe("campaignPassesFarmingEligibility", () => {
  it("skips an unlinked campaign only when farmUnlinkedCampaigns is off", () => {
    const off = { ...ELIGIBLE_ALL, farmUnlinkedCampaigns: false };
    expect(campaignPassesFarmingEligibility(campaign({ accountLinked: false }), off)).toBe(false);
    expect(campaignPassesFarmingEligibility(campaign({ accountLinked: true }), off)).toBe(true);
    expect(campaignPassesFarmingEligibility(campaign({ accountLinked: false }), ELIGIBLE_ALL)).toBe(true);
  });

  it("skips a subscription campaign only when farmSubscriptionCampaigns is off", () => {
    const off = { ...ELIGIBLE_ALL, farmSubscriptionCampaigns: false };
    expect(campaignPassesFarmingEligibility(subscriptionCampaign(), off)).toBe(false);
    expect(campaignPassesFarmingEligibility(subscriptionCampaign(), ELIGIBLE_ALL)).toBe(true);
  });

  it("passes an ordinary campaign regardless of display flags", () => {
    expect(campaignPassesFarmingEligibility(campaign(), ELIGIBLE_ALL)).toBe(true);
  });
});

describe("campaignFarmable", () => {
  // The single shared definition consumed by both the scheduler (isEligible)
  // and the popup (isCampaignVisible). These mirror what used to be the private
  // engine-only isEligible tests, now directly testable since the predicate is
  // exported from shared.
  it("is true for an ordinary active campaign with an earnable reward", () => {
    expect(campaignFarmable(campaign(), settings())).toBe(true);
  });

  it("is false once every reward is claimed", () => {
    const c = campaign({ rewards: [{ ...campaign().rewards[0]!, status: "claimed" }] });
    expect(campaignFarmable(c, settings())).toBe(false);
  });

  it("is false for a non-active status", () => {
    expect(campaignFarmable(campaign({ status: "expired" }), settings())).toBe(false);
    expect(campaignFarmable(campaign({ status: "upcoming" }), settings())).toBe(false);
  });

  it("is false for an ended campaign even while status is still active", () => {
    const c = campaign({ endsAt: new Date(Date.now() - 1000).toISOString() });
    expect(campaignFarmable(c, settings())).toBe(false);
  });

  it("is false when eligibility says otherwise", () => {
    expect(campaignFarmable(campaign({ eligibility: "expired" }), settings())).toBe(false);
  });

  it("is false for an excluded campaign", () => {
    const s = settings({ excludedCampaignIds: ["campaign"] });
    expect(campaignFarmable(campaign(), s)).toBe(false);
  });

  it("is false when the class flag turns off unlinked or subscription farming", () => {
    expect(campaignFarmable(campaign({ accountLinked: false }), settings({ farmingEligibility: { ...ELIGIBLE_ALL, farmUnlinkedCampaigns: false } }))).toBe(false);
    expect(campaignFarmable(subscriptionCampaign(), settings({ farmingEligibility: { ...ELIGIBLE_ALL, farmSubscriptionCampaigns: false } }))).toBe(false);
  });

  it("is false outside the selected categories in include mode", () => {
    const c = campaign({ gameName: "Other Game" });
    const s = settings({ categorySelection: { categoryMode: "include", categories: [{ id: "selected-game", name: "Selected Game" }] } });
    expect(campaignFarmable(c, s)).toBe(false);
  });

  it("is false for an unlinked Twitch campaign even with farmUnlinkedCampaigns on (platform block)", () => {
    const c = campaign({ platform: "twitch", accountLinked: false });
    expect(campaignFarmable(c, settings())).toBe(false);
  });

  it("is true for an unlinked Kick campaign (no platform block)", () => {
    const c = campaign({ platform: "kick", accountLinked: false });
    expect(campaignFarmable(c, settings())).toBe(true);
  });

  it("is false when the only reward's precondition is not met", () => {
    const c = campaign({ rewards: [{ ...campaign().rewards[0]!, preconditionsMet: false }] });
    expect(campaignFarmable(c, settings())).toBe(false);
  });

  it("is false when the reward's deadline is infeasible under skipUnfinishableRewards", () => {
    const c = campaign({
      endsAt: new Date(Date.now() + 60_000).toISOString(), // ends in 1 minute
      rewards: [{ ...campaign().rewards[0]!, requiredMinutes: 120, watchedMinutes: 0 }], // needs 2 hours
    });
    expect(campaignFarmable(c, settings())).toBe(false);
  });

  it("is true when skipUnfinishableRewards is off despite an infeasible deadline", () => {
    const c = campaign({
      endsAt: new Date(Date.now() + 60_000).toISOString(),
      rewards: [{ ...campaign().rewards[0]!, requiredMinutes: 120, watchedMinutes: 0 }],
    });
    const s: ExtensionSettings = { ...settings(), skipUnfinishableRewards: false };
    expect(campaignFarmable(c, s)).toBe(true);
  });
});

describe("isCampaignVisible not-linked / subscription class flags", () => {
  // These two classes are visible when campaignFarmable(...) says true (the
  // invariant: a farmable campaign is always visible) OR the class's own
  // display flag is on. The class flags below (farmUnlinkedCampaigns /
  // farmSubscriptionCampaigns) only matter insofar as they feed into
  // campaignFarmable; isCampaignVisible itself no longer reads them directly.
  const NOT_FARMED_UNLINKED = { ...ELIGIBLE_ALL, farmUnlinkedCampaigns: false };
  const NOT_FARMED_SUBSCRIPTION = { ...ELIGIBLE_ALL, farmSubscriptionCampaigns: false };

  it("hides a not-linked campaign only when it is not farmed and showNotLinked is off", () => {
    const c = campaign({ accountLinked: false });
    // Not farmed + hidden → gone.
    expect(visible(c, { dropsListFilter: { ...SHOW_ALL, showNotLinked: false }, farmingEligibility: NOT_FARMED_UNLINKED })).toBe(false);
    // Not farmed + shown → visible.
    expect(visible(c, { dropsListFilter: { ...SHOW_ALL, showNotLinked: true }, farmingEligibility: NOT_FARMED_UNLINKED })).toBe(true);
  });

  it("keeps a farmed not-linked campaign visible even with showNotLinked off (invariant)", () => {
    const c = campaign({ accountLinked: false });
    // Farming this class forces visibility regardless of the display flag.
    expect(campaignPassesFarmingEligibility(c, ELIGIBLE_ALL)).toBe(true);
    expect(visible(c, { dropsListFilter: { ...SHOW_ALL, showNotLinked: false }, farmingEligibility: ELIGIBLE_ALL })).toBe(true);
  });

  it("hides a subscription campaign only when it is not farmed and showSubscription is off", () => {
    const c = subscriptionCampaign();
    expect(visible(c, { dropsListFilter: { ...SHOW_ALL, showSubscription: false }, farmingEligibility: NOT_FARMED_SUBSCRIPTION })).toBe(false);
    expect(visible(c, { dropsListFilter: { ...SHOW_ALL, showSubscription: true }, farmingEligibility: NOT_FARMED_SUBSCRIPTION })).toBe(true);
  });

  it("keeps a farmed subscription campaign visible even with showSubscription off (invariant)", () => {
    // A pure, still-locked subscription reward is never reward-level farmable —
    // there is nothing to actively watch, only a subscription to wait for — so
    // farmSubscriptionCampaigns alone cannot force it visible; only a mixed
    // campaign with a genuinely earnable watch reward can exercise the
    // farming-forces-visible invariant for this class.
    const c = subscriptionCampaign({
      rewards: [
        { id: "sub", name: "Subscriber reward", requiredMinutes: 0, requirement: "subscription", requiredSubs: 1, watchedMinutes: 0, status: "locked" },
        { id: "watch", name: "Watch reward", requiredMinutes: 30, requirement: "watch", isWatchBased: true, watchedMinutes: 0, status: "locked" },
      ],
    });
    expect(campaignFarmable(c, settings({ farmingEligibility: ELIGIBLE_ALL }))).toBe(true);
    expect(visible(c, { dropsListFilter: { ...SHOW_ALL, showSubscription: false }, farmingEligibility: ELIGIBLE_ALL })).toBe(true);
  });
});

describe("isCampaignVisible display flags", () => {
  it("hides upcoming campaigns unless showUpcoming is on", () => {
    const c = campaign({ status: "upcoming" });
    expect(visible(c, { dropsListFilter: { ...SHOW_ALL, showUpcoming: false } })).toBe(false);
    expect(visible(c, { dropsListFilter: { ...SHOW_ALL, showUpcoming: true } })).toBe(true);
  });

  it("hides expired campaigns unless showExpired is on", () => {
    const c = campaign({ status: "expired" });
    expect(visible(c, { dropsListFilter: { ...SHOW_ALL, showExpired: false } })).toBe(false);
    expect(visible(c, { dropsListFilter: { ...SHOW_ALL, showExpired: true } })).toBe(true);
  });

  it("hides finished campaigns unless showFinished is on", () => {
    const c = campaign({
      rewards: [{
        id: "reward",
        name: "Reward",
        requiredMinutes: 30,
        requirement: "watch",
        isWatchBased: true,
        watchedMinutes: 30,
        status: "claimed",
      }],
    });
    expect(visible(c, { dropsListFilter: { ...SHOW_ALL, showFinished: false } })).toBe(false);
    expect(visible(c, { dropsListFilter: { ...SHOW_ALL, showFinished: true } })).toBe(true);
  });

  it("hides excluded campaigns unless showExcluded is on", () => {
    const c = campaign();
    expect(visible(c, { dropsListFilter: { ...SHOW_ALL, showExcluded: false }, excludedCampaignIds: ["campaign"] })).toBe(false);
    expect(visible(c, { dropsListFilter: { ...SHOW_ALL, showExcluded: true }, excludedCampaignIds: ["campaign"] })).toBe(true);
  });

  it("finished wins over expired precedence", () => {
    // A claimed, past-end campaign is finished, not expired: showFinished governs.
    const c = campaign({
      status: "expired",
      endsAt: new Date(Date.now() - 1000).toISOString(),
      rewards: [{
        id: "reward",
        name: "Reward",
        requiredMinutes: 30,
        requirement: "watch",
        isWatchBased: true,
        watchedMinutes: 30,
        status: "claimed",
      }],
    });
    expect(visible(c, { dropsListFilter: { ...SHOW_ALL, showFinished: false, showExpired: true } })).toBe(false);
  });

  it("keeps the claimable escape hatch even when every display flag is off", () => {
    const c = campaign({
      status: "expired",
      rewards: [{
        id: "reward",
        name: "Reward",
        requiredMinutes: 30,
        requirement: "watch",
        isWatchBased: true,
        watchedMinutes: 30,
        status: "claimable",
      }],
    });
    expect(visible(c, { dropsListFilter: ALL_OFF, excludedCampaignIds: ["campaign"] })).toBe(true);
  });
});

describe("campaignFilterCategories", () => {
  it("tags an excluded campaign", () => {
    expect(campaignFilterCategories(campaign(), new Set(["campaign"]))).toContain("excluded");
  });

  it("treats an active campaign with an upcoming eligibility as upcoming", () => {
    // The engine categorises by eligibility, not just status; the display must
    // agree or a showUpcoming: false filter leaks a campaign the engine hides.
    const c = campaign({ status: "active", eligibility: "upcoming" });
    expect(campaignFilterCategories(c, new Set())).toContain("upcoming");
  });

  it("treats an active campaign with an expired eligibility as expired", () => {
    const c = campaign({ status: "active", eligibility: "expired" });
    expect(campaignFilterCategories(c, new Set())).toContain("expired");
  });

  it("treats an active campaign with a completed eligibility as finished", () => {
    const c = campaign({ status: "active", eligibility: "completed" });
    expect(campaignFilterCategories(c, new Set())).toContain("finished");
  });
});

describe("eligibility-driven lifecycle hides in the Drops list", () => {
  // Aligning display with the engine's eligibility view: none of these states is
  // farmable (campaignFarmable rejects any eligibility !== "eligible"), so hiding
  // them cannot hide a farmable campaign.
  it("hides an active/upcoming-eligibility campaign when showUpcoming is off", () => {
    const c = campaign({ status: "active", eligibility: "upcoming" });
    expect(visible(c, { dropsListFilter: ALL_OFF })).toBe(false);
    expect(visible(c, { dropsListFilter: { ...ALL_OFF, showUpcoming: true } })).toBe(true);
  });

  it("hides an active/expired-eligibility campaign when showExpired is off", () => {
    const c = campaign({ status: "active", eligibility: "expired" });
    expect(visible(c, { dropsListFilter: ALL_OFF })).toBe(false);
    expect(visible(c, { dropsListFilter: { ...ALL_OFF, showExpired: true } })).toBe(true);
  });

  it("hides an active/completed-eligibility campaign when showFinished is off", () => {
    const c = campaign({ status: "active", eligibility: "completed" });
    expect(visible(c, { dropsListFilter: ALL_OFF })).toBe(false);
    expect(visible(c, { dropsListFilter: { ...ALL_OFF, showFinished: true } })).toBe(true);
  });
});

describe("visibility invariant: every farmable campaign stays visible", () => {
  // This binds the popup's visibility predicate to the engine's farming rule:
  // anything the engine would farm MUST remain visible with every display flag
  // off. A campaign the engine farms is active, not ended, eligibility
  // "eligible" (or absent), and has an earnable reward — regardless of link
  // status or subscription requirement, since farmUnlinkedCampaigns and
  // farmSubscriptionCampaigns both default to on. ALL_OFF turns off every
  // display flag INCLUDING showNotLinked/showSubscription, so the not-linked and
  // subscription cases here specifically prove that farming-on overrides the
  // class show-flags. It must return true for all of these. If a future change
  // makes a farmable campaign hideable, this fails.

  // The kind of campaign the engine actually farms: active, eligible, with an
  // unclaimed watch reward that still has minutes to earn.
  const farmable: DropCampaign[] = [
    // Ordinary active campaign.
    campaign({ eligibility: "eligible" }),
    // Active campaign, eligibility left absent (also farmed).
    campaign(),
    // Unlinked campaign — still farmed because farmUnlinkedCampaigns defaults on
    // and the default platform is Kick, which has no unlink block.
    campaign({ accountLinked: false }),
    // Subscription-gated campaign — still farmed because farmSubscriptionCampaigns
    // defaults on and it carries an earnable watch reward.
    subscriptionCampaign({
      rewards: [{
        id: "watch",
        name: "Watch reward",
        requiredMinutes: 30,
        requirement: "watch",
        isWatchBased: true,
        watchedMinutes: 0,
        status: "locked",
      }],
    }),
  ];

  it("keeps every farmable campaign visible with all display flags off", () => {
    for (const c of farmable) {
      const s = settings({ dropsListFilter: ALL_OFF });
      expect(campaignFarmable(c, s)).toBe(true);
      expect(isCampaignVisible(c, s, new Set())).toBe(true);
    }
  });
});

describe("isCampaignVisible category selection", () => {
  const selectedOnly: Pick<PlatformSettings, "categoryMode" | "categories"> = {
    categoryMode: "include",
    categories: [{ id: "selected-game", name: "Selected Game" }],
  };
  const allButSelected: Pick<PlatformSettings, "categoryMode" | "categories"> = {
    categoryMode: "exclude",
    categories: [{ id: "selected-game", name: "Selected Game" }],
  };

  it("hides a campaign outside the selected categories in include mode", () => {
    const c = campaign({ gameName: "Other Game" });
    expect(visible(c, { categorySelection: selectedOnly })).toBe(false);
  });

  it("keeps a campaign in the selected categories visible", () => {
    const c = campaign({ gameName: "Selected Game" });
    expect(visible(c, { categorySelection: selectedOnly })).toBe(true);
  });

  it("shows every campaign in all mode regardless of the list", () => {
    const c = campaign({ gameName: "Other Game" });
    expect(visible(c, { categorySelection: { categoryMode: "all", categories: [] } })).toBe(true);
  });

  it("inverts the same list in exclude mode", () => {
    expect(visible(campaign({ gameName: "Selected Game" }), { categorySelection: allButSelected })).toBe(false);
    expect(visible(campaign({ gameName: "Other Game" }), { categorySelection: allButSelected })).toBe(true);
  });

  it("shows every campaign when the exclude list is empty", () => {
    const c = campaign({ gameName: "Other Game" });
    expect(visible(c, { categorySelection: { categoryMode: "exclude", categories: [] } })).toBe(true);
  });

  it("keeps a claimable reward visible even when its category is excluded", () => {
    const c = campaign({
      gameName: "Selected Game",
      rewards: [{ id: "reward", name: "Reward", requiredMinutes: 30, requirement: "watch", isWatchBased: true, watchedMinutes: 30, status: "claimable" }],
    });
    expect(visible(c, { dropsListFilter: ALL_OFF, categorySelection: allButSelected })).toBe(true);
  });

  it("keeps a claimable reward visible even outside the selected categories", () => {
    const c = campaign({
      gameName: "Other Game",
      rewards: [{
        id: "reward",
        name: "Reward",
        requiredMinutes: 30,
        requirement: "watch",
        isWatchBased: true,
        watchedMinutes: 30,
        status: "claimable",
      }],
    });
    expect(visible(c, { categorySelection: selectedOnly })).toBe(true);
  });

  it("matches the engine's farming rule: a category-filtered-out campaign is never farmable either", () => {
    const c = campaign({ gameName: "Other Game" });
    expect(visible(c, { dropsListFilter: ALL_OFF, categorySelection: selectedOnly })).toBe(false);
  });

  // The category filter has no display-flag override anywhere, so it wins over
  // every other bucket — even ones with their own flag turned fully on — for a
  // campaign that is ALSO in that other bucket's class.
  it("hides an excluded campaign outside the selected categories even with showExcluded on", () => {
    const c = campaign({ gameName: "Other Game" });
    expect(visible(c, { dropsListFilter: SHOW_ALL, excludedCampaignIds: ["campaign"], categorySelection: selectedOnly })).toBe(false);
  });

  it("hides a finished campaign outside the selected categories even with showFinished on", () => {
    const c = campaign({
      gameName: "Other Game",
      rewards: [{ ...campaign().rewards[0]!, status: "claimed" }],
    });
    expect(visible(c, { dropsListFilter: SHOW_ALL, categorySelection: selectedOnly })).toBe(false);
  });

  it("hides an upcoming campaign outside the selected categories even with showUpcoming on", () => {
    const c = campaign({ status: "upcoming", gameName: "Other Game" });
    expect(visible(c, { dropsListFilter: SHOW_ALL, categorySelection: selectedOnly })).toBe(false);
  });

  it("hides a not-linked campaign outside the selected categories even with showNotLinked on", () => {
    const c = campaign({ accountLinked: false, gameName: "Other Game" });
    expect(visible(c, { dropsListFilter: SHOW_ALL, categorySelection: selectedOnly })).toBe(false);
  });

  it("hides a subscription campaign outside the selected categories even with showSubscription on", () => {
    const c = subscriptionCampaign({ gameName: "Other Game" });
    expect(visible(c, { dropsListFilter: SHOW_ALL, categorySelection: selectedOnly })).toBe(false);
  });

  it("shows a not-linked campaign in the selected categories, governed by showNotLinked as usual", () => {
    // farmUnlinkedCampaigns off so campaignEligibleClass is false for a reason
    // OTHER than category, landing this campaign in the showNotLinked bucket.
    const c = campaign({ accountLinked: false, gameName: "Selected Game" });
    const farmingEligibility = { ...ELIGIBLE_ALL, farmUnlinkedCampaigns: false };
    expect(visible(c, { dropsListFilter: { ...SHOW_ALL, showNotLinked: false }, farmingEligibility, categorySelection: selectedOnly })).toBe(false);
    expect(visible(c, { dropsListFilter: { ...SHOW_ALL, showNotLinked: true }, farmingEligibility, categorySelection: selectedOnly })).toBe(true);
  });
});

describe("isCampaignVisible stays visible despite reward-timing infeasibility", () => {
  // A campaign whose only reward is momentarily un-farmable for TIMING reasons
  // (deadline infeasible under skipUnfinishableRewards, an unmet precondition on
  // a locked follow-up reward) must NOT vanish from the list, even though
  // campaignFarmable (and therefore isEligible) correctly refuses to farm it:
  // the user still needs to see it to adjust settings, or — in "priority list
  // only" mode — drag it into their priority list, which is the only way to
  // ever make it farmable there. prioritiesFromOrder (popup-ui) builds
  // campaignPriorities purely from the rendered/visible list order, so a hidden
  // campaign could never be prioritized: hiding it here would be a regression,
  // not a stricter invariant.
  it("stays visible when the only reward has an infeasible deadline, but is not farmable", () => {
    const c = campaign({
      endsAt: new Date(Date.now() + 60_000).toISOString(),
      rewards: [{ ...campaign().rewards[0]!, requiredMinutes: 120, watchedMinutes: 0 }],
    });
    expect(campaignFarmable(c, settings())).toBe(false);
    expect(visible(c)).toBe(true);
  });

  it("stays visible when the only reward's precondition is not met, but is not farmable", () => {
    const c = campaign({ rewards: [{ ...campaign().rewards[0]!, preconditionsMet: false }] });
    expect(campaignFarmable(c, settings())).toBe(false);
    expect(visible(c)).toBe(true);
  });

  it("is also farmable once the reward's timing becomes feasible again", () => {
    const c = campaign({ rewards: [{ ...campaign().rewards[0]!, preconditionsMet: true }] });
    expect(campaignFarmable(c, settings())).toBe(true);
    expect(visible(c)).toBe(true);
  });
});
