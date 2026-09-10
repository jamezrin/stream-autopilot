import { afterEach, describe, expect, it, vi } from "vitest";
import { collectDiscoverySnapshot, DiscoverySnapshotLane } from "@lurkloot/core/discoverySnapshot";
import type { PageFetcher } from "@lurkloot/core/adapter";
import { SafeFetchError } from "@lurkloot/core/fetchError";
import { createKickFetcher, KickDiscoveryState } from "@lurkloot/core/kick";
import { kickAdapter } from "./helpers/adapters";
import { selectWatchTargetFromSnapshot } from "@lurkloot/core/scheduler";
import type { ChannelCandidate, DropCampaign, DropReward, ExtensionSettings, WatchSession } from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";

const NOW = Date.parse("2026-09-09T10:00:00Z");
const reward: DropReward = { id: "reward", name: "Reward", requiredMinutes: 60, watchedMinutes: 0, status: "locked", requirement: "watch", isWatchBased: true };
function campaign(overrides: Partial<DropCampaign> = {}): DropCampaign {
  return { id: "campaign", platform: "kick", name: "Campaign", status: "active", categoryId: "13", rewards: [{ ...reward }], ...overrides };
}
function candidate(username = "streamer", overrides: Partial<ChannelCandidate> = {}): ChannelCandidate {
  return { platform: "kick", username, url: `https://kick.com/${username}`, ...overrides };
}
afterEach(() => vi.useRealTimers());

function fetcher(handler: (url: string, init?: RequestInit) => unknown): PageFetcher {
  return { fetchJson: vi.fn(async (url, init) => handler(url, init)) as PageFetcher["fetchJson"] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
const liveResponse = { id: 1, livestream: { id: 2, is_live: true, categories: [{ id: 13, name: "Rust" }], viewer_count: 100 } };

describe("Kick discovery batch", () => {
  it.each([
    ["initial", false], ["initial", true],
    ["stale", false], ["stale", true],
    ["refreshing", false], ["refreshing", true],
  ] as const)("drains %s followed-channel fallback before cycle completion (inventory failure=%s)", async (cacheState, inventoryFails) => {
    vi.useFakeTimers();
    const discoveryState = new KickDiscoveryState();
    if (cacheState !== "initial") {
      await discoveryState.followedChannels.refreshOnce(async () => ["old-friend"]);
      vi.advanceTimersByTime(6 * 60_000);
    }
    let settled = false;
    let lateLifecycleUpdates = 0;
    let fallbacks = 0;
    const transport = createKickFetcher({
      background: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error("page context needed");
      },
      pageFetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [{ channel: { slug: "fresh-friend" } }];
      },
      onPageFallback: () => { fallbacks += 1; if (settled) lateLifecycleUpdates += 1; },
    });
    const adapter = kickAdapter(transport, undefined, undefined, undefined, { discoveryState });
    vi.spyOn(adapter, "refreshCampaigns").mockImplementation(async () => {
      if (inventoryFails) throw new Error("inventory unavailable");
      return [];
    });
    if (cacheState === "refreshing") await adapter.listFollowedChannels();
    const run = collectDiscoverySnapshot(adapter, undefined, new AbortController().signal)
      .then((result) => { settled = true; return result; }, () => { settled = true; return undefined; });
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    expect(fallbacks).toBe(1);
    expect(settled).toBe(false);
    await vi.runAllTimersAsync();
    const result = await run;
    expect(settled).toBe(true);
    expect(lateLifecycleUpdates).toBe(0);
    expect(discoveryState.followedChannels.get()).toEqual(["fresh-friend"]);
    expect(result?.complete).toBe(inventoryFails ? undefined : true);
  });

  it.each([{}, { data: {} }, { data: [{}] }])("retains the previous snapshot after malformed general directory evidence: %j", async (directory) => {
    let malformed = false;
    const adapter = kickAdapter(fetcher((url) => url.includes("/api/v1/livestreams")
      ? malformed ? directory : { data: [{ channel: { slug: "streamer" }, category: { id: 13 } }] }
      : liveResponse));
    vi.spyOn(adapter, "refreshCampaigns").mockResolvedValue([campaign()]);
    const lane = new DiscoverySnapshotLane("kick", ({ signal }) => collectDiscoverySnapshot(adapter, undefined, signal, () => NOW, false));
    await lane.requestAndWait();
    const coherent = lane.current().snapshot;
    expect(coherent?.campaigns[0]?.candidates[0]?.live).toBe(true);
    malformed = true;
    await lane.requestAndWait();
    expect(lane.current().snapshot).toBe(coherent);
    expect(lane.current().lastAttempt?.complete).toBe(false);
  });

  it.each([{ data: [] }, { data: { livestreams: [] } }])("accepts a genuinely empty general directory: %j", async (directory) => {
    const adapter = kickAdapter(fetcher(() => directory));
    vi.spyOn(adapter, "refreshCampaigns").mockResolvedValue([campaign()]);
    const result = await collectDiscoverySnapshot(adapter, undefined, new AbortController().signal, () => NOW, false);
    expect(result.complete).toBe(true);
    expect(result.campaigns[0]?.candidates).toEqual([]);
  });

  it.each(["page", "api"])("retains the previous snapshot when live %s evidence lacks the required category", async (source) => {
    let missingCategory = false;
    const adapter = kickAdapter(fetcher((url) => {
      if (!missingCategory) return liveResponse;
      if (url.includes("/api/")) {
        if (source === "api") return { livestream: { is_live: true } };
        throw new Error("unavailable");
      }
      return { html: '{"is_live":true}' };
    }));
    vi.spyOn(adapter, "refreshCampaigns").mockResolvedValue([campaign()]);
    vi.spyOn(adapter, "listCandidateChannels").mockResolvedValue([candidate()]);
    const lane = new DiscoverySnapshotLane("kick", ({ signal }) => collectDiscoverySnapshot(adapter, undefined, signal, () => NOW, false));
    await lane.requestAndWait();
    const coherent = lane.current().snapshot;
    expect(coherent?.campaigns[0]?.candidates[0]?.categoryMatches).toBe(true);
    missingCategory = true;
    await lane.requestAndWait();
    expect(lane.current().snapshot).toBe(coherent);
    expect(lane.current().lastAttempt?.complete).toBe(false);
  });

  it.each([
    [false, campaign(), false],
    [true, undefined, true],
  ] as const)("accepts page live=%s without category when it is not needed", async (live, source, expectedLive) => {
    const adapter = kickAdapter(fetcher((url) => {
      if (url.includes("/api/")) throw new Error("unavailable");
      return { html: JSON.stringify({ is_live: live }) };
    }));
    const result = await adapter.checkChannels([{ channel: candidate(), campaign: source }]);
    expect(result.checks[0]?.live).toBe(expectedLive);
  });

  it("shares raw evidence across campaigns without sharing category decisions or candidate metadata", async () => {
    const transport = fetcher(() => liveResponse);
    const adapter = kickAdapter(transport);
    const requests = [
      { channel: candidate("Streamer", { campaignId: "first", isAclMatch: true }), campaign: campaign({ id: "first" }) },
      { channel: candidate("streamer", { campaignId: "second", isAclMatch: false }), campaign: campaign({ id: "second", categoryId: "99" }) },
      { channel: candidate("streamer", { categoryId: "99" }) },
    ];
    const result = await adapter.checkChannels(requests);
    expect(transport.fetchJson).toHaveBeenCalledTimes(1);
    expect(result.uniqueChannelChecks).toBe(1);
    expect(result.checks.map((check) => [check!.categoryMatches, check!.candidate.campaignId, check!.candidate.isAclMatch]))
      .toEqual([[true, "first", true], [false, "second", false], [false, undefined, undefined]]);
    expect(result.checks.every((check) => check!.live && check!.campaignMatches === undefined)).toBe(true);
    await adapter.checkChannels(requests);
    expect(transport.fetchJson).toHaveBeenCalledTimes(2);
  });

  it("finishes six unique checks in two bounded waves and keeps request order", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maximum = 0;
    const transport = fetcher(async (url) => {
      active += 1;
      maximum = Math.max(maximum, active);
      const index = Number(url.split("/").at(-1));
      await new Promise((resolve) => setTimeout(resolve, index % 3 === 0 ? 100 : 90));
      active -= 1;
      return liveResponse;
    });
    const start = Date.now();
    const run = kickAdapter(transport).checkChannels([0, 1, 2, 3, 4, 5].map((id) => ({ channel: candidate(String(id)), campaign: campaign({ id: String(id) }) })));
    await vi.runAllTimersAsync();
    const result = await run;
    expect(maximum).toBe(3);
    expect(Date.now() - start).toBe(190);
    expect(result.checks.map((check) => check!.candidate.username)).toEqual(["0", "1", "2", "3", "4", "5"]);
  });

  it("stops admission on rate limiting, drains active checks and never retries through the page", async () => {
    vi.useFakeTimers();
    const transport = fetcher(async (url) => {
      await new Promise((resolve) => setTimeout(resolve, url.endsWith("/0") ? 10 : 100));
      if (url.endsWith("/0")) throw new SafeFetchError({ kind: "http_error", status: 429 });
      return liveResponse;
    });
    let settled = false;
    const run = kickAdapter(transport).checkChannels([0, 1, 2, 3, 4, 5].map((id) => ({ channel: candidate(String(id)) })))
      .then(() => { settled = true; return undefined; }, (error: unknown) => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(20);
    expect(settled).toBe(false);
    expect(transport.fetchJson).toHaveBeenCalledTimes(3);
    await vi.runAllTimersAsync();
    expect(await run).toMatchObject({ failure: { status: 429 } });
    expect(transport.fetchJson).toHaveBeenCalledTimes(3);
  });

  it("retains the coherent snapshot when both channel API and page evidence fail", async () => {
    let failed = false;
    const transport = fetcher(() => { if (failed) throw new Error("unavailable"); return liveResponse; });
    const adapter = kickAdapter(transport);
    vi.spyOn(adapter, "refreshCampaigns").mockResolvedValue([campaign()]);
    vi.spyOn(adapter, "listCandidateChannels").mockResolvedValue([candidate()]);
    const lane = new DiscoverySnapshotLane("kick", ({ signal }) => collectDiscoverySnapshot(adapter, undefined, signal, () => NOW, false));
    await lane.requestAndWait();
    const coherent = lane.current().snapshot;
    expect(coherent?.campaigns[0]?.candidates[0]?.live).toBe(true);
    failed = true;
    await lane.requestAndWait();
    expect(lane.current().snapshot).toBe(coherent);
    expect(lane.current().lastAttempt?.complete).toBe(false);
  });

  it("rejects incomplete progress during snapshot collection", async () => {
    const adapter = kickAdapter(fetcher((url) => {
      if (url.endsWith("/progress")) throw new Error("unavailable");
      return { data: [] };
    }));
    await expect(collectDiscoverySnapshot(adapter, undefined, new AbortController().signal, () => NOW, false)).rejects.toThrow();
  });

  it.each(["campaigns", "progress"])("rejects unrecognized %s inventory instead of publishing an empty snapshot", async (endpoint) => {
    const adapter = kickAdapter(fetcher((url) => url.endsWith(`/${endpoint}`) ? {} : { data: [] }));
    await expect(collectDiscoverySnapshot(adapter, undefined, new AbortController().signal, () => NOW, false)).rejects.toThrow("incomplete");
  });

  it.each(["campaigns", "progress"])("rejects malformed records in recognized %s inventory", async (endpoint) => {
    const adapter = kickAdapter(fetcher((url) => url.endsWith(`/${endpoint}`) ? { data: [{}] } : { data: [] }));

    await expect(collectDiscoverySnapshot(adapter, undefined, new AbortController().signal, () => NOW, false))
      .rejects.toThrow("incomplete");
  });

  it.each([{ livestream: {} }, { livestream: "offline" }, { livestream: false }, { livestream: 0 }])(
    "rejects ambiguous channel live evidence: %j",
    async (response) => {
      const adapter = kickAdapter(fetcher(() => response));

      await expect(adapter.checkChannels([{ channel: candidate() }])).rejects.toThrow("incomplete");
    },
  );

  it("does not commit an aborted followed-channel lookup as a fresh empty cache entry", async () => {
    const pending = deferred<unknown>();
    const discoveryState = new KickDiscoveryState();
    const adapter = kickAdapter(fetcher(() => pending.promise), undefined, undefined, undefined, { discoveryState });
    const abort = new AbortController();

    const strictLookup = adapter.listFollowedChannels({ signal: abort.signal, requireComplete: true });
    abort.abort(new DOMException("cancelled", "AbortError"));
    pending.resolve([{ channel: { slug: "fresh-friend" } }]);

    await expect(strictLookup).rejects.toMatchObject({ name: "AbortError" });
    await expect(adapter.listFollowedChannels()).resolves.toEqual(["fresh-friend"]);
  });

  it("drains progress when campaign inventory fails before returning the cycle", async () => {
    vi.useFakeTimers();
    let progressFinished = false;
    let settled = false;
    const adapter = kickAdapter(fetcher(async (url) => {
      if (url.endsWith("/campaigns")) throw new Error("unavailable");
      await new Promise((resolve) => setTimeout(resolve, 100));
      progressFinished = true;
      return { data: [] };
    }));
    const run = collectDiscoverySnapshot(adapter, undefined, new AbortController().signal, () => NOW, false)
      .catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    await vi.runAllTimersAsync();
    await run;
    expect(progressFinished).toBe(true);
  });

  it("does not turn a rate limit into a page-context transport retry", async () => {
    const background = vi.fn(async () => { throw new SafeFetchError({ kind: "http_error", status: 429 }); });
    const pageFetch = vi.fn(async () => liveResponse);
    const adapter = kickAdapter(createKickFetcher({ background, pageFetch }));
    await expect(adapter.checkChannels([{ channel: candidate() }])).rejects.toMatchObject({ failure: { status: 429 } });
    expect(background).toHaveBeenCalledOnce();
    expect(pageFetch).not.toHaveBeenCalled();
  });

  it("rejects missing API and ambiguous page evidence without logging error details", async () => {
    const events: unknown[] = [];
    const adapter = kickAdapter(fetcher((url) => url.includes("/api/") ? {} : { html: "<html>login</html>" }),
      undefined, undefined, (event) => { events.push(event); });
    await expect(adapter.checkChannels([{ channel: candidate() }])).rejects.toThrow("incomplete");
    expect(JSON.stringify(events)).not.toContain("<html>");
  });

  it("retains safe transport failure context in strict fallback diagnostics", async () => {
    const events: unknown[] = [];
    const adapter = kickAdapter(fetcher((url) => {
      if (url.includes("/api/")) throw new SafeFetchError({ kind: "http_error", status: 503 });
      return { html: "<html>unavailable</html>" };
    }), undefined, undefined, (event) => { events.push(event); });

    await expect(adapter.checkChannels([{ channel: candidate() }])).rejects.toThrow("incomplete");
    expect(JSON.stringify(events)).toContain("http_error status=503");
    expect(JSON.stringify(events)).not.toContain("<html>");
  });

  it("uses affirmative page evidence after API failure, sharing the fallback within the revision", async () => {
    const transport = fetcher((url) => {
      if (url.includes("/api/")) throw new Error("private transport detail");
      return { html: '{"is_live":true,"category_id":13}' };
    });
    const events: unknown[] = [];
    const adapter = kickAdapter(transport, undefined, undefined, (event) => { events.push(event); });
    const result = await adapter.checkChannels([
      { channel: candidate(), campaign: campaign() },
      { channel: candidate(), campaign: campaign({ id: "other", categoryId: "99" }) },
    ]);
    expect(result.checks.map((check) => [check!.live, check!.categoryMatches])).toEqual([[true, true], [true, false]]);
    expect(transport.fetchJson).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(events)).not.toContain("private transport detail");
  });

  it("checks only the first valid channel per campaign, without speculative later requests", async () => {
    const transport = fetcher(() => liveResponse);
    const adapter = kickAdapter(transport);
    vi.spyOn(adapter, "refreshCampaigns").mockResolvedValue([campaign(), campaign({ id: "second" })]);
    vi.spyOn(adapter, "listCandidateChannels").mockResolvedValue([candidate("first"), candidate("second"), candidate("third")]);
    const result = await collectDiscoverySnapshot(adapter, undefined, new AbortController().signal, () => NOW, false);
    expect(transport.fetchJson).toHaveBeenCalledTimes(1);
    expect(result.metrics.uniqueChannelChecks).toBe(1);
    expect(result.metrics.candidates).toBe(2);
    expect(result.campaigns.map((item) => item.candidates.map((check) => check.candidate.username))).toEqual([["first"], ["first"]]);
  });

  it("rejects a batch that omits required evidence", async () => {
    const adapter = kickAdapter(fetcher(() => liveResponse));
    vi.spyOn(adapter, "refreshCampaigns").mockResolvedValue([campaign()]);
    vi.spyOn(adapter, "listCandidateChannels").mockResolvedValue([candidate()]);
    vi.spyOn(adapter, "checkChannels").mockResolvedValue({ checks: [undefined], uniqueChannelChecks: 0 });
    await expect(collectDiscoverySnapshot(adapter, undefined, new AbortController().signal, () => NOW, false)).rejects.toThrow("incomplete");
  });

  it("drains started work and admits no next campaign after cancellation", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const transport = fetcher(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return liveResponse;
    });
    let settled = false;
    const run = kickAdapter(transport).checkChannels([0, 1, 2, 3].map((id) => ({ channel: candidate(String(id)) })), { signal: abort.signal })
      .catch((error: unknown) => { settled = true; return error; });
    abort.abort();
    await vi.advanceTimersByTimeAsync(20);
    expect(settled).toBe(false);
    await vi.runAllTimersAsync();
    expect(await run).toMatchObject({ name: "AbortError" });
    expect(transport.fetchJson).toHaveBeenCalledTimes(3);
  });
});

describe("Kick discovery request budgets and selection", () => {
  it.each(["idle", "retained", "switch"] as const)("bounds %s discovery requests and latency", async (scenario) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const settings = mergeSettings(undefined);
    settings.preferKnownChannels = false;
    const previous: WatchSession = { platform: "kick", status: "watching", offlineChecks: 0, campaignId: "current", rewardId: "current-reward",
      channel: candidate("retained"), watchMode: "tabless", lastHeartbeatOk: true, lastHeartbeatAt: new Date(NOW).toISOString() };
    const transport = fetcher(async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (url.endsWith("/campaigns")) return { data: [
        { id: "current", name: "Current", status: scenario === "retained" ? "active" : "completed", category_id: 13,
          channels: [{ slug: "unused-current" }], rewards: [{ id: "current-reward", name: "Current reward", required_minutes: 60 }] },
        { id: "target", name: "Target", status: scenario === "switch" ? "active" : "expired", category_id: 13,
          channels: [{ slug: "target-first" }, { slug: "unused-target" }], rewards: [{ id: "target-reward", name: "Target reward", required_minutes: 60 }] },
      ] };
      if (url.endsWith("/progress")) return { data: [] };
      if (url.includes("/api/v2/channels/")) return liveResponse;
      throw new Error(`Unexpected request: ${url}`);
    });
    const adapter = kickAdapter(transport);
    const lane = new DiscoverySnapshotLane("kick", ({ signal }) => collectDiscoverySnapshot(adapter, previous, signal, Date.now, false, [], undefined, settings));
    const run = lane.requestAndWait();
    await vi.runAllTimersAsync();
    await run;
    const snapshot = lane.current().snapshot!;
    expect(snapshot.campaigns).toHaveLength(2);
    expect(snapshot.metrics.skippedBeforeChannelWork).toBe(scenario === "idle" ? 2 : 1);
    expect(snapshot.metrics.uniqueChannelChecks).toBe(scenario === "idle" ? 0 : 1);
    expect(transport.fetchJson).toHaveBeenCalledTimes(scenario === "idle" ? 2 : 3);
    expect(Date.now() - NOW).toBe(scenario === "idle" ? 100 : 200);
    const selected = await selectWatchTargetFromSnapshot({ snapshot, previous, previousCampaigns: [], settings });
    expect(selected.decision.channel?.username).toBe(scenario === "idle" ? undefined : scenario === "retained" ? "retained" : "target-first");
    expect(selected.decision.campaign?.id).toBe(scenario === "idle" ? undefined : scenario === "retained" ? "current" : "target");
    if (scenario === "retained") expect(selected.retention.keep).toBe(true);
    expect(transport.fetchJson).toHaveBeenCalledTimes(scenario === "idle" ? 2 : 3);
  });
});

describe("Kick static discovery gate", () => {
  const cases: Array<[string, Partial<DropCampaign>, (settings: ExtensionSettings) => void]> = [
    ["completed", { status: "completed" }, () => {}],
    ["expired", { endsAt: "2026-09-09T09:59:00Z" }, () => {}],
    ["upcoming", { status: "upcoming" }, () => {}],
    ["excluded", {}, (settings) => { settings.excludedCampaignIds = ["campaign"]; }],
    ["infeasible", { endsAt: "2026-09-09T10:30:00Z" }, () => {}],
    ["unlinked disabled", { accountLinked: false }, (settings) => { settings.farmingEligibility.farmUnlinkedCampaigns = false; }],
    ["subscription disabled", { rewards: [{ ...reward, requirement: "subscription", requiredSubs: 1, isWatchBased: false }] }, (settings) => { settings.farmingEligibility.farmSubscriptionCampaigns = false; }],
    ["category excluded", {}, (settings) => { settings.platform.kick.categoryMode = "exclude"; settings.platform.kick.categories = [{ id: "13", name: "Rust" }]; }],
    ["priority not selected", {}, (settings) => { settings.priorityMode = "priority_list_only"; }],
    ["no rewards", { rewards: [] }, () => {}],
    ["claimed", { rewards: [{ ...reward, status: "claimed" }] }, () => {}],
    ["prerequisites unmet", { rewards: [{ ...reward, preconditionsMet: false }] }, () => {}],
    ["reward not started", { rewards: [{ ...reward, availableFrom: "2026-09-09T11:00:00Z" }] }, () => {}],
    ["reward window ended", { rewards: [{ ...reward, availableUntil: "2026-09-09T09:00:00Z" }] }, () => {}],
  ];
  it.each(cases)("keeps %s inventory without channel enumeration", async (_name, overrides, configure) => {
    const settings = mergeSettings(undefined);
    configure(settings);
    const source = campaign(overrides);
    const listCandidateChannels = vi.fn(async () => [candidate()]);
    const checkChannel = vi.fn(async (channel: ChannelCandidate) => ({ candidate: channel, live: true, categoryMatches: true }));
    const result = await collectDiscoverySnapshot({ platform: "kick", refreshCampaigns: async () => [source], listCandidateChannels, checkChannel },
      undefined, new AbortController().signal, () => NOW, false, [], undefined, settings);
    expect(result.campaigns).toEqual([{ campaign: source, candidates: [] }]);
    expect(listCandidateChannels).not.toHaveBeenCalled();
    expect(checkChannel).not.toHaveBeenCalled();
    expect(result.metrics.skippedBeforeChannelWork).toBe(1);
  });

  it.each([
    ["ordinary", {}],
    ["unlinked allowed", { accountLinked: false }],
    ["claimable", { rewards: [{ ...reward, status: "claimable", watchedMinutes: 60 }] }],
    ["uncertain campaign eligibility", { eligibility: "waiting_for_subscription" }],
  ] as Array<[string, Partial<DropCampaign>]>)("still checks %s campaigns", async (_name, overrides) => {
    const source = campaign(overrides);
    const result = await collectDiscoverySnapshot({ platform: "kick", refreshCampaigns: async () => [source], listCandidateChannels: async () => [candidate()],
      checkChannel: async (channel) => ({ candidate: channel, live: true, categoryMatches: true }) },
    undefined, new AbortController().signal, () => NOW, false, [], undefined, mergeSettings(undefined));
    expect(result.campaigns[0]?.candidates).toHaveLength(1);
    expect(result.metrics.skippedBeforeChannelWork).toBe(0);
  });

  it("evaluates the static gate after persisted claim reconciliation", async () => {
    const source = campaign({
      rewards: [
        { ...reward, id: "predecessor", claimId: "claim-1", status: "locked" },
        { ...reward, id: "successor", status: "locked", preconditionsMet: false },
      ],
    });
    const reconciled = campaign({
      rewards: [
        { ...reward, id: "predecessor", claimId: "claim-1", status: "claimed", watchedMinutes: 60 },
        { ...reward, id: "successor", status: "in_progress", preconditionsMet: true },
      ],
    });
    const listCandidateChannels = vi.fn(async () => [candidate()]);

    const result = await collectDiscoverySnapshot(
      { platform: "kick", refreshCampaigns: async () => [source], listCandidateChannels,
        checkChannel: async (channel) => ({ candidate: channel, live: true, categoryMatches: true }) },
      undefined,
      new AbortController().signal,
      () => NOW,
      false,
      [],
      undefined,
      mergeSettings(undefined),
      () => [reconciled],
    );

    expect(listCandidateChannels).toHaveBeenCalledOnce();
    expect(result.campaigns[0]?.campaign).toBe(reconciled);
  });
});
