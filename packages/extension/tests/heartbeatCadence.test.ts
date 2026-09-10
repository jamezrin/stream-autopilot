import { describe, expect, it } from "vitest";
import type { ChannelCandidate, DropCampaign, ExtensionSettings, SchedulerState, WatchSession } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import { runSchedulerTick } from "@lurkloot/core/scheduler";
import { heartbeatContextKey, nextHeartbeatDueAt } from "@lurkloot/core/heartbeatCadence";

function tablessSession(patch: Partial<WatchSession> = {}): WatchSession {
  const channel: ChannelCandidate = {
    platform: "twitch",
    username: "channel",
    displayName: "Channel",
    url: "https://www.twitch.tv/channel",
    broadcastId: "broadcast",
    channelId: "channel-id",
  };
  return {
    platform: "twitch",
    channel,
    campaignId: "campaign",
    rewardId: "reward",
    status: "watching",
    watchMode: "tabless",
    offlineChecks: 0,
    ...patch,
  };
}

describe("tabless heartbeat cadence", () => {
  it("anchors the next heartbeat to the previous due time", () => {
    expect(nextHeartbeatDueAt(1_000, 66_250)).toBe(121_000);
  });

  it("skips every missed slot after a late timer", () => {
    expect(nextHeartbeatDueAt(1_000, 190_000)).toBe(241_000);
  });

  it("keys the complete normalized watch target", () => {
    const session = tablessSession({ campaignId: "campaign", rewardId: "reward" });
    expect(heartbeatContextKey(session)).toContain("campaign");
    expect(heartbeatContextKey(session)).toContain("reward");
    expect(heartbeatContextKey({ ...session, channel: undefined })).toBeUndefined();
  });

  it("changes the normalized context key when the channel category changes", () => {
    const first = tablessSession({
      platform: "kick",
      channel: {
        platform: "kick",
        username: "channel",
        url: "https://kick.com/channel",
        categoryId: "category-a",
      },
    });
    const second = {
      ...first,
      channel: { ...first.channel!, categoryId: "category-b" },
    };

    expect(heartbeatContextKey(first)).not.toBe(heartbeatContextKey(second));
    expect(heartbeatContextKey(first)).toContain("category-a");
    expect(heartbeatContextKey(second)).toContain("category-b");
  });
});

function heartbeatCampaign(id = "campaign", rewardId = "reward"): DropCampaign {
  return {
    id,
    platform: "twitch",
    name: id,
    status: "active",
    rewards: [{
      id: rewardId,
      name: rewardId,
      requiredMinutes: 60,
      watchedMinutes: 0,
      status: "in_progress",
    }],
  };
}

function heartbeatAdapter(
  campaigns: DropCampaign[],
  candidates: ChannelCandidate[],
  supportsTabless = true,
): PlatformAdapter {
  return {
    platform: "twitch",
    supportsTabless,
    checkAuthHealth: async () => ({ status: "healthy" }),
    refreshCampaigns: async () => campaigns,
    listCandidateChannels: async () => candidates,
    checkChannel: async (candidate) => ({ live: true, categoryMatches: true, candidate }),
    claimReward: async () => true,
    prepareWatchTab: async () => ({ tabId: 42, managedByExtension: true }),
    stopWatchTab: async () => undefined,
  };
}

function heartbeatSettings(tablessMode: boolean): ExtensionSettings {
  return {
    ...DEFAULT_SETTINGS,
    tablessMode,
    platform: {
      ...DEFAULT_SETTINGS.platform,
      twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
      kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
    },
  };
}

function heartbeatState(session: WatchSession, campaigns: DropCampaign[]): SchedulerState {
  return {
    authHealth: { twitch: { status: "healthy" }, kick: { status: "healthy" } },
    sessions: {
      twitch: session,
      kick: { platform: "kick", status: "idle", offlineChecks: 0 },
    },
    campaigns: { twitch: campaigns, kick: [] },
  };
}

const PERSISTED_CONTEXT_KEY = "[\"twitch\",\"https://www.twitch.tv/channel\",\"channel\",\"broadcast\",\"channel-id\",\"\",\"campaign\",\"reward\"]";

describe("scheduler tabless heartbeat cadence state", () => {
  it("retains cadence metadata when the normalized tabless target is unchanged", async () => {
    const session = tablessSession({
      tablessHeartbeat: {
        generation: 3,
        contextKey: PERSISTED_CONTEXT_KEY,
        nextDueAt: "2026-09-02T20:10:00.000Z",
      },
    });
    const campaigns = [heartbeatCampaign()];

    const result = await runSchedulerTick(
      heartbeatState(session, campaigns),
      heartbeatSettings(true),
      { twitch: heartbeatAdapter(campaigns, [session.channel!]), kick: heartbeatAdapter([], [], false) },
      { platforms: ["twitch"] },
    );

    expect(result.state.sessions.twitch.tablessHeartbeat).toEqual(session.tablessHeartbeat);
  });

  it("clears cadence metadata when a tabless watch switches to a visible tab", async () => {
    const session = tablessSession({
      tablessHeartbeat: {
        generation: 3,
        contextKey: PERSISTED_CONTEXT_KEY,
        nextDueAt: "2026-09-02T20:10:00.000Z",
      },
    });
    const campaigns = [heartbeatCampaign()];

    const result = await runSchedulerTick(
      heartbeatState(session, campaigns),
      heartbeatSettings(false),
      { twitch: heartbeatAdapter(campaigns, [session.channel!], false), kick: heartbeatAdapter([], [], false) },
      { platforms: ["twitch"] },
    );

    expect(result.state.sessions.twitch.watchMode).toBe("tab");
    expect(result.state.sessions.twitch.tablessHeartbeat).toBeUndefined();
  });

  it("clears cadence metadata when a watch stops", async () => {
    const session = tablessSession({
      tablessHeartbeat: {
        generation: 3,
        contextKey: PERSISTED_CONTEXT_KEY,
        nextDueAt: "2026-09-02T20:10:00.000Z",
      },
    });
    const stopped = await runSchedulerTick(
      heartbeatState(session, []),
      heartbeatSettings(true),
      { twitch: heartbeatAdapter([], []), kick: heartbeatAdapter([], [], false) },
      { platforms: ["twitch"] },
    );
    expect(stopped.state.sessions.twitch.status).toBe("idle");
    expect(stopped.state.sessions.twitch.tablessHeartbeat).toBeUndefined();
  });

  it("clears cadence metadata when a watch changes target", async () => {
    const session = tablessSession({
      tablessHeartbeat: {
        generation: 3,
        contextKey: PERSISTED_CONTEXT_KEY,
        nextDueAt: "2026-09-02T20:10:00.000Z",
      },
    });
    const campaigns = [heartbeatCampaign()];
    const nextCampaign = heartbeatCampaign("next-campaign", "next-reward");
    const nextChannel = { ...session.channel!, username: "next-channel", url: "https://www.twitch.tv/next-channel" };
    const changed = await runSchedulerTick(
      heartbeatState(session, campaigns),
      heartbeatSettings(true),
      { twitch: heartbeatAdapter([nextCampaign], [nextChannel]), kick: heartbeatAdapter([], [], false) },
      { platforms: ["twitch"] },
    );
    expect(changed.state.sessions.twitch.channel?.url).toBe(nextChannel.url);
    expect(changed.state.sessions.twitch.tablessHeartbeat).toBeUndefined();
  });

  it("clears cadence metadata when a live stream identity changes", async () => {
    const session = tablessSession({
      tablessHeartbeat: {
        generation: 3,
        contextKey: PERSISTED_CONTEXT_KEY,
        nextDueAt: "2026-09-02T20:10:00.000Z",
      },
    });
    const campaigns = [heartbeatCampaign()];
    const adapter = heartbeatAdapter(campaigns, [session.channel!]);
    adapter.checkChannel = async (candidate) => ({
      live: true,
      categoryMatches: true,
      candidate: { ...candidate, broadcastId: "next-broadcast" },
    });

    const changed = await runSchedulerTick(
      heartbeatState(session, campaigns),
      heartbeatSettings(true),
      { twitch: adapter, kick: heartbeatAdapter([], [], false) },
      { platforms: ["twitch"] },
    );

    expect(changed.state.sessions.twitch.channel?.broadcastId).toBe("next-broadcast");
    expect(changed.state.sessions.twitch.tablessHeartbeat).toBeUndefined();
  });
});
