import { describe, expect, it } from "vitest";
import { evaluateCampaignFarming } from "@lurkloot/shared/campaignFarming";
import type { DropCampaign, ExtensionSettings } from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";

const NOW = Date.parse("2026-08-15T10:00:00.000Z");

function settings(overrides: Partial<ExtensionSettings> = {}): ExtensionSettings {
  const base = mergeSettings(undefined);
  return {
    ...base,
    ...overrides,
    platform: overrides.platform ?? base.platform,
    farmingEligibility: overrides.farmingEligibility ?? base.farmingEligibility,
  };
}

function campaign(overrides: Partial<DropCampaign> = {}): DropCampaign {
  return {
    id: "campaign",
    platform: "twitch",
    name: "Campaign",
    status: "active",
    accountLinked: true,
    rewards: [{
      id: "reward",
      name: "Reward",
      requiredMinutes: 60,
      watchedMinutes: 0,
      status: "locked",
      requirement: "watch",
      isWatchBased: true,
    }],
    connectionUrls: [],
    ...overrides,
  };
}

describe("evaluateCampaignFarming", () => {
  it.each([
    ["excluded", campaign(), settings({ excludedCampaignIds: ["campaign"] })],
    ["upcoming", campaign({ status: "upcoming" }), settings()],
    ["expired", campaign({ status: "expired" }), settings()],
    ["completed", campaign({ status: "completed" }), settings()],
    ["twitch_link_required", campaign({ accountLinked: false }), settings()],
    ["no_rewards", campaign({ rewards: [] }), settings()],
  ] as const)("returns %s for a rejected campaign", (code, source, currentSettings) => {
    expect(evaluateCampaignFarming(source, currentSettings, { now: NOW })).toMatchObject({
      farmable: false,
      code,
    });
  });

  it("distinguishes a disabled unlinked class from Twitch's platform requirement", () => {
    const currentSettings = settings({
      farmingEligibility: {
        farmUnlinkedCampaigns: false,
        farmSubscriptionCampaigns: true,
      },
    });
    expect(evaluateCampaignFarming(campaign({ platform: "kick", accountLinked: false }), currentSettings, { now: NOW }))
      .toMatchObject({ farmable: false, code: "unlinked_campaigns_disabled" });
  });

  it("returns category_filtered before inspecting rewards in include mode", () => {
    const currentSettings = settings();
    currentSettings.platform.twitch = {
      ...currentSettings.platform.twitch,
      categoryMode: "include",
      categories: [{ id: "other", name: "Other" }],
    };
    expect(evaluateCampaignFarming(campaign({ categoryId: "game" }), currentSettings, { now: NOW }))
      .toMatchObject({ farmable: false, code: "category_filtered" });
  });

  it("returns category_filtered for a listed category in exclude mode", () => {
    const currentSettings = settings();
    currentSettings.platform.twitch = {
      ...currentSettings.platform.twitch,
      categoryMode: "exclude",
      categories: [{ id: "game", name: "Game" }],
    };
    expect(evaluateCampaignFarming(campaign({ categoryId: "game" }), currentSettings, { now: NOW }))
      .toMatchObject({ farmable: false, code: "category_filtered" });
    expect(evaluateCampaignFarming(campaign({ categoryId: "other" }), currentSettings, { now: NOW }))
      .toEqual({ farmable: true });
  });

  it("farms everything when the exclude list is empty", () => {
    const currentSettings = settings();
    currentSettings.platform.twitch = { ...currentSettings.platform.twitch, categoryMode: "exclude", categories: [] };
    expect(evaluateCampaignFarming(campaign({ categoryId: "game" }), currentSettings, { now: NOW }))
      .toEqual({ farmable: true });
  });

  it("returns priority_not_selected only when priority-list-only evaluation is requested", () => {
    const currentSettings = settings({ priorityMode: "priority_list_only" });
    expect(evaluateCampaignFarming(campaign(), currentSettings, { now: NOW, includePriorityMode: true }))
      .toMatchObject({ farmable: false, code: "priority_not_selected" });
    expect(evaluateCampaignFarming(campaign(), currentSettings, { now: NOW })).toEqual({ farmable: true });
  });

  it.each([
    ["reward_prerequisites_unmet", { preconditionsMet: false }],
    ["reward_not_started", { availableFrom: "2026-08-15T11:00:00.000Z" }],
    ["reward_window_ended", { availableUntil: "2026-08-15T09:00:00.000Z" }],
  ] as const)("returns %s with reward context", (code, rewardOverrides) => {
    const source = campaign({ rewards: [{ ...campaign().rewards[0]!, ...rewardOverrides }] });
    expect(evaluateCampaignFarming(source, settings(), { now: NOW })).toMatchObject({
      farmable: false,
      code,
      rewardId: "reward",
      rewardName: "Reward",
    });
  });

  it("returns insufficient_time with actionable deadline context", () => {
    const source = campaign({
      endsAt: "2026-08-15T10:30:00.000Z",
      rewards: [{ ...campaign().rewards[0]!, requiredMinutes: 60, watchedMinutes: 10 }],
    });
    expect(evaluateCampaignFarming(source, settings(), { now: NOW })).toEqual({
      farmable: false,
      code: "insufficient_time",
      rewardId: "reward",
      rewardName: "Reward",
      deadline: "2026-08-15T10:30:00.000Z",
      remainingMinutes: 50,
      availableMinutes: 30,
      marginMinutes: 5,
    });
  });

  it("returns farmable when any reward can currently be earned", () => {
    expect(evaluateCampaignFarming(campaign(), settings(), { now: NOW })).toEqual({ farmable: true });
  });
});
