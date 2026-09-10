import { join } from "node:path";
import { vi } from "vitest";
import { resolveCompatibility } from "@lurkloot/core";
import { heartbeatContextKey } from "@lurkloot/core/heartbeatCadence";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import type { HeartbeatResult, TablessWatchController } from "@lurkloot/core/tablessWatch";
import type { ChannelCandidate, DropCampaign, EngineSettings, Platform, WatchSession } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import { DEFAULT_CLI_SETTINGS, type CliSettings } from "../../src/settings";
import type { Logger } from "../../src/logger";
import { runLoop } from "../../src/runtime/run";
import { loadState, saveState } from "../../src/storage";
import type { TransportHandle } from "../../src/transport";

type Scenario = "idle" | "stable" | "switch" | "higherPriorityUnavailable" | "heartbeatOverlap" | "slow" | "failed";

interface Counts {
  // PlatformAdapter calls, not raw HTTP request counts.
  adapterOperations: number;
  campaignDiscovery: number;
  candidateListings: number;
  channelChecks: number;
  heartbeatAttempts: number;
  heartbeatBlockedByDiscovery: number;
  discoveryBlockedByHeartbeat: number;
  adapterConstructions: number;
  watcherReconciliations: number;
}

interface Durations {
  discovery: number;
  selection: number;
  watcher: number;
  persistence: number;
  total: number;
}

const silentLogger: Logger = {
  level: "error",
  log: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function countingAdapter(
  platform: Platform,
  scenario: Scenario,
  counts: Counts,
  advance: (phase: "discovery" | "selection" | "watcher", milliseconds: number) => void,
): PlatformAdapter {
  const campaign: DropCampaign = {
    id: `${platform}-campaign`,
    platform,
    name: `${platform} campaign`,
    status: "active",
    rewards: [{
      id: `${platform}-reward`,
      name: `${platform} reward`,
      requiredMinutes: 60,
      watchedMinutes: 10,
      status: "in_progress",
    }],
  };
  const urgentCampaign: DropCampaign = {
    ...campaign,
    id: `${platform}-urgent`,
  };
  const candidate: ChannelCandidate = {
    platform,
    username: `${platform}-creator`,
    url: platform === "twitch"
      ? "https://www.twitch.tv/twitch-creator"
      : "https://kick.com/kick-creator",
  };
  const request = (): void => { counts.adapterOperations += 1; };
  return {
    platform,
    checkAuthHealth: async () => {
      request();
      return { status: "healthy" };
    },
    refreshCampaigns: async () => {
      counts.campaignDiscovery += 1;
      request();
      advance("discovery", scenario === "slow" ? 300 : 30);
      if (scenario === "failed") throw new Error(`${platform} synthetic discovery failure`);
      return scenario === "idle"
        ? []
        : scenario === "higherPriorityUnavailable" ? [campaign, urgentCampaign] : [campaign];
    },
    listCandidateChannels: async (selectedCampaign) => {
      counts.candidateListings += 1;
      request();
      advance("selection", scenario === "slow" ? 100 : 10);
      return [{
        ...candidate,
        username: selectedCampaign.id.endsWith("urgent") ? `${platform}-urgent-creator` : candidate.username,
      }];
    },
    checkChannel: async (checkedCandidate) => {
      counts.channelChecks += 1;
      request();
      advance("selection", scenario === "slow" ? 100 : 10);
      return {
        live: scenario !== "higherPriorityUnavailable" || !checkedCandidate.username.includes("urgent"),
        categoryMatches: true,
        candidate: checkedCandidate,
      };
    },
    claimReward: async () => false,
    prepareWatchTab: async () => {
      counts.watcherReconciliations += 1;
      advance("watcher", 5);
      return { tabId: platform === "twitch" ? 10 : 20, managedByExtension: false };
    },
    stopWatchTab: async () => undefined,
  };
}

export async function runCliBaselineCell(
  directory: string,
  platform: Platform,
  scenario: Scenario,
) {
  if (scenario === "heartbeatOverlap") {
    return runCliHeartbeatOverlapCell(directory, platform);
  }
  const counts: Counts = {
    adapterOperations: 0,
    campaignDiscovery: 0,
    candidateListings: 0,
    channelChecks: 0,
    heartbeatAttempts: 0,
    heartbeatBlockedByDiscovery: 0,
    discoveryBlockedByHeartbeat: 0,
    adapterConstructions: 0,
    watcherReconciliations: 0,
  };
  let stateLoads = 0;
  let stateSaves = 0;
  const durationsMs: Durations = {
    discovery: 0,
    selection: 0,
    watcher: 0,
    persistence: 0,
    total: 0,
  };
  const advance = (phase: "discovery" | "selection" | "watcher" | "persistence", milliseconds: number): void => {
    durationsMs[phase] += milliseconds;
    durationsMs.total += milliseconds;
    vi.setSystemTime(Date.now() + milliseconds);
  };
  const adapters = {
    twitch: countingAdapter("twitch", platform === "twitch" ? scenario : "idle", counts, advance),
    kick: countingAdapter("kick", platform === "kick" ? scenario : "idle", counts, advance),
  } satisfies Record<Platform, PlatformAdapter>;
  const settings: CliSettings = {
    ...DEFAULT_CLI_SETTINGS,
    platform: {
      twitch: { ...DEFAULT_CLI_SETTINGS.platform.twitch, enabled: platform === "twitch" },
      kick: { ...DEFAULT_CLI_SETTINGS.platform.kick, enabled: platform === "kick" },
    },
    campaignPriorities: scenario === "higherPriorityUnavailable"
      ? { [`${platform}-urgent`]: 10 }
      : {},
  };
  const buildOne = (selectedPlatform: Platform, _emit: EventEmitter, engineSettings: EngineSettings) => {
    counts.adapterConstructions += 1;
    return {
      adapter: adapters[selectedPlatform],
      ...resolveCompatibility(engineSettings.compatibility, { host: "cli", twitchIdentity: "web" }),
    };
  };
  const transport: TransportHandle = {
    adapters,
    createAdapter: buildOne,
    createAdapters: (_emit, engineSettings) => {
      counts.adapterConstructions += 2;
      return {
        adapters,
        ...resolveCompatibility(engineSettings.compatibility, { host: "cli", twitchIdentity: "web" }),
      };
    },
    dispose: async () => undefined,
  };

  const statePath = join(directory, `${platform}-${scenario}.json`);
  if (scenario === "stable" || scenario === "switch" || scenario === "higherPriorityUnavailable") {
    const candidate: ChannelCandidate = {
      platform,
      username: `${platform}-creator`,
      url: platform === "twitch"
        ? "https://www.twitch.tv/twitch-creator"
        : "https://kick.com/kick-creator",
    };
    const current = scenario === "switch"
      ? countingCampaign(platform, "old-campaign", "old-reward")
      : countingCampaign(platform);
    await saveState(statePath, {
      ...structuredClone(DEFAULT_STATE),
      campaigns: { ...DEFAULT_STATE.campaigns, [platform]: [current] },
      sessions: {
        ...DEFAULT_STATE.sessions,
        [platform]: {
          platform,
          status: "watching",
          offlineChecks: 0,
          channel: candidate,
          campaignId: current.id,
          rewardId: current.rewards[0].id,
          watchMode: "tab",
          startedAt: new Date().toISOString(),
        },
      },
    });
  }

  await runLoop({
    settings,
    statePath,
    transport,
    logger: silentLogger,
    once: true,
    stateStore: {
      load: async () => {
        stateLoads += 1;
        return loadState(statePath);
      },
      save: async (state) => {
        stateSaves += 1;
        await saveState(statePath, state);
      },
    },
  });
  const finalState = await loadState(statePath);

  return {
    host: "cli" as const,
    platform,
    scenario,
    counts,
    stateLoads,
    stateSaves,
    durationsMs,
    outcomeCampaignId: finalState.sessions[platform].campaignId,
  };
}

type OverlapMilestone =
  | "initialDiscoveryCompleted"
  | "discoveryStarted"
  | "discoveryProgressed"
  | "discoveryCompleted"
  | "heartbeatStarted"
  | "heartbeatFinished"
  | "heartbeatCommitted";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createOverlapMilestones() {
  const names: readonly OverlapMilestone[] = [
    "initialDiscoveryCompleted",
    "discoveryStarted",
    "discoveryProgressed",
    "discoveryCompleted",
    "heartbeatStarted",
    "heartbeatFinished",
    "heartbeatCommitted",
  ];
  const waits = Object.fromEntries(names.map((name) => [name, deferred()])) as Record<
    OverlapMilestone,
    ReturnType<typeof deferred>
  >;
  const order = new Map<OverlapMilestone, number>();
  let sequence = 0;
  return {
    mark(name: OverlapMilestone): void {
      if (order.has(name)) return;
      order.set(name, ++sequence);
      waits[name].resolve();
    },
    wait(name: OverlapMilestone): Promise<void> {
      return waits[name].promise;
    },
    happenedAfter(later: OverlapMilestone, earlier: OverlapMilestone): number {
      const laterOrder = order.get(later);
      const earlierOrder = order.get(earlier);
      if (laterOrder === undefined || earlierOrder === undefined) {
        throw new Error(`Missing overlap milestone: ${later}/${earlier}`);
      }
      return Number(laterOrder > earlierOrder);
    },
  };
}

async function runCliHeartbeatOverlapCell(directory: string, platform: Platform) {
  const signalListenersBefore = {
    SIGINT: new Set(process.listeners("SIGINT")),
    SIGTERM: new Set(process.listeners("SIGTERM")),
  };
  const counts: Counts = {
    adapterOperations: 0,
    campaignDiscovery: 0,
    candidateListings: 0,
    channelChecks: 0,
    heartbeatAttempts: 0,
    heartbeatBlockedByDiscovery: 0,
    discoveryBlockedByHeartbeat: 0,
    adapterConstructions: 0,
    watcherReconciliations: 0,
  };
  const durationsMs: Durations = {
    discovery: 0,
    selection: 0,
    watcher: 0,
    persistence: 0,
    total: 0,
  };
  const advance = (phase: "discovery" | "selection" | "watcher" | "persistence", milliseconds: number): void => {
    durationsMs[phase] += milliseconds;
    durationsMs.total += milliseconds;
    vi.setSystemTime(Date.now() + milliseconds);
  };
  const milestones = createOverlapMilestones();
  const releaseDiscovery = deferred();
  const releaseHeartbeat = deferred();
  let watcherChannelUrl: string | undefined;
  const watcher: TablessWatchController = {
    platform,
    get channelUrl() {
      return watcherChannelUrl;
    },
    start: async (channel) => {
      watcherChannelUrl = channel.url;
      counts.watcherReconciliations += 1;
      advance("watcher", 5);
    },
    tick: async (): Promise<HeartbeatResult> => {
      counts.heartbeatAttempts += 1;
      milestones.mark("heartbeatStarted");
      await releaseHeartbeat.promise;
      milestones.mark("heartbeatFinished");
      return { ok: true, live: true };
    },
    drainEvents: () => [],
    stop: async () => {
      watcherChannelUrl = undefined;
    },
  };
  const measuredAdapter = countingAdapter(platform, "stable", counts, advance);
  let refreshCalls = 0;
  const refreshCampaigns = measuredAdapter.refreshCampaigns;
  measuredAdapter.refreshCampaigns = async (session, options) => {
    refreshCalls += 1;
    if (refreshCalls === 2) {
      milestones.mark("discoveryStarted");
      await releaseDiscovery.promise;
    }
    return refreshCampaigns(session, options);
  };
  const checkChannel = measuredAdapter.checkChannel;
  measuredAdapter.checkChannel = async (channel, options) => {
    const checked = await checkChannel(channel, options);
    if (refreshCalls === 2) milestones.mark("discoveryProgressed");
    return checked;
  };
  measuredAdapter.supportsTabless = true;
  measuredAdapter.createTablessWatcher = () => watcher;
  const adapters = {
    twitch: platform === "twitch"
      ? measuredAdapter
      : countingAdapter("twitch", "idle", counts, advance),
    kick: platform === "kick"
      ? measuredAdapter
      : countingAdapter("kick", "idle", counts, advance),
  } satisfies Record<Platform, PlatformAdapter>;
  const settings: CliSettings = {
    ...DEFAULT_CLI_SETTINGS,
    pollIntervalMinutes: 1,
    platform: {
      twitch: { ...DEFAULT_CLI_SETTINGS.platform.twitch, enabled: platform === "twitch" },
      kick: { ...DEFAULT_CLI_SETTINGS.platform.kick, enabled: platform === "kick" },
    },
  };
  const compatibility = resolveCompatibility(settings.compatibility, {
    host: "cli",
    twitchIdentity: "web",
  });
  const buildOne = (selectedPlatform: Platform) => {
    counts.adapterConstructions += 1;
    return { adapter: adapters[selectedPlatform], ...compatibility };
  };
  const transport: TransportHandle = {
    adapters,
    createAdapter: (selectedPlatform) => buildOne(selectedPlatform),
    createAdapters: () => {
      counts.adapterConstructions += 2;
      return { adapters, ...compatibility };
    },
    dispose: async () => undefined,
  };
  let completedDiscoveryTicks = 0;
  const logger: Logger = {
    level: "error",
    log: (_level, message, scope) => {
      if (scope === platform && /^Tick #\d+ finished after /.test(message)) {
        completedDiscoveryTicks += 1;
        milestones.mark(completedDiscoveryTicks === 1
          ? "initialDiscoveryCompleted"
          : "discoveryCompleted");
      }
      if (scope === platform && /^Tabless heartbeat timing /.test(message)) {
        milestones.mark("heartbeatCommitted");
      }
    },
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const campaign = countingCampaign(platform);
  const candidate: ChannelCandidate = {
    platform,
    username: `${platform}-creator`,
    url: platform === "twitch"
      ? "https://www.twitch.tv/twitch-creator"
      : "https://kick.com/kick-creator",
  };
  const session: WatchSession = {
    platform,
    status: "watching",
    offlineChecks: 0,
    channel: candidate,
    campaignId: campaign.id,
    rewardId: campaign.rewards[0]!.id,
    watchMode: "tabless",
    startedAt: new Date().toISOString(),
  };
  const contextKey = heartbeatContextKey(session);
  if (!contextKey) throw new Error("Expected a complete baseline heartbeat context");
  session.tablessHeartbeat = {
    generation: 1,
    contextKey,
    nextDueAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const statePath = join(directory, `${platform}-heartbeat-overlap.json`);
  await saveState(statePath, {
    ...structuredClone(DEFAULT_STATE),
    authHealth: {
      ...DEFAULT_STATE.authHealth,
      [platform]: { status: "healthy" },
    },
    campaigns: {
      ...DEFAULT_STATE.campaigns,
      [platform]: [campaign],
    },
    sessions: {
      ...DEFAULT_STATE.sessions,
      [platform]: session,
    },
  });

  const running = runLoop({
    settings,
    statePath,
    transport,
    logger,
    checkCredentialAvailability: async () => ({ status: "available" }),
  });
  let result: {
    host: "cli";
    platform: Platform;
    scenario: "heartbeatOverlap";
    counts: Counts;
    durationsMs: Durations;
    outcomeCampaignId: string | undefined;
  } | undefined;
  try {
    await milestones.wait("initialDiscoveryCompleted");
    await vi.waitFor(() => {
      if (vi.getTimerCount() !== 2) {
        throw new Error(`Expected both CLI host timers, observed ${vi.getTimerCount()}`);
      }
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await milestones.wait("discoveryStarted");
    setTimeout(() => releaseDiscovery.resolve(), 1);
    await vi.advanceTimersByTimeAsync(1);
    setTimeout(() => releaseHeartbeat.resolve(), 1);
    await vi.advanceTimersByTimeAsync(1);

    await Promise.all([
      milestones.wait("discoveryProgressed"),
      milestones.wait("discoveryCompleted"),
      milestones.wait("heartbeatStarted"),
      milestones.wait("heartbeatFinished"),
      milestones.wait("heartbeatCommitted"),
    ]);
    counts.heartbeatBlockedByDiscovery = milestones.happenedAfter(
      "heartbeatStarted",
      "discoveryProgressed",
    );
    counts.discoveryBlockedByHeartbeat = milestones.happenedAfter(
      "discoveryProgressed",
      "heartbeatFinished",
    );
    const finalState = await loadState(statePath);
    result = {
      host: "cli",
      platform,
      scenario: "heartbeatOverlap",
      counts,
      durationsMs,
      outcomeCampaignId: finalState.sessions[platform].campaignId,
    };
  } finally {
    releaseDiscovery.resolve();
    releaseHeartbeat.resolve();
    try {
      process.emit("SIGTERM");
      await running;
    } finally {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        for (const listener of process.listeners(signal)) {
          if (!signalListenersBefore[signal].has(listener)) {
            process.removeListener(signal, listener);
          }
        }
      }
    }
  }
  if (!result) throw new Error("CLI heartbeat overlap baseline did not complete");
  return result;
}

function countingCampaign(platform: Platform, campaignSuffix = "campaign", rewardSuffix = "reward"): DropCampaign {
  return {
    id: `${platform}-${campaignSuffix}`,
    platform,
    name: `${platform} campaign`,
    status: "active",
    rewards: [{
      id: `${platform}-${rewardSuffix}`,
      name: `${platform} reward`,
      requiredMinutes: 60,
      watchedMinutes: 10,
      status: "in_progress",
    }],
  };
}
