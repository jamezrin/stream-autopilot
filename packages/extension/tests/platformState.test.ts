import { describe, expect, it } from "vitest";
import type { Platform, SchedulerState } from "@lurkloot/shared/models";
import { mergePlatformState } from "@lurkloot/core/background/platformState";

function state(label: string, lastTickAt: string): SchedulerState {
  const session = (platform: Platform) => ({
    platform,
    status: "idle" as const,
    offlineChecks: 0,
    message: `${label}-${platform}`,
  });
  return {
    sessions: {
      twitch: session("twitch"),
      kick: session("kick"),
    },
    authHealth: {
      twitch: { status: "healthy" },
      kick: { status: "healthy" },
    },
    campaigns: {
      twitch: [],
      kick: [],
    },
    managedWatchTabs: {
      twitch: {
        platform: "twitch",
        tabId: label === "source" ? 11 : 10,
        channelUrl: `https://www.twitch.tv/${label}`,
        ownedByExtension: true,
      },
      kick: {
        platform: "kick",
        tabId: label === "source" ? 21 : 20,
        channelUrl: `https://kick.com/${label}`,
        ownedByExtension: true,
      },
    },
    deadlineInfeasibleRewardIds: {
      twitch: [`${label}-twitch`],
      kick: [`${label}-kick`],
    },
    campaignSearchBackoffs: {
      twitch: { campaignId: `${label}-twitch`, retryAt: "2099-01-01T00:00:00.000Z", fingerprint: label },
      kick: { campaignId: `${label}-kick`, retryAt: "2099-01-01T00:00:00.000Z", fingerprint: label },
    },
    installedAt: `${label}-installed`,
    lastTickAt,
  };
}

describe("mergePlatformState", () => {
  it("replaces only the owned platform slice and preserves the newest tick time", () => {
    const destination = state("destination", "2026-07-29T12:00:00.000Z");
    const source = state("source", "2026-07-29T11:00:00.000Z");

    const merged = mergePlatformState(destination, source, "twitch");

    expect(merged.sessions.twitch).toEqual(source.sessions.twitch);
    expect(merged.sessions.kick).toEqual(destination.sessions.kick);
    expect(merged.managedWatchTabs?.twitch).toEqual(source.managedWatchTabs?.twitch);
    expect(merged.managedWatchTabs?.kick).toEqual(destination.managedWatchTabs?.kick);
    expect(merged.deadlineInfeasibleRewardIds?.twitch).toEqual(
      source.deadlineInfeasibleRewardIds?.twitch,
    );
    expect(merged.deadlineInfeasibleRewardIds?.kick).toEqual(
      destination.deadlineInfeasibleRewardIds?.kick,
    );
    expect(merged.campaignSearchBackoffs?.twitch).toEqual(source.campaignSearchBackoffs?.twitch);
    expect(merged.campaignSearchBackoffs?.kick).toEqual(destination.campaignSearchBackoffs?.kick);
    expect(merged.installedAt).toBe(destination.installedAt);
    expect(merged.lastTickAt).toBe("2026-07-29T12:00:00.000Z");
  });

  it("deletes absent optional entries only for the owned platform", () => {
    const destination = state("destination", "2026-07-29T11:00:00.000Z");
    const source = state("source", "2026-07-29T12:00:00.000Z");
    delete source.managedWatchTabs?.twitch;
    delete source.deadlineInfeasibleRewardIds?.twitch;

    const merged = mergePlatformState(destination, source, "twitch");

    expect(merged.managedWatchTabs?.twitch).toBeUndefined();
    expect(merged.managedWatchTabs?.kick).toEqual(destination.managedWatchTabs?.kick);
    expect(merged.deadlineInfeasibleRewardIds?.twitch).toBeUndefined();
    expect(merged.deadlineInfeasibleRewardIds?.kick).toEqual(
      destination.deadlineInfeasibleRewardIds?.kick,
    );
    expect(merged.lastTickAt).toBe("2026-07-29T12:00:00.000Z");
  });
});
