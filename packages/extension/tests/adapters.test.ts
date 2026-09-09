import { describe, expect, it, vi } from "vitest";
import type { PageFetcher, PlatformAdapter } from "@lurkloot/core/adapter";
import { createKickClaimCapability, createKickFetcher, KickAdapter, KickClaimState, KickDiscoveryState } from "@lurkloot/core/kick";
import { fetchTwitchInBackgroundWith, KickWafBlockedError } from "@lurkloot/core/tabs";
import type { TwitchIntegrityRequest } from "@lurkloot/core/tabs";
import { readFileSync } from "node:fs";
import { TwitchAdapter, TwitchDiscoveryState } from "@lurkloot/core/twitch";
import type { EngineEvent } from "@lurkloot/shared/events";
import type { DropCampaign, DropReward, ExtensionSettings } from "@lurkloot/shared/models";
import { chooseCampaignDecision } from "@lurkloot/core/scheduler";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { resolveCompatibility } from "@lurkloot/core";
import { SafeFetchError, type SafeFetchFailureKind } from "@lurkloot/core/fetchError";
import { kickAdapter, twitchAdapter, TWITCH_COMPAT } from "./helpers/adapters";

function jsonFetcher(handler: (url: string, init?: RequestInit) => unknown): PageFetcher {
  const fetchJson = vi.fn(async (url: string, init?: RequestInit): Promise<unknown> => handler(url, init));
  return {
    fetchJson: fetchJson as PageFetcher["fetchJson"],
  };
}

function operation(init?: RequestInit): string {
  return JSON.parse(String(init?.body)).operationName;
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function twitchInventory(campaignIds: string[], userId = "user-id"): unknown {
  return {
    data: {
      currentUser: {
        id: userId,
        inventory: {
          dropCampaignsInProgress: campaignIds.map((id) => ({
            id,
            name: "Inventory Campaign",
            game: { id: "game", slug: "game-slug", displayName: "Game" },
            timeBasedDrops: [{
              id: `${id}-drop`,
              requiredMinutesWatched: 60,
              self: { currentMinutesWatched: 20, isClaimed: false },
              benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
            }],
          })),
        },
      },
    },
  };
}

function twitchDashboard(campaignIds: string[], userId = "user-id"): unknown {
  return {
    data: {
      currentUser: {
        id: userId,
        login: "viewer",
        dropCampaigns: campaignIds.map((id) => ({ id, status: "ACTIVE", self: { isAccountConnected: true } })),
      },
    },
  };
}

function twitchCampaignDetails(dropID: string): unknown {
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

function kickCampaigns(campaignId = "campaign", rewardId = "reward"): unknown {
  return {
    data: [{
      id: campaignId,
      name: "Kick Campaign",
      status: "active",
      rewards: [{
        id: rewardId,
        name: "Reward",
        required_minutes: 1,
      }],
    }],
  };
}

describe("KickAdapter", () => {
  it("starts Kick campaign and progress requests concurrently", async () => {
    let campaignStarted = false;
    let progressStarted = false;
    const fetcher = jsonFetcher(async (url) => {
      if (url.endsWith("/drops/campaigns")) {
        campaignStarted = true;
        await vi.waitFor(() => expect(progressStarted).toBe(true));
        return {
          data: [{
            id: 1,
            name: "Kick Campaign",
            status: "active",
            category: { id: 99, name: "Game" },
            rewards: [{ id: 10, name: "Reward", required_minutes: 60 }],
          }],
        };
      }
      if (url.endsWith("/drops/progress")) {
        progressStarted = true;
        await vi.waitFor(() => expect(campaignStarted).toBe(true));
        return {
          data: [{
            id: 1,
            status: "in progress",
            rewards: [{ id: 10, progress: 0.5, required_units: 60 }],
          }],
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = kickAdapter(fetcher);

    const campaigns = await adapter.refreshCampaigns();

    expect(campaigns[0]?.rewards[0]?.watchedMinutes).toBe(30);
    expect(fetcher.fetchJson).toHaveBeenCalledTimes(2);
  });

  it("keeps Kick campaigns when concurrent progress refresh fails", async () => {
    const events: EngineEvent[] = [];
    const adapter = kickAdapter(jsonFetcher((url) => {
      if (url.endsWith("/drops/campaigns")) {
        return {
          data: [{
            id: 1,
            name: "Kick Campaign",
            status: "active",
            rewards: [{ id: 10, name: "Reward", required_minutes: 60 }],
          }],
        };
      }
      throw new Error("progress unavailable");
    }), undefined, undefined, (event) => events.push(event));

    const campaigns = await adapter.refreshCampaigns();

    expect(campaigns).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      level: "warn",
      message: expect.stringContaining("using last-known progress"),
    }));
  });

  it("propagates Kick progress authentication failures during refresh", async () => {
    const failure = new SafeFetchError({ kind: "authentication_rejected", status: 401 });
    const adapter = kickAdapter(jsonFetcher((url) => {
      if (url.endsWith("/drops/campaigns")) return { data: [] };
      throw failure;
    }));

    await expect(adapter.refreshCampaigns()).rejects.toBe(failure);
  });

  it("propagates Kick campaign discovery failures during refresh", async () => {
    const failure = new Error("campaigns unavailable");
    const adapter = kickAdapter(jsonFetcher((url) => {
      if (url.endsWith("/drops/progress")) return { data: [] };
      throw failure;
    }));

    await expect(adapter.refreshCampaigns()).rejects.toBe(failure);
  });

  it("propagates Kick refresh cancellation without reporting a progress fallback", async () => {
    const abort = new AbortController();
    const events: EngineEvent[] = [];
    const adapter = kickAdapter(jsonFetcher((url, init) => {
      if (url.endsWith("/drops/campaigns")) return { data: [] };
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }), undefined, undefined, (event) => events.push(event));

    const refresh = adapter.refreshCampaigns(undefined, { signal: abort.signal });
    const reason = new Error("cancelled");
    abort.abort(reason);

    await expect(refresh).rejects.toBe(reason);
    expect(events).not.toContainEqual(expect.objectContaining({
      category: "diagnostic",
      level: "warn",
      message: expect.stringContaining("using last-known progress"),
    }));
  });

  it("passes the auth probe signal to the Kick identity request", async () => {
    const abort = new AbortController();
    const emit = vi.fn();
    const fetchJson = vi.fn(async () => ({ id: 42 }));
    const fetcher = { fetchJson: fetchJson as PageFetcher["fetchJson"] };

    await kickAdapter(fetcher, undefined, undefined, emit).checkAuthHealth(abort.signal);

    expect(fetchJson).toHaveBeenCalledWith(
      "https://kick.com/api/v1/user",
      { signal: abort.signal },
      emit,
    );
  });

  it("does not swallow authentication failures while refreshing progress", async () => {
    const failure = new SafeFetchError({ kind: "authentication_rejected", status: 401 });
    const adapter = kickAdapter(jsonFetcher((url) => {
      if (url.endsWith("/drops/campaigns")) return { data: [] };
      throw failure;
    }));

    await expect(adapter.refreshCampaigns()).rejects.toBe(failure);
  });

  it("does not swallow security-policy failures while claiming challenges", async () => {
    const failure = new SafeFetchError({ kind: "security_policy_blocked", status: 403, reference: "safe-ref" });
    const adapter = kickAdapter(jsonFetcher((url) => {
      if (url.endsWith("/gamification/challenges")) {
        return { data: [{ id: "daily", claimed_at: null, recurrence: "daily", condition: { progress: 1, threshold: 1 } }] };
      }
      throw failure;
    }));

    await expect(adapter.claimChallenges()).rejects.toBe(failure);
  });

  it.each([
    ["authentication_rejected", "invalid_credentials", "credentials_rejected", "authInvalidCredentials"],
    ["security_policy_blocked", "blocked", "security_policy_blocked", "authSecurityPolicyBlocked"],
    ["network_error", "unavailable", "network_unavailable", "authNetworkUnavailable"],
    ["http_error", "unavailable", "platform_unavailable", "authPlatformUnavailable"],
  ] as const)("maps %s account probe failures to %s", async (kind, status, reasonCode, key) => {
    const fetcher = jsonFetcher(() => {
      throw new SafeFetchError({
        kind: kind as SafeFetchFailureKind,
        status: kind === "network_error" ? undefined : kind === "authentication_rejected" ? 401 : 403,
        reason: kind === "security_policy_blocked" ? "Request blocked by security policy." : undefined,
        reference: kind === "security_policy_blocked" ? "9e4db7e3" : undefined,
      });
    });

    const health = await kickAdapter(fetcher).checkAuthHealth();

    expect(health).toMatchObject({ status, reasonCode, message: { key } });
    expect(health.message?.values?.reference).toBe(kind === "security_policy_blocked" ? "9e4db7e3" : undefined);
    expect(Date.parse(health.checkedAt ?? "")).not.toBeNaN();
  });

  it("does not copy unknown account probe errors into health state", async () => {
    const fetcher = jsonFetcher(() => { throw new Error("token=secret-value"); });

    const health = await kickAdapter(fetcher).checkAuthHealth();

    expect(health).toMatchObject({
      status: "unavailable",
      reasonCode: "platform_unavailable",
      message: { key: "authPlatformUnavailable" },
    });
    expect(JSON.stringify(health)).not.toContain("secret-value");
  });

  it("uses the automatic Kick claim capability selected by compatibility resolution", async () => {
    let claimPosts = 0;
    const fetcher = jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/drops/claim") {
        claimPosts += 1;
        return { connect_url: "https://accounts.example/automatic" };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const compatibility = resolveCompatibility(DEFAULT_SETTINGS.compatibility, {
      host: "extension",
      twitchIdentity: "web",
    }).compatibility.kick;
    const adapter = kickAdapter(fetcher, undefined, undefined, undefined, { compatibility });
    const campaign = { id: "campaign" } as DropCampaign;
    const reward = { id: "reward", status: "claimable", requiredMinutes: 1, watchedMinutes: 1 } as DropReward;

    await expect(adapter.claimReward(campaign, reward)).resolves.toBe(false);
    await expect(adapter.claimReward(campaign, reward)).resolves.toBe(false);

    expect(compatibility.claim).toBe("kick-claim-v2");
    expect(claimPosts).toBe(1);
    expect(reward.claimGuidance).toEqual({ kind: "link_required", url: "https://accounts.example/automatic" });
  });

  it("keeps an explicit Kick claim v1 adapter campaign-only for its lifetime", async () => {
    let claimPosts = 0;
    const fetcher = jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/drops/claim") {
        claimPosts += 1;
        return { connect_url: "https://accounts.example/ignored" };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const compatibility = resolveCompatibility({
      ...DEFAULT_SETTINGS.compatibility,
      kick: { ...DEFAULT_SETTINGS.compatibility.kick, claimLinkHandling: "kick-claim-v1" },
    }, { host: "extension", twitchIdentity: "web" }).compatibility.kick;
    const adapter = kickAdapter(fetcher, undefined, undefined, undefined, { compatibility });
    const campaign = { id: "campaign", accountLinked: true } as DropCampaign;
    const reward = { id: "reward", status: "claimable", requiredMinutes: 1, watchedMinutes: 1 } as DropReward;

    await expect(adapter.claimReward(campaign, reward)).resolves.toBe(false);
    compatibility.claim = "kick-claim-v2";
    await expect(adapter.claimReward(campaign, reward)).resolves.toBe(false);

    expect(compatibility.claim).toBe("kick-claim-v2");
    expect(claimPosts).toBe(2);
    expect(reward.claimGuidance).toBeUndefined();
  });

  it("keeps adapter diagnostics scoped to the supplied emitter", async () => {
    const failingFetcher = jsonFetcher((url) => {
      if (url.endsWith("/drops/campaigns")) return { data: [] };
      throw new Error("progress unavailable");
    });
    const first: EngineEvent[] = [];
    const second: EngineEvent[] = [];
    const firstAdapter = kickAdapter(failingFetcher, undefined, undefined, (event) => first.push(event));
    const secondAdapter = kickAdapter(failingFetcher, undefined, undefined, (event) => second.push(event));

    await firstAdapter.refreshCampaigns();
    await secondAdapter.refreshCampaigns();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).not.toBe(second[0]);
  });

  it("discovers campaigns, merges nested progress, and lists category streams", async () => {
    const fetcher = jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/drops/campaigns") {
        return {
          data: [{
            id: 1,
            name: "Kick Campaign",
            status: "active",
            category: { id: 99, name: "Game" },
            rewards: [{ id: 10, name: "Reward", required_minutes: 60 }],
          }],
        };
      }
      if (url === "https://web.kick.com/api/v1/drops/progress") {
        return {
          data: [{
            id: 1,
            status: "in progress",
            rewards: [{ id: 10, progress: 0.5, required_units: 60 }],
          }],
        };
      }
      if (url.startsWith("https://web.kick.com/api/v1/livestreams")) {
        const params = new URL(url).searchParams;
        expect(params.get("sort")).toBe("viewer_count_desc");
        expect(params.get("category_id")).toBe("99");
        return {
          data: {
            livestreams: [{
              channel: { slug: "creator" },
              category: { id: 99, name: "Game" },
              viewer_count: 123,
              session_title: "Drops",
            }],
          },
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = kickAdapter(fetcher);

    const campaigns = await adapter.refreshCampaigns();
    const candidates = await adapter.listCandidateChannels(campaigns[0]);

    expect(campaigns[0].rewards[0].watchedMinutes).toBe(30);
    expect(campaigns[0].rewards[0].status).toBe("in_progress");
    expect(candidates[0]).toMatchObject({ username: "creator", viewerCount: 123, title: "Drops" });
  });

  it("lists followed live channels from the Kick user livestreams endpoint and caches them", async () => {
    let calls = 0;
    let requestedUrl = "";
    const adapter = kickAdapter(jsonFetcher((url) => {
      requestedUrl = url;
      calls += 1;
      return [
        { channel: { slug: "Friend" } },
        { channel: { username: "other" } },
        { channel: {} },
      ];
    }));

    await expect(adapter.listFollowedChannels()).resolves.toEqual(["friend", "other"]);
    await expect(adapter.listFollowedChannels()).resolves.toEqual(["friend", "other"]);

    expect(requestedUrl).toBe("https://kick.com/api/v1/user/livestreams");
    expect(calls).toBe(1);
  });

  it("reports no followed channels for a signed-out session or a failed lookup", async () => {
    const emit = vi.fn();
    const adapter = kickAdapter(jsonFetcher(() => {
      throw new SafeFetchError({ kind: "authentication_rejected", status: 401 });
    }), undefined, undefined, emit);

    await expect(adapter.listFollowedChannels()).resolves.toEqual([]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      category: "diagnostic",
      message: expect.stringContaining("followed-channel lookup failed"),
    }));
  });

  it("shares the followed-channel cache across adapter instances via discoveryState", async () => {
    // Every host reconstructs KickAdapter fresh every scheduler tick, so a cache
    // the discoveryState doesn't survive would hit the network on every tick.
    // Two separate instances standing in for two ticks proves the cache
    // outlives the adapter.
    let calls = 0;
    const fetcher = jsonFetcher(() => {
      calls += 1;
      return [{ channel: { slug: "friend" } }];
    });
    const discoveryState = new KickDiscoveryState();
    const firstTick = kickAdapter(fetcher, undefined, undefined, undefined, { discoveryState });
    const secondTick = kickAdapter(fetcher, undefined, undefined, undefined, { discoveryState });

    await expect(firstTick.listFollowedChannels()).resolves.toEqual(["friend"]);
    await expect(secondTick.listFollowedChannels()).resolves.toEqual(["friend"]);

    expect(calls).toBe(1);
  });

  it("serves a stale followed-channel cache immediately and refreshes in the background", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let resolveSecondFetch: (() => void) | undefined;
      const fetcher = jsonFetcher(() => {
        calls += 1;
        if (calls === 1) return [{ channel: { slug: "stale-friend" } }];
        // The second (background) fetch never resolves until the test lets it,
        // so a caller blocking on it would hang the assertion below.
        return new Promise((resolve) => {
          resolveSecondFetch = () => resolve([{ channel: { slug: "fresh-friend" } }]);
        });
      });
      const discoveryState = new KickDiscoveryState();
      const firstTick = kickAdapter(fetcher, undefined, undefined, undefined, { discoveryState });

      await expect(firstTick.listFollowedChannels()).resolves.toEqual(["stale-friend"]);
      expect(calls).toBe(1);

      vi.advanceTimersByTime(6 * 60_000); // past the 5-minute cache TTL
      const secondTick = kickAdapter(fetcher, undefined, undefined, undefined, { discoveryState });

      // Resolves with the stale value without waiting on the (still-pending)
      // background refresh.
      await expect(secondTick.listFollowedChannels()).resolves.toEqual(["stale-friend"]);
      expect(calls).toBe(2);

      resolveSecondFetch?.();
      await vi.waitFor(() => expect(kickAdapter(fetcher, undefined, undefined, undefined, { discoveryState }).listFollowedChannels())
        .resolves.toEqual(["fresh-friend"]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists general live streams for site-wide Kick campaigns", async () => {
    let requestedUrl = "";
    const fetcher = jsonFetcher((url) => {
      if (url.startsWith("https://web.kick.com/api/v1/livestreams")) {
        requestedUrl = url;
        return {
          data: {
            livestreams: [{
              channel: { slug: "anyone-live" },
              category: { id: 77, name: "Any Game" },
              viewer_count: 321,
              session_title: "Site-wide drops",
            }],
          },
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = kickAdapter(fetcher);

    const candidates = await adapter.listCandidateChannels({
      id: "site-wide",
      platform: "kick",
      name: "Site-wide Drop",
      status: "active",
      rewards: [],
      isGeneralDrop: true,
    });

    expect(new URL(requestedUrl).searchParams.has("category_id")).toBe(false);
    expect(candidates[0]).toMatchObject({
      username: "anyone-live",
      categoryId: "77",
      categoryName: "Any Game",
      viewerCount: 321,
    });
  });

  it("can select a site-wide Kick campaign candidate without enforcing a category", async () => {
    const fetcher = jsonFetcher((url) => {
      if (url.startsWith("https://web.kick.com/api/v1/livestreams")) {
        return { data: { livestreams: [{ channel: { slug: "creator" }, category: { id: 7, name: "Game" } }] } };
      }
      if (url === "https://kick.com/api/v2/channels/creator") {
        return { id: 10, livestream: { id: 20, is_live: true, categories: [{ id: 8, name: "Different Game" }] } };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = kickAdapter(fetcher);
    const settings: ExtensionSettings = {
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
      },
    };

    const decision = await chooseCampaignDecision(
      "kick",
      [{
        id: "site-wide",
        platform: "kick",
        name: "Site-wide Drop",
        status: "active",
        rewards: [{ id: "reward", name: "Reward", requiredMinutes: 30, watchedMinutes: 0, status: "locked" }],
        isGeneralDrop: true,
      }],
      settings,
      adapter,
    );

    expect(decision.action).toBe("watch");
    expect(decision.channel).toMatchObject({ username: "creator", categoryId: "8", categoryName: "Different Game" });
  });

  it("still enforces category matching for category-specific Kick campaigns", async () => {
    const fetcher = jsonFetcher((url) => {
      if (url.startsWith("https://web.kick.com/api/v1/livestreams")) {
        return { data: { livestreams: [{ channel: { slug: "creator" }, category: { id: 99, name: "Expected Game" } }] } };
      }
      if (url === "https://kick.com/api/v2/channels/creator") {
        return { id: 10, livestream: { id: 20, is_live: true, categories: [{ id: 100, name: "Wrong Game" }] } };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = kickAdapter(fetcher);

    const decision = await chooseCampaignDecision(
      "kick",
      [{
        id: "category-drop",
        platform: "kick",
        name: "Category Drop",
        status: "active",
        categoryId: "99",
        rewards: [{ id: "reward", name: "Reward", requiredMinutes: 30, watchedMinutes: 0, status: "locked" }],
        isGeneralDrop: true,
      }],
      { ...DEFAULT_SETTINGS },
      adapter,
    );

    expect(decision.action).toBe("idle");
  });

  it("checks channel category and claims rewards through the page-context API", async () => {
    const fetcher = jsonFetcher((url, init) => {
      if (url === "https://kick.com/api/v2/channels/creator") {
        return { livestream: { is_live: true, category: { id: 99, name: "Game" }, viewer_count: 456, session_title: "Live now" } };
      }
      if (url === "https://web.kick.com/api/v1/drops/claim") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toMatchObject({ campaign_id: "campaign", reward_id: "reward" });
        return { success: true };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = kickAdapter(fetcher);
    const campaign = { id: "campaign", categoryId: "99" } as DropCampaign;
    const reward = { id: "reward", status: "claimable", requiredMinutes: 1, watchedMinutes: 1 } as DropReward;

    await expect(adapter.checkChannel(
      { platform: "kick", username: "creator", url: "https://kick.com/creator" },
      { campaign },
    ))
      .resolves.toMatchObject({
        live: true,
        categoryMatches: true,
        candidate: { categoryId: "99", categoryName: "Game", viewerCount: 456, title: "Live now" },
      });
    await expect(adapter.claimReward(campaign, reward)).resolves.toBe(true);
  });

  it("treats a Kick claim as successful only on a positive response signal", async () => {
    const campaign = { id: "campaign" } as DropCampaign;
    const reward = { id: "reward", status: "claimable", requiredMinutes: 1, watchedMinutes: 1 } as DropReward;
    const claimWith = (body: unknown) => kickAdapter(jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/drops/claim") return body;
      throw new Error(`Unexpected URL ${url}`);
    })).claimReward(campaign, reward);

    await expect(claimWith({ message: "Success", data: { id: 1 } })).resolves.toBe(true);
    await expect(claimWith({ success: true })).resolves.toBe(true);
    // HTTP 200 with a non-success body must not be reported as a claim.
    await expect(claimWith({ message: "Reward not available", data: null })).resolves.toBe(false);
    await expect(claimWith({})).resolves.toBe(false);
  });

  it("classifies Kick claim v2 link guidance from supported response fields", () => {
    const capability = createKickClaimCapability("kick-claim-v2");
    const campaign = { id: "campaign" } as DropCampaign;

    expect(capability.classify({ connect_url: "https://accounts.example/link" }, campaign))
      .toEqual({ kind: "link_required", url: "https://accounts.example/link" });
    expect(capability.classify({ connectUrl: "https://accounts.example/camel" }, campaign))
      .toEqual({ kind: "link_required", url: "https://accounts.example/camel" });
    expect(capability.classify({ data: { connect_url: "https://accounts.example/nested" } }, campaign))
      .toEqual({ kind: "link_required", url: "https://accounts.example/nested" });
    expect(capability.classify({ data: { connectUrl: "https://accounts.example/nested-camel" } }, campaign))
      .toEqual({ kind: "link_required", url: "https://accounts.example/nested-camel" });
  });

  it("rejects unsafe, malformed, and arbitrarily nested Kick claim v2 guidance", () => {
    const capability = createKickClaimCapability("kick-claim-v2");
    const campaign = { id: "campaign" } as DropCampaign;

    for (const response of [
      { connect_url: "not a URL" },
      { connect_url: "https://user:pass@accounts.example/link" },
      { connectUrl: "javascript:alert(1)" },
      { data: { connect_url: "data:text/plain,hello" } },
      { data: { connectUrl: 42 } },
      { error: { connect_url: "https://accounts.example/too-deep" } },
      { data: { error: { connectUrl: "https://accounts.example/too-deep" } } },
    ]) {
      expect(capability.classify(response, campaign)).toEqual({ kind: "not_claimed" });
    }
  });

  it("classifies normal Kick claim success independently of link guidance", () => {
    const capability = createKickClaimCapability("kick-claim-v2");
    const campaign = { id: "campaign" } as DropCampaign;

    expect(capability.classify({ message: "Success", data: { id: 1 } }, campaign)).toEqual({ kind: "claimed" });
    expect(capability.classify({ success: true }, campaign)).toEqual({ kind: "claimed" });
    expect(capability.classify({}, campaign)).toEqual({ kind: "not_claimed" });
  });

  it("suppresses repeated link-required claims until refreshed progress explicitly confirms linking", async () => {
    let claimPosts = 0;
    let progress: unknown = { data: [{ campaign_id: "campaign" }] };
    const events: EngineEvent[] = [];
    const fetcher = jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/drops/claim") {
        claimPosts += 1;
        return { connect_url: "https://accounts.example/link?state=opaque-secret#fragment" };
      }
      if (url === "https://web.kick.com/api/v1/drops/campaigns") return kickCampaigns();
      if (url === "https://web.kick.com/api/v1/drops/progress") return progress;
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = kickAdapter(fetcher, undefined, undefined, (event) => events.push(event));
    const campaign = {
      id: "campaign",
      platform: "kick",
      name: "Campaign",
      status: "active",
      // Stale last-known metadata must not count as refreshed affirmative evidence.
      accountLinked: true,
      rewards: [{ id: "reward", name: "Reward", status: "claimable", requiredMinutes: 1, watchedMinutes: 1 }],
    } as DropCampaign;
    const reward = campaign.rewards[0];

    await expect(adapter.claimReward(campaign, reward)).resolves.toBe(false);
    await expect(adapter.claimReward(campaign, reward)).resolves.toBe(false);
    expect(claimPosts).toBe(1);
    expect(reward.claimGuidance).toEqual({
      kind: "link_required",
      url: "https://accounts.example/link?state=opaque-secret#fragment",
    });
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain("opaque-secret");
    expect(serializedEvents).not.toContain("/link");

    const ambiguous = await adapter.refreshCampaigns();
    await expect(adapter.claimReward(ambiguous[0], ambiguous[0].rewards[0])).resolves.toBe(false);
    expect(claimPosts).toBe(1);

    progress = { data: [{ campaign_id: "campaign", user_app_connected: true, progress_units: 2 }] };
    const linked = await adapter.refreshCampaigns();
    expect(linked[0].accountLinked).toBe(true);
    expect(linked[0].claimGuidance).toBeUndefined();
    expect(linked[0].rewards[0].claimGuidance).toBeUndefined();
    await expect(adapter.claimReward(linked[0], linked[0].rewards[0])).resolves.toBe(false);
    expect(claimPosts).toBe(2);
  });

  it("cleans all campaign suppressions after affirmative linking, including absent rewards", () => {
    const capability = createKickClaimCapability("kick-claim-v2");
    const campaign = {
      id: "campaign",
      rewards: [
        { id: "present", status: "claimable" },
        { id: "removed", status: "claimable" },
      ],
    } as DropCampaign;
    capability.suppress?.(campaign, campaign.rewards[0], "https://accounts.example/present");
    capability.suppress?.(campaign, campaign.rewards[1], "https://accounts.example/removed");

    const refreshed = [{ ...campaign, rewards: [campaign.rewards[0]] }];
    capability.reconcileProgress?.(refreshed, new Set(["campaign"]));

    expect(capability.isSuppressed?.(campaign, campaign.rewards[0])).toBe(false);
    expect(capability.isSuppressed?.(campaign, campaign.rewards[1])).toBe(false);
  });

  it("clears v2 suppression from a bare-array affirmative progress response", async () => {
    let claimPosts = 0;
    let progress: unknown = [{ campaign_id: "campaign" }];
    const adapter = kickAdapter(jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/drops/claim") {
        claimPosts += 1;
        return { connect_url: "https://accounts.example/link" };
      }
      if (url === "https://web.kick.com/api/v1/drops/campaigns") return kickCampaigns();
      if (url === "https://web.kick.com/api/v1/drops/progress") return progress;
      throw new Error(`Unexpected URL ${url}`);
    }));
    const campaign = {
      id: "campaign",
      rewards: [{ id: "reward", status: "claimable" }],
    } as DropCampaign;

    await adapter.claimReward(campaign, campaign.rewards[0]);
    progress = [{ campaign_id: "campaign", user_app_connected: true, progress_units: 2 }];
    const refreshed = await adapter.refreshCampaigns();
    await adapter.claimReward(refreshed[0], refreshed[0].rewards[0]);

    expect(claimPosts).toBe(2);
  });

  it("shares link-required suppression across fresh adapters but lets a new host state retry", async () => {
    let claimPosts = 0;
    const fetcher = jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/drops/claim") {
        claimPosts += 1;
        return { connectUrl: "https://accounts.example/link" };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const campaign = { id: "campaign" } as DropCampaign;
    const reward = { id: "reward", name: "Reward", status: "claimable", requiredMinutes: 1, watchedMinutes: 1 } as DropReward;

    const state = new KickClaimState();
    await kickAdapter(fetcher, undefined, undefined, undefined, { claimState: state }).claimReward(campaign, reward);
    await kickAdapter(fetcher, undefined, undefined, undefined, { claimState: state }).claimReward(campaign, reward);

    expect(claimPosts).toBe(1);

    state.clear();
    await kickAdapter(fetcher, undefined, undefined, undefined, { claimState: state }).claimReward(campaign, reward);

    expect(claimPosts).toBe(2);

    await kickAdapter(fetcher, undefined, undefined, undefined, { claimState: new KickClaimState() }).claimReward(campaign, reward);

    expect(claimPosts).toBe(3);
  });

  it("keeps Kick claim v1 limited to campaign account-link metadata", () => {
    const capability = createKickClaimCapability("kick-claim-v1");

    expect(capability.classify(
      { connect_url: "https://accounts.example/ignored" },
      { id: "campaign", accountLinked: true } as DropCampaign,
    )).toEqual({ kind: "not_claimed" });
    expect(capability.classify(
      { message: "Reward not available" },
      { id: "campaign", accountLinked: false, accountLinkUrl: "https://accounts.example/from-campaign" } as DropCampaign,
    )).toEqual({ kind: "link_required", url: "https://accounts.example/from-campaign" });
    expect(capability.classify(
      { message: "Reward not available" },
      { id: "campaign", accountLinked: false, accountLinkUrl: "javascript:alert(1)" } as DropCampaign,
    )).toEqual({ kind: "not_claimed" });
  });

  it("guides the user to link instead of erroring when an unlinked Kick claim is rejected", async () => {
    const reward = { id: "reward", name: "Spray", status: "claimable", requiredMinutes: 1, watchedMinutes: 1 } as DropReward;
    let rejectionPosts = 0;
    const rejecting = () => kickAdapter(jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/drops/claim") {
        rejectionPosts += 1;
        throw new Error("403 Forbidden");
      }
      throw new Error(`Unexpected URL ${url}`);
    }));

    // Unlinked campaign: the rejection is swallowed (no platform backoff) and reported as a non-claim.
    const unlinked = rejecting();
    const unlinkedCampaign = { id: "c", accountLinked: false, accountLinkUrl: "https://accounts.krafton.com/x" } as DropCampaign;
    await expect(unlinked.claimReward(unlinkedCampaign, reward)).resolves.toBe(false);
    await expect(unlinked.claimReward(unlinkedCampaign, reward)).resolves.toBe(false);
    expect(rejectionPosts).toBe(1);

    // Linked campaign: a genuine claim error still propagates for the scheduler to handle.
    await expect(
      rejecting().claimReward({ id: "c", accountLinked: true } as DropCampaign, reward),
    ).rejects.toThrow("403");

    await expect(
      rejecting().claimReward({ id: "c", accountLinked: false, accountLinkUrl: "https://user:pass@accounts.example/x" } as DropCampaign, reward),
    ).rejects.toThrow("403");
  });

  it("reads category and viewer count from the new `categories` array shape", async () => {
    const fetcher = jsonFetcher((url) => {
      if (url === "https://kick.com/api/v2/channels/creator") {
        return { livestream: { is_live: true, categories: [{ id: 13, name: "Rust" }], viewer_count: 164, session_title: "Live" } };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const check = await kickAdapter(fetcher).checkChannel({ platform: "kick", username: "creator", url: "https://kick.com/creator" });
    expect(check.live).toBe(true);
    expect(check.candidate.viewerCount).toBe(164);
    expect(check.candidate.categoryName).toBe("Rust");
  });

  it("falls back to Kick channel page data when the channel API fails", async () => {
    const abort = new AbortController();
    const fetcher = jsonFetcher((url, init) => {
      if (url === "https://kick.com/api/v2/channels/creator") {
        throw new Error("Kick API unavailable");
      }
      if (url === "https://kick.com/creator") {
        expect(init?.signal).toBe(abort.signal);
        return { html: '{"livestream":{"is_live":true,"category":{"id":99,"name":"Game"}}}' };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = kickAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "kick", username: "creator", url: "https://kick.com/creator" },
      { campaign: { categoryId: "99" } as DropCampaign, signal: abort.signal },
    )).resolves.toMatchObject({
      live: true,
      categoryMatches: true,
      reason: "Kick API check failed; used channel page fallback",
      candidate: { categoryId: "99" },
    });
  });

  it("treats Kick channel validation as invalid when API and page fallback both fail", async () => {
    const fetcher = jsonFetcher((url) => {
      if (url === "https://kick.com/api/v2/channels/creator") {
        throw new Error("Kick API unavailable");
      }
      if (url === "https://kick.com/creator") {
        throw new Error("Kick page unavailable");
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = kickAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "kick", username: "creator", url: "https://kick.com/creator" },
      { campaign: { categoryId: "99" } as DropCampaign },
    )).resolves.toMatchObject({
      live: false,
      categoryMatches: false,
      reason: "Kick API unavailable",
    });
  });

  it("searches categories and maps id/name/banner image", async () => {
    const fetcher = jsonFetcher((url) => {
      expect(url.startsWith("https://kick.com/api/search")).toBe(true);
      expect(new URL(url).searchParams.get("searched_word")).toBe("rust");
      // Shape confirmed live: { channels, categories, livestreams }.
      return {
        channels: [{ id: 1, slug: "rustimba" }],
        categories: [
          { id: 13, category_id: 1, name: "Rust", slug: "rust", banner: { src: "https://files.kick.com/rust.webp" } },
          { id: 13, name: "Rust dup" },
          { id: "", name: "blank" },
        ],
      };
    });

    await expect(kickAdapter(fetcher).searchCategories("rust")).resolves.toEqual([
      { id: "13", name: "Rust", imageUrl: "https://files.kick.com/rust.webp" },
    ]);
  });

  it("returns no categories for a blank query without fetching", async () => {
    const fetcher = jsonFetcher(() => { throw new Error("should not fetch"); });
    await expect(kickAdapter(fetcher).searchCategories("   ")).resolves.toEqual([]);
  });

  it("claims only completed, unclaimed Kick challenges", async () => {
    const claimed: string[] = [];
    const fetcher = jsonFetcher((url, init) => {
      if (url === "https://web.kick.com/api/v1/gamification/challenges") {
        return {
          data: [
            { id: "done", recurrence: "daily", claimed_at: null, condition: { progress: 60, threshold: 60 } },
            { id: "already", recurrence: "daily", claimed_at: "2026-07-17T23:39:02Z", condition: { progress: 60, threshold: 60 } },
            { id: "partial", recurrence: "daily", claimed_at: null, condition: { progress: 30, threshold: 60 } },
          ],
        };
      }
      if (url === "https://web.kick.com/api/v1/gamification/challenges/done/claim") {
        expect(init?.method).toBe("POST");
        claimed.push("done");
        return { data: { challenge_id: "done", winner: { id: "card", rarity: "legendary" } } };
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const adapter = kickAdapter(fetcher);

    await expect(adapter.claimChallenges!()).resolves.toEqual([
      { id: "done", rarity: "legendary", recurrence: "daily" },
    ]);
    expect(claimed).toEqual(["done"]);
  });

  it("reports an unknown rarity when the Kick claim response omits a winner", async () => {
    const fetcher = jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/gamification/challenges") {
        return { data: [{ id: "done", recurrence: "weekly", claimed_at: null, condition: { progress: 5, threshold: 5 } }] };
      }
      if (url === "https://web.kick.com/api/v1/gamification/challenges/done/claim") return { message: "success" };
      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(kickAdapter(fetcher).claimChallenges!()).resolves.toEqual([
      { id: "done", rarity: "unknown", recurrence: "weekly" },
    ]);
  });

  it("keeps claiming Kick challenges after one claim fails", async () => {
    const fetcher = jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/gamification/challenges") {
        return {
          data: [
            { id: "bad", recurrence: "daily", claimed_at: null, condition: { progress: 1, threshold: 1 } },
            { id: "good", recurrence: "daily", claimed_at: null, condition: { progress: 1, threshold: 1 } },
          ],
        };
      }
      if (url === "https://web.kick.com/api/v1/gamification/challenges/bad/claim") throw new Error("boom");
      if (url === "https://web.kick.com/api/v1/gamification/challenges/good/claim") {
        return { data: { winner: { rarity: "common" } } };
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(kickAdapter(fetcher).claimChallenges!()).resolves.toEqual([
      { id: "good", rarity: "common", recurrence: "daily" },
    ]);
  });

  it("returns nothing when Kick reports no challenges", async () => {
    const fetcher = jsonFetcher(() => ({}));
    await expect(kickAdapter(fetcher).claimChallenges!()).resolves.toEqual([]);
  });
});

describe("createKickFetcher (background-first, tab fallback)", () => {
  it("coalesces every request outcome into one consume-once cycle observation", async () => {
    const fetcher = createKickFetcher({
      background: async () => ({ ok: true }),
      pageFetch: async () => ({ ok: true }),
    });

    await Promise.all(Array.from({ length: 40 }, (_, index) => fetcher.fetchJson(
      index % 2 === 0 ? "https://kick.com/api/test" : "https://web.kick.com/api/test",
    )));

    expect(fetcher.consumePageContextCycleObservation()).toEqual({
      backgroundHosts: ["kick.com", "web.kick.com"],
      fallbackHosts: [],
    });
    expect(fetcher.consumePageContextCycleObservation()).toBeUndefined();
  });

  it("records fallback evidence alongside successes so reconciliation can give fallback precedence", async () => {
    let calls = 0;
    const fetcher = createKickFetcher({
      background: async () => {
        calls += 1;
        if (calls === 2) throw new KickWafBlockedError("blocked");
        return { ok: true };
      },
      pageFetch: async () => ({ ok: true }),
    });

    await fetcher.fetchJson("https://kick.com/api/first");
    await fetcher.fetchJson("https://kick.com/api/second");

    expect(fetcher.consumePageContextCycleObservation()).toEqual({
      backgroundHosts: ["kick.com"],
      fallbackHosts: ["kick.com"],
    });
  });

  it("uses the service-worker result and never touches the page tab when the background fetch succeeds", async () => {
    const background = vi.fn(async () => ({ data: "from-sw" }));
    const pageFetch = vi.fn(async () => ({ data: "from-tab" }));
    const onBackgroundSuccess = vi.fn(async () => undefined);
    const onPageFallback = vi.fn(async () => undefined);
    const fetcher = createKickFetcher({ background, pageFetch, onBackgroundSuccess, onPageFallback });

    const result = await fetcher.fetchJson("https://web.kick.com/api/v1/drops/campaigns");

    expect(result).toEqual({ data: "from-sw" });
    expect(background).toHaveBeenCalledTimes(1);
    expect(pageFetch).not.toHaveBeenCalled();
    expect(onBackgroundSuccess).toHaveBeenCalledWith("web.kick.com", expect.any(Function));
    expect(onPageFallback).not.toHaveBeenCalled();
  });

  it("falls back to the page tab when the background fetch is WAF-blocked", async () => {
    const background = vi.fn(async () => { throw new KickWafBlockedError("HTTP 403 Forbidden"); });
    const pageFetch = vi.fn(async () => ({ data: "from-tab" }));
    const onPageFallback = vi.fn(async () => undefined);
    const fetcher = createKickFetcher({ background, pageFetch, onPageFallback });

    const result = await fetcher.fetchJson("https://web.kick.com/api/v1/drops/campaigns", { method: "GET" });

    expect(result).toEqual({ data: "from-tab" });
    expect(background).toHaveBeenCalledTimes(1);
    // The same url + init are forwarded to the fallback unchanged.
    expect(pageFetch).toHaveBeenCalledWith("https://web.kick.com/api/v1/drops/campaigns", { method: "GET" });
    expect(onPageFallback).toHaveBeenCalledWith("web.kick.com", expect.any(Function));
  });

  it("does not enter page fallback for an already-aborted request", async () => {
    const reason = new Error("auth deadline elapsed");
    const abort = new AbortController();
    abort.abort(reason);
    const background = vi.fn(async () => {
      throw new KickWafBlockedError("background rejected after deadline");
    });
    const pageFetch = vi.fn(async () => ({ id: 42 }));
    const onPageFallback = vi.fn(async () => undefined);
    const fetcher = createKickFetcher({ background, pageFetch, onPageFallback });

    await expect(fetcher.fetchJson(
      "https://kick.com/api/v1/user",
      { signal: abort.signal },
    )).rejects.toBe(reason);

    expect(pageFetch).not.toHaveBeenCalled();
    expect(onPageFallback).not.toHaveBeenCalled();
  });

  it("does not enter page fallback when an in-flight background request is aborted", async () => {
    const reason = new Error("auth deadline elapsed");
    const abort = new AbortController();
    let backgroundStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      backgroundStarted = resolve;
    });
    const background = vi.fn(async (_url: string, init?: RequestInit) => {
      backgroundStarted();
      await new Promise<void>((resolve) => {
        init?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new KickWafBlockedError("background rejected after deadline");
    });
    const pageFetch = vi.fn(async () => ({ id: 42 }));
    const onPageFallback = vi.fn(async () => undefined);
    const fetcher = createKickFetcher({ background, pageFetch, onPageFallback });

    const request = fetcher.fetchJson(
      "https://kick.com/api/v1/user",
      { signal: abort.signal },
    );
    await started;
    abort.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(pageFetch).not.toHaveBeenCalled();
    expect(onPageFallback).not.toHaveBeenCalled();
  });

  it("records fallback before page execution even when the page request fails", async () => {
    const order: string[] = [];
    const fetcher = createKickFetcher({
      background: async () => { throw new KickWafBlockedError("blocked"); },
      onPageFallback: async () => { order.push("fallback"); },
      pageFetch: async () => {
        order.push("page");
        throw new Error("page unavailable");
      },
    });

    await expect(fetcher.fetchJson("https://web.kick.com/api/v1/drops/campaigns"))
      .rejects.toThrow("page unavailable");
    expect(order).toEqual(["fallback", "page"]);
  });

  it("keeps fallback diagnostics free of request details and raw errors", async () => {
    const events: EngineEvent[] = [];
    const fetcher = createKickFetcher({
      background: async () => { throw new Error("token=secret-value"); },
      pageFetch: async () => ({ ok: true }),
    });

    await fetcher.fetchJson("https://web.kick.com/api/private?token=secret-value", undefined, (event) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ category: "diagnostic", platform: "kick" });
    expect(events[0].category === "diagnostic" ? events[0].message : "").toContain("web.kick.com");
    expect(events[0].category === "diagnostic" ? events[0].message : "").not.toContain("secret-value");

    events.length = 0;
    await fetcher.fetchJson("not-a-url-secret-value", undefined, (event) => events.push(event));
    expect(events[0].category === "diagnostic" ? events[0].message : "").toContain("unknown-host");
    expect(events[0].category === "diagnostic" ? events[0].message : "").not.toContain("secret-value");
  });

  it("does not turn lifecycle bookkeeping failures into request failures or extra fallbacks", async () => {
    const pageFetch = vi.fn(async () => ({ data: "from-tab" }));
    const backgroundFetcher = createKickFetcher({
      background: async () => ({ data: "from-sw" }),
      pageFetch,
      onBackgroundSuccess: async () => { throw new Error("bookkeeping failed"); },
    });

    await expect(backgroundFetcher.fetchJson("https://web.kick.com/api/v1/drops/campaigns"))
      .resolves.toEqual({ data: "from-sw" });
    expect(pageFetch).not.toHaveBeenCalled();

    const fallbackFetcher = createKickFetcher({
      background: async () => { throw new KickWafBlockedError("blocked"); },
      pageFetch,
      onPageFallback: async () => { throw new Error("bookkeeping failed"); },
    });
    await expect(fallbackFetcher.fetchJson("https://web.kick.com/api/v1/drops/campaigns"))
      .resolves.toEqual({ data: "from-tab" });
  });

  it("also falls back on a non-WAF background error", async () => {
    const background = vi.fn(async () => { throw new Error("boom"); });
    const pageFetch = vi.fn(async () => ({ data: "from-tab" }));
    const fetcher = createKickFetcher({ background, pageFetch });

    await expect(fetcher.fetchJson("https://kick.com/api/v2/channels/x")).resolves.toEqual({ data: "from-tab" });
    expect(pageFetch).toHaveBeenCalledTimes(1);
  });
});

describe("TwitchAdapter", () => {
  it("refreshes Twitch campaigns with one inventory request", async () => {
    let inventoryCalls = 0;
    const adapter = twitchAdapter(jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as
        | Record<string, unknown>
        | Array<Record<string, unknown>>;
      if (Array.isArray(body)) {
        return body.map((entry) =>
          twitchCampaignDetails(String((entry.variables as { dropID?: string }).dropID)));
      }
      if (body.operationName === "Inventory") {
        inventoryCalls += 1;
        return twitchInventory(["campaign"]);
      }
      return twitchDashboard(["campaign"]);
    }));

    await adapter.refreshCampaigns();

    expect(inventoryCalls).toBe(1);
  });

  it("merges active Twitch session progress without repeating inventory", async () => {
    let inventoryCalls = 0;
    let currentDropCalls = 0;
    const adapter = twitchAdapter(jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as
        | Record<string, unknown>
        | Array<Record<string, unknown>>;
      if (Array.isArray(body)) {
        return body.map((entry) =>
          twitchCampaignDetails(String((entry.variables as { dropID?: string }).dropID)));
      }
      if (body.operationName === "Inventory") {
        inventoryCalls += 1;
        return twitchInventory(["campaign"]);
      }
      if (body.operationName === "ViewerDropsDashboard") return twitchDashboard(["campaign"]);
      if (body.operationName === "VideoPlayerStreamInfoOverlayChannel") {
        return { data: { user: { id: "channel-id" } } };
      }
      if (body.operationName === "DropCurrentSessionContext") {
        currentDropCalls += 1;
        return {
          data: {
            currentUser: {
              dropCurrentSession: {
                dropID: "campaign-drop",
                currentMinutesWatched: 42,
              },
            },
          },
        };
      }
      throw new Error(`Unexpected operation ${String(body.operationName)}`);
    }));

    const campaigns = await adapter.refreshCampaigns({
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      channel: {
        platform: "twitch",
        username: "creator",
        url: "https://www.twitch.tv/creator",
      },
    } as never);

    expect(inventoryCalls).toBe(1);
    expect(currentDropCalls).toBe(1);
    expect(campaigns[0]?.rewards[0]?.watchedMinutes).toBe(42);
  });

  it("lists followed live channels and caches them across calls", async () => {
    let calls = 0;
    const adapter = twitchAdapter(jsonFetcher((_url, init) => {
      const body = requestBody(init);
      if (body.operationName !== "FollowedLiveChannels") throw new Error(`Unexpected operation ${String(body.operationName)}`);
      calls += 1;
      return {
        data: {
          currentUser: {
            id: "user-id",
            followedLiveUsers: {
              edges: [
                { node: { id: "1", login: "Friend" } },
                { node: { id: "2", login: "other" } },
                { node: {} },
              ],
            },
          },
        },
      };
    }));

    await expect(adapter.listFollowedChannels()).resolves.toEqual(["friend", "other"]);
    await expect(adapter.listFollowedChannels()).resolves.toEqual(["friend", "other"]);
    expect(calls).toBe(1);
  });

  it("reports no followed channels when the query returns GQL errors", async () => {
    const emit = vi.fn();
    // Schema drift answers 200 with an errors body rather than throwing, so it
    // must not be mistaken for a signed-out account with no live follows.
    const adapter = twitchAdapter(
      jsonFetcher(() => ({ errors: [{ message: "Cannot query field followedLiveUsers" }] })),
      undefined,
      undefined,
      undefined,
      emit,
    );

    await expect(adapter.listFollowedChannels()).resolves.toEqual([]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      category: "diagnostic",
      message: expect.stringContaining("followed-channel lookup failed"),
    }));
  });

  it("returns no followed channels for a signed-out session", async () => {
    const adapter = twitchAdapter(jsonFetcher(() => ({ data: { currentUser: null } })));

    await expect(adapter.listFollowedChannels()).resolves.toEqual([]);
  });

  it("shares the followed-channel cache across adapter instances via discoveryState", async () => {
    // The extension reconstructs TwitchAdapter fresh every scheduler tick, so a
    // cache the discoveryState doesn't survive would hit the network on every
    // tick. Two separate instances standing in for two ticks proves the cache
    // outlives the adapter.
    let calls = 0;
    const fetcher = jsonFetcher(() => {
      calls += 1;
      return { data: { currentUser: { followedLiveUsers: { edges: [{ node: { login: "friend" } }] } } } };
    });
    const discoveryState = new TwitchDiscoveryState();
    const firstTick = twitchAdapter(fetcher, undefined, undefined, { discoveryState });
    const secondTick = twitchAdapter(fetcher, undefined, undefined, { discoveryState });

    await expect(firstTick.listFollowedChannels()).resolves.toEqual(["friend"]);
    await expect(secondTick.listFollowedChannels()).resolves.toEqual(["friend"]);

    expect(calls).toBe(1);
  });

  it("drops the followed-channel cache when the authenticated user changes", async () => {
    // Follows are per-account, so a cache populated under one user must never
    // answer for the next one — the discoveryState outlives the adapter, so
    // without an explicit reset the old account's list would serve for the rest
    // of the TTL.
    let calls = 0;
    const fetcher = jsonFetcher(() => {
      calls += 1;
      const login = calls === 1 ? "first-account-friend" : "second-account-friend";
      return { data: { currentUser: { followedLiveUsers: { edges: [{ node: { login } }] } } } };
    });
    const discoveryState = new TwitchDiscoveryState();
    discoveryState.setAuthenticatedUser("user-1");
    const firstTick = twitchAdapter(fetcher, undefined, undefined, { discoveryState });
    await expect(firstTick.listFollowedChannels()).resolves.toEqual(["first-account-friend"]);

    discoveryState.setAuthenticatedUser("user-2");
    const secondTick = twitchAdapter(fetcher, undefined, undefined, { discoveryState });

    await expect(secondTick.listFollowedChannels()).resolves.toEqual(["second-account-friend"]);
    expect(calls).toBe(2);
  });

  it("keeps the followed-channel cache when the same user re-authenticates", async () => {
    let calls = 0;
    const fetcher = jsonFetcher(() => {
      calls += 1;
      return { data: { currentUser: { followedLiveUsers: { edges: [{ node: { login: "friend" } }] } } } };
    });
    const discoveryState = new TwitchDiscoveryState();
    discoveryState.setAuthenticatedUser("user-1");
    const firstTick = twitchAdapter(fetcher, undefined, undefined, { discoveryState });
    await expect(firstTick.listFollowedChannels()).resolves.toEqual(["friend"]);

    // Discovery re-reports the same id every tick; that must not cost a refetch.
    discoveryState.setAuthenticatedUser("user-1");
    const secondTick = twitchAdapter(fetcher, undefined, undefined, { discoveryState });

    await expect(secondTick.listFollowedChannels()).resolves.toEqual(["friend"]);
    expect(calls).toBe(1);
  });

  it("serves a stale followed-channel cache immediately and refreshes in the background", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let resolveSecondFetch: (() => void) | undefined;
      const fetcher = jsonFetcher(() => {
        calls += 1;
        if (calls === 1) {
          return { data: { currentUser: { followedLiveUsers: { edges: [{ node: { login: "stale-friend" } }] } } } };
        }
        // The second (background) fetch never resolves until the test lets it,
        // so a caller blocking on it would hang the assertion below.
        return new Promise((resolve) => {
          resolveSecondFetch = () => resolve({ data: { currentUser: { followedLiveUsers: { edges: [{ node: { login: "fresh-friend" } }] } } } });
        });
      });
      const discoveryState = new TwitchDiscoveryState();
      const firstTick = twitchAdapter(fetcher, undefined, undefined, { discoveryState });

      await expect(firstTick.listFollowedChannels()).resolves.toEqual(["stale-friend"]);
      expect(calls).toBe(1);

      vi.advanceTimersByTime(6 * 60_000); // past the 5-minute cache TTL
      const secondTick = twitchAdapter(fetcher, undefined, undefined, { discoveryState });

      // Resolves with the stale value without waiting on the (still-pending)
      // background refresh.
      await expect(secondTick.listFollowedChannels()).resolves.toEqual(["stale-friend"]);
      expect(calls).toBe(2);

      resolveSecondFetch?.();
      await vi.waitFor(() => expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState }).listFollowedChannels())
        .resolves.toEqual(["fresh-friend"]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the auth probe signal to the Twitch CurrentUser request", async () => {
    const abort = new AbortController();
    const emit = vi.fn();
    const fetchJson = vi.fn(async () => ({ data: { currentUser: { id: "u" } } }));
    const fetcher = { fetchJson: fetchJson as PageFetcher["fetchJson"] };

    await twitchAdapter(fetcher, undefined, undefined, undefined, emit).checkAuthHealth(abort.signal);

    expect(fetchJson).toHaveBeenCalledWith(
      "https://gql.twitch.tv/gql",
      expect.objectContaining({ signal: abort.signal }),
      emit,
    );
  });

  it("reports healthy only when the authenticated CurrentUser probe returns a user", async () => {
    const ensureIntegrity = vi.fn(async () => true);
    const fetcher = jsonFetcher((_url, init) => {
      expect(operation(init)).toBe("CurrentUser");
      expect(requestBody(init).query).toContain("currentUser { id }");
      return { data: { currentUser: { id: "private-user-id" } } };
    });

    await expect(twitchAdapter(fetcher, ensureIntegrity).checkAuthHealth()).resolves.toEqual({
      status: "healthy",
      checkedAt: expect.any(String),
      message: { key: "authHealthy" },
    });
    expect(ensureIntegrity).not.toHaveBeenCalled();
  });

  it.each([
    { data: { currentUser: null } },
    { data: {} },
    { data: { user: { id: "public-user-id" } } },
  ])("rejects a completed response without authenticated identity: %j", async (response) => {
    const fetcher = jsonFetcher(() => response);

    await expect(twitchAdapter(fetcher).checkAuthHealth()).resolves.toEqual({
      status: "invalid_credentials",
      checkedAt: expect.any(String),
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    });
  });

  it.each([
    { error: "Unauthorized", message: "OAuth token is invalid" },
    { errors: [{ message: "Unauthenticated" }] },
    { errors: [{ message: "The OAuth token was invalid" }] },
  ])("classifies explicit Twitch credential rejection as invalid: %j", async (response) => {
    const fetcher = jsonFetcher(() => response);

    await expect(twitchAdapter(fetcher).checkAuthHealth()).resolves.toEqual({
      status: "invalid_credentials",
      checkedAt: expect.any(String),
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    });
  });

  it.each([
    [401, "Unauthorized", "invalid_credentials", "credentials_rejected", "authInvalidCredentials"],
    [503, "Service Unavailable", "unavailable", "platform_unavailable", "authPlatformUnavailable"],
  ] as const)("classifies background HTTP %i without treating it as a network failure", async (status, statusText, healthStatus, reasonCode, messageKey) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(status === 401 ? "OAuth token rejected" : "upstream unavailable", { status, statusText }),
    );
    const cookieApi = {
      cookies: {
        get: vi.fn(async ({ name }: { name: string }) => name === "auth-token" ? { value: "secret" } : null),
      },
    };
    const fetcher: PageFetcher = {
      fetchJson: (url, init) => fetchTwitchInBackgroundWith(cookieApi, url, init),
    };

    try {
      await expect(twitchAdapter(fetcher).checkAuthHealth()).resolves.toEqual({
        status: healthStatus,
        checkedAt: expect.any(String),
        reasonCode,
        message: { key: messageKey },
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("classifies request transport failure as network unavailability", async () => {
    const fetcher = jsonFetcher(() => {
      throw new TypeError("Failed to fetch secret-url");
    });

    await expect(twitchAdapter(fetcher).checkAuthHealth()).resolves.toEqual({
      status: "unavailable",
      checkedAt: expect.any(String),
      reasonCode: "network_unavailable",
      message: { key: "authNetworkUnavailable" },
    });
  });

  it.each([
    { errors: [{ message: "service unavailable" }] },
    { error: "Service Unavailable", message: "upstream failed" },
    null,
  ])("classifies Twitch response failure as platform unavailability: %j", async (response) => {
    const fetcher = jsonFetcher(() => response);

    await expect(twitchAdapter(fetcher).checkAuthHealth()).resolves.toEqual({
      status: "unavailable",
      checkedAt: expect.any(String),
      reasonCode: "platform_unavailable",
      message: { key: "authPlatformUnavailable" },
    });
  });

  it("declares the post-claim handoff capability for Twitch only", () => {
    // Reading a capability must not touch the network.
    const fetcher = jsonFetcher(() => {
      throw new Error("unexpected fetch");
    });

    // Read through the interface: the capability is optional there, and Kick's
    // concrete class deliberately does not declare it at all.
    const twitch: PlatformAdapter = twitchAdapter(fetcher);
    const kick: PlatformAdapter = kickAdapter(fetcher);

    expect(twitch.supportsPostClaimHandoff).toBe(true);
    expect(kick.supportsPostClaimHandoff).toBeUndefined();
  });

  it("discovers active dashboard campaigns through detail GQL and merges inventory progress", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        expect(requestBody(init).variables).toMatchObject({ fetchRewardCampaigns: false });
        return {
          data: {
            currentUser: {
              id: "user-id",
              inventory: {
                dropCampaignsInProgress: [{
                  id: "campaign",
                  timeBasedDrops: [{
                    id: "drop",
                    requiredMinutesWatched: 60,
                    self: { currentMinutesWatched: 60, dropInstanceID: "claim", isClaimed: false },
                  }],
                }],
              },
            },
          },
        };
      }
      if (op === "ViewerDropsDashboard") {
        expect(requestBody(init).variables).toMatchObject({ fetchRewardCampaigns: false });
        return {
          data: {
            currentUser: {
              id: "user-id",
              login: "viewer",
              dropCampaigns: [{ id: "campaign", status: "ACTIVE", self: { isAccountConnected: true } }],
            },
          },
        };
      }
      if (op === "DropCampaignDetails") {
        expect(requestBody(init).variables).toMatchObject({ channelLogin: "user-id", dropID: "campaign" });
        return {
          data: {
            dropCampaign: {
              id: "campaign",
              name: "Twitch Campaign",
              game: { id: "game", slug: "game-slug", displayName: "Game" },
              timeBasedDrops: [{
                id: "drop",
                requiredMinutesWatched: 60,
                benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
              }],
            },
          },
        };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = twitchAdapter(fetcher);

    const campaigns = await adapter.refreshCampaigns();

    expect(campaigns[0]).toMatchObject({ id: "campaign", name: "Twitch Campaign", isGeneralDrop: true });
    expect(campaigns[0].rewards[0]).toMatchObject({ status: "claimable", claimId: "claim" });
  });

  it("falls back to inventory campaigns when Twitch campaign details hash is stale", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return {
          data: {
            currentUser: {
              id: "user-id",
              inventory: {
                dropCampaignsInProgress: [{
                  id: "campaign",
                  name: "Inventory Campaign",
                  game: { id: "game", slug: "game-slug", displayName: "Game" },
                  timeBasedDrops: [{
                    id: "drop",
                    requiredMinutesWatched: 60,
                    self: { currentMinutesWatched: 20, dropInstanceID: "claim", isClaimed: false },
                  }],
                }],
              },
            },
          },
        };
      }
      if (op === "ViewerDropsDashboard") {
        return {
          data: {
            currentUser: {
              login: "viewer",
              dropCampaigns: [{ id: "campaign", status: "ACTIVE", self: { isAccountConnected: true } }],
            },
          },
        };
      }
      if (op === "DropCampaignDetails") {
        return { errors: [{ message: "PersistedQueryNotFound" }] };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await twitchAdapter(fetcher).refreshCampaigns();

    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]).toMatchObject({ id: "campaign", name: "Inventory Campaign", status: "active" });
    expect(campaigns[0].rewards[0]).toMatchObject({ watchedMinutes: 20, status: "in_progress", claimId: "claim" });
  });

  it("batches Twitch campaign detail operations in bounded groups", async () => {
    const campaignIds = Array.from({ length: 41 }, (_, index) => `campaign-${index}`);
    const detailBatchSizes: number[] = [];
    let activeDetailBatches = 0;
    let peakDetailBatches = 0;
    const emit = vi.fn();
    const fetcher = jsonFetcher(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      if (Array.isArray(body)) {
        detailBatchSizes.push(body.length);
        activeDetailBatches += 1;
        peakDetailBatches = Math.max(peakDetailBatches, activeDetailBatches);
        await Promise.resolve();
        activeDetailBatches -= 1;
        return body.map((entry) => twitchCampaignDetails(String(
          (entry.variables as { dropID?: string }).dropID,
        )));
      }
      if (body.operationName === "Inventory") return twitchInventory([]);
      if (body.operationName === "ViewerDropsDashboard") return twitchDashboard(campaignIds);
      throw new Error(`Unexpected operation ${String(body.operationName)}`);
    });

    const campaigns = await twitchAdapter(
      fetcher,
      undefined,
      undefined,
      undefined,
      emit,
    ).refreshCampaigns();

    expect(campaigns).toHaveLength(41);
    expect(detailBatchSizes).toEqual([20, 20, 1]);
    expect(peakDetailBatches).toBeLessThanOrEqual(2);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      message: expect.stringMatching(/^Twitch campaign details finished in \d+ms \(41 campaigns: 41 fetched in 3 batch requests, 0 single fallbacks, 0 served from cache\)$/),
    }));
  });

  it("starts Twitch inventory and dashboard discovery requests concurrently", async () => {
    let releaseInventory!: () => void;
    const inventoryGate = new Promise<void>((resolve) => {
      releaseInventory = resolve;
    });
    let dashboardStarted = false;
    const fetcher = jsonFetcher(async (_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        await inventoryGate;
        return twitchInventory([]);
      }
      if (op === "ViewerDropsDashboard") {
        dashboardStarted = true;
        return twitchDashboard([]);
      }
      throw new Error(`Unexpected operation ${op}`);
    });
    const discovery = twitchAdapter(fetcher).refreshCampaigns();

    try {
      await vi.waitFor(() => expect(dashboardStarted).toBe(true));
    } finally {
      releaseInventory();
    }
    await expect(discovery).resolves.toEqual([]);
  });

  it("keeps Twitch inventory campaigns when the dashboard query returns an empty response", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return {
          data: {
            currentUser: {
              id: "user-id",
              inventory: {
                dropCampaignsInProgress: [{
                  id: "campaign",
                  name: "Inventory Campaign",
                  game: { id: "game", slug: "fortnite", displayName: "Fortnite" },
                  timeBasedDrops: [{
                    id: "drop",
                    requiredMinutesWatched: 30,
                    benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
                  }],
                }],
              },
            },
          },
        };
      }
      if (op === "ViewerDropsDashboard") return null;
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await twitchAdapter(fetcher).refreshCampaigns();

    expect(campaigns[0]).toMatchObject({ id: "campaign", name: "Inventory Campaign", eligibility: "eligible" });
  });

  it("keeps a campaign whose details request fails once it has been seen successfully", async () => {
    let failing: string | undefined;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([]);
      if (op === "ViewerDropsDashboard") return twitchDashboard(["a", "b"]);
      if (op === "DropCampaignDetails") {
        const dropID = String((requestBody(init).variables as Record<string, unknown>).dropID);
        if (dropID === failing) throw new Error("service unavailable");
        return twitchCampaignDetails(dropID);
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const events: EngineEvent[] = [];
    const discoveryState = new TwitchDiscoveryState();
    const firstAdapter = twitchAdapter(fetcher, undefined, undefined, { discoveryState });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime("2026-08-31T12:00:00.000Z");
      expect((await firstAdapter.refreshCampaigns()).map((campaign) => campaign.id)).toEqual(["a", "b"]);
      failing = "b";
      // Past the detail reuse window, so "b" is actually re-requested and can
      // fail; retention is what has to carry it, not the reuse cache.
      vi.setSystemTime("2026-08-31T12:10:00.000Z");
      const secondAdapter = twitchAdapter(fetcher, undefined, undefined, { discoveryState }, (event) => events.push(event));
      const campaigns = await secondAdapter.refreshCampaigns();

      expect(campaigns.map((campaign) => campaign.id)).toEqual(["a", "b"]);
      expect(events.some((event) => event.category === "diagnostic" && event.level === "warn" && event.message.includes("b"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits a campaign whose details request fails before it was ever seen, but records it", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([]);
      if (op === "ViewerDropsDashboard") return twitchDashboard(["a", "b"]);
      if (op === "DropCampaignDetails") {
        const dropID = String((requestBody(init).variables as Record<string, unknown>).dropID);
        if (dropID === "b") throw new Error("service unavailable");
        return twitchCampaignDetails(dropID);
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const events: EngineEvent[] = [];
    const adapter = twitchAdapter(fetcher, undefined, undefined, undefined, (event) => events.push(event));

    const campaigns = await adapter.refreshCampaigns();

    expect(campaigns.map((campaign) => campaign.id)).toEqual(["a"]);
    expect(events.some((event) => event.category === "diagnostic" && event.level === "warn" && event.message.includes("b"))).toBe(true);
  });

  it("still propagates auth failures from a campaign details request", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([]);
      if (op === "ViewerDropsDashboard") return twitchDashboard(["a"]);
      if (op === "DropCampaignDetails") {
        throw new SafeFetchError({ kind: "authentication_rejected", status: 401, reason: "rejected" });
      }
      throw new Error(`Unexpected op ${op}`);
    });

    await expect(twitchAdapter(fetcher).refreshCampaigns()).rejects.toThrow(SafeFetchError);
  });

  it("keeps not-yet-started campaigns when the dashboard request fails after a successful one", async () => {
    let dashboardFails = false;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([]);
      if (op === "ViewerDropsDashboard") {
        if (dashboardFails) throw new Error("service unavailable");
        return twitchDashboard(["a"]);
      }
      if (op === "DropCampaignDetails") {
        return twitchCampaignDetails(String((requestBody(init).variables as Record<string, unknown>).dropID));
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const events: EngineEvent[] = [];
    const discoveryState = new TwitchDiscoveryState();
    const firstAdapter = twitchAdapter(fetcher, undefined, undefined, { discoveryState });

    expect((await firstAdapter.refreshCampaigns()).map((campaign) => campaign.id)).toEqual(["a"]);
    dashboardFails = true;
    const secondAdapter = twitchAdapter(fetcher, undefined, undefined, { discoveryState }, (event) => events.push(event));
    const campaigns = await secondAdapter.refreshCampaigns();

    expect(campaigns.map((campaign) => campaign.id)).toEqual(["a"]);
    expect(events.some((event) => event.category === "diagnostic" && event.level === "warn" && event.message.includes("dashboard"))).toBe(true);

    dashboardFails = false;
    expect((await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns()).map((campaign) => campaign.id)).toEqual(["a"]);
  });

  it("does not retain dashboard campaigns when the dashboard genuinely returns none", async () => {
    let dashboardIds = ["campaign"];
    let dashboardFails = false;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([]);
      if (op === "ViewerDropsDashboard") {
        if (dashboardFails) throw new Error("service unavailable");
        return twitchDashboard(dashboardIds);
      }
      if (op === "DropCampaignDetails") {
        return twitchCampaignDetails(String((requestBody(init).variables as Record<string, unknown>).dropID));
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();
    const firstAdapter = twitchAdapter(fetcher, undefined, undefined, { discoveryState });

    expect((await firstAdapter.refreshCampaigns()).map((campaign) => campaign.id)).toEqual(["campaign"]);
    dashboardIds = [];
    const secondAdapter = twitchAdapter(fetcher, undefined, undefined, { discoveryState });
    const campaigns = await secondAdapter.refreshCampaigns();

    expect(campaigns).toEqual([]);

    dashboardFails = true;
    const thirdAdapter = twitchAdapter(fetcher, undefined, undefined, { discoveryState });
    const failedCampaigns = await thirdAdapter.refreshCampaigns();

    expect(failedCampaigns).toEqual([]);
  });

  it("keeps a successful empty first dashboard authoritative when the reward-campaign fallback fails", async () => {
    let refresh = 1;
    let fallbackDashboard = false;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([]);
      if (op === "ViewerDropsDashboard") {
        if (refresh === 1) return twitchDashboard(["retained"]);
        if (fallbackDashboard) throw new Error("reward-campaign dashboard unavailable");
        fallbackDashboard = true;
        return twitchDashboard([]);
      }
      if (op === "DropCampaignDetails") {
        return twitchCampaignDetails(String((requestBody(init).variables as Record<string, unknown>).dropID));
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();

    expect((await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
      .map((campaign) => campaign.id)).toEqual(["retained"]);
    refresh = 2;

    const campaigns = await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns();

    expect(campaigns).toEqual([]);
  });

  it("keeps a successful empty dashboard authoritative when the reward-campaign inventory fallback fails", async () => {
    let refresh = 1;
    let fallbackInventoryFails = false;
    let dashboardFails = false;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      const variables = requestBody(init).variables as { fetchRewardCampaigns?: boolean };
      if (op === "Inventory") {
        if (fallbackInventoryFails && variables.fetchRewardCampaigns) {
          throw new Error("reward-campaign inventory unavailable");
        }
        return twitchInventory([]);
      }
      if (op === "ViewerDropsDashboard") {
        if (dashboardFails) throw new Error("dashboard unavailable");
        return twitchDashboard(refresh === 1 ? ["retained"] : []);
      }
      if (op === "DropCampaignDetails") {
        return twitchCampaignDetails(String((requestBody(init).variables as Record<string, unknown>).dropID));
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();

    expect((await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
      .map((campaign) => campaign.id)).toEqual(["retained"]);
    refresh = 2;
    fallbackInventoryFails = true;

    await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
      .resolves.toEqual([]);

    fallbackInventoryFails = false;
    dashboardFails = true;
    await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
      .resolves.toEqual([]);
  });

  it("still propagates authentication failures from the reward-campaign inventory fallback", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      const variables = requestBody(init).variables as { fetchRewardCampaigns?: boolean };
      if (op === "Inventory") {
        if (variables.fetchRewardCampaigns) {
          throw new SafeFetchError({ kind: "authentication_rejected", status: 401, reason: "rejected" });
        }
        return twitchInventory([]);
      }
      if (op === "ViewerDropsDashboard") return twitchDashboard([]);
      throw new Error(`Unexpected op ${op}`);
    });

    await expect(twitchAdapter(fetcher).refreshCampaigns()).rejects.toThrow(SafeFetchError);
  });

  it("does not reuse discovery retained for another authenticated Twitch user", async () => {
    let userId = "user-a";
    let dashboardFails = false;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([], userId);
      if (op === "ViewerDropsDashboard") {
        if (dashboardFails) throw new Error("dashboard unavailable");
        return twitchDashboard(["user-a-campaign"], userId);
      }
      if (op === "DropCampaignDetails") {
        if (dashboardFails) throw new Error("details unavailable");
        return twitchCampaignDetails(String((requestBody(init).variables as Record<string, unknown>).dropID));
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();

    expect((await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
      .map((campaign) => campaign.id)).toEqual(["user-a-campaign"]);
    userId = "user-b";
    dashboardFails = true;

    const campaigns = await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns();

    expect(campaigns).toEqual([]);
  });

  it("does not reuse campaign details retained for another authenticated Twitch user", async () => {
    let userId = "user-a";
    let detailsFail = false;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([], userId);
      if (op === "ViewerDropsDashboard") return twitchDashboard(["shared-campaign-id"], userId);
      if (op === "DropCampaignDetails") {
        if (detailsFail) throw new Error("details unavailable");
        return twitchCampaignDetails("shared-campaign-id");
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();

    expect((await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
      .map((campaign) => campaign.id)).toEqual(["shared-campaign-id"]);
    userId = "user-b";
    detailsFail = true;

    const campaigns = await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns();

    expect(campaigns).toEqual([]);
  });

  it("marks inventory campaigns expired when a successful dashboard contains only ended campaigns", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory(["ended"]);
      if (op === "ViewerDropsDashboard") {
        return {
          data: {
            currentUser: {
              id: "user-id",
              login: "viewer",
              dropCampaigns: [{ id: "ended", status: "EXPIRED" }],
            },
          },
        };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await twitchAdapter(fetcher).refreshCampaigns();

    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]).toMatchObject({ id: "ended", status: "expired", eligibility: "expired" });
  });

  it("does not reuse retained campaign details after Twitch authoritatively returns no campaign", async () => {
    let detailResponse: "campaign" | "missing" | "failure" = "campaign";
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([]);
      if (op === "ViewerDropsDashboard") return twitchDashboard(["campaign"]);
      if (op === "DropCampaignDetails") {
        if (detailResponse === "failure") throw new Error("details unavailable");
        if (detailResponse === "missing") return { data: { dropCampaign: null } };
        return twitchCampaignDetails("campaign");
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime("2026-08-31T12:00:00.000Z");
      expect((await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
        .map((campaign) => campaign.id)).toEqual(["campaign"]);
      detailResponse = "missing";
      // Each later refresh is stepped past the detail reuse window so it issues
      // a real request: reuse must not stand in for the authoritative "no such
      // campaign" answer this test is about.
      vi.setSystemTime("2026-08-31T12:10:00.000Z");
      await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
        .resolves.toEqual([]);
      detailResponse = "failure";

      vi.setSystemTime("2026-08-31T12:20:00.000Z");
      await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
        .resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prunes expired retained campaign details during a later write", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime("2026-07-26T12:00:00.000Z");
      const discoveryState = new TwitchDiscoveryState();
      const details = (discoveryState as unknown as {
        campaignDetailsByDropId: Map<string, unknown>;
      }).campaignDetailsByDropId;

      discoveryState.rememberCampaignDetails(
        "expired",
        { id: "expired" },
        undefined,
        discoveryState.availabilityRequestIdentity(),
      );
      vi.setSystemTime("2026-07-26T12:31:00.000Z");
      discoveryState.rememberCampaignDetails(
        "fresh",
        { id: "fresh" },
        undefined,
        discoveryState.availabilityRequestIdentity(),
      );

      expect([...details.keys()]).toEqual(["fresh"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks in-progress inventory campaigns the dashboard no longer lists active as expired", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return {
          data: {
            currentUser: {
              id: "user-id",
              inventory: {
                dropCampaignsInProgress: [
                  {
                    id: "active",
                    name: "Active Campaign",
                    timeBasedDrops: [{ id: "active-drop", requiredMinutesWatched: 60, self: { currentMinutesWatched: 20 } }],
                  },
                  {
                    id: "ended",
                    name: "Ended Campaign",
                    timeBasedDrops: [{ id: "ended-drop", requiredMinutesWatched: 60, self: { currentMinutesWatched: 20 } }],
                  },
                ],
              },
            },
          },
        };
      }
      if (op === "ViewerDropsDashboard") {
        return {
          data: {
            currentUser: {
              id: "user-id",
              login: "viewer",
              dropCampaigns: [{ id: "active", status: "ACTIVE", self: { isAccountConnected: true } }],
            },
          },
        };
      }
      if (op === "DropCampaignDetails") {
        return {
          data: {
            dropCampaign: {
              id: "active",
              name: "Active Campaign",
              timeBasedDrops: [{ id: "active-drop", requiredMinutesWatched: 60, benefitEdges: [{ benefit: { id: "b", name: "Reward" } }] }],
            },
          },
        };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await twitchAdapter(fetcher).refreshCampaigns();

    expect(campaigns.find((campaign) => campaign.id === "active")).toMatchObject({ status: "active", eligibility: "eligible" });
    expect(campaigns.find((campaign) => campaign.id === "ended")).toMatchObject({ status: "expired", eligibility: "expired" });
  });

  it("keeps an ended inventory campaign visible while it still has a claimable reward", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return {
          data: {
            currentUser: {
              id: "user-id",
              inventory: {
                dropCampaignsInProgress: [
                  {
                    id: "active",
                    name: "Active Campaign",
                    timeBasedDrops: [{ id: "active-drop", requiredMinutesWatched: 60, self: { currentMinutesWatched: 20 } }],
                  },
                  {
                    id: "ended",
                    name: "Ended Campaign",
                    timeBasedDrops: [{ id: "ended-drop", requiredMinutesWatched: 60, self: { currentMinutesWatched: 60, dropInstanceID: "claim" } }],
                  },
                ],
              },
            },
          },
        };
      }
      if (op === "ViewerDropsDashboard") {
        return {
          data: {
            currentUser: {
              id: "user-id",
              login: "viewer",
              dropCampaigns: [{ id: "active", status: "ACTIVE", self: { isAccountConnected: true } }],
            },
          },
        };
      }
      if (op === "DropCampaignDetails") {
        return {
          data: {
            dropCampaign: {
              id: "active",
              name: "Active Campaign",
              timeBasedDrops: [{ id: "active-drop", requiredMinutesWatched: 60, benefitEdges: [{ benefit: { id: "b", name: "Reward" } }] }],
            },
          },
        };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await twitchAdapter(fetcher).refreshCampaigns();

    const ended = campaigns.find((campaign) => campaign.id === "ended");
    expect(ended).toMatchObject({ status: "active", eligibility: "eligible" });
    expect(ended?.rewards[0]).toMatchObject({ status: "claimable" });
  });

  it("uses the inventory user id for Twitch details and keeps unlinked campaigns visible", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return { data: { currentUser: { id: "numeric-user-id", inventory: { dropCampaignsInProgress: [] } } } };
      }
      if (op === "ViewerDropsDashboard") {
        return {
          data: {
            currentUser: {
              login: "viewer-login",
              dropCampaigns: [{ id: "campaign", status: "ACTIVE", self: { isAccountConnected: false } }],
            },
          },
        };
      }
      if (op === "DropCampaignDetails") {
        expect(requestBody(init).variables).toMatchObject({ channelLogin: "numeric-user-id", dropID: "campaign" });
        return {
          data: {
            user: {
              dropCampaign: {
                id: "campaign",
                name: "Unlinked Campaign",
                status: "ACTIVE",
                accountLinkURL: "https://link",
                self: { isAccountConnected: false },
                game: { id: "game", slug: "fortnite", displayName: "Fortnite" },
                timeBasedDrops: [{
                  id: "drop",
                  requiredMinutesWatched: 30,
                  benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
                }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await twitchAdapter(fetcher).refreshCampaigns();

    expect(campaigns[0]).toMatchObject({
      id: "campaign",
      accountLinked: false,
      eligibility: "account_not_linked",
    });
  });

  it("retries Twitch campaign discovery with reward campaign variables when default responses are empty", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      const variables = requestBody(init).variables as { fetchRewardCampaigns?: boolean; dropID?: string };
      if (op === "Inventory") {
        return variables.fetchRewardCampaigns
          ? { data: { currentUser: { id: "user-id", inventory: { dropCampaignsInProgress: [] } } } }
          : { data: { currentUser: { inventory: { dropCampaignsInProgress: [] } } } };
      }
      if (op === "ViewerDropsDashboard") {
        return variables.fetchRewardCampaigns
          ? { data: { currentUser: { dropCampaigns: [{ id: "campaign", status: "ACTIVE" }] } } }
          : { data: { currentUser: { dropCampaigns: [] } } };
      }
      if (op === "DropCampaignDetails") {
        expect(variables.dropID).toBe("campaign");
        return {
          data: {
            dropCampaign: {
              id: "campaign",
              name: "Fallback Campaign",
              status: "ACTIVE",
              game: { id: "game", slug: "fortnite", displayName: "Fortnite" },
              timeBasedDrops: [{
                id: "drop",
                requiredMinutesWatched: 30,
                benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
              }],
            },
          },
        };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await twitchAdapter(fetcher).refreshCampaigns();

    expect(campaigns[0]).toMatchObject({ id: "campaign", name: "Fallback Campaign", eligibility: "eligible" });
  });

  it("discovers upcoming Twitch dashboard campaigns without making them farmable", async () => {
    const startsAt = "2999-01-01T00:00:00.000Z";
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return { data: { currentUser: { inventory: { dropCampaignsInProgress: [] } } } };
      }
      if (op === "ViewerDropsDashboard") {
        return {
          data: {
            currentUser: {
              login: "viewer",
              dropCampaigns: [{ id: "future", status: "UPCOMING", self: { isAccountConnected: true } }],
            },
          },
        };
      }
      if (op === "DropCampaignDetails") {
        return {
          data: {
            user: {
              dropCampaign: {
                id: "future",
                name: "Future Campaign",
                status: "UPCOMING",
                startAt: startsAt,
                endAt: "2999-01-02T00:00:00.000Z",
                game: { id: "game", slug: "game-slug", displayName: "Game" },
                timeBasedDrops: [{
                  id: "drop",
                  startAt: startsAt,
                  endAt: "2999-01-02T00:00:00.000Z",
                  requiredMinutesWatched: 30,
                  benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
                }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await twitchAdapter(fetcher).refreshCampaigns();

    expect(campaigns[0]).toMatchObject({
      id: "future",
      status: "upcoming",
      eligibility: "upcoming",
    });
  });

  it("retries transient GQL failures once", async () => {
    let attempts = 0;
    const fetcher = jsonFetcher((_url, init) => {
      attempts += 1;
      const op = operation(init);
      if (op === "ChannelPointsContext" && attempts === 1) {
        return { errors: [{ message: "service unavailable" }] };
      }
      if (op === "ChannelPointsContext") {
        return {
          data: {
            community: {
              channel: {
                id: "channel-id",
                self: { communityPoints: { availableClaim: { id: "claim-id" } } },
              },
            },
          },
        };
      }
      if (op === "ClaimCommunityPoints") {
        return { data: { claimCommunityPoints: { status: "CLAIMED" } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = twitchAdapter(fetcher);

    await expect(adapter.claimChannelPoints({ platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" }))
      .resolves.toBe(true);
    expect(attempts).toBe(3);
  });

  it("unwraps array-wrapped Twitch GQL responses from the batched endpoint", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        // Twitch answers with a one-entry array even for a single operation.
        return [{
          data: {
            currentUser: {
              id: "user-id",
              inventory: {
                dropCampaignsInProgress: [{
                  id: "campaign",
                  name: "Array Campaign",
                  game: { id: "game", slug: "fortnite", displayName: "Fortnite" },
                  timeBasedDrops: [{
                    id: "drop",
                    requiredMinutesWatched: 30,
                    benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
                  }],
                }],
              },
            },
          },
        }];
      }
      if (op === "ViewerDropsDashboard") return [null];
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await twitchAdapter(fetcher).refreshCampaigns();

    expect(campaigns[0]).toMatchObject({ id: "campaign", name: "Array Campaign", eligibility: "eligible" });
  });

  it("retries PersistedQueryNotFound from an array-wrapped Twitch GQL response with an inline query", async () => {
    let inventoryAttempts = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        inventoryAttempts += 1;
        if (inventoryAttempts === 1) {
          expect(requestBody(init).query).toBeUndefined();
          return [{ errors: [{ message: "PersistedQueryNotFound" }] }];
        }
        expect(String(requestBody(init).query)).toContain("dropCampaignsInProgress");
        return {
          data: {
            currentUser: {
              id: "user-id",
              inventory: {
                dropCampaignsInProgress: [{
                  id: "campaign",
                  name: "Inline Campaign",
                  game: { id: "game", slug: "fortnite", displayName: "Fortnite" },
                  timeBasedDrops: [{
                    id: "drop",
                    requiredMinutesWatched: 30,
                    benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
                  }],
                }],
              },
            },
          },
        };
      }
      if (op === "ViewerDropsDashboard") return [null];
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await twitchAdapter(fetcher).refreshCampaigns();

    expect(inventoryAttempts).toBe(2);
    expect(campaigns[0]).toMatchObject({ id: "campaign", name: "Inline Campaign", eligibility: "eligible" });
  });

  it("does not use inline fallback for non-persisted-query Twitch errors", async () => {
    let inventoryAttempts = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        inventoryAttempts += 1;
        return [{ errors: [{ message: "permission denied" }] }];
      }
      throw new Error(`Unexpected op ${op}`);
    });

    await expect(twitchAdapter(fetcher).refreshCampaigns()).rejects.toThrow("permission denied");
    expect(inventoryAttempts).toBe(1);
  });

  it("retries channel points context with an inline query when the persisted hash is stale", async () => {
    let contextAttempts = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "ChannelPointsContext") {
        contextAttempts += 1;
        if (contextAttempts === 1) return { errors: [{ message: "PersistedQueryNotFound" }] };
        expect(String(requestBody(init).query)).toContain("availableClaim");
        return {
          data: {
            community: {
              channel: {
                id: "channel-id",
                self: { communityPoints: { availableClaim: { id: "claim-id" } } },
              },
            },
          },
        };
      }
      if (op === "ClaimCommunityPoints") {
        return { data: { claimCommunityPoints: { status: "CLAIMED" } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    await expect(twitchAdapter(fetcher).claimChannelPoints({ platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" }))
      .resolves.toBe(true);
    expect(contextAttempts).toBe(2);
  });

  it("keeps the v1 inventory hash, variables, inline fallback, and parser paired", async () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/twitch-inventory-v1.json", import.meta.url), "utf8"));
    const inventoryBodies: Record<string, unknown>[] = [];
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        const body = requestBody(init);
        inventoryBodies.push(body);
        return inventoryBodies.length === 1
          ? { errors: [{ message: "PersistedQueryNotFound" }] }
          : fixture;
      }
      if (op === "ViewerDropsDashboard") return { data: { currentUser: { dropCampaigns: [] } } };
      throw new Error(`Unexpected op ${op}`);
    });

    // Explicit v1 override: the recommended/automatic profile resolves to
    // inventory v2, but this test exercises v1's hash/fallback/parser pairing.
    const campaigns = await twitchAdapter(fetcher, undefined, undefined, {
      compatibility: { ...TWITCH_COMPAT, inventory: "twitch-inventory-v1" },
    }).refreshCampaigns();

    expect(inventoryBodies).toHaveLength(2);
    expect(inventoryBodies[0]).toMatchObject({
      variables: { fetchRewardCampaigns: false },
      extensions: { persistedQuery: { sha256Hash: "d86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b" } },
    });
    expect(inventoryBodies[1]).toMatchObject({
      variables: { fetchRewardCampaigns: false },
      query: expect.stringContaining("dropCampaignsInProgress"),
    });
    expect(campaigns.map((campaign) => campaign.id)).toEqual(["active-campaign", "owned-campaign"]);
  });

  it("constructs the resolved inventory capability once and reuses it for requests, fallback, and parsing", async () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/twitch-inventory-v1.json", import.meta.url), "utf8"));
    const events: EngineEvent[] = [];
    let inventorySelectionReads = 0;
    const compatibility = {
      profile: "twitch-2026-07" as const,
      heartbeat: "twitch-heartbeat-spade-v1" as const,
      get inventory() {
        inventorySelectionReads += 1;
        return "twitch-inventory-v1" as const;
      },
    };
    let inventoryAttempts = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        inventoryAttempts += 1;
        return inventoryAttempts === 1
          ? { errors: [{ message: "PersistedQueryNotFound" }] }
          : fixture;
      }
      if (op === "ViewerDropsDashboard") return { data: { currentUser: { dropCampaigns: [] } } };
      throw new Error(`Unexpected op ${op}`);
    });

    const adapter = twitchAdapter(
      fetcher,
      undefined,
      undefined,
      { compatibility },
      (event) => events.push(event),
    );
    const campaigns = await adapter.refreshCampaigns();

    expect(inventorySelectionReads).toBe(1);
    expect(campaigns.map((campaign) => campaign.id)).toEqual(["active-campaign", "owned-campaign"]);
    expect(events).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      message: expect.stringContaining("twitch-inventory-v1"),
    }));
  });

  it("surfaces Twitch's top-level {error,message} auth failures", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      if (operation(init) === "Inventory") return { error: "Unauthorized", message: "invalid OAuth token" };
      throw new Error(`Unexpected op ${operation(init)}`);
    });

    await expect(twitchAdapter(fetcher).refreshCampaigns())
      .rejects.toMatchObject({
        failure: { kind: "authentication_rejected", status: 401 },
      });
  });

  it("guides signed-out users when inventory returns a null current user", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory" || op === "ViewerDropsDashboard") {
        return { data: { currentUser: null } };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    await expect(twitchAdapter(fetcher).refreshCampaigns())
      .rejects.toThrow("Twitch did not return a logged-in current user; open twitch.tv and confirm you are signed in");
  });

  it("reports unusable array-wrapped Twitch GQL responses as empty", async () => {
    for (const empty of [[], [null]] as const) {
      const adapter = twitchAdapter(jsonFetcher((_url, init) => {
        if (operation(init) === "ChannelPointsContext") return empty;
        throw new Error(`Unexpected op ${operation(init)}`);
      }));

      await expect(adapter.claimChannelPoints({ platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" }))
        .rejects.toThrow("ChannelPointsContext persisted query returned an empty Twitch GQL response");
    }
  });

  it("surfaces the page fetcher's __twitchGqlError diagnostic envelope", async () => {
    const adapter = twitchAdapter(jsonFetcher((_url, init) => {
      if (operation(init) === "Inventory") {
        return { __twitchGqlError: "returned an unusable response; status=200; body=null" };
      }
      throw new Error(`Unexpected op ${operation(init)}`);
    }));

    await expect(adapter.refreshCampaigns())
      .rejects.toThrow("Inventory: returned an unusable response; status=200; body=null");
  });

  it("reports null Twitch GQL responses with the operation name", async () => {
    const adapter = twitchAdapter(jsonFetcher((_url, init) => {
      if (operation(init) === "ChannelPointsContext") return null;
      throw new Error(`Unexpected op ${operation(init)}`);
    }));

    await expect(adapter.claimChannelPoints({ platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" }))
      .rejects.toThrow("ChannelPointsContext persisted query returned an empty Twitch GQL response");
  });

  it("maps stream info checks to live/category state via an inline query", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      expect(operation(init)).toBe("StreamInfo");
      const body = JSON.parse(String(init?.body));
      // Inline query is used instead of a persisted hash, which rotates and breaks.
      expect(body.query).toContain("viewersCount");
      expect(body.extensions?.persistedQuery).toBeUndefined();
      // Public query runs anonymously; logged-in GQL calls without integrity are rejected.
      expect(init?.credentials).toBe("omit");
      return { data: { user: { displayName: "Creator", stream: { viewersCount: 789, game: { id: "game", name: "Game" } } } } };
    });
    const adapter = twitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
      { campaign: { categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({
      live: true,
      categoryMatches: true,
      candidate: { categoryId: "game", categoryName: "Game", viewerCount: 789, displayName: "Creator" },
    });
  });

  it("confirms the selected campaign is available on the Twitch channel", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game", name: "Game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        expect(requestBody(init).variables).toEqual({ channelID: "channel-id" });
        return { data: { channel: { id: "channel-id", viewerDropCampaigns: [{ id: "campaign" }] } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = twitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator", isAclMatch: true },
      { campaign: { id: "campaign", categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({
      live: true,
      categoryMatches: true,
      campaignMatches: true,
      candidate: { channelId: "channel-id" },
    });
  });

  it("rejects a Twitch channel that explicitly does not offer the selected campaign", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        return { data: { channel: { id: "channel-id", viewerDropCampaigns: [{ id: "other" }] } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = twitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
      { campaign: { id: "campaign", categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({
      live: true,
      categoryMatches: true,
      campaignMatches: false,
      reason: "Twitch campaign is not available on this channel",
    });
  });

  it("falls back to live/category validation when Twitch campaign availability is unavailable", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") throw new Error("availability unavailable");
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = twitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
      { campaign: { id: "campaign", categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({
      live: true,
      categoryMatches: true,
      campaignMatches: undefined,
    });
  });

  it("treats malformed Twitch campaign availability as a soft fallback", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        return { data: { channel: { id: "channel-id" } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = twitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
      { campaign: { id: "campaign", categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({
      live: true,
      categoryMatches: true,
      campaignMatches: undefined,
    });
  });

  it("retries stale Twitch campaign availability hashes with an inline query", async () => {
    let availabilityAttempts = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        availabilityAttempts += 1;
        const body = requestBody(init);
        if (!body.query) return { errors: [{ message: "PersistedQueryNotFound" }] };
        expect(body.query).toContain("viewerDropCampaigns");
        return { data: { channel: { id: "channel-id", viewerDropCampaigns: [{ id: "campaign" }] } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = twitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
      { campaign: { id: "campaign", categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({ campaignMatches: true });
    expect(availabilityAttempts).toBe(2);
  });

  it("caches positive and negative Twitch campaign availability for a bounded time", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-13T12:00:00.000Z"));
      let availabilityCalls = 0;
      const fetcher = jsonFetcher((_url, init) => {
        const op = operation(init);
        if (op === "StreamInfo") {
          return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
        }
        if (op === "DropsHighlightService_AvailableDrops") {
          availabilityCalls += 1;
          return { data: { channel: { id: "channel-id", viewerDropCampaigns: [{ id: "available" }] } } };
        }
        throw new Error(`Unexpected op ${op}`);
      });
      const adapter = twitchAdapter(fetcher);
      const candidate = { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" } as const;

      await expect(adapter.checkChannel(candidate, {
        campaign: { id: "available", categoryId: "game" } as DropCampaign,
      }))
        .resolves.toMatchObject({ campaignMatches: true });
      await expect(adapter.checkChannel(candidate, {
        campaign: { id: "missing", categoryId: "game" } as DropCampaign,
      }))
        .resolves.toMatchObject({ campaignMatches: false });
      expect(availabilityCalls).toBe(1);

      // Past the old 60s TTL but inside the current 2-minute one: this is the
      // exact boundary #338 was filed over — a selection ~60s after the
      // previous one must still hit, not refetch.
      vi.advanceTimersByTime(60_001);
      await adapter.checkChannel(candidate, {
        campaign: { id: "available", categoryId: "game" } as DropCampaign,
      });
      expect(availabilityCalls).toBe(1);

      vi.advanceTimersByTime(60_000);
      await adapter.checkChannel(candidate, {
        campaign: { id: "available", categoryId: "game" } as DropCampaign,
      });
      expect(availabilityCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares Twitch campaign availability across adapter instances via discoveryState", async () => {
    // TwitchAdapter is reconstructed fresh every scheduler tick, so without
    // this the availability cache would refetch AvailableDrops for the same
    // channel on every tick — the defect #338 was filed over.
    let availabilityCalls = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        availabilityCalls += 1;
        return { data: { channel: { id: "channel-id", viewerDropCampaigns: [{ id: "campaign" }] } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();
    const candidate = { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" } as const;
    const campaign = { id: "campaign", categoryId: "game" } as DropCampaign;

    const firstTick = twitchAdapter(fetcher, undefined, undefined, { discoveryState });
    await expect(firstTick.checkChannel(candidate, { campaign })).resolves.toMatchObject({ campaignMatches: true });

    const secondTick = twitchAdapter(fetcher, undefined, undefined, { discoveryState });
    await expect(secondTick.checkChannel(candidate, { campaign })).resolves.toMatchObject({ campaignMatches: true });

    expect(availabilityCalls).toBe(1);
  });

  it("expires strict Twitch availability relative to the requested campaign", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-15T15:00:00.000Z"));
      const availabilityCalls = new Map<string, number>();
      const fetcher = jsonFetcher((_url, init) => {
        const op = operation(init);
        if (op === "StreamInfo") {
          const channel = String((requestBody(init).variables as { channel?: string }).channel);
          const channelId = channel === "positive" ? "positive-channel" : channel === "empty" ? "empty-channel" : "mixed-channel";
          return {
            data: {
              user: {
                id: channelId,
                stream: { id: `${channelId}-broadcast`, game: { id: "game" } },
              },
            },
          };
        }
        if (op === "DropsHighlightService_AvailableDrops") {
          const channelId = String((requestBody(init).variables as { channelID?: string }).channelID);
          availabilityCalls.set(channelId, (availabilityCalls.get(channelId) ?? 0) + 1);
          return {
            data: {
              channel: {
                id: channelId,
                viewerDropCampaigns: channelId === "empty-channel" ? [] : [{ id: "campaign-b" }],
              },
            },
          };
        }
        throw new Error(`Unexpected op ${op}`);
      });
      const discoveryState = new TwitchDiscoveryState();
      const adapter = twitchAdapter(fetcher, undefined, undefined, { discoveryState });
      const mixedCandidate = { platform: "twitch", username: "mixed", url: "https://www.twitch.tv/mixed" } as const;
      const positiveCandidate = { platform: "twitch", username: "positive", url: "https://www.twitch.tv/positive" } as const;
      const emptyCandidate = { platform: "twitch", username: "empty", url: "https://www.twitch.tv/empty" } as const;
      const campaignA = { id: "campaign-a", categoryId: "game" } as DropCampaign;
      const campaignB = { id: "campaign-b", categoryId: "game" } as DropCampaign;

      await expect(adapter.checkChannel(mixedCandidate, { campaign: campaignA }))
        .resolves.toMatchObject({ campaignMatches: false });
      expect(availabilityCalls.get("mixed-channel")).toBe(1);

      await expect(adapter.checkChannel(mixedCandidate, { campaign: campaignA }))
        .resolves.toMatchObject({ campaignMatches: false });
      expect(availabilityCalls.get("mixed-channel")).toBe(1);

      vi.advanceTimersByTime(30_001);
      await expect(adapter.checkChannel(mixedCandidate, { campaign: campaignB }))
        .resolves.toMatchObject({ campaignMatches: true });
      expect(availabilityCalls.get("mixed-channel")).toBe(1);

      await expect(adapter.checkChannel(mixedCandidate, { campaign: campaignA }))
        .resolves.toMatchObject({ campaignMatches: false });
      expect(availabilityCalls.get("mixed-channel")).toBe(2);

      await expect(adapter.checkChannel(positiveCandidate, { campaign: campaignB }))
        .resolves.toMatchObject({ campaignMatches: true });
      expect(availabilityCalls.get("positive-channel")).toBe(1);
      vi.advanceTimersByTime(2 * 60_000 - 1);
      await expect(adapter.checkChannel(positiveCandidate, { campaign: campaignB }))
        .resolves.toMatchObject({ campaignMatches: true });
      expect(availabilityCalls.get("positive-channel")).toBe(1);
      vi.advanceTimersByTime(1);
      await expect(adapter.checkChannel(positiveCandidate, { campaign: campaignB }))
        .resolves.toMatchObject({ campaignMatches: true });
      expect(availabilityCalls.get("positive-channel")).toBe(2);

      await expect(adapter.checkChannel(emptyCandidate, { campaign: campaignA }))
        .resolves.toMatchObject({ campaignMatches: false });
      expect(availabilityCalls.get("empty-channel")).toBe(1);
      vi.advanceTimersByTime(30_000 - 1);
      await expect(adapter.checkChannel(emptyCandidate, { campaign: campaignA }))
        .resolves.toMatchObject({ campaignMatches: false });
      expect(availabilityCalls.get("empty-channel")).toBe(1);
      vi.advanceTimersByTime(1);
      await expect(adapter.checkChannel(emptyCandidate, { campaign: campaignA }))
        .resolves.toMatchObject({ campaignMatches: false });
      expect(availabilityCalls.get("empty-channel")).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a contradictory Twitch availability negative after material progress", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-15T15:00:00.000Z"));
      let availabilityCalls = 0;
      const discoveryState = new TwitchDiscoveryState();
      discoveryState.setAuthenticatedUser("user-id");
      const fetcher = jsonFetcher((_url, init) => {
        const op = operation(init);
        if (op === "StreamInfo" || op === "VideoPlayerStreamInfoOverlayChannel") {
          return {
            data: {
              user: {
                id: "channel-id",
                stream: { id: "broadcast-a", game: { id: "game" } },
              },
            },
          };
        }
        if (op === "DropsHighlightService_AvailableDrops") {
          availabilityCalls += 1;
          return { data: { channel: { id: "channel-id", viewerDropCampaigns: [] } } };
        }
        if (op === "Inventory") {
          return {
            data: {
              currentUser: {
                id: "user-id",
                inventory: {
                  dropCampaignsInProgress: [{
                    id: "campaign-a",
                    timeBasedDrops: [{
                      id: "drop-a",
                      requiredMinutesWatched: 60,
                      self: { currentMinutesWatched: 10, isClaimed: false },
                    }],
                  }],
                },
              },
            },
          };
        }
        if (op === "ViewerDropsDashboard") return twitchDashboard([], "user-id");
        if (op === "DropCurrentSessionContext") {
          return {
            data: {
              currentUser: {
                dropCurrentSession: { dropID: "drop-a", currentMinutesWatched: 11 },
              },
            },
          };
        }
        throw new Error(`Unexpected op ${op}`);
      });
      const candidate = { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" } as const;
      const campaign = { id: "campaign-a", categoryId: "game" } as DropCampaign;

      await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState })
        .checkChannel(candidate, { campaign })).resolves.toMatchObject({ campaignMatches: false });
      expect(availabilityCalls).toBe(1);

      const progress = await twitchAdapter(fetcher, undefined, undefined, { discoveryState })
        .refreshCampaigns({
          platform: "twitch",
          status: "watching",
          offlineChecks: 0,
          channel: candidate,
        });
      expect(progress[0]?.rewards[0]?.watchedMinutes).toBe(11);

      await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState })
        .checkChannel(candidate, { campaign })).resolves.toMatchObject({ campaignMatches: true });
      expect(availabilityCalls).toBe(1);

      vi.advanceTimersByTime(5 * 60_000 + 1);
      await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState })
        .checkChannel(candidate, { campaign })).resolves.toMatchObject({ campaignMatches: false });
      expect(availabilityCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches single-channel availability when the channel starts a new broadcast", async () => {
    let broadcastId = "broadcast-a";
    let availabilityCalls = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: broadcastId, game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        availabilityCalls += 1;
        return {
          data: {
            channel: {
              id: "channel-id",
              viewerDropCampaigns: availabilityCalls === 1 ? [] : [{ id: "campaign" }],
            },
          },
        };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();
    const candidate = { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" } as const;
    const campaign = { id: "campaign", categoryId: "game" } as DropCampaign;

    await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState })
      .checkChannel(candidate, { campaign })).resolves.toMatchObject({ campaignMatches: false });
    broadcastId = "broadcast-b";
    await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState })
      .checkChannel(candidate, { campaign })).resolves.toMatchObject({ campaignMatches: true });

    expect(availabilityCalls).toBe(2);
  });

  it("drops the campaign availability cache when the authenticated user changes", async () => {
    // Availability results are per-account, same as follows — a cache
    // populated under one user must never answer for the next one.
    let availabilityCalls = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        availabilityCalls += 1;
        return { data: { channel: { id: "channel-id", viewerDropCampaigns: [{ id: "campaign" }] } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();
    const candidate = { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" } as const;
    const campaign = { id: "campaign", categoryId: "game" } as DropCampaign;

    discoveryState.setAuthenticatedUser("user-1");
    const firstTick = twitchAdapter(fetcher, undefined, undefined, { discoveryState });
    await expect(firstTick.checkChannel(candidate, { campaign })).resolves.toMatchObject({ campaignMatches: true });

    discoveryState.setAuthenticatedUser("user-2");
    const secondTick = twitchAdapter(fetcher, undefined, undefined, { discoveryState });
    await expect(secondTick.checkChannel(candidate, { campaign })).resolves.toMatchObject({ campaignMatches: true });

    expect(availabilityCalls).toBe(2);
  });

  it("logs a diagnostic and clears discovery caches when the authenticated Twitch identity changes", async () => {
    const events: EngineEvent[] = [];
    const emit = (event: EngineEvent) => events.push(event);
    const discoveryState = new TwitchDiscoveryState();
    const fetcherFor = (userId: string): PageFetcher => jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      if (Array.isArray(body)) {
        return body.map((entry) =>
          twitchCampaignDetails(String((entry.variables as { dropID?: string }).dropID)));
      }
      if (body.operationName === "Inventory") return twitchInventory(["campaign"], userId);
      return twitchDashboard(["campaign"], userId);
    });

    await twitchAdapter(fetcherFor("user-1"), undefined, undefined, { discoveryState }, emit).refreshCampaigns();
    expect(events.some((event) =>
      event.category === "diagnostic" && event.message.includes("identity changed"))).toBe(false);

    events.length = 0;
    await twitchAdapter(fetcherFor("user-2"), undefined, undefined, { discoveryState }, emit).refreshCampaigns();
    expect(events).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      message: "Twitch authenticated identity changed; discovery caches cleared",
    }));
  });

  it("bounds the campaign availability cache to a fixed number of channels (FIFO)", () => {
    const discoveryState = new TwitchDiscoveryState();
    // No identity has been discovered yet — direct adapter/state tests like
    // this one must keep working safely under the initial generation.
    const requestIdentity = discoveryState.availabilityRequestIdentity();
    for (let index = 0; index < 128; index += 1) {
      discoveryState.rememberChannelAvailability(`channel-${index}`, `broadcast-${index}`, new Set(["campaign"]), requestIdentity);
    }
    expect(discoveryState.cachedChannelAvailability("channel-0", "broadcast-0", "campaign")).toEqual({
      status: "hit",
      campaignIds: new Set(["campaign"]),
    });

    // Pushes the cache past its bound; the oldest entry must be evicted, not
    // an arbitrary or most-recent one.
    discoveryState.rememberChannelAvailability("channel-128", "broadcast-128", new Set(["campaign"]), requestIdentity);

    expect(discoveryState.cachedChannelAvailability("channel-0", "broadcast-0", "campaign")).toEqual({ status: "miss" });
    expect(discoveryState.cachedChannelAvailability("channel-128", "broadcast-128", "campaign")).toEqual({
      status: "hit",
      campaignIds: new Set(["campaign"]),
    });
  });

  it("limits progress-confirmed availability to the exact channel and campaign", () => {
    const discoveryState = new TwitchDiscoveryState();
    const identity = discoveryState.availabilityRequestIdentity();

    discoveryState.rememberChannelAvailability("channel-a", "broadcast-a", new Set(), identity);
    expect(discoveryState.rememberProgressConfirmedAvailability(
      "channel-a",
      "campaign-a",
      identity,
    )).toBe(true);

    expect(discoveryState.hasProgressConfirmedAvailability("channel-a", "campaign-a")).toBe(true);
    expect(discoveryState.hasProgressConfirmedAvailability("channel-a", "campaign-b")).toBe(false);
    expect(discoveryState.hasProgressConfirmedAvailability("channel-b", "campaign-a")).toBe(false);
    expect(discoveryState.cachedChannelAvailability("channel-a", "broadcast-a", "campaign-a")).toEqual({
      status: "hit",
      campaignIds: new Set(["campaign-a"]),
    });
  });

  it("promotes a progress-confirmed negative availability snapshot to the positive TTL", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-15T15:00:00Z"));
      const discoveryState = new TwitchDiscoveryState();
      const identity = discoveryState.availabilityRequestIdentity();
      discoveryState.rememberChannelAvailability("channel-a", "broadcast-a", new Set(), identity);
      vi.advanceTimersByTime(20_000);
      discoveryState.rememberProgressConfirmedAvailability("channel-a", "campaign-a", identity);

      vi.advanceTimersByTime(30_001);
      expect(discoveryState.cachedChannelAvailability("channel-a", "broadcast-a", "campaign-a")).toEqual({
        status: "hit",
        campaignIds: new Set(["campaign-a"]),
      });

      vi.advanceTimersByTime(89_998);
      expect(discoveryState.cachedChannelAvailability("channel-a", "broadcast-a", "campaign-a")).toEqual({
        status: "hit",
        campaignIds: new Set(["campaign-a"]),
      });

      vi.advanceTimersByTime(1);
      expect(discoveryState.cachedChannelAvailability("channel-a", "broadcast-a", "campaign-a")).toEqual({ status: "expired" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires progress-confirmed availability after five minutes", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-15T15:00:00Z"));
      const discoveryState = new TwitchDiscoveryState();
      const identity = discoveryState.availabilityRequestIdentity();

      discoveryState.rememberProgressConfirmedAvailability("channel-a", "campaign-a", identity);
      vi.advanceTimersByTime(5 * 60_000 - 1);
      expect(discoveryState.hasProgressConfirmedAvailability("channel-a", "campaign-a")).toBe(true);

      vi.advanceTimersByTime(1);
      expect(discoveryState.hasProgressConfirmedAvailability("channel-a", "campaign-a")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds progress-confirmed availability to 128 pairs in FIFO order", () => {
    const discoveryState = new TwitchDiscoveryState();
    const identity = discoveryState.availabilityRequestIdentity();
    for (let index = 0; index < 128; index += 1) {
      discoveryState.rememberProgressConfirmedAvailability(`channel-${index}`, "campaign", identity);
    }
    expect(discoveryState.hasProgressConfirmedAvailability("channel-0", "campaign")).toBe(true);

    discoveryState.rememberProgressConfirmedAvailability("channel-128", "campaign", identity);

    expect(discoveryState.hasProgressConfirmedAvailability("channel-0", "campaign")).toBe(false);
    expect(discoveryState.hasProgressConfirmedAvailability("channel-128", "campaign")).toBe(true);
  });

  it("clears progress-confirmed availability when the authenticated user changes", () => {
    const discoveryState = new TwitchDiscoveryState();
    discoveryState.setAuthenticatedUser("user-a");
    discoveryState.rememberProgressConfirmedAvailability(
      "channel-a",
      "campaign-a",
      discoveryState.availabilityRequestIdentity(),
    );

    discoveryState.setAuthenticatedUser("user-b");

    expect(discoveryState.hasProgressConfirmedAvailability("channel-a", "campaign-a")).toBe(false);
  });

  it("rejects progress-confirmed availability captured before an A -> B -> A identity round trip", () => {
    const discoveryState = new TwitchDiscoveryState();
    discoveryState.setAuthenticatedUser("user-a");
    const staleIdentity = discoveryState.availabilityRequestIdentity();

    discoveryState.setAuthenticatedUser("user-b");
    discoveryState.setAuthenticatedUser("user-a");

    expect(discoveryState.rememberProgressConfirmedAvailability(
      "channel-a",
      "campaign-a",
      staleIdentity,
    )).toBe(false);
    expect(discoveryState.hasProgressConfirmedAvailability("channel-a", "campaign-a")).toBe(false);
  });

  it("invalidates a cached channel availability snapshot when the broadcast changes", () => {
    const discoveryState = new TwitchDiscoveryState();
    const identity = discoveryState.availabilityRequestIdentity();

    discoveryState.rememberChannelAvailability(
      "channel-id",
      "broadcast-a",
      new Set<string>(),
      identity,
    );

    expect(discoveryState.cachedChannelAvailability("channel-id", "broadcast-a", "campaign-a"))
      .toEqual({ status: "hit", campaignIds: new Set() });
    expect(discoveryState.cachedChannelAvailability("channel-id", "broadcast-b", "campaign-a"))
      .toEqual({ status: "broadcast_changed" });
    expect(discoveryState.cachedChannelAvailability("channel-id", "broadcast-a", "campaign-a"))
      .toEqual({ status: "miss" });
  });

  it("expires negative availability before positive availability", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-15T15:00:00Z"));
      const discoveryState = new TwitchDiscoveryState();
      const identity = discoveryState.availabilityRequestIdentity();

      discoveryState.rememberChannelAvailability("negative", "broadcast-n", new Set(), identity);
      discoveryState.rememberChannelAvailability("positive", "broadcast-p", new Set(["campaign"]), identity);
      vi.advanceTimersByTime(30_001);

      expect(discoveryState.cachedChannelAvailability("negative", "broadcast-n", "campaign"))
        .toEqual({ status: "expired" });
      expect(discoveryState.cachedChannelAvailability("positive", "broadcast-p", "campaign"))
        .toEqual({ status: "hit", campaignIds: new Set(["campaign"]) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports availability cache hits, misses, and expirations in the selection diagnostic", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-13T12:00:00.000Z"));
      const candidate = {
        platform: "twitch" as const,
        username: "directory-winner",
        url: "https://www.twitch.tv/directory-winner",
        channelId: "winner-id",
        broadcastId: "winner-broadcast",
        categoryId: "game",
        live: true,
        isAclMatch: false,
      };
      const fetcher = jsonFetcher(() => ({ data: { channel: { id: "winner-id", viewerDropCampaigns: [{ id: "campaign" }] } } }));
      const discoveryState = new TwitchDiscoveryState();
      const events: EngineEvent[] = [];
      const emit = (event: EngineEvent) => events.push(event);
      const campaign = { id: "campaign", name: "Campaign", categoryId: "game" } as DropCampaign;

      // First selection: a genuine miss, establishes the cache entry.
      await twitchAdapter(fetcher, undefined, undefined, { discoveryState }, emit)
        .selectCandidateChannel?.([candidate], campaign);
      expect(events).toContainEqual(expect.objectContaining({
        category: "diagnostic",
        message: expect.stringContaining("0 availability cache hits, 1 availability cache misses, 0 availability cache expirations"),
      }));
      events.length = 0;

      // Second selection, ~60s later (a fresh adapter, as a real tick would
      // be): the entry is still within TTL, so it must report as a hit.
      vi.advanceTimersByTime(60_001);
      await twitchAdapter(fetcher, undefined, undefined, { discoveryState }, emit)
        .selectCandidateChannel?.([candidate], campaign);
      expect(events).toContainEqual(expect.objectContaining({
        category: "diagnostic",
        message: expect.stringContaining("1 availability cache hits, 0 availability cache misses, 0 availability cache expirations"),
      }));
      events.length = 0;

      // Third selection, past the TTL: an expiration, not a fresh miss.
      vi.advanceTimersByTime(60_000);
      await twitchAdapter(fetcher, undefined, undefined, { discoveryState }, emit)
        .selectCandidateChannel?.([candidate], campaign);
      expect(events).toContainEqual(expect.objectContaining({
        category: "diagnostic",
        message: expect.stringContaining("0 availability cache hits, 0 availability cache misses, 1 availability cache expirations"),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a progress-confirmed override for single-channel availability", async () => {
    const discoveryState = new TwitchDiscoveryState();
    discoveryState.rememberProgressConfirmedAvailability(
      "channel-a",
      "campaign-a",
      discoveryState.availabilityRequestIdentity(),
    );
    let availabilityCalls = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-a", stream: { id: "broadcast-a", game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        availabilityCalls += 1;
        return { data: { channel: { id: "channel-a", viewerDropCampaigns: [] } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState }).checkChannel(
      { platform: "twitch", username: "channel-a", url: "https://www.twitch.tv/channel-a" },
      { campaign: { id: "campaign-a", categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({ campaignMatches: true });

    expect(availabilityCalls).toBe(0);
  });

  it("uses a progress-confirmed override in batch selection", async () => {
    const discoveryState = new TwitchDiscoveryState();
    discoveryState.rememberProgressConfirmedAvailability(
      "channel-a",
      "campaign-a",
      discoveryState.availabilityRequestIdentity(),
    );
    const availabilityChannels: string[] = [];
    const events: EngineEvent[] = [];
    const fetcher = jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      const requests = Array.isArray(body) ? body : [body];
      availabilityChannels.push(...requests.map((request) => String((request.variables as { channelID?: string }).channelID)));
      const response = (request: Record<string, unknown>) => ({
        data: {
          channel: {
            id: String((request.variables as { channelID?: string }).channelID),
            viewerDropCampaigns: [],
          },
        },
      });
      return Array.isArray(body) ? requests.map(response) : response(body);
    });
    const candidates = [
      {
        platform: "twitch" as const,
        username: "channel-a",
        url: "https://www.twitch.tv/channel-a",
        channelId: "channel-a",
        broadcastId: "broadcast-a",
        categoryId: "game",
        live: true,
        isAclMatch: false,
      },
      {
        platform: "twitch" as const,
        username: "channel-b",
        url: "https://www.twitch.tv/channel-b",
        channelId: "channel-b",
        broadcastId: "broadcast-b",
        categoryId: "game",
        live: true,
        isAclMatch: false,
      },
    ];

    const selection = await twitchAdapter(fetcher, undefined, undefined, { discoveryState }, (event) => {
      events.push(event);
    }).selectCandidateChannel?.(candidates, { id: "campaign-a", name: "Campaign", categoryId: "game" } as DropCampaign);

    expect(selection?.channel?.username).toBe("channel-a");
    expect(availabilityChannels).toEqual(["channel-b"]);
    expect(events).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      message: expect.stringContaining("1 progress-confirmed availability overrides"),
    }));
  });

  it("does not use a progress-confirmed override for an unrelated campaign or channel", async () => {
    const discoveryState = new TwitchDiscoveryState();
    discoveryState.rememberProgressConfirmedAvailability(
      "channel-a",
      "campaign-a",
      discoveryState.availabilityRequestIdentity(),
    );
    const availabilityChannels: string[] = [];
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        const channel = String((requestBody(init).variables as { channel?: string }).channel);
        return {
          data: {
            user: {
              id: channel,
              stream: { id: `broadcast-${channel}`, game: { id: "game" } },
            },
          },
        };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        const channelId = String((requestBody(init).variables as { channelID?: string }).channelID);
        availabilityChannels.push(channelId);
        return { data: { channel: { id: channelId, viewerDropCampaigns: [] } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState }).checkChannel(
      { platform: "twitch", username: "channel-a", url: "https://www.twitch.tv/channel-a" },
      { campaign: { id: "campaign-b", categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({ campaignMatches: false });
    await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState }).checkChannel(
      { platform: "twitch", username: "channel-b", url: "https://www.twitch.tv/channel-b" },
      { campaign: { id: "campaign-a", categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({ campaignMatches: false });

    expect(availabilityChannels).toEqual(["channel-a", "channel-b"]);
  });

  it("refetches batch availability after a trusted directory candidate starts a new broadcast", async () => {
    const discoveryState = new TwitchDiscoveryState();
    discoveryState.rememberChannelAvailability(
      "channel-a",
      "broadcast-a",
      new Set(),
      discoveryState.availabilityRequestIdentity(),
    );
    const candidates = [
      {
        platform: "twitch" as const,
        username: "directory-a",
        url: "https://www.twitch.tv/directory-a",
        channelId: "channel-a",
        broadcastId: "broadcast-a-next",
        categoryId: "game",
        live: true,
        isAclMatch: false,
      },
      {
        platform: "twitch" as const,
        username: "directory-b",
        url: "https://www.twitch.tv/directory-b",
        channelId: "channel-b",
        broadcastId: "broadcast-b",
        categoryId: "game",
        live: true,
        isAclMatch: false,
      },
    ];
    const batchRequests: string[][] = [];
    const events: EngineEvent[] = [];
    const fetcher = jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>;
      expect(Array.isArray(body)).toBe(true);
      batchRequests.push(body.map((entry) => String((entry.variables as { channelID?: string }).channelID)));
      return body.map((entry) => {
        const channelId = String((entry.variables as { channelID?: string }).channelID);
        return {
          data: {
            channel: {
              id: channelId,
              viewerDropCampaigns: channelId === "channel-b" ? [{ id: "campaign" }] : [],
            },
          },
        };
      });
    });

    const selection = await twitchAdapter(fetcher, undefined, undefined, { discoveryState }, (event) => {
      events.push(event);
    }).selectCandidateChannel?.(
      candidates,
      { id: "campaign", name: "Campaign", categoryId: "game" } as DropCampaign,
    );

    expect(selection?.channel?.username).toBe("directory-b");
    expect(batchRequests).toEqual([["channel-a", "channel-b"]]);
    expect(events).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      message: expect.stringContaining("1 availability broadcast invalidations"),
    }));
  });

  it("does not cache a failed or malformed Twitch campaign availability response", async () => {
    // A transport failure or a malformed payload must not poison the cache
    // with an authoritative negative — the next lookup has to hit the network
    // again rather than silently serving "not available" from a bad response.
    let availabilityCalls = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        availabilityCalls += 1;
        if (availabilityCalls === 1) throw new Error("availability unavailable");
        return { data: { channel: { id: "channel-id", viewerDropCampaigns: [{ id: "campaign" }] } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();
    const candidate = { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" } as const;
    const campaign = { id: "campaign", categoryId: "game" } as DropCampaign;

    const firstTick = twitchAdapter(fetcher, undefined, undefined, { discoveryState });
    await expect(firstTick.checkChannel(candidate, { campaign })).resolves.toMatchObject({ campaignMatches: undefined });

    const secondTick = twitchAdapter(fetcher, undefined, undefined, { discoveryState });
    await expect(secondTick.checkChannel(candidate, { campaign })).resolves.toMatchObject({ campaignMatches: true });

    expect(availabilityCalls).toBe(2);
  });

  it("caches Twitch campaign availability when the response channel id matches the requested channel", async () => {
    let availabilityCalls = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        availabilityCalls += 1;
        return { data: { channel: { id: "channel-id", viewerDropCampaigns: [{ id: "campaign" }] } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();
    const candidate = { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" } as const;
    const campaign = { id: "campaign", categoryId: "game" } as DropCampaign;

    await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).checkChannel(candidate, { campaign });
    await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).checkChannel(candidate, { campaign });

    expect(availabilityCalls).toBe(1);
  });

  it("treats a mismatched availability response channel id as ambiguous and never caches it", async () => {
    let availabilityCalls = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        availabilityCalls += 1;
        // Wrong channel in the envelope — e.g. a batched-response ordering slip.
        return { data: { channel: { id: "other-channel-id", viewerDropCampaigns: [{ id: "campaign" }] } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();
    const candidate = { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" } as const;
    const campaign = { id: "campaign", categoryId: "game" } as DropCampaign;

    await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState }).checkChannel(candidate, { campaign }))
      .resolves.toMatchObject({ campaignMatches: undefined });
    await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).checkChannel(candidate, { campaign });

    expect(availabilityCalls).toBe(2);
    expect(discoveryState.cachedChannelAvailability("channel-id", "broadcast-id", "campaign")).toEqual({ status: "miss" });
  });

  it("treats a missing availability response channel id as ambiguous and never caches it", async () => {
    let availabilityCalls = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        availabilityCalls += 1;
        return { data: { channel: { viewerDropCampaigns: [{ id: "campaign" }] } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();
    const candidate = { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" } as const;
    const campaign = { id: "campaign", categoryId: "game" } as DropCampaign;

    await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState }).checkChannel(candidate, { campaign }))
      .resolves.toMatchObject({ campaignMatches: undefined });
    await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).checkChannel(candidate, { campaign });

    expect(availabilityCalls).toBe(2);
  });

  it("treats a null viewerDropCampaigns collection as ambiguous and never caches it", async () => {
    let availabilityCalls = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        availabilityCalls += 1;
        return { data: { channel: { id: "channel-id", viewerDropCampaigns: null } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();
    const candidate = { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" } as const;
    const campaign = { id: "campaign", categoryId: "game" } as DropCampaign;

    await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState }).checkChannel(candidate, { campaign }))
      .resolves.toMatchObject({ campaignMatches: undefined });
    await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).checkChannel(candidate, { campaign });

    expect(availabilityCalls).toBe(2);
  });

  it("ignores a null entry inside viewerDropCampaigns instead of throwing", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        return { data: { channel: { id: "channel-id", viewerDropCampaigns: [null, { id: "campaign" }] } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const candidate = { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" } as const;
    const campaign = { id: "campaign", categoryId: "game" } as DropCampaign;

    await expect(twitchAdapter(fetcher).checkChannel(candidate, { campaign }))
      .resolves.toMatchObject({ campaignMatches: true });
  });

  it("applies the same channel-id validation to the batched availability response path as the single path", async () => {
    const candidates = [
      {
        platform: "twitch" as const,
        username: "directory-a",
        url: "https://www.twitch.tv/directory-a",
        channelId: "channel-a",
        broadcastId: "broadcast-a",
        categoryId: "game",
        live: true,
        isAclMatch: false,
      },
      {
        platform: "twitch" as const,
        username: "directory-b",
        url: "https://www.twitch.tv/directory-b",
        channelId: "channel-b",
        broadcastId: "broadcast-b",
        categoryId: "game",
        live: true,
        isAclMatch: false,
      },
    ];
    let singleFallbackCalls = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      if (Array.isArray(body)) {
        return body.map((entry) => {
          const channelId = String((entry.variables as { channelID?: string }).channelID);
          // channel-a's envelope echoes the wrong id; channel-b's is correct.
          return channelId === "channel-a"
            ? { data: { channel: { id: "wrong-id", viewerDropCampaigns: [{ id: "campaign" }] } } }
            : { data: { channel: { id: channelId, viewerDropCampaigns: [{ id: "campaign" }] } } };
        });
      }
      // channel-a's ambiguous batch entry falls back to a single request —
      // still echoing the wrong id, so the single path applies the same rule.
      singleFallbackCalls += 1;
      return { data: { channel: { id: "wrong-id", viewerDropCampaigns: [{ id: "campaign" }] } } };
    });
    const discoveryState = new TwitchDiscoveryState();
    const campaign = { id: "campaign", categoryId: "game" } as DropCampaign;

    const selection = await twitchAdapter(fetcher, undefined, undefined, { discoveryState })
      .selectCandidateChannel?.(candidates, campaign);

    // channel-a's mismatched id is ambiguous, not a rejection: ambiguous falls
    // through to live/category validation rather than being treated as false,
    // so the selection still lands on the first (unconfirmed) candidate.
    expect(selection?.channel?.username).toBe("directory-a");
    expect(singleFallbackCalls).toBe(1);
    expect(discoveryState.cachedChannelAvailability("channel-a", "broadcast-a", "campaign")).toEqual({ status: "miss" });
    expect(discoveryState.cachedChannelAvailability("channel-b", "broadcast-b", "campaign")).toEqual({
      status: "hit",
      campaignIds: new Set(["campaign"]),
    });
  });

  it("ignores a null entry inside a batched viewerDropCampaigns response instead of throwing", async () => {
    // Unlike the single path, the batch path's per-candidate parsing loop has
    // no surrounding try/catch — a throw here would crash the whole selection
    // instead of just falling back for this one candidate. Two candidates are
    // required to actually exercise the chunked batch request: a single
    // candidate takes a different, single-request short circuit.
    const candidates = [
      {
        platform: "twitch" as const,
        username: "directory-a",
        url: "https://www.twitch.tv/directory-a",
        channelId: "channel-a",
        broadcastId: "broadcast-a",
        categoryId: "game",
        live: true,
        isAclMatch: false,
      },
      {
        platform: "twitch" as const,
        username: "directory-b",
        url: "https://www.twitch.tv/directory-b",
        channelId: "channel-b",
        broadcastId: "broadcast-b",
        categoryId: "game",
        live: true,
        isAclMatch: false,
      },
    ];
    const fetcher = jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>;
      return body.map((entry) => {
        const channelId = String((entry.variables as { channelID?: string }).channelID);
        return { data: { channel: { id: channelId, viewerDropCampaigns: [null, { id: "campaign" }] } } };
      });
    });
    const campaign = { id: "campaign", categoryId: "game" } as DropCampaign;

    const selection = await twitchAdapter(fetcher).selectCandidateChannel?.(candidates, campaign);

    expect(selection?.channel?.username).toBe("directory-a");
  });

  it("treats a batched availability response carrying a GraphQL errors envelope as ambiguous, even with a matching id and campaigns", async () => {
    // The single path can never see this shape — the transport throws on a
    // top-level errors[] envelope before returning a response — so this
    // exercises a branch only the batch path's raw parsing can reach.
    const candidates = [
      {
        platform: "twitch" as const,
        username: "directory-a",
        url: "https://www.twitch.tv/directory-a",
        channelId: "channel-a",
        broadcastId: "broadcast-a",
        categoryId: "game",
        live: true,
        isAclMatch: false,
      },
      {
        platform: "twitch" as const,
        username: "directory-b",
        url: "https://www.twitch.tv/directory-b",
        channelId: "channel-b",
        broadcastId: "broadcast-b",
        categoryId: "game",
        live: true,
        isAclMatch: false,
      },
    ];
    let singleFallbackCalls = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      if (Array.isArray(body)) {
        return body.map((entry) => {
          const channelId = String((entry.variables as { channelID?: string }).channelID);
          if (channelId === "channel-a") {
            // A partial response: id and campaigns both look valid, but the
            // errors envelope means the payload cannot be trusted.
            return {
              errors: [{ message: "GraphQL execution error" }],
              data: { channel: { id: channelId, viewerDropCampaigns: [{ id: "campaign" }] } },
            };
          }
          return { data: { channel: { id: channelId, viewerDropCampaigns: [{ id: "campaign" }] } } };
        });
      }
      singleFallbackCalls += 1;
      return {
        errors: [{ message: "GraphQL execution error" }],
        data: { channel: { id: "channel-a", viewerDropCampaigns: [{ id: "campaign" }] } },
      };
    });
    const discoveryState = new TwitchDiscoveryState();
    const campaign = { id: "campaign", categoryId: "game" } as DropCampaign;

    await twitchAdapter(fetcher, undefined, undefined, { discoveryState })
      .selectCandidateChannel?.(candidates, campaign);

    // The errors envelope forced a single-fallback retry for channel-a — if it
    // had been ignored, this response would have cached directly and the
    // fallback would never have been called.
    expect(singleFallbackCalls).toBe(1);
    expect(discoveryState.cachedChannelAvailability("channel-a", "broadcast-a", "campaign")).toEqual({ status: "miss" });
    expect(discoveryState.cachedChannelAvailability("channel-b", "broadcast-b", "campaign")).toEqual({
      status: "hit",
      campaignIds: new Set(["campaign"]),
    });
  });

  it("discards an availability write from a request started under a prior identity, then accepts one started under the new identity", async () => {
    // #7/#8: an availability request begun under user-a must not repopulate the
    // shared cache once user-b has become current, but a fresh request begun
    // under user-b must still reach the network and cache normally.
    let deferredResolve: ((value: unknown) => void) | undefined;
    const stalePromise = new Promise<unknown>((resolve) => {
      deferredResolve = resolve;
    });
    let resolveRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      resolveRequestStarted = resolve;
    });
    let availabilityCalls = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        availabilityCalls += 1;
        if (availabilityCalls === 1) {
          resolveRequestStarted?.();
          return stalePromise;
        }
        return { data: { channel: { id: "channel-id", viewerDropCampaigns: [{ id: "campaign" }] } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();
    discoveryState.setAuthenticatedUser("user-a");
    const candidate = { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" } as const;
    const campaign = { id: "campaign", categoryId: "game" } as DropCampaign;

    // Request A starts under user-a but its network response is held open.
    const pendingA = twitchAdapter(fetcher, undefined, undefined, { discoveryState })
      .checkChannel(candidate, { campaign });

    // Wait until request A's availability lookup has actually been dispatched
    // (its identity captured) before switching — otherwise the switch could
    // race ahead of the capture and this test would prove nothing.
    await requestStarted;
    discoveryState.setAuthenticatedUser("user-b");
    deferredResolve?.({ data: { channel: { id: "channel-id", viewerDropCampaigns: [{ id: "campaign" }] } } });

    // Request A still answers its own caller correctly...
    await expect(pendingA).resolves.toMatchObject({ campaignMatches: true });
    // ...but must not have repopulated the shared cache under user-b.
    expect(discoveryState.cachedChannelAvailability("channel-id", "broadcast-id", "campaign")).toEqual({ status: "miss" });

    // A fresh request under user-b reaches the network and populates the cache.
    await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState })
      .checkChannel(candidate, { campaign })).resolves.toMatchObject({ campaignMatches: true });
    expect(availabilityCalls).toBe(2);

    // A third call under the same identity now hits the populated cache.
    await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).checkChannel(candidate, { campaign });
    expect(availabilityCalls).toBe(2);
  });

  it("rejects an availability write whose generation predates a later A -> B -> A identity round trip", () => {
    // The user id alone is not enough to detect staleness: switching back to
    // the same user must still invalidate a write captured before the round
    // trip, which is exactly what the generation counter is for.
    const discoveryState = new TwitchDiscoveryState();
    discoveryState.setAuthenticatedUser("user-a");
    const staleIdentity = discoveryState.availabilityRequestIdentity();

    discoveryState.setAuthenticatedUser("user-b");
    discoveryState.setAuthenticatedUser("user-a");

    expect(discoveryState.rememberChannelAvailability(
      "channel-id",
      "broadcast-id",
      new Set(["campaign"]),
      staleIdentity,
    )).toBe(false);
    expect(discoveryState.cachedChannelAvailability("channel-id", "broadcast-id", "campaign")).toEqual({ status: "miss" });

    expect(discoveryState.rememberChannelAvailability(
      "channel-id",
      "broadcast-id",
      new Set(["campaign"]),
      discoveryState.availabilityRequestIdentity(),
    )).toBe(true);
    expect(discoveryState.cachedChannelAvailability("channel-id", "broadcast-id", "campaign")).toEqual({
      status: "hit",
      campaignIds: new Set(["campaign"]),
    });
  });

  it("lists Twitch drop-enabled streams through the slug directory query", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      expect(operation(init)).toBe("DirectoryPage_Game");
      expect(requestBody(init).variables).toMatchObject({
        slug: "fortnite",
        options: {
          systemFilters: ["DROPS_ENABLED"],
          includeRestricted: ["SUB_ONLY_LIVE"],
          freeformTags: null,
          sort: "VIEWER_COUNT",
        },
      });
      return {
        data: {
          game: {
            streams: {
              edges: [{
                node: {
                  id: "broadcast-id",
                  title: "FNCS",
                  viewersCount: 34513,
                  broadcaster: {
                    login: "faxuty",
                    displayName: "faxuty",
                    profileImageURL: "https://image",
                  },
                },
              }],
            },
          },
        },
      };
    });
    const adapter = twitchAdapter(fetcher);

    const candidates = await adapter.listCandidateChannels({
      id: "campaign",
      platform: "twitch",
      name: "FNCS Summit | Finals",
      slug: "fortnite",
      gameName: "Fortnite",
      categoryId: "33214",
      status: "active",
      rewards: [],
      isGeneralDrop: true,
    });

    expect(candidates[0]).toMatchObject({
      username: "faxuty",
      displayName: "faxuty",
      viewerCount: 34513,
      title: "FNCS",
      campaignId: "campaign",
      categoryId: "33214",
      broadcastId: "broadcast-id",
    });
  });

  it("trusts drops-enabled directory liveness and confirms only the selected candidate", async () => {
    const operations: string[] = [];
    const fetcher = jsonFetcher((_url, init) => {
      operations.push(operation(init));
      return { data: { channel: { id: "winner-id", viewerDropCampaigns: [{ id: "campaign" }] } } };
    });
    const adapter = twitchAdapter(fetcher);
    const candidate = {
      platform: "twitch" as const,
      username: "directory-winner",
      url: "https://www.twitch.tv/directory-winner",
      channelId: "winner-id",
      broadcastId: "winner-broadcast",
      categoryId: "game",
      live: true,
      isAclMatch: false,
    };

    const selection = await adapter.selectCandidateChannel?.(
      [candidate],
      { id: "campaign", categoryId: "game" } as DropCampaign,
    );

    expect(selection?.channel?.username).toBe("directory-winner");
    expect(operations).toEqual(["DropsHighlightService_AvailableDrops"]);
  });

  it("revalidates a trusted directory candidate without a broadcast id before checking availability", async () => {
    const operations: string[] = [];
    const fetcher = jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      if (Array.isArray(body)) {
        operations.push(String(body[0]?.operationName));
        return [{
          data: {
            user: {
              id: "winner-id",
              stream: { id: "winner-broadcast", game: { id: "game" } },
            },
          },
        }];
      }
      operations.push(String(body.operationName));
      return { data: { channel: { id: "winner-id", viewerDropCampaigns: [{ id: "campaign" }] } } };
    });
    const candidate = {
      platform: "twitch" as const,
      username: "directory-winner",
      url: "https://www.twitch.tv/directory-winner",
      channelId: "winner-id",
      categoryId: "game",
      live: true,
      isAclMatch: false,
    };

    const selection = await twitchAdapter(fetcher).selectCandidateChannel?.(
      [candidate],
      { id: "campaign", categoryId: "game" } as DropCampaign,
    );

    expect(selection?.channel?.username).toBe("directory-winner");
    expect(operations).toEqual(["StreamInfo", "DropsHighlightService_AvailableDrops"]);
  });

  it("batches campaign availability checks for trusted directory candidates", async () => {
    const candidates = Array.from({ length: 24 }, (_, index) => ({
      platform: "twitch" as const,
      username: `directory-${index}`,
      url: `https://www.twitch.tv/directory-${index}`,
      channelId: `channel-${index}`,
      broadcastId: `broadcast-${index}`,
      categoryId: "game",
      live: true,
      isAclMatch: false,
    }));
    const availabilityBatchSizes: number[] = [];
    const events: EngineEvent[] = [];
    const fetcher = jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      expect(Array.isArray(body)).toBe(true);
      const operations = body as Array<Record<string, unknown>>;
      expect(operations.every((entry) =>
        entry.operationName === "DropsHighlightService_AvailableDrops")).toBe(true);
      availabilityBatchSizes.push(operations.length);
      return operations.map((entry) => {
        const channelId = String((entry.variables as { channelID?: string }).channelID);
        return {
          data: {
            channel: {
              id: channelId,
              viewerDropCampaigns: channelId === "channel-23" ? [{ id: "campaign-1" }] : [],
            },
          },
        };
      });
    });

    const selection = await twitchAdapter(fetcher, undefined, undefined, {}, (event) => {
      events.push(event);
    }).selectCandidateChannel?.(
      candidates,
      { id: "campaign-1", name: "Campaign One", categoryId: "game" } as DropCampaign,
    );

    expect(selection?.channel?.username).toBe("directory-23");
    expect(availabilityBatchSizes).toEqual([20, 4]);
    expect(events).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      message: expect.stringMatching(
        /^Twitch channel selection for "Campaign One" \(campaign campaign-1\) finished in \d+ms/,
      ),
    }));
    expect(events.some((event) =>
      event.category === "diagnostic" &&
      event.message.includes("2 AvailableDrops batch requests, 0 AvailableDrops single fallbacks"))).toBe(true);
  });

  it("labels idle channel selection diagnostics when no candidate wins", async () => {
    const events: EngineEvent[] = [];
    const fetcher = jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>;
      expect(body).toHaveLength(1);
      expect(body[0]?.operationName).toBe("StreamInfo");
      return [{ data: { user: { stream: null } } }];
    });

    const selection = await twitchAdapter(fetcher, undefined, undefined, {}, (event) => {
      events.push(event);
    }).selectCandidateChannel?.([{
      platform: "twitch",
      username: "offline",
      url: "https://www.twitch.tv/offline",
      isAclMatch: true,
    }]);

    expect(selection).toMatchObject({
      checked: 1,
      metrics: {
        cacheHits: 0,
        cacheMisses: 0,
        batchRequests: 1,
        singleFallbacks: 0,
      },
    });
    expect(selection?.observations).toEqual([
      expect.objectContaining({ live: false, categoryMatches: true }),
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      message: expect.stringMatching(/^Twitch idle channel selection finished in \d+ms/),
    }));
  });

  it("bounds single AvailableDrops fallbacks when Twitch rejects availability batches", async () => {
    const candidates = Array.from({ length: 24 }, (_, index) => ({
      platform: "twitch" as const,
      username: `directory-${index}`,
      url: `https://www.twitch.tv/directory-${index}`,
      channelId: `channel-${index}`,
      broadcastId: `broadcast-${index}`,
      categoryId: "game",
      live: true,
      isAclMatch: false,
    }));
    let activeSingles = 0;
    let maxActiveSingles = 0;
    let singleCalls = 0;
    const fetcher = jsonFetcher(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      if (Array.isArray(body)) throw new Error("batch unavailable");
      expect(body.operationName).toBe("DropsHighlightService_AvailableDrops");
      singleCalls += 1;
      activeSingles += 1;
      maxActiveSingles = Math.max(maxActiveSingles, activeSingles);
      await Promise.resolve();
      activeSingles -= 1;
      return { data: { channel: { viewerDropCampaigns: [] } } };
    });

    await twitchAdapter(fetcher).selectCandidateChannel?.(
      candidates,
      { id: "campaign", categoryId: "game" } as DropCampaign,
    );

    expect(singleCalls).toBe(24);
    expect(maxActiveSingles).toBeLessThanOrEqual(2);
  });

  it("batches ACL StreamInfo and AvailableDrops checks", async () => {
    const candidates = Array.from({ length: 25 }, (_, index) => ({
      platform: "twitch" as const,
      username: `acl-${index}`,
      url: `https://www.twitch.tv/acl-${index}`,
      isAclMatch: true,
    }));
    const streamBatchSizes: number[] = [];
    const availabilityBatchSizes: number[] = [];
    const fetcher = jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      if (Array.isArray(body)) {
        const operationName = String(body[0]?.operationName);
        if (operationName === "DropsHighlightService_AvailableDrops") {
          availabilityBatchSizes.push(body.length);
          return body.map((entry) => {
            const channelId = String((entry.variables as { channelID?: string }).channelID);
            return { data: { channel: { id: channelId, viewerDropCampaigns: [{ id: "campaign" }] } } };
          });
        }
        expect(operationName).toBe("StreamInfo");
        expect(init?.credentials).toBe("omit");
        streamBatchSizes.push(body.length);
        return body.map((entry) => {
          const username = String((entry.variables as { channel?: string }).channel);
          return {
            data: {
              user: {
                id: `${username}-id`,
                displayName: username,
                stream: { id: `${username}-broadcast`, game: { id: "game", name: "Game" } },
              },
            },
          };
        });
      }
      throw new Error(`Unexpected operation ${String(body.operationName)}`);
    });
    const adapter = twitchAdapter(fetcher);

    const selection = await adapter.selectCandidateChannel?.(
      candidates,
      { id: "campaign", categoryId: "game" } as DropCampaign,
    );

    expect(selection?.channel?.username).toBe("acl-0");
    expect(streamBatchSizes).toEqual([20, 5]);
    expect(availabilityBatchSizes).toEqual([20, 5]);
  });

  it("bounds single StreamInfo fallbacks when Twitch rejects channel batches", async () => {
    const candidates = Array.from({ length: 25 }, (_, index) => ({
      platform: "twitch" as const,
      username: `fallback-${index}`,
      url: `https://www.twitch.tv/fallback-${index}`,
      isAclMatch: true,
    }));
    let activeSingles = 0;
    let maxActiveSingles = 0;
    let singleCalls = 0;
    const diagnostics: string[] = [];
    const fetcher = jsonFetcher(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      if (Array.isArray(body)) throw new Error("batch unavailable");
      if (body.operationName === "StreamInfo") {
        singleCalls += 1;
        activeSingles += 1;
        maxActiveSingles = Math.max(maxActiveSingles, activeSingles);
        await Promise.resolve();
        activeSingles -= 1;
        const username = String((body.variables as { channel?: string }).channel);
        return {
          data: {
            user: {
              id: `${username}-id`,
              stream: { id: `${username}-broadcast`, game: { id: "other-game" } },
            },
          },
        };
      }
      throw new Error(`Unexpected operation ${String(body.operationName)}`);
    });
    const adapter = twitchAdapter(fetcher, undefined, undefined, {}, (event) => {
      if (event.category === "diagnostic") diagnostics.push(event.message);
    });

    await adapter.selectCandidateChannel?.(
      candidates,
      { id: "campaign", categoryId: "game" } as DropCampaign,
    );

    expect(singleCalls).toBe(25);
    expect(maxActiveSingles).toBeLessThanOrEqual(2);
    expect(diagnostics.some((message) =>
      message.includes("25 StreamInfo single fallbacks"))).toBe(true);
  });

  it("checks the next batched candidate after Twitch rejects campaign availability", async () => {
    const candidates = ["first", "second"].map((username) => ({
      platform: "twitch" as const,
      username,
      url: `https://www.twitch.tv/${username}`,
      isAclMatch: true,
    }));
    const availabilityChannels: string[] = [];
    const fetcher = jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      if (Array.isArray(body)) {
        return body.map((entry) => {
          const username = String((entry.variables as { channel?: string }).channel);
          return {
            data: {
              user: {
                id: `${username}-id`,
                stream: { id: `${username}-broadcast`, game: { id: "game" } },
              },
            },
          };
        });
      }
      if (body.operationName === "DropsHighlightService_AvailableDrops") {
        const channelId = String((body.variables as { channelID?: string }).channelID);
        availabilityChannels.push(channelId);
        return {
          data: {
            channel: {
              id: channelId,
              viewerDropCampaigns: channelId === "second-id" ? [{ id: "campaign" }] : [],
            },
          },
        };
      }
      throw new Error(`Unexpected operation ${String(body.operationName)}`);
    });

    const selection = await twitchAdapter(fetcher).selectCandidateChannel?.(
      candidates,
      { id: "campaign", categoryId: "game" } as DropCampaign,
    );

    expect(selection?.channel?.username).toBe("second");
    expect(availabilityChannels).toEqual(["first-id", "second-id"]);
  });

  it("falls back to Twitch channel page data when stream info GQL fails", async () => {
    const abort = new AbortController();
    const fetcher = jsonFetcher((url, init) => {
      if (url === "https://gql.twitch.tv/gql" && operation(init) === "StreamInfo") {
        return { errors: [{ message: "PersistedQueryNotFound" }] };
      }
      if (url === "https://www.twitch.tv/creator") {
        expect(init?.signal).toBe(abort.signal);
        return { html: '{"isLiveBroadcast":true,"game":{"id":"game","name":"Game"}}' };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = twitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
      { campaign: { categoryId: "game" } as DropCampaign, signal: abort.signal },
    )).resolves.toMatchObject({
      live: true,
      categoryMatches: true,
      reason: "Twitch GQL check failed; used channel page fallback",
      candidate: { categoryId: "game" },
    });
  });

  it("treats Twitch channel validation as invalid when GQL and page fallback both fail", async () => {
    const fetcher = jsonFetcher((url, init) => {
      if (url === "https://gql.twitch.tv/gql" && operation(init) === "StreamInfo") {
        return { errors: [{ message: "PersistedQueryNotFound" }] };
      }
      if (url === "https://www.twitch.tv/creator") {
        throw new Error("Twitch page unavailable");
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = twitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
      { campaign: { categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({
      live: false,
      categoryMatches: false,
      reason: "PersistedQueryNotFound",
    });
  });

  it("treats a Twitch channel as offline when the page fallback shows no live signal", async () => {
    const fetcher = jsonFetcher((url, init) => {
      if (url === "https://gql.twitch.tv/gql" && operation(init) === "StreamInfo") {
        return { errors: [{ message: "PersistedQueryNotFound" }] };
      }
      if (url === "https://www.twitch.tv/creator") {
        return { html: "<html><body>nothing recognizable</body></html>" };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = twitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
      { campaign: { categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({
      live: false,
      reason: "Twitch GQL check failed; used channel page fallback",
    });
  });

  it("merges current watched drop progress for the active Twitch session", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return {
          data: {
            currentUser: {
              inventory: {
                dropCampaignsInProgress: [{
                  id: "campaign",
                  timeBasedDrops: [{
                    id: "drop",
                    requiredMinutesWatched: 60,
                    self: { currentMinutesWatched: 10, isClaimed: false },
                  }],
                }],
              },
            },
          },
        };
      }
      if (op === "VideoPlayerStreamInfoOverlayChannel") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropCurrentSessionContext") {
        return { data: { currentUser: { dropCurrentSession: { dropID: "drop", currentMinutesWatched: 42 } } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = twitchAdapter(fetcher);

    const progress = await adapter.refreshCampaigns({
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      channel: { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
    });

    expect(progress[0].rewards[0]).toMatchObject({
      watchedMinutes: 42,
      status: "in_progress",
      isCurrentReward: true,
    });
  });

  it("records material current-session progress as availability evidence", async () => {
    const discoveryState = new TwitchDiscoveryState();
    const events: EngineEvent[] = [];
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return {
          data: {
            currentUser: {
              id: "user-id",
              inventory: {
                dropCampaignsInProgress: [{
                  id: "campaign",
                  timeBasedDrops: [{
                    id: "drop",
                    requiredMinutesWatched: 60,
                    self: { currentMinutesWatched: 10, isClaimed: false },
                  }],
                }],
              },
            },
          },
        };
      }
      if (op === "VideoPlayerStreamInfoOverlayChannel") {
        discoveryState.rememberChannelAvailability(
          "channel-id",
          "broadcast-id",
          new Set(),
          discoveryState.availabilityRequestIdentity(),
        );
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropCurrentSessionContext") {
        return { data: { currentUser: { dropCurrentSession: { dropID: "drop", currentMinutesWatched: 11 } } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    await twitchAdapter(fetcher, undefined, undefined, { discoveryState }, (event) => {
      events.push(event);
    }).refreshCampaigns({
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      channel: { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
    });

    expect(discoveryState.hasProgressConfirmedAvailability("channel-id", "campaign")).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      level: "debug",
      message: "Twitch current-session progress confirmed campaign campaign for creator despite a negative availability snapshot",
    }));
  });

  it("does not record unchanged current-session progress as availability evidence", async () => {
    const discoveryState = new TwitchDiscoveryState();
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return {
          data: {
            currentUser: {
              inventory: {
                dropCampaignsInProgress: [{
                  id: "campaign",
                  timeBasedDrops: [{
                    id: "drop",
                    requiredMinutesWatched: 60,
                    self: { currentMinutesWatched: 10, isClaimed: false },
                  }],
                }],
              },
            },
          },
        };
      }
      if (op === "VideoPlayerStreamInfoOverlayChannel") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropCurrentSessionContext") {
        return { data: { currentUser: { dropCurrentSession: { dropID: "drop", currentMinutesWatched: 10 } } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns({
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      channel: { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
    });

    expect(discoveryState.hasProgressConfirmedAvailability("channel-id", "campaign")).toBe(false);
  });

  it.each([
    ["zero", []],
    ["two", ["campaign-a", "campaign-b"]],
  ])("does not record an ambiguous current-session drop that occurs in %s campaigns", async (_occurrences, campaignIds) => {
    const discoveryState = new TwitchDiscoveryState();
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return {
          data: {
            currentUser: {
              inventory: {
                dropCampaignsInProgress: campaignIds.map((id) => ({
                  id,
                  timeBasedDrops: [{
                    id: "drop",
                    requiredMinutesWatched: 60,
                    self: { currentMinutesWatched: 10, isClaimed: false },
                  }],
                })),
              },
            },
          },
        };
      }
      if (op === "VideoPlayerStreamInfoOverlayChannel") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropCurrentSessionContext") {
        return { data: { currentUser: { dropCurrentSession: { dropID: "drop", currentMinutesWatched: 11 } } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    await twitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns({
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      channel: { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
    });

    expect(discoveryState.hasProgressConfirmedAvailability("channel-id", "campaign-a")).toBe(false);
    expect(discoveryState.hasProgressConfirmedAvailability("channel-id", "campaign-b")).toBe(false);
  });

  it("claims a Twitch reward with the real drop-instance id", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      if (operation(init) === "DropsPage_ClaimDropRewards") {
        expect(requestBody(init).variables).toMatchObject({ input: { dropInstanceID: "instance-id" } });
        return { data: { claimDropRewards: { status: "ELIGIBLE_FOR_ALL" } } };
      }
      throw new Error(`Unexpected op ${operation(init)}`);
    });
    const ensureIntegrity = vi.fn(async () => true);
    const adapter = twitchAdapter(fetcher, ensureIntegrity);
    const reward = { id: "drop", name: "Reward", requiredMinutes: 60, watchedMinutes: 60, status: "claimable", claimId: "instance-id" } as DropReward;

    await expect(adapter.claimReward({ id: "campaign" } as DropCampaign, reward)).resolves.toBe(true);
    // A valid integrity token is ensured before the claim is sent.
    expect(ensureIntegrity).toHaveBeenCalledTimes(1);
  });

  it("does not call Twitch or ensure integrity, and reports not claim-ready, when the drop-instance id is missing", async () => {
    const fetcher = jsonFetcher(() => {
      throw new Error("should not fetch without a claim id");
    });
    const ensureIntegrity = vi.fn(async () => true);
    const adapter = twitchAdapter(fetcher, ensureIntegrity);
    const reward = { id: "drop", name: "Reward", requiredMinutes: 60, watchedMinutes: 60, status: "claimable" } as DropReward;

    expect(adapter.isClaimReady(reward)).toBe(false);
    expect(adapter.isClaimReady({ ...reward, claimId: "instance-id" })).toBe(true);
    await expect(adapter.claimReward({ id: "campaign" } as DropCampaign, reward)).resolves.toBe(false);
    expect(ensureIntegrity).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected Twitch claim status as an error without retrying", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      if (operation(init) === "DropsPage_ClaimDropRewards") {
        return { data: { claimDropRewards: { status: "INELIGIBLE" } } };
      }
      throw new Error(`Unexpected op ${operation(init)}`);
    });
    const ensureIntegrity = vi.fn(async () => true);
    const adapter = twitchAdapter(fetcher, ensureIntegrity);
    const reward = { id: "drop", name: "Reward", requiredMinutes: 60, watchedMinutes: 60, status: "claimable", claimId: "instance-id" } as DropReward;

    await expect(adapter.claimReward({ id: "campaign" } as DropCampaign, reward)).rejects.toThrow(/status=INELIGIBLE/);
    // A non-integrity failure must not trigger a refresh + retry.
    expect(ensureIntegrity).toHaveBeenCalledTimes(1);
  });

  it("refreshes the integrity token and retries once when the first claim fails an integrity check", async () => {
    let claimAttempts = 0;
    const fetcher = jsonFetcher((_url, init) => {
      if (operation(init) === "DropsPage_ClaimDropRewards") {
        claimAttempts += 1;
        if (claimAttempts === 1) return { error: "failed integrity check" };
        return { data: { claimDropRewards: { status: "ELIGIBLE_FOR_ALL" } } };
      }
      throw new Error(`Unexpected op ${operation(init)}`);
    });
    const ensureIntegrity = vi.fn(async () => true);
    const adapter = twitchAdapter(fetcher, ensureIntegrity);
    const reward = { id: "drop", name: "Reward", requiredMinutes: 60, watchedMinutes: 60, status: "claimable", claimId: "instance-id" } as DropReward;

    await expect(adapter.claimReward({ id: "campaign" } as DropCampaign, reward)).resolves.toBe(true);
    expect(claimAttempts).toBe(2);
    // Once before the first attempt, once to force a fresh token before the retry.
    expect(ensureIntegrity).toHaveBeenCalledTimes(2);
  });

  it("reports a clear error when an integrity token cannot be refreshed", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      if (operation(init) === "DropsPage_ClaimDropRewards") {
        return { error: "failed integrity check" };
      }
      throw new Error(`Unexpected op ${operation(init)}`);
    });
    // No token can be captured (e.g. logged out / no tab can be opened).
    const ensureIntegrity = vi.fn(async () => false);
    const adapter = twitchAdapter(fetcher, ensureIntegrity);
    const reward = { id: "drop", name: "Reward", requiredMinutes: 60, watchedMinutes: 60, status: "claimable", claimId: "instance-id" } as DropReward;

    await expect(adapter.claimReward({ id: "campaign" } as DropCampaign, reward))
      .rejects.toThrow(/Keep a logged-in twitch\.tv tab open/);
  });

  it("reconstructs the drop-instance id for a watched-complete drop with no self edge", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return {
          data: {
            currentUser: {
              id: "user-id",
              inventory: {
                dropCampaignsInProgress: [{
                  id: "campaign",
                  timeBasedDrops: [{
                    id: "drop",
                    requiredMinutesWatched: 60,
                    self: { currentMinutesWatched: 30, isClaimed: false },
                  }],
                }],
              },
            },
          },
        };
      }
      if (op === "ViewerDropsDashboard") return twitchDashboard([]);
      if (op === "VideoPlayerStreamInfoOverlayChannel") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game" } } } } };
      }
      if (op === "DropCurrentSessionContext") {
        return { data: { currentUser: { dropCurrentSession: { dropID: "drop", currentMinutesWatched: 60 } } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = twitchAdapter(fetcher);

    const progress = await adapter.refreshCampaigns({
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      channel: { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
    });

    // Reconstructed deterministically as userID#campaignID#dropID so the drop is
    // still claimable even though Twitch hasn't returned the self edge yet.
    expect(progress[0].rewards[0]).toMatchObject({ status: "claimable", isCurrentReward: true, claimId: "user-id#campaign#drop" });
    expect(adapter.isClaimReady(progress[0].rewards[0])).toBe(true);
  });

  it("searches categories via inline GQL and maps id/name/box art", async () => {
    const fetcher = jsonFetcher((url, init) => {
      expect(url).toBe("https://gql.twitch.tv/gql");
      const body = requestBody(init);
      expect(body.operationName).toBe("SearchCategories");
      expect(body.variables).toMatchObject({ query: "fort" });
      // Sent inline (no persisted hash) so it keeps working without registration.
      expect(typeof body.query).toBe("string");
      return {
        data: {
          searchCategories: {
            edges: [
              { node: { id: "33214", displayName: "Fortnite", boxArtURL: "https://art/fortnite-{width}x{height}.jpg" } },
              { node: { id: "", displayName: "skip-me" } },
            ],
          },
        },
      };
    });

    await expect(twitchAdapter(fetcher).searchCategories("fort")).resolves.toEqual([
      { id: "33214", name: "Fortnite", imageUrl: "https://art/fortnite-144x192.jpg" },
    ]);
  });
});

describe("TwitchAdapter client identity", () => {
  const emptyCategories = { data: { searchCategories: { edges: [] } } };

  it("sends an injected non-web Client-ID + matching User-Agent on GQL requests", async () => {
    let captured: RequestInit | undefined;
    const adapter = twitchAdapter(
      jsonFetcher((_url, init) => { captured = init; return emptyCategories; }),
      undefined,
      undefined,
      { clientId: "kd1unb4b3q4t58fwlpcbzcbnm76a8fp", userAgent: "Dalvik/android-app" },
    );
    await adapter.searchCategories("rust");
    const headers = captured?.headers as Record<string, string>;
    expect(headers["Client-ID"]).toBe("kd1unb4b3q4t58fwlpcbzcbnm76a8fp");
    expect(headers["User-Agent"]).toBe("Dalvik/android-app");
  });

  it("defaults to the web Client-ID and omits the User-Agent (extension behavior)", async () => {
    let captured: RequestInit | undefined;
    await twitchAdapter(jsonFetcher((_url, init) => { captured = init; return emptyCategories; })).searchCategories("rust");
    const headers = captured?.headers as Record<string, string>;
    expect(headers["Client-ID"]).toBe("kimne78kx3ncx6brgo4mv6wki5h1ko");
    expect(headers["User-Agent"]).toBeUndefined();
  });
});

// Twitch can reject an authenticated request with "failed integrity check" even
// while the session is healthy and the captured token has not locally expired.
// Recovery is a single forced refresh plus a single identical retry — never a
// loop, never for anonymous requests, and never for other failure kinds.
describe("TwitchAdapter integrity recovery", () => {
  const INTEGRITY_REJECTION = { error: "failed integrity check" };

  // Models the real callback contract: only a forced request can produce a token
  // different from the one Twitch just rejected.
  function integrityCallback() {
    return vi.fn(async (request?: { forceRefresh?: boolean }) => request?.forceRefresh === true);
  }

  // Rejects the named operation on its first call only, then serves `payload`.
  function rejectFirst(target: string, payload: (init?: RequestInit) => unknown) {
    const attempts = new Map<string, number>();
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      attempts.set(op, (attempts.get(op) ?? 0) + 1);
      if (op === target && attempts.get(op) === 1) return INTEGRITY_REJECTION;
      return payload(init);
    });
    return { fetcher, attempts };
  }

  // The refresh bound is only sound if the token it compares against is the one
  // the failed request actually sent. The transport therefore attaches integrity
  // itself and stamps the failure with what it used: re-reading a global in the
  // catch would race a concurrent capture, report a token the request never
  // carried, and — because that token differs from the current one — convince the
  // forced refresh the rejection had already been handled.
  it("reports the integrity token the rejected request actually carried", async () => {
    // A fresh token on every read, so a value snapshotted anywhere other than at
    // send time cannot coincidentally match what went out.
    let minted = 0;
    const currentIntegrity = () => {
      minted += 1;
      return { integrity: `token-${minted}`, deviceId: "device", clientSessionId: "session", expiresAt: Date.now() + 60_000 };
    };
    const sent: Array<string | null> = [];
    const ensureIntegrity = integrityCallback();
    let attempts = 0;
    const fetcher = jsonFetcher((_url, init) => {
      sent.push(new Headers(init?.headers as HeadersInit).get("client-integrity"));
      attempts += 1;
      return attempts === 1 ? INTEGRITY_REJECTION : { data: { currentUser: { id: "u" } } };
    });

    await twitchAdapter(fetcher, ensureIntegrity, undefined, { currentIntegrity }).checkAuthHealth();

    expect(sent[0]).toBe("token-1");
    expect(ensureIntegrity).toHaveBeenCalledWith(expect.objectContaining({
      forceRefresh: true,
      reason: "rejection_recovery",
      rejectedToken: sent[0],
    }));
  });

  it("pins the managed replacement for the immediate retry when the global capture is replayed", async () => {
    const rejected = {
      integrity: "rejected-token",
      deviceId: "rejected-device",
      clientSessionId: "rejected-session",
      expiresAt: Date.now() + 60_000,
    };
    const replacement = {
      integrity: "replacement-token",
      deviceId: "replacement-device",
      clientSessionId: "replacement-session",
      expiresAt: Date.now() + 60_000,
    };
    const sent: string[] = [];
    const ensureIntegrity = vi.fn(async (request?: TwitchIntegrityRequest) => {
      if (request?.forceRefresh) {
        // A concurrent user tab replays the rejected bundle into the ordinary
        // global slot after the helper capture; only the callback's exact
        // bundle is safe for this immediate retry.
        request.onIntegrityCaptured?.(replacement);
      }
      return true;
    });
    let attempts = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const headers = new Headers(init?.headers as HeadersInit);
      sent.push(headers.get("client-integrity") ?? "");
      attempts += 1;
      return attempts === 1
        ? INTEGRITY_REJECTION
        : { data: { currentUser: { id: "u" } } };
    });

    await expect(twitchAdapter(fetcher, ensureIntegrity, undefined, {
      currentIntegrity: () => rejected,
    }).checkAuthHealth()).resolves.toMatchObject({ status: "healthy" });

    expect(sent).toEqual([rejected.integrity, replacement.integrity]);
  });

  it("sends the integrity trio together so the replayed token stays bound to its identity", async () => {
    const currentIntegrity = () => ({
      integrity: "bound-token",
      deviceId: "bound-device",
      clientSessionId: "bound-session",
      expiresAt: Date.now() + 60_000,
    });
    let seen: Headers | undefined;
    const fetcher = jsonFetcher((_url, init) => {
      seen = new Headers(init?.headers as HeadersInit);
      return { data: { currentUser: { id: "u" } } };
    });

    await twitchAdapter(fetcher, undefined, undefined, { currentIntegrity }).checkAuthHealth();

    expect(seen?.get("client-integrity")).toBe("bound-token");
    expect(seen?.get("x-device-id")).toBe("bound-device");
    expect(seen?.get("client-session-id")).toBe("bound-session");
  });

  describe("safe authenticated reads", () => {
    const dropID = (init?: RequestInit) =>
      String((requestBody(init).variables as Record<string, unknown>).dropID);

    const discoveryPayload = (init?: RequestInit) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([]);
      if (op === "ViewerDropsDashboard") return twitchDashboard(["campaign"]);
      if (op === "DropCampaignDetails") return twitchCampaignDetails(dropID(init));
      throw new Error(`Unexpected op ${op}`);
    };

    it.each(["ViewerDropsDashboard", "Inventory", "DropCampaignDetails"])(
      "refreshes integrity once and retries %s once during discovery",
      async (target) => {
        const ensureIntegrity = integrityCallback();
        const { fetcher, attempts } = rejectFirst(target, discoveryPayload);

        const campaigns = await twitchAdapter(fetcher, ensureIntegrity).refreshCampaigns();

        expect(campaigns.map((campaign) => campaign.id)).toEqual(["campaign"]);
        expect(ensureIntegrity).toHaveBeenCalledOnce();
        expect(ensureIntegrity).toHaveBeenCalledWith(expect.objectContaining({
          forceRefresh: true,
          reason: "rejection_recovery",
        }));
        expect(attempts.get(target)).toBe(2);
      },
    );

    it("recovers the dashboard without warning about retained campaigns", async () => {
      const events: EngineEvent[] = [];
      const ensureIntegrity = integrityCallback();
      const { fetcher } = rejectFirst("ViewerDropsDashboard", discoveryPayload);

      const campaigns = await twitchAdapter(
        fetcher,
        ensureIntegrity,
        undefined,
        {},
        (event) => events.push(event),
      ).refreshCampaigns();

      expect(campaigns.map((campaign) => campaign.id)).toEqual(["campaign"]);
      expect(events).not.toContainEqual(expect.objectContaining({
        message: expect.stringContaining("reusing the last campaign list"),
      }));
    });

    it("falls back to retained campaigns when the forced refresh fails", async () => {
      const events: EngineEvent[] = [];
      const ensureIntegrity = vi.fn(async () => false);
      let dashboardAttempts = 0;
      const fetcher = jsonFetcher((_url, init) => {
        const op = operation(init);
        if (op === "Inventory") return twitchInventory([]);
        if (op === "ViewerDropsDashboard") {
          dashboardAttempts += 1;
          return INTEGRITY_REJECTION;
        }
        if (op === "DropCampaignDetails") return twitchCampaignDetails(dropID(init));
        throw new Error(`Unexpected op ${op}`);
      });

      await twitchAdapter(fetcher, ensureIntegrity, undefined, {}, (event) => events.push(event))
        .refreshCampaigns();

      // Discovery makes two dashboard requests when both lists come back empty
      // (the second asks for reward campaigns). Each gets one refresh attempt
      // and, because the refresh failed, no retry at all.
      expect(ensureIntegrity).toHaveBeenCalledTimes(2);
      expect(ensureIntegrity.mock.calls).toEqual([
        [expect.objectContaining({ forceRefresh: true, reason: "rejection_recovery" })],
        [expect.objectContaining({ forceRefresh: true, reason: "rejection_recovery" })],
      ]);
      expect(dashboardAttempts).toBe(2);
      expect(events).toContainEqual(expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("reusing the last campaign list"),
      }));
    });

    it("stops after one retry when the refreshed token is rejected again", async () => {
      const ensureIntegrity = integrityCallback();
      let dashboardAttempts = 0;
      const fetcher = jsonFetcher((_url, init) => {
        const op = operation(init);
        if (op === "Inventory") return twitchInventory([]);
        if (op === "ViewerDropsDashboard") {
          dashboardAttempts += 1;
          return INTEGRITY_REJECTION;
        }
        throw new Error(`Unexpected op ${op}`);
      });

      await twitchAdapter(fetcher, ensureIntegrity).refreshCampaigns();

      // Two dashboard requests, each bounded to exactly one refresh and one
      // retry — the second rejection is never refreshed or replayed again.
      expect(ensureIntegrity).toHaveBeenCalledTimes(2);
      expect(dashboardAttempts).toBe(4);
    });

    it("does not enter integrity recovery for a generic dashboard failure", async () => {
      const ensureIntegrity = integrityCallback();
      let dashboardAttempts = 0;
      const fetcher = jsonFetcher((_url, init) => {
        const op = operation(init);
        if (op === "Inventory") return twitchInventory([]);
        if (op === "ViewerDropsDashboard") {
          dashboardAttempts += 1;
          throw new Error("dashboard unavailable");
        }
        throw new Error(`Unexpected op ${op}`);
      });

      await twitchAdapter(fetcher, ensureIntegrity).refreshCampaigns();

      // Both dashboard requests fail generically: no refresh, and no replay of
      // either request.
      expect(ensureIntegrity).not.toHaveBeenCalled();
      expect(dashboardAttempts).toBe(2);
    });

    it("refreshes integrity once and retries DirectoryPage_Game once", async () => {
      const ensureIntegrity = integrityCallback();
      const { fetcher, attempts } = rejectFirst("DirectoryPage_Game", () => ({
        data: {
          game: {
            streams: {
              edges: [{ node: { broadcaster: { login: "Creator", displayName: "Creator" }, viewersCount: 5 } }],
            },
          },
        },
      }));

      const candidates = await twitchAdapter(fetcher, ensureIntegrity)
        .listCandidateChannels({ id: "campaign", slug: "game-slug" } as DropCampaign);

      expect(candidates.map((candidate) => candidate.username)).toEqual(["creator"]);
      expect(ensureIntegrity).toHaveBeenCalledWith(expect.objectContaining({
        forceRefresh: true,
        reason: "rejection_recovery",
      }));
      expect(attempts.get("DirectoryPage_Game")).toBe(2);
    });

    it("refreshes integrity once and retries DropsHighlightService_AvailableDrops once", async () => {
      const ensureIntegrity = integrityCallback();
      const { fetcher, attempts } = rejectFirst("DropsHighlightService_AvailableDrops", (init) => {
        const op = operation(init);
        if (op === "StreamInfo") {
          return { data: { user: { id: "channel-id", displayName: "Creator", stream: { id: "b", game: { id: "game" } } } } };
        }
        if (op === "DropsHighlightService_AvailableDrops") {
          return { data: { channel: { id: "channel-id", viewerDropCampaigns: [{ id: "campaign" }] } } };
        }
        throw new Error(`Unexpected op ${op}`);
      });

      const check = await twitchAdapter(fetcher, ensureIntegrity).checkChannel(
        { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
        { campaign: { id: "campaign", categoryId: "game" } as DropCampaign },
      );

      expect(check.campaignMatches).toBe(true);
      expect(ensureIntegrity).toHaveBeenCalledWith(expect.objectContaining({
        forceRefresh: true,
        reason: "rejection_recovery",
      }));
      expect(attempts.get("DropsHighlightService_AvailableDrops")).toBe(2);
    });

    it.each(["VideoPlayerStreamInfoOverlayChannel", "DropCurrentSessionContext"])(
      "refreshes integrity once and retries %s once while merging session progress",
      async (target) => {
        const ensureIntegrity = integrityCallback();
        const { fetcher, attempts } = rejectFirst(target, (init) => {
          const op = operation(init);
          if (op === "Inventory") return twitchInventory(["campaign"]);
          if (op === "ViewerDropsDashboard") return twitchDashboard([]);
          if (op === "VideoPlayerStreamInfoOverlayChannel") return { data: { user: { id: "channel-id" } } };
          if (op === "DropCurrentSessionContext") {
            return { data: { currentUser: { dropCurrentSession: { dropID: "campaign-drop", currentMinutesWatched: 42 } } } };
          }
          throw new Error(`Unexpected op ${op}`);
        });
        const progressed = await twitchAdapter(fetcher, ensureIntegrity).refreshCampaigns({
          platform: "twitch",
          status: "watching",
          offlineChecks: 0,
          channel: { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
        } as never);

        expect(progressed[0]?.rewards[0]?.watchedMinutes).toBe(42);
        expect(ensureIntegrity).toHaveBeenCalledWith(expect.objectContaining({
          forceRefresh: true,
          reason: "rejection_recovery",
        }));
        expect(attempts.get(target)).toBe(2);
      },
    );

    it("refreshes integrity once and retries the authenticated CurrentUser probe once", async () => {
      const ensureIntegrity = integrityCallback();
      const { fetcher, attempts } = rejectFirst("CurrentUser", () => ({
        data: { currentUser: { id: "user-id" } },
      }));

      const health = await twitchAdapter(fetcher, ensureIntegrity).checkAuthHealth();

      expect(health.status).toBe("healthy");
      expect(ensureIntegrity).toHaveBeenCalledWith(expect.objectContaining({
        forceRefresh: true,
        reason: "rejection_recovery",
      }));
      expect(attempts.get("CurrentUser")).toBe(2);
    });
  });

  describe("anonymous reads", () => {
    it.each([
      ["StreamInfo", (adapter: TwitchAdapter) => adapter.checkChannel({ platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" })],
      ["SearchCategories", (adapter: TwitchAdapter) => adapter.searchCategories("rust")],
    ])("keeps %s anonymous and never acquires integrity", async (target, run) => {
      const ensureIntegrity = integrityCallback();
      let captured: RequestInit | undefined;
      let attempts = 0;
      const fetcher = jsonFetcher((_url, init) => {
        if (operation(init) !== target) throw new Error(`Unexpected op ${operation(init)}`);
        captured = init;
        attempts += 1;
        return INTEGRITY_REJECTION;
      });

      await run(twitchAdapter(fetcher, ensureIntegrity)).catch(() => undefined);

      expect(captured?.credentials).toBe("omit");
      expect(ensureIntegrity).not.toHaveBeenCalled();
      // Anonymous requests must not be replayed by integrity recovery.
      expect(attempts).toBe(1);
    });
  });

  describe("mutations", () => {
    const reward = {
      id: "drop",
      name: "Reward",
      requiredMinutes: 60,
      watchedMinutes: 60,
      status: "claimable",
      claimId: "instance-id",
    } as DropReward;

    it("forces a genuinely fresh token before retrying a rejected drop claim", async () => {
      const ensureIntegrity = integrityCallback();
      const { fetcher, attempts } = rejectFirst("DropsPage_ClaimDropRewards", () => ({
        data: { claimDropRewards: { status: "ELIGIBLE_FOR_ALL" } },
      }));

      await expect(twitchAdapter(fetcher, ensureIntegrity)
        .claimReward({ id: "campaign" } as DropCampaign, reward)).resolves.toBe(true);

      expect(attempts.get("DropsPage_ClaimDropRewards")).toBe(2);
      // Proactive fast path first, then an explicit forced refresh.
      expect(ensureIntegrity.mock.calls).toEqual([
        [{ signal: undefined }],
        [{
          forceRefresh: true,
          reason: "rejection_recovery",
          rejectedToken: undefined,
          onIntegrityCaptured: expect.any(Function),
          signal: undefined,
        }],
      ]);
    });

    it("recovers the channel-points context through the safe-read path", async () => {
      const ensureIntegrity = integrityCallback();
      const { fetcher, attempts } = rejectFirst("ChannelPointsContext", (init) => {
        const op = operation(init);
        if (op === "ChannelPointsContext") {
          return { data: { community: { channel: { id: "channel-id", self: { communityPoints: { availableClaim: { id: "claim-id" } } } } } } };
        }
        if (op === "ClaimCommunityPoints") return { data: { claimCommunityPoints: { status: "SUCCESS" } } };
        throw new Error(`Unexpected op ${op}`);
      });

      await expect(twitchAdapter(fetcher, ensureIntegrity).claimChannelPoints({
        platform: "twitch",
        username: "creator",
        url: "https://www.twitch.tv/creator",
      })).resolves.toBe(true);

      expect(attempts.get("ChannelPointsContext")).toBe(2);
      expect(ensureIntegrity).toHaveBeenCalledWith(expect.objectContaining({
        forceRefresh: true,
        reason: "rejection_recovery",
      }));
    });

    it("ensures integrity before the channel-points mutation and retries it exactly once", async () => {
      const ensureIntegrity = integrityCallback();
      const { fetcher, attempts } = rejectFirst("ClaimCommunityPoints", (init) => {
        const op = operation(init);
        if (op === "ChannelPointsContext") {
          return { data: { community: { channel: { id: "channel-id", self: { communityPoints: { availableClaim: { id: "claim-id" } } } } } } };
        }
        if (op === "ClaimCommunityPoints") return { data: { claimCommunityPoints: { status: "SUCCESS" } } };
        throw new Error(`Unexpected op ${op}`);
      });

      await expect(twitchAdapter(fetcher, ensureIntegrity).claimChannelPoints({
        platform: "twitch",
        username: "creator",
        url: "https://www.twitch.tv/creator",
      })).resolves.toBe(true);

      expect(attempts.get("ClaimCommunityPoints")).toBe(2);
      expect(ensureIntegrity.mock.calls).toEqual([
        [{ signal: undefined }],
        [{
          forceRefresh: true,
          reason: "rejection_recovery",
          rejectedToken: undefined,
          onIntegrityCaptured: expect.any(Function),
          signal: undefined,
        }],
      ]);
    });

    it("propagates a second channel-points rejection without a third attempt", async () => {
      const ensureIntegrity = integrityCallback();
      let claimAttempts = 0;
      const fetcher = jsonFetcher((_url, init) => {
        const op = operation(init);
        if (op === "ChannelPointsContext") {
          return { data: { community: { channel: { id: "channel-id", self: { communityPoints: { availableClaim: { id: "claim-id" } } } } } } };
        }
        if (op === "ClaimCommunityPoints") {
          claimAttempts += 1;
          return INTEGRITY_REJECTION;
        }
        throw new Error(`Unexpected op ${op}`);
      });

      await expect(twitchAdapter(fetcher, ensureIntegrity).claimChannelPoints({
        platform: "twitch",
        username: "creator",
        url: "https://www.twitch.tv/creator",
      })).rejects.toThrow(/integrity/i);

      expect(claimAttempts).toBe(2);
    });
  });
});
