import { describe, expect, it, vi } from "vitest";
import type { PageFetcher } from "@lurkloot/core/adapter";
import { TwitchDiscoveryState } from "@lurkloot/core/twitch";
import type { EngineEvent } from "@lurkloot/shared/events";
import type { DropCampaign, DropReward, WatchSession } from "@lurkloot/shared/models";
import { twitchAdapter } from "./helpers/adapters";

// #339: campaign details were refetched for every dashboard-listed campaign on
// every tick. They are now reused for a short, per-campaign-spread window, so
// what these tests pin down is exactly when a request must still happen.

const REUSE_WINDOW_MS = 5 * 60_000 + 1;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function dashboard(campaigns: readonly { id: string; status?: string }[]): unknown {
  return {
    data: {
      currentUser: {
        id: "user-id",
        login: "viewer",
        dropCampaigns: campaigns.map(({ id, status }) => ({
          id,
          status: status ?? "ACTIVE",
          self: { isAccountConnected: true },
        })),
      },
    },
  };
}

function details(dropID: string): unknown {
  return {
    data: {
      dropCampaign: {
        id: dropID,
        name: `Campaign ${dropID}`,
        game: { id: "game", slug: "game-slug", displayName: "Game" },
        timeBasedDrops: [{
          id: `${dropID}-drop`,
          requiredMinutesWatched: 60,
          benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
        }],
      },
    },
  };
}

const EMPTY_INVENTORY = {
  data: { currentUser: { id: "user-id", inventory: { dropCampaignsInProgress: [] } } },
};

// Records which campaigns each refresh actually asked Twitch about, which is
// the whole measurement #339 is after.
function detailRecordingFetcher(
  listedCampaigns: () => readonly { id: string; status?: string }[],
): { fetcher: PageFetcher; requested: string[]; claims: number } {
  const requested: string[] = [];
  const state = { claims: 0 };
  const handle = (body: Record<string, unknown>): unknown => {
    const op = body.operationName;
    if (op === "Inventory") return EMPTY_INVENTORY;
    if (op === "ViewerDropsDashboard") return dashboard(listedCampaigns());
    if (op === "DropCampaignDetails") {
      const dropID = String((body.variables as { dropID?: string }).dropID);
      requested.push(dropID);
      return details(dropID);
    }
    if (op === "DropsPage_ClaimDropRewards") {
      state.claims += 1;
      return { data: { claimDropRewards: { status: "ELIGIBLE_FOR_ALL" } } };
    }
    throw new Error(`Unexpected operation ${String(op)}`);
  };
  const fetcher: PageFetcher = {
    fetchJson: vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as
        | Record<string, unknown>
        | Record<string, unknown>[];
      return Array.isArray(body) ? body.map(handle) : handle(body);
    }) as PageFetcher["fetchJson"],
  };
  return { fetcher, requested, get claims() { return state.claims; } };
}

describe("twitch campaign details reuse (#339)", () => {
  it("serves a steady-state tick from cache instead of refetching every campaign", async () => {
    const listed = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const { fetcher, requested } = detailRecordingFetcher(() => listed);
    const discoveryState = new TwitchDiscoveryState();
    const events: EngineEvent[] = [];

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime("2026-08-31T12:00:00.000Z");
      const first = await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns();
      expect(requested).toEqual(["a", "b", "c"]);
      expect(fetcher.fetchJson).toHaveBeenCalledTimes(3);

      vi.setSystemTime("2026-08-31T12:01:00.000Z");
      const second = await twitchAdapter(
        fetcher,
        undefined,
        undefined,
        { discoveryState },
        (event) => events.push(event),
      ).refreshCampaigns();

      expect(requested).toEqual(["a", "b", "c"]);
      // The warm tick performs only inventory + dashboard transport requests;
      // campaign details are served from the state shared by rebuilt adapters.
      expect(fetcher.fetchJson).toHaveBeenCalledTimes(5);
      expect(second.map((campaign) => campaign.id)).toEqual(first.map((campaign) => campaign.id));
      expect(events.some((event) =>
        event.category === "diagnostic"
        && /^Twitch campaign details finished in \d+ms \(3 campaigns: 0 fetched in 0 batch requests, 0 single fallbacks, 3 served from cache\)$/.test(event.message))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fetches a campaign the dashboard lists for the first time on the tick it appears", async () => {
    let listed: { id: string }[] = [{ id: "a" }, { id: "b" }];
    const { fetcher, requested } = detailRecordingFetcher(() => listed);
    const discoveryState = new TwitchDiscoveryState();

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime("2026-08-31T12:00:00.000Z");
      await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns();
      requested.length = 0;

      listed = [{ id: "a" }, { id: "b" }, { id: "new" }];
      vi.setSystemTime("2026-08-31T12:01:00.000Z");
      const campaigns = await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns();

      expect(requested).toEqual(["new"]);
      // Reuse must not reorder the snapshot: it stays in dashboard order.
      expect(campaigns.map((campaign) => campaign.id)).toEqual(["a", "b", "new"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("always refetches the campaign being farmed", async () => {
    const listed = [{ id: "a" }, { id: "farmed" }];
    const { fetcher, requested } = detailRecordingFetcher(() => listed);
    const discoveryState = new TwitchDiscoveryState();
    // No channel, so discovery returns without the watched-session progress
    // merge; only the reuse decision is under test here.
    const session: WatchSession = { platform: "twitch", campaignId: "farmed", status: "starting", offlineChecks: 0 };

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime("2026-08-31T12:00:00.000Z");
      await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns(session);
      requested.length = 0;

      vi.setSystemTime("2026-08-31T12:01:00.000Z");
      await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns(session);

      expect(requested).toEqual(["farmed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches a campaign whose dashboard status changed inside the reuse window", async () => {
    let listed: { id: string; status?: string }[] = [{ id: "a" }, { id: "starting", status: "UPCOMING" }];
    const { fetcher, requested } = detailRecordingFetcher(() => listed);
    const discoveryState = new TwitchDiscoveryState();

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime("2026-08-31T12:00:00.000Z");
      await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns();
      requested.length = 0;

      listed = [{ id: "a" }, { id: "starting", status: "ACTIVE" }];
      vi.setSystemTime("2026-08-31T12:01:00.000Z");
      await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns();

      expect(requested).toEqual(["starting"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a campaign's reuse window when one of its rewards is claimed", async () => {
    const listed = [{ id: "a" }, { id: "claimed" }];
    const { fetcher, requested } = detailRecordingFetcher(() => listed);
    const discoveryState = new TwitchDiscoveryState();
    const adapter = twitchAdapter(fetcher, undefined, undefined, { discoveryState });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime("2026-08-31T12:00:00.000Z");
      await adapter.refreshCampaigns();
      requested.length = 0;

      const campaign = { id: "claimed", name: "Campaign claimed" } as DropCampaign;
      const reward = { id: "claimed-drop", name: "Reward", claimId: "instance-1" } as DropReward;
      expect(await adapter.claimReward(campaign, reward)).toBe(true);

      vi.setSystemTime("2026-08-31T12:01:00.000Z");
      await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns();

      expect(requested).toEqual(["claimed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spreads reuse deadlines so a cold batch does not all re-expire on one tick", async () => {
    const listed = Array.from({ length: 40 }, (_, index) => ({ id: `campaign-${index}` }));
    const { fetcher, requested } = detailRecordingFetcher(() => listed);
    const discoveryState = new TwitchDiscoveryState();

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime("2026-08-31T12:00:00.000Z");
      await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns();
      requested.length = 0;

      // Past the base freshness but inside the spread: some campaigns are due,
      // most are not. A single shared deadline would refetch all 40 here.
      vi.setSystemTime("2026-08-31T12:04:00.000Z");
      await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns();

      expect(requested.length).toBeGreaterThan(0);
      expect(requested.length).toBeLessThan(listed.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches after a service-worker restart discards the in-memory cache", async () => {
    const listed = [{ id: "a" }, { id: "b" }];
    const { fetcher, requested } = detailRecordingFetcher(() => listed);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime("2026-08-31T12:00:00.000Z");
      await twitchAdapter(fetcher, undefined, undefined, { discoveryState: new TwitchDiscoveryState() }).refreshCampaigns();
      requested.length = 0;

      vi.setSystemTime("2026-08-31T12:01:00.000Z");
      await twitchAdapter(fetcher, undefined, undefined, { discoveryState: new TwitchDiscoveryState() }).refreshCampaigns();

      expect(requested).toEqual(["a", "b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an old identity refresh overwrite the current identity's details cache", async () => {
    let activeUser = { id: "user-a-id", login: "user-a" };
    const oldDetails = deferred<unknown>();
    const oldDetailsStarted = deferred<void>();
    let userBDetailRequests = 0;
    const fetcher: PageFetcher = {
      fetchJson: vi.fn(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as
          | Record<string, unknown>
          | Record<string, unknown>[];
        const respond = async (body: Record<string, unknown>): Promise<unknown> => {
          if (body.operationName === "Inventory") {
            return {
              data: {
                currentUser: {
                  id: activeUser.id,
                  inventory: { dropCampaignsInProgress: [] },
                },
              },
            };
          }
          if (body.operationName === "ViewerDropsDashboard") {
            return {
              data: {
                currentUser: {
                  ...activeUser,
                  dropCampaigns: [{
                    id: "campaign",
                    status: "ACTIVE",
                    self: { isAccountConnected: true },
                  }],
                },
              },
            };
          }
          if (body.operationName === "DropCampaignDetails") {
            const login = String((body.variables as { channelLogin?: string }).channelLogin);
            if (login === "user-a-id") {
              oldDetailsStarted.resolve();
              return oldDetails.promise;
            }
            userBDetailRequests += 1;
            return {
              data: {
                dropCampaign: {
                  ...(details("campaign") as { data: { dropCampaign: Record<string, unknown> } }).data.dropCampaign,
                  name: "Campaign from user B",
                },
              },
            };
          }
          throw new Error(`Unexpected operation ${String(body.operationName)}`);
        };
        return Array.isArray(request)
          ? Promise.all(request.map(respond))
          : respond(request);
      }) as PageFetcher["fetchJson"],
    };
    const discoveryState = new TwitchDiscoveryState();

    const oldRefresh = twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns();
    await oldDetailsStarted.promise;

    activeUser = { id: "user-b-id", login: "user-b" };
    const currentRefresh = await twitchAdapter(
      fetcher,
      undefined,
      undefined,
      { discoveryState },
    ).refreshCampaigns();
    expect(currentRefresh[0]?.name).toBe("Campaign from user B");

    oldDetails.resolve({
      data: {
        dropCampaign: {
          ...(details("campaign") as { data: { dropCampaign: Record<string, unknown> } }).data.dropCampaign,
          name: "Campaign from user A",
        },
      },
    });
    await oldRefresh;

    const nextCurrentRefresh = await twitchAdapter(
      fetcher,
      undefined,
      undefined,
      { discoveryState },
    ).refreshCampaigns();

    expect(userBDetailRequests).toBe(1);
    expect(nextCurrentRefresh[0]?.name).toBe("Campaign from user B");
  });

  describe("TwitchDiscoveryState", () => {
    it("keeps outage retention alive after the reuse window lapses", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime("2026-08-31T12:00:00.000Z");
        const discoveryState = new TwitchDiscoveryState();
        discoveryState.rememberCampaignDetails(
          "a",
          { id: "a" },
          undefined,
          discoveryState.availabilityRequestIdentity(),
        );

        vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z").getTime() + REUSE_WINDOW_MS);
        // #274's failure fallback outlives reuse by design: a lapsed reuse
        // window costs a request, it must never drop the payload.
        expect(discoveryState.freshCampaignDetails("a")).toBeUndefined();
        expect(discoveryState.retainedCampaignDetails("a")).toEqual({ id: "a" });

        vi.setSystemTime("2026-08-31T12:31:00.000Z");
        expect(discoveryState.retainedCampaignDetails("a")).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops reusable details when the authenticated identity changes", () => {
      const discoveryState = new TwitchDiscoveryState();
      discoveryState.setAuthenticatedUser("user-a");
      discoveryState.rememberCampaignDetails(
        "a",
        { id: "a" },
        undefined,
        discoveryState.availabilityRequestIdentity(),
      );
      expect(discoveryState.freshCampaignDetails("a")).toEqual({ id: "a" });

      discoveryState.setAuthenticatedUser("user-b");

      expect(discoveryState.freshCampaignDetails("a")).toBeUndefined();
      expect(discoveryState.retainedCampaignDetails("a")).toBeUndefined();
    });

    it("does not let an old identity response delete the current identity's details", () => {
      const discoveryState = new TwitchDiscoveryState();
      discoveryState.setAuthenticatedUser("user-a");
      const oldRequestIdentity = discoveryState.availabilityRequestIdentity();

      discoveryState.setAuthenticatedUser("user-b");
      discoveryState.rememberCampaignDetails(
        "campaign",
        { id: "campaign", owner: "user-b" },
        "ACTIVE",
        discoveryState.availabilityRequestIdentity(),
      );

      expect(discoveryState.forgetCampaignDetails("campaign", oldRequestIdentity)).toBe(false);
      expect(discoveryState.retainedCampaignDetails("campaign")).toEqual({
        id: "campaign",
        owner: "user-b",
      });
    });

    it("keeps the last known dashboard status when a tick has no dashboard answer", () => {
      const discoveryState = new TwitchDiscoveryState();
      const requestIdentity = discoveryState.availabilityRequestIdentity();
      discoveryState.rememberCampaignDetails("a", { id: "a" }, "UPCOMING", requestIdentity);
      discoveryState.rememberCampaignDetails("a", { id: "a" }, undefined, requestIdentity);

      // Still comparable against a later dashboard answer, so the flip is not
      // lost just because one tick could not reach the dashboard.
      expect(discoveryState.freshCampaignDetails("a", "ACTIVE")).toBeUndefined();
      expect(discoveryState.freshCampaignDetails("a", "UPCOMING")).toEqual({ id: "a" });
    });
  });
});
