import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCountingAdapter,
  createTickBaselineRecorder,
  runExtensionBaselineCell,
} from "./helpers/tickBaseline";

function reportBaseline(result: unknown): void {
  if (process.env.LURKLOOT_TICK_BASELINE === "1") {
    console.log(`TICK_BASELINE ${JSON.stringify(result)}`);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduler tick baseline recorder", () => {
  it("records aggregate work without credential or payload fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");
    const recorder = createTickBaselineRecorder();

    recorder.count("adapterOperations");
    await recorder.clock.advance("discovery", 40);

    expect(recorder.snapshot()).toEqual({
      counts: {
        adapterOperations: 1,
        campaignDiscovery: 0,
        candidateListings: 0,
        channelChecks: 0,
        heartbeatAttempts: 0,
        heartbeatBlockedByDiscovery: 0,
        discoveryBlockedByHeartbeat: 0,
        campaignsEvaluated: 0,
        candidatesEvaluated: 0,
        watcherReconciliations: 0,
        adapterConstructions: 0,
        settingsLoads: 0,
        stateLoads: 0,
        stateSaves: 0,
        eventPublications: 0,
      },
      durationsMs: {
        discovery: 40,
        selection: 0,
        watcher: 0,
        persistence: 0,
        total: 40,
      },
    });
    expect(JSON.stringify(recorder.snapshot())).not.toMatch(
      /credential|cookie|token|authorization|payload/i,
    );
  });

  it.each(["twitch", "kick"] as const)("counts normalized %s provider work", async (platform) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");
    const recorder = createTickBaselineRecorder();
    const adapter = createCountingAdapter(platform, "refresh", recorder);

    const campaigns = await adapter.refreshCampaigns();
    const candidates = await adapter.listCandidateChannels(campaigns[0]);
    const checked = await adapter.checkChannel(candidates[0]);

    expect(campaigns).toHaveLength(1);
    expect(checked).toMatchObject({ live: true, categoryMatches: true });
    expect(recorder.snapshot()).toMatchObject({
      counts: {
        adapterOperations: 3,
        campaignDiscovery: 1,
        candidateListings: 1,
        channelChecks: 1,
      },
      durationsMs: { discovery: 30, selection: 20, total: 50 },
    });
  });
});

describe("extension scheduler tick baseline", () => {
  it.each(["twitch", "kick"] as const)("measures isolated %s heartbeat/discovery overlap", async (platform) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");

    const result = await runExtensionBaselineCell(
      platform,
      "heartbeatOverlap",
    );
    reportBaseline(result);

    expect(result.counts).toEqual({
      adapterOperations: 4,
      campaignDiscovery: 1,
      candidateListings: 1,
      channelChecks: 1,
      heartbeatAttempts: 1,
      heartbeatBlockedByDiscovery: 0,
      discoveryBlockedByHeartbeat: 0,
      campaignsEvaluated: 0,
      candidatesEvaluated: 1,
      watcherReconciliations: 1,
      adapterConstructions: 3,
      settingsLoads: 6,
      stateLoads: 8,
      stateSaves: 3,
      eventPublications: 6,
    });
    expect(result.durationsMs).toEqual({
      discovery: 30,
      selection: 20,
      watcher: 5,
      persistence: 15,
      total: 70,
    });
    expect(JSON.stringify(result)).not.toMatch(/credential|cookie|token|authorization|payload/i);
  });

  it.each(["twitch", "kick"] as const)("measures an idle %s alarm tick", async (platform) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");

    const result = await runExtensionBaselineCell(platform, "idle");
    reportBaseline(result);

    expect(result).toMatchObject({
      host: "extension",
      platform,
      scenario: "idle",
      counts: {
        campaignDiscovery: 1,
        candidateListings: 0,
        channelChecks: 0,
        campaignsEvaluated: 0,
        candidatesEvaluated: 0,
        adapterOperations: 2,
        adapterConstructions: 1,
        settingsLoads: 5,
        stateLoads: 5,
        stateSaves: 2,
        eventPublications: 6,
        watcherReconciliations: 0,
      },
      durationsMs: {
        discovery: 30,
        selection: 0,
        watcher: 0,
        persistence: 10,
        total: 40,
      },
      observedControllerMs: {
        discovery: 30,
        total: 40,
      },
    });
  });

  it.each(["twitch", "kick"] as const)("measures a stable retained %s watch", async (platform) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");

    const result = await runExtensionBaselineCell(platform, "stable");
    reportBaseline(result);

    expect(result.counts).toMatchObject({
      adapterOperations: 4,
      campaignDiscovery: 1,
      candidateListings: 1,
      channelChecks: 1,
      campaignsEvaluated: 0,
      candidatesEvaluated: 1,
      adapterConstructions: 1,
      settingsLoads: 5,
      stateLoads: 5,
      stateSaves: 2,
      watcherReconciliations: 1,
    });
    expect(result.durationsMs).toEqual({
      discovery: 30,
      selection: 20,
      watcher: 5,
      persistence: 10,
      total: 65,
    });
  });

  it.each([
    ["twitch", "switch"],
    ["kick", "switch"],
    ["twitch", "higherPriorityUnavailable"],
    ["kick", "higherPriorityUnavailable"],
  ] as const)("measures %s/%s selection work", async (platform, scenario) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");

    const result = await runExtensionBaselineCell(platform, scenario);
    reportBaseline(result);

    expect(result.outcomeCampaignId).toBe(`${platform}-campaign`);

    expect(result.counts).toMatchObject({
      adapterOperations: scenario === "higherPriorityUnavailable" ? 6 : 4,
      campaignDiscovery: 1,
      candidateListings: scenario === "higherPriorityUnavailable" ? 2 : 1,
      channelChecks: scenario === "higherPriorityUnavailable" ? 2 : 1,
      campaignsEvaluated: scenario === "higherPriorityUnavailable" ? 2 : 1,
      candidatesEvaluated: scenario === "higherPriorityUnavailable" ? 2 : 1,
      adapterConstructions: 1,
      settingsLoads: 5,
      stateLoads: 5,
      stateSaves: 2,
      watcherReconciliations: 1,
    });
    expect(result.durationsMs).toEqual({
      discovery: 30,
      selection: scenario === "higherPriorityUnavailable" ? 40 : 20,
      watcher: 5,
      persistence: 10,
      total: scenario === "higherPriorityUnavailable" ? 85 : 65,
    });
  });

  it.each(["twitch", "kick"] as const)("measures a failed %s provider response", async (platform) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");

    const result = await runExtensionBaselineCell(platform, "failed");
    reportBaseline(result);

    expect(result.counts).toMatchObject({
      adapterOperations: 2,
      campaignDiscovery: 1,
      candidateListings: 0,
      channelChecks: 0,
      campaignsEvaluated: 0,
      candidatesEvaluated: 0,
      stateSaves: 2,
    });
    expect(result.durationsMs).toEqual({
      discovery: 30,
      selection: 0,
      watcher: 0,
      persistence: 10,
      total: 40,
    });
  });

  it.each(["twitch", "kick"] as const)("attributes controlled slow %s work to its phases", async (platform) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");

    const result = await runExtensionBaselineCell(platform, "slow");
    reportBaseline(result);

    expect(result.durationsMs).toEqual({
      discovery: 300,
      selection: 200,
      watcher: 5,
      persistence: 10,
      total: 515,
    });
    expect(result.observedControllerMs).toEqual({
      discovery: 500,
      selection: 0,
      total: 515,
    });
  });
});
