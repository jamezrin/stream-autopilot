import { describe, expect, it, vi } from "vitest";
import {
  adapterFromDiscoverySnapshot,
  collectDiscoverySnapshot,
  DiscoverySnapshotLane,
  type DiscoveryRefreshMetrics,
  type DiscoveryRefreshResult,
} from "@lurkloot/core/discoverySnapshot";

const metrics: DiscoveryRefreshMetrics = {
  campaigns: 0,
  candidates: 0,
  cacheHits: 0,
  cacheMisses: 0,
  batchRequests: 0,
  singleFallbacks: 0,
};

const complete = (): DiscoveryRefreshResult => ({ campaigns: [], idleCandidates: [], followedChannels: [], complete: true, metrics });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("DiscoverySnapshotLane", () => {
  it("runs one refresh and retains at most one coalesced pending refresh", async () => {
    const first = deferred<DiscoveryRefreshResult>();
    const second = deferred<DiscoveryRefreshResult>();
    const refresh = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const lane = new DiscoverySnapshotLane("twitch", refresh);

    lane.request();
    lane.request();
    lane.request();
    expect(refresh).toHaveBeenCalledTimes(1);
    first.resolve(complete());
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    second.resolve(complete());
    await lane.settle();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(lane.current().snapshot?.revision).toBe(2);
  });

  it("keeps the latest request context with a coalesced refresh", async () => {
    const first = deferred<DiscoveryRefreshResult>();
    const seen: string[] = [];
    const lane = new DiscoverySnapshotLane<string>("twitch", async ({ request }) => {
      seen.push(request);
      if (seen.length === 1) return first.promise;
      return complete();
    });

    lane.request("first-tick");
    lane.request("superseded-tick");
    lane.request("latest-tick");
    first.resolve(complete());
    await lane.settle();

    expect(seen).toEqual(["first-tick", "latest-tick"]);
  });

  it("lets provider lanes complete independently", async () => {
    const twitchRefresh = deferred<DiscoveryRefreshResult>();
    const twitch = new DiscoverySnapshotLane("twitch", () => twitchRefresh.promise);
    const kick = new DiscoverySnapshotLane("kick", async () => complete());

    twitch.request();
    kick.request();
    await kick.settle();
    expect(kick.current().snapshot?.revision).toBe(1);
    expect(twitch.current().snapshot).toBeUndefined();
    twitchRefresh.resolve(complete());
    await twitch.settle();
  });

  it("retains the last coherent snapshot after failed and incomplete attempts", async () => {
    const refresh = vi.fn()
      .mockResolvedValueOnce(complete())
      .mockResolvedValueOnce({ campaigns: [], idleCandidates: [], followedChannels: [], complete: false, failure: "partial", metrics })
      .mockRejectedValueOnce(new Error("offline"));
    const lane = new DiscoverySnapshotLane("kick", refresh);

    lane.request();
    await lane.settle();
    const coherent = lane.current().snapshot;
    lane.request();
    await lane.settle();
    expect(lane.current().snapshot).toBe(coherent);
    expect(lane.current().lastAttempt?.failure).toBe("partial");
    lane.request();
    await lane.settle();
    expect(lane.current().snapshot).toBe(coherent);
    expect(lane.current().lastAttempt?.failure).toBe("offline");
  });

  it("discards an in-flight result after invalidation", async () => {
    const refresh = deferred<DiscoveryRefreshResult>();
    const lane = new DiscoverySnapshotLane("twitch", () => refresh.promise);

    lane.request();
    lane.invalidate();
    refresh.resolve(complete());
    await lane.settle();

    expect(lane.current().snapshot).toBeUndefined();
    expect(lane.current().lastAttempt?.discarded).toBe("stale_generation");
  });

  it("clears a previously committed snapshot when its generation is invalidated", async () => {
    const lane = new DiscoverySnapshotLane("twitch", async () => complete());
    lane.request();
    await lane.settle();

    lane.invalidate();

    expect(lane.current().snapshot).toBeUndefined();
    expect(lane.current().lastAttempt).toBeUndefined();
    lane.request();
    await lane.settle();
    expect(lane.current().snapshot?.revision).toBe(2);
  });
});

describe("collectDiscoverySnapshot", () => {
  it("retains a backed-off campaign observation without candidate provider calls", async () => {
    const campaign = { id: "backed-off", platform: "twitch" as const, name: "Backed off", status: "active" as const, rewards: [] };
    const candidate = { platform: "twitch" as const, username: "offline", url: "https://www.twitch.tv/offline" };
    const retained = [{ candidate, live: true, categoryMatches: true, eligible: false as const, observedAt: 41 }];
    const listCandidateChannels = vi.fn(async () => [candidate]);
    const result = await collectDiscoverySnapshot({
      platform: "twitch",
      refreshCampaigns: vi.fn(async () => [campaign]),
      listCandidateChannels,
      checkChannel: vi.fn(),
      selectCandidateChannel: undefined,
    }, undefined, new AbortController().signal, () => 42, false, [], (item) =>
      item.id === campaign.id ? retained : undefined);

    expect(result.campaigns).toEqual([{ campaign, candidates: retained }]);
    expect(listCandidateChannels).not.toHaveBeenCalled();
    expect(result.metrics.candidates).toBe(0);
  });

  it("captures followed-channel preference evidence inside discovery", async () => {
    const listFollowedChannels = vi.fn(async () => ["friend"]);
    const adapter = {
      platform: "twitch" as const,
      refreshCampaigns: vi.fn(async () => []),
      listCandidateChannels: vi.fn(),
      checkChannel: vi.fn(),
      selectCandidateChannel: undefined,
      listFollowedChannels,
    };

    const result = await collectDiscoverySnapshot(adapter, undefined, new AbortController().signal);

    expect(result.followedChannels).toEqual(["friend"]);
    expect(listFollowedChannels).toHaveBeenCalledOnce();
  });

  it("skips followed-channel discovery when preference is disabled", async () => {
    const listFollowedChannels = vi.fn(async () => ["friend"]);
    const adapter = {
      platform: "twitch" as const,
      refreshCampaigns: vi.fn(async () => []),
      listCandidateChannels: vi.fn(),
      checkChannel: vi.fn(),
      selectCandidateChannel: undefined,
      listFollowedChannels,
    };

    const result = await collectDiscoverySnapshot(
      adapter,
      undefined,
      new AbortController().signal,
      Date.now,
      false,
    );

    expect(result.followedChannels).toEqual([]);
    expect(listFollowedChannels).not.toHaveBeenCalled();
  });

  it("keeps Kick channel-specific eligibility unknown", async () => {
    const campaign = {
      id: "campaign",
      platform: "kick" as const,
      name: "Campaign",
      status: "active" as const,
      startsAt: new Date(0).toISOString(),
      endsAt: new Date(1_000).toISOString(),
      rewards: [],
    };
    const candidate = {
      platform: "kick" as const,
      username: "streamer",
      displayName: "Streamer",
      url: "https://kick.com/streamer",
    };
    const adapter = {
      platform: "kick" as const,
      refreshCampaigns: vi.fn(async () => [campaign]),
      listCandidateChannels: vi.fn(async () => [candidate]),
      checkChannel: vi.fn(async () => ({ live: true, categoryMatches: true, candidate })),
      selectCandidateChannel: undefined,
    };

    const result = await collectDiscoverySnapshot(adapter, undefined, new AbortController().signal, () => 42);

    expect(result.complete).toBe(true);
    expect(result.campaigns[0]?.candidates[0]).toMatchObject({
      live: true,
      categoryMatches: true,
      eligible: "unknown",
      observedAt: 42,
    });
  });

  it("preserves all provider candidate observations and tri-state eligibility", async () => {
    const campaign = {
      id: "campaign",
      platform: "twitch" as const,
      name: "Campaign",
      status: "active" as const,
      startsAt: new Date(0).toISOString(),
      endsAt: new Date(1_000).toISOString(),
      rewards: [],
    };
    const candidates = ["eligible", "rejected", "unknown"].map((username) => ({
      platform: "twitch" as const,
      username,
      displayName: username,
      url: `https://twitch.tv/${username}`,
    }));
    const adapter = {
      platform: "twitch" as const,
      refreshCampaigns: vi.fn(async () => [campaign]),
      listCandidateChannels: vi.fn(async () => candidates),
      checkChannel: vi.fn(),
      selectCandidateChannel: vi.fn(async () => ({
        channel: candidates[0],
        checked: 3,
        observations: candidates.map((candidate, index) => ({
          live: true,
          categoryMatches: true,
          campaignMatches: index === 0 ? true : index === 1 ? false : undefined,
          candidate,
        })),
      })),
    };

    const result = await collectDiscoverySnapshot(adapter, undefined, new AbortController().signal, () => 42);

    expect(result.campaigns[0]?.candidates.map(({ candidate, eligible }) =>
      [candidate.username, eligible])).toEqual([
      ["eligible", true],
      ["rejected", false],
      ["unknown", "unknown"],
    ]);
  });
});

describe("adapterFromDiscoverySnapshot", () => {
  it("does not perform inline provider discovery when no snapshot exists", async () => {
    const candidate = {
      platform: "kick" as const,
      username: "streamer",
      displayName: "Streamer",
      url: "https://kick.com/streamer",
    };
    const campaign = {
      id: "campaign",
      platform: "kick" as const,
      name: "Campaign",
      status: "active" as const,
      startsAt: new Date(0).toISOString(),
      endsAt: new Date(1_000).toISOString(),
      rewards: [],
    };
    const checkChannel = vi.fn();
    const listCandidateChannels = vi.fn();
    const adapter = adapterFromDiscoverySnapshot({
      platform: "kick",
      checkChannel,
      listCandidateChannels,
    } as never, undefined);

    expect(await adapter.listCandidateChannels(campaign)).toEqual([]);
    expect(await adapter.checkChannel(candidate, { campaign })).toMatchObject({
      live: false,
      categoryMatches: false,
    });
    expect(listCandidateChannels).not.toHaveBeenCalled();
    expect(checkChannel).not.toHaveBeenCalled();
  });
});
