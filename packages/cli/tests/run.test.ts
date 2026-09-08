import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialAvailability } from "@lurkloot/core/controller";
import { resolveCompatibility } from "@lurkloot/core";
import { heartbeatContextKey } from "@lurkloot/core/heartbeatCadence";
import type { ChannelCandidate, ChannelCheck, DropCampaign, EngineSettings, Platform, PlatformAuthHealth, SchedulerState, WatchSession } from "@lurkloot/shared/models";
import type { PlatformAdapter, PreparedWatchTab } from "@lurkloot/core/adapter";
import type { HeartbeatResult, TablessWatchController } from "@lurkloot/core/tablessWatch";
import type { EventEmitter } from "@lurkloot/shared/events";
import { createTransport } from "../src/transport";
import type { TransportHandle } from "../src/transport";
import { DEFAULT_CLI_SETTINGS } from "../src/settings";
import { runCliTickOnce, runLoop } from "../src/runtime/run";
import { createLogger } from "../src/logger";
import type { Logger } from "../src/logger";
import { runCliBaselineCell } from "./helpers/tickBaseline";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import { saveState } from "../src/storage";

function reportBaseline(result: unknown): void {
  if (process.env.LURKLOOT_TICK_BASELINE === "1") {
    console.log(`TICK_BASELINE ${JSON.stringify(result)}`);
  }
}

// A benign adapter whose only interesting behaviour is checkAuthHealth. Every
// data method returns an empty result so an unhealthy (suspended) tick never
// throws while we assert on the persisted auth health.
function fakeAdapter(platform: Platform, health: PlatformAuthHealth): PlatformAdapter {
  return {
    platform,
    checkAuthHealth: async () => health,
    refreshCampaigns: async () => [],
    listCandidateChannels: async () => [],
    checkChannel: async (candidate: ChannelCandidate): Promise<ChannelCheck> => ({ live: false, categoryMatches: false, candidate }),
    claimReward: async () => false,
    prepareWatchTab: async (): Promise<PreparedWatchTab> => ({ tabId: 0, managedByExtension: false }),
    stopWatchTab: async () => {},
  };
}

// Reuses a real HTTP transport purely for its resolved compatibility (a
// synchronous construction, no network), then swaps in fake adapters so ticks
// stay deterministic and offline.
async function fakeTransport(health: Record<Platform, PlatformAuthHealth>): Promise<TransportHandle> {
  const real = await createTransport("http", {}, "/tmp/lurkloot-run-compat", { twitch: true, kick: true });
  const build = (_emit: EventEmitter, settings: EngineSettings) => {
    const { compatibility, warnings } = real.createAdapters(() => {}, settings);
    return {
      adapters: {
        twitch: fakeAdapter("twitch", health.twitch),
        kick: fakeAdapter("kick", health.kick),
      } as Record<Platform, PlatformAdapter>,
      compatibility,
      warnings,
    };
  };
  const buildOne = (platform: Platform, emit: EventEmitter, settings: EngineSettings) => {
    const { adapters, ...resolution } = build(emit, settings);
    return { adapter: adapters[platform], ...resolution };
  };
  const initial = build(() => {}, DEFAULT_CLI_SETTINGS as unknown as EngineSettings);
  return {
    adapters: initial.adapters,
    createAdapter: buildOne,
    createAdapters: build,
    dispose: async () => { await real.dispose(); },
  };
}

const HEALTHY: PlatformAuthHealth = { status: "healthy", message: { key: "authHealthy" } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function readAuthHealth(statePath: string): Promise<SchedulerState["authHealth"]> {
  const state = JSON.parse(await readFile(statePath, "utf8")) as SchedulerState;
  return state.authHealth;
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lurkloot-run-")); });
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

async function runOnce(health: Record<Platform, PlatformAuthHealth>, availability: (platform: Platform) => CredentialAvailability): Promise<string> {
  const statePath = join(dir, "state.json");
  await runLoop({
    settings: DEFAULT_CLI_SETTINGS,
    statePath,
    transport: await fakeTransport(health),
    logger: createLogger("error"),
    once: true,
    checkCredentialAvailability: async (platform) => availability(platform),
  });
  return statePath;
}

function stateWithSubscriptionWait(id: string): SchedulerState {
  return {
    ...structuredClone(DEFAULT_STATE),
    campaigns: {
      ...DEFAULT_STATE.campaigns,
      twitch: [{
        id: `campaign-${id}`,
        platform: "twitch",
        name: `Campaign ${id}`,
        status: "active",
        eligibility: "waiting_for_subscription",
        rewards: [{
          id: `reward-${id}`,
          name: `Reward ${id}`,
          requirement: "subscription",
          requiredSubs: 1,
          requiredMinutes: 0,
          watchedMinutes: 0,
          status: "in_progress",
        }],
      }],
    },
  };
}

describe("CLI committed tick consumption", () => {
  const engineSettings = DEFAULT_CLI_SETTINGS as unknown as EngineSettings;
  const enabledPlatforms: Platform[] = ["twitch"];

  it("uses the returned committed state without a fallback load", async () => {
    const state = stateWithSubscriptionWait("success");
    const loadState = vi.fn(async () => structuredClone(DEFAULT_STATE));
    const logger = createLogger("error");
    logger.info = vi.fn();

    await runCliTickOnce({
      controller: { tickAndHandOff: vi.fn(async () => state) },
      enabledPlatforms,
      engineSettings,
      loadState,
      seenSubscriptionWaits: new Set(),
      logger,
    });

    expect(loadState).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Reward success"), "twitch");
  });

  it("logs a failed tick without consuming fallback state", async () => {
    const logger = createLogger("error");
    logger.error = vi.fn();
    const loadState = vi.fn(async () => stateWithSubscriptionWait("stale"));

    await runCliTickOnce({
      controller: { tickAndHandOff: vi.fn(async () => { throw new Error("tick failed"); }) },
      enabledPlatforms,
      engineSettings,
      loadState,
      seenSubscriptionWaits: new Set(),
      logger,
    });

    expect(loadState).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("tick failed", "tick");
  });

  it("consumes the final handoff result and clears resolved subscription waits", async () => {
    const seen = new Set<string>();
    const logger = createLogger("error");
    logger.info = vi.fn();
    const tickAndHandOff = vi.fn()
      .mockResolvedValueOnce(stateWithSubscriptionWait("handoff"))
      .mockResolvedValueOnce(structuredClone(DEFAULT_STATE))
      .mockResolvedValueOnce(stateWithSubscriptionWait("handoff"));
    const options = {
      controller: { tickAndHandOff }, enabledPlatforms, engineSettings,
      loadState: vi.fn(async () => structuredClone(DEFAULT_STATE)),
      seenSubscriptionWaits: seen, logger,
    };

    await runCliTickOnce(options);
    await runCliTickOnce(options);
    await runCliTickOnce(options);

    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it("does not associate overlapping results with each other", async () => {
    const first = deferred<SchedulerState>();
    const second = deferred<SchedulerState>();
    const logger = createLogger("error");
    logger.info = vi.fn();
    const tickAndHandOff = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const options = () => ({
      controller: { tickAndHandOff }, enabledPlatforms, engineSettings,
      loadState: vi.fn(async () => structuredClone(DEFAULT_STATE)),
      seenSubscriptionWaits: new Set<string>(), logger,
    });

    const firstRun = runCliTickOnce(options());
    const secondRun = runCliTickOnce(options());
    second.resolve(stateWithSubscriptionWait("second"));
    await secondRun;
    first.resolve(stateWithSubscriptionWait("first"));
    await firstRun;

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Reward first"), "twitch");
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Reward second"), "twitch");
  });
});

describe("runLoop authentication health reporting", () => {
  it("records missing credentials without invoking the live probe", async () => {
    // If the probe ran it would report the adapter's healthy status; the missing
    // gate must win, proving credential availability precedes the probe.
    const statePath = await runOnce(
      { twitch: HEALTHY, kick: HEALTHY },
      (platform) => (platform === "twitch" ? { status: "missing" } : { status: "available" }),
    );
    const authHealth = await readAuthHealth(statePath);
    expect(authHealth.twitch).toMatchObject({ status: "missing_credentials", reasonCode: "credentials_missing" });
    expect(authHealth.kick.status).toBe("healthy");
  });

  it("reports rejected credentials from the live probe when a credential is available", async () => {
    const rejected: PlatformAuthHealth = { status: "invalid_credentials", reasonCode: "credentials_rejected", message: { key: "authInvalidCredentials" } };
    const statePath = await runOnce({ twitch: rejected, kick: HEALTHY }, () => ({ status: "available" }));
    const authHealth = await readAuthHealth(statePath);
    expect(authHealth.twitch).toMatchObject({ status: "invalid_credentials", reasonCode: "credentials_rejected" });
  });

  it("reports a transient probe failure as unavailable", async () => {
    const transient: PlatformAuthHealth = { status: "unavailable", reasonCode: "network_unavailable", message: { key: "authNetworkUnavailable" } };
    const statePath = await runOnce({ twitch: HEALTHY, kick: transient }, () => ({ status: "available" }));
    const authHealth = await readAuthHealth(statePath);
    expect(authHealth.kick).toMatchObject({ status: "unavailable", reasonCode: "network_unavailable" });
  });

  it("surfaces an unavailable credential lookup ahead of the probe", async () => {
    const statePath = await runOnce(
      { twitch: HEALTHY, kick: HEALTHY },
      (platform) => (platform === "kick" ? { status: "unavailable" } : { status: "available" }),
    );
    const authHealth = await readAuthHealth(statePath);
    expect(authHealth.kick).toMatchObject({ status: "unavailable", reasonCode: "credential_lookup_failed" });
  });
});

describe("CLI scheduler tick baseline", () => {
  it.each(["twitch", "kick"] as const)("measures isolated %s heartbeat/discovery overlap", async (platform) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");
    const existingListener = vi.fn();
    process.on("SIGINT", existingListener);
    const sigintListenersBefore = process.listeners("SIGINT");

    try {
      const result = await runCliBaselineCell(
        dir,
        platform,
        "heartbeatOverlap",
      );
      reportBaseline(result);

      expect(result.counts).toEqual({
        adapterOperations: 8,
        campaignDiscovery: 2,
        candidateListings: 2,
        channelChecks: 2,
        heartbeatAttempts: 1,
        heartbeatBlockedByDiscovery: 0,
        discoveryBlockedByHeartbeat: 0,
        // The non-once loop now performs one recovery pass for both providers
        // at startup before the first discovery completes.
        // Tick-owned adapters survive auth, discovery, and commit. Startup
        // recovery and the independent heartbeat path retain their own bundles.
        adapterConstructions: 6,
        watcherReconciliations: 1,
      });
      expect(result.durationsMs).toEqual({
        discovery: 60,
        selection: 40,
        watcher: 5,
        persistence: 0,
        total: 105,
      });
      expect(JSON.stringify(result)).not.toMatch(/credential|cookie|token|authorization|payload/i);
      expect(process.listeners("SIGINT")).toEqual(sigintListenersBefore);
    } finally {
      process.removeListener("SIGINT", existingListener);
    }
  });

  it.each(["twitch", "kick"] as const)("measures an idle %s one-shot tick", async (platform) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");
    const result = await runCliBaselineCell(dir, platform, "idle");
    reportBaseline(result);

    expect(result).toEqual({
      host: "cli",
      platform,
      scenario: "idle",
      // The stacked controller now performs five shared-engine loads in both
      // hosts; the former CLI-only post-tick reload would make this six.
      stateLoads: 5,
      stateSaves: 2,
      counts: {
        adapterOperations: 2,
        campaignDiscovery: 1,
        candidateListings: 0,
        channelChecks: 0,
        heartbeatAttempts: 0,
        heartbeatBlockedByDiscovery: 0,
        discoveryBlockedByHeartbeat: 0,
        adapterConstructions: 1,
        watcherReconciliations: 0,
      },
      durationsMs: {
        discovery: 30,
        selection: 0,
        watcher: 0,
        persistence: 0,
        total: 30,
      },
      outcomeCampaignId: undefined,
    });
  });

  it.each(["twitch", "kick"] as const)("uses the shared snapshot-driven %s selection lifecycle", async (platform) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");

    const result = await runCliBaselineCell(dir, platform, "stable");
    reportBaseline(result);

    expect(result.counts).toMatchObject({
      // Candidate listing and validation happen once while building the
      // committed discovery snapshot. Core selection adds no provider calls.
      adapterOperations: 4,
      campaignDiscovery: 1,
      candidateListings: 1,
      channelChecks: 1,
      adapterConstructions: 1,
      watcherReconciliations: 1,
    });
    expect(result.outcomeCampaignId).toBe(`${platform}-campaign`);
    expect(result.durationsMs).toEqual({
      discovery: 30,
      selection: 20,
      watcher: 5,
      persistence: 0,
      total: 55,
    });
  });

  it.each(["twitch", "kick"] as const)("attributes slow %s work with the same controlled clock", async (platform) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");

    const result = await runCliBaselineCell(dir, platform, "slow");
    reportBaseline(result);

    expect(result.durationsMs).toEqual({
      discovery: 300,
      selection: 200,
      watcher: 5,
      persistence: 0,
      total: 505,
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

    const result = await runCliBaselineCell(dir, platform, scenario);
    reportBaseline(result);

    expect(result.outcomeCampaignId).toBe(`${platform}-campaign`);

    expect(result.counts).toMatchObject({
      adapterOperations: scenario === "higherPriorityUnavailable" ? 6 : 4,
      campaignDiscovery: 1,
      candidateListings: scenario === "higherPriorityUnavailable" ? 2 : 1,
      channelChecks: scenario === "higherPriorityUnavailable" ? 2 : 1,
      adapterConstructions: 1,
      watcherReconciliations: 1,
    });
    expect(result.durationsMs).toEqual({
      discovery: 30,
      selection: scenario === "higherPriorityUnavailable" ? 40 : 20,
      watcher: 5,
      persistence: 0,
      total: scenario === "higherPriorityUnavailable" ? 75 : 55,
    });
  });

  it.each(["twitch", "kick"] as const)("measures a failed %s response", async (platform) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");

    const result = await runCliBaselineCell(dir, platform, "failed");
    reportBaseline(result);

    expect(result.counts).toMatchObject({
      adapterOperations: 2,
      campaignDiscovery: 1,
      candidateListings: 0,
      channelChecks: 0,
    });
    expect(result.durationsMs).toEqual({
      discovery: 30,
      selection: 0,
      watcher: 0,
      persistence: 0,
      total: 30,
    });
  });
});

describe("runLoop disabled platform cleanup", () => {
  it("clears a persisted watch when its platform was disabled between runs", async () => {
    const statePath = join(dir, "state.json");
    await saveState(statePath, {
      ...structuredClone(DEFAULT_STATE),
      campaigns: {
        ...DEFAULT_STATE.campaigns,
        kick: [{
          id: "stale-kick-campaign",
          platform: "kick",
          name: "Stale Kick campaign",
          status: "active",
          rewards: [{
            id: "stale-kick-reward",
            name: "Stale reward",
            requiredMinutes: 60,
            watchedMinutes: 10,
            status: "in_progress",
          }],
        }],
      },
      sessions: {
        ...DEFAULT_STATE.sessions,
        kick: {
          platform: "kick",
          status: "watching",
          offlineChecks: 0,
          campaignId: "stale-kick-campaign",
          rewardId: "stale-kick-reward",
          channel: { platform: "kick", username: "stale", url: "https://kick.com/stale" },
          watchMode: "tabless",
        },
      },
    });
    const settings = {
      ...DEFAULT_CLI_SETTINGS,
      platform: {
        twitch: { ...DEFAULT_CLI_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_CLI_SETTINGS.platform.kick, enabled: false },
      },
    };

    await runLoop({
      settings,
      statePath,
      transport: await fakeTransport({ twitch: HEALTHY, kick: HEALTHY }),
      logger: createLogger("error"),
      once: true,
      checkCredentialAvailability: async () => ({ status: "available" }),
    });

    const state = JSON.parse(await readFile(statePath, "utf8")) as SchedulerState;
    expect(state.campaigns.kick).toEqual([]);
    expect(state.sessions.kick).toMatchObject({
      status: "paused",
      reasonCode: "platform_disabled",
    });
    expect(state.sessions.kick.channel).toBeUndefined();
  });
});

describe("runLoop interval baseline", () => {
  it("serializes provider discovery with at most one coalesced follow-up", async () => {
    vi.useFakeTimers();
    const pendingRefresh = deferred<DropCampaign[]>();
    let refreshCalls = 0;
    const twitch = fakeAdapter("twitch", HEALTHY);
    twitch.refreshCampaigns = vi.fn(async () => {
      refreshCalls += 1;
      return refreshCalls === 1 ? [] : pendingRefresh.promise;
    });
    const kick = fakeAdapter("kick", HEALTHY);
    const transport: TransportHandle = {
      adapters: { twitch, kick },
      createAdapter: (platform) => ({
        adapter: platform === "twitch" ? twitch : kick,
        ...resolveCompatibility(DEFAULT_CLI_SETTINGS.compatibility, { host: "cli", twitchIdentity: "web" }),
      }),
      createAdapters: () => ({
        adapters: { twitch, kick },
        ...resolveCompatibility(DEFAULT_CLI_SETTINGS.compatibility, { host: "cli", twitchIdentity: "web" }),
      }),
      dispose: vi.fn(async () => undefined),
    };
    const settings = {
      ...DEFAULT_CLI_SETTINGS,
      pollIntervalMinutes: 1,
      platform: {
        twitch: { ...DEFAULT_CLI_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_CLI_SETTINGS.platform.kick, enabled: false },
      },
    };

    const running = runLoop({
      settings,
      statePath: join(dir, "interval-state.json"),
      transport,
      logger: createLogger("error"),
      checkCredentialAvailability: async () => ({ status: "available" }),
    });
    await vi.waitFor(() => expect(refreshCalls).toBe(1));

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(refreshCalls).toBe(2));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshCalls).toBe(2);

    pendingRefresh.resolve([]);
    await vi.waitFor(() => expect(refreshCalls).toBe(3));
    process.emit("SIGTERM");
    await running;
  });
});

const HEARTBEAT_TEST_START = new Date("2026-09-02T12:00:00.000Z");
const HEARTBEAT_TEST_CHANNEL: ChannelCandidate = {
  platform: "twitch",
  username: "heartbeat-creator",
  url: "https://www.twitch.tv/heartbeat-creator",
  broadcastId: "heartbeat-broadcast",
};
const HEARTBEAT_TEST_CAMPAIGN: DropCampaign = {
  id: "heartbeat-campaign",
  platform: "twitch",
  name: "Heartbeat campaign",
  status: "active",
  rewards: [{
    id: "heartbeat-reward",
    name: "Heartbeat reward",
    requiredMinutes: 60,
    watchedMinutes: 10,
    status: "in_progress",
  }],
};

function fakeHeartbeatWatcher(
  tick: () => Promise<HeartbeatResult> = async () => ({ ok: true, live: true }),
): TablessWatchController & { tick: ReturnType<typeof vi.fn> } {
  const watcher = {
    platform: "twitch" as const,
    channelUrl: undefined as string | undefined,
    start: vi.fn(async (channel: ChannelCandidate) => {
      watcher.channelUrl = channel.url;
    }),
    tick: vi.fn(tick),
    drainEvents: vi.fn(() => []),
    stop: vi.fn(async () => {
      watcher.channelUrl = undefined;
    }),
  };
  return watcher;
}

interface HeartbeatDriverHarnessOptions {
  refreshCampaigns?: (call: number) => Promise<DropCampaign[]>;
  heartbeat?: () => Promise<HeartbeatResult>;
  dispose?: () => Promise<void>;
  beforeCreateAdapter?: (platform: Platform) => void;
  logger?: Logger;
  once?: boolean;
}

async function startHeartbeatDriver(options: HeartbeatDriverHarnessOptions = {}) {
  const statePath = join(dir, "heartbeat-driver-state.json");
  const session: WatchSession = {
    platform: "twitch",
    status: "watching",
    offlineChecks: 0,
    watchMode: "tabless",
    channel: HEARTBEAT_TEST_CHANNEL,
    campaignId: HEARTBEAT_TEST_CAMPAIGN.id,
    rewardId: HEARTBEAT_TEST_CAMPAIGN.rewards[0]!.id,
  };
  const contextKey = heartbeatContextKey(session);
  if (!contextKey) throw new Error("Expected a complete heartbeat test session");
  session.tablessHeartbeat = {
    generation: 1,
    contextKey,
    nextDueAt: new Date(HEARTBEAT_TEST_START.getTime() + 60_000).toISOString(),
  };
  await saveState(statePath, {
    ...structuredClone(DEFAULT_STATE),
    authHealth: {
      ...DEFAULT_STATE.authHealth,
      twitch: HEALTHY,
    },
    campaigns: {
      ...DEFAULT_STATE.campaigns,
      twitch: [HEARTBEAT_TEST_CAMPAIGN],
    },
    sessions: {
      ...DEFAULT_STATE.sessions,
      twitch: session,
    },
  });

  let refreshCalls = 0;
  const watcher = fakeHeartbeatWatcher(options.heartbeat);
  const twitch = fakeAdapter("twitch", HEALTHY);
  twitch.supportsTabless = true;
  twitch.createTablessWatcher = () => watcher;
  twitch.refreshCampaigns = vi.fn(async () => {
    refreshCalls += 1;
    return options.refreshCampaigns?.(refreshCalls) ?? [HEARTBEAT_TEST_CAMPAIGN];
  });
  twitch.checkChannel = vi.fn(async (candidate: ChannelCandidate): Promise<ChannelCheck> => ({
    live: true,
    categoryMatches: true,
    campaignMatches: true,
    candidate,
  }));
  const kick = fakeAdapter("kick", HEALTHY);
  const compatibility = resolveCompatibility(
    DEFAULT_CLI_SETTINGS.compatibility,
    { host: "cli", twitchIdentity: "web" },
  );
  const adapterFor = (platform: Platform): PlatformAdapter =>
    platform === "twitch" ? twitch : kick;
  const transport: TransportHandle = {
    adapters: { twitch, kick },
    createAdapter: (platform) => {
      options.beforeCreateAdapter?.(platform);
      return { adapter: adapterFor(platform), ...compatibility };
    },
    createAdapters: () => ({ adapters: { twitch, kick }, ...compatibility }),
    dispose: vi.fn(options.dispose ?? (async () => undefined)),
  };
  const settings = {
    ...DEFAULT_CLI_SETTINGS,
    pollIntervalMinutes: 7,
    platform: {
      twitch: { ...DEFAULT_CLI_SETTINGS.platform.twitch, enabled: true },
      kick: { ...DEFAULT_CLI_SETTINGS.platform.kick, enabled: false },
    },
  };
  const running = runLoop({
    settings,
    statePath,
    transport,
    logger: options.logger ?? createLogger("error"),
    checkCredentialAvailability: async () => ({ status: "available" }),
    ...(options.once ? { once: true } : {}),
  });
  await vi.waitFor(() => expect(twitch.refreshCampaigns).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(watcher.start).toHaveBeenCalledOnce());
  return { running, statePath, transport, twitch, watcher };
}

describe("runLoop heartbeat driver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(HEARTBEAT_TEST_START);
  });

  it("attempts heartbeats every minute independently of the seven-minute discovery period", async () => {
    const { running, twitch, watcher } = await startHeartbeatDriver();
    try {
      expect(watcher.tick).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(watcher.tick).toHaveBeenCalledTimes(1));
      expect(twitch.refreshCampaigns).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(watcher.tick).toHaveBeenCalledTimes(2));
      expect(twitch.refreshCampaigns).toHaveBeenCalledTimes(1);
    } finally {
      process.emit("SIGTERM");
      await running;
    }
  });

  it("recovers a due heartbeat before the first discovery finishes and still shuts down", async () => {
    const blockedDiscovery = deferred<DropCampaign[]>();
    vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));
    const { running, transport, twitch, watcher } = await startHeartbeatDriver({
      refreshCampaigns: async () => blockedDiscovery.promise,
    });

    expect(twitch.refreshCampaigns).toHaveBeenCalledOnce();
    expect(watcher.tick).toHaveBeenCalledOnce();

    process.emit("SIGTERM");
    await running;
    expect(transport.dispose).toHaveBeenCalledOnce();

    blockedDiscovery.resolve([HEARTBEAT_TEST_CAMPAIGN]);
  });

  it("attempts a due heartbeat while discovery is blocked", async () => {
    const blockedDiscovery = deferred<DropCampaign[]>();
    const { running, statePath, twitch, watcher } = await startHeartbeatDriver({
      refreshCampaigns: async (call) => call === 1
        ? [HEARTBEAT_TEST_CAMPAIGN]
        : blockedDiscovery.promise,
    });
    try {
      for (let minute = 1; minute <= 6; minute += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => expect(watcher.tick).toHaveBeenCalledTimes(minute));
        await vi.waitFor(async () => {
          const state = JSON.parse(await readFile(statePath, "utf8")) as SchedulerState;
          expect(state.sessions.twitch.tablessHeartbeat?.nextDueAt).toBe(
            new Date(HEARTBEAT_TEST_START.getTime() + (minute + 1) * 60_000).toISOString(),
          );
        });
      }

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(twitch.refreshCampaigns).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(watcher.tick).toHaveBeenCalledTimes(7));
      await vi.waitFor(async () => {
        const state = JSON.parse(await readFile(statePath, "utf8")) as SchedulerState;
        expect(Date.parse(state.sessions.twitch.lastHeartbeatAt ?? "")).toBeGreaterThanOrEqual(
          HEARTBEAT_TEST_START.getTime() + 7 * 60_000,
        );
      });
    } finally {
      blockedDiscovery.resolve([HEARTBEAT_TEST_CAMPAIGN]);
      await vi.waitFor(async () => {
        const state = JSON.parse(await readFile(statePath, "utf8")) as SchedulerState;
        expect(Date.parse(state.sessions.twitch.lastCheckedAt ?? "")).toBeGreaterThanOrEqual(
          HEARTBEAT_TEST_START.getTime() + 7 * 60_000,
        );
        expect(state.sessions.twitch.tablessHeartbeat?.nextDueAt).toBe(
          new Date(HEARTBEAT_TEST_START.getTime() + 8 * 60_000).toISOString(),
        );
      });
      process.emit("SIGTERM");
      await running;
    }
  });

  it("runs seven-minute discovery while a heartbeat is blocked", async () => {
    const blockedHeartbeat = deferred<HeartbeatResult>();
    const { running, statePath, twitch, watcher } = await startHeartbeatDriver({
      heartbeat: () => blockedHeartbeat.promise,
    });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(watcher.tick).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(6 * 60_000);
      await vi.waitFor(() => expect(twitch.refreshCampaigns).toHaveBeenCalledTimes(2));
      expect(watcher.tick).toHaveBeenCalledOnce();
    } finally {
      blockedHeartbeat.resolve({ ok: true, live: true });
      await vi.waitFor(async () => {
        const state = JSON.parse(await readFile(statePath, "utf8")) as SchedulerState;
        expect(state.sessions.twitch.lastHeartbeatOk).toBe(true);
      });
      process.emit("SIGTERM");
      await running;
    }
  });

  it("logs heartbeat driver errors independently and continues discovery", async () => {
    let failAdapterCreation = false;
    const logger: Logger = {
      level: "debug",
      log: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { running, twitch, watcher } = await startHeartbeatDriver({
      logger,
      beforeCreateAdapter: (platform) => {
        if (failAdapterCreation && platform === "twitch") {
          throw new Error("heartbeat adapter failed");
        }
      },
    });
    try {
      failAdapterCreation = true;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(
        "heartbeat adapter failed",
        "heartbeat",
      ));
      expect(watcher.tick).not.toHaveBeenCalled();

      failAdapterCreation = false;
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      await vi.waitFor(() => expect(twitch.refreshCampaigns).toHaveBeenCalledTimes(2));
      expect(logger.error).not.toHaveBeenCalledWith(expect.any(String), "tick");
    } finally {
      process.emit("SIGTERM");
      await running;
    }
  });

  it("clears both recurring drivers before transport disposal on SIGTERM", async () => {
    const disposeStarted = deferred<void>();
    const finishDispose = deferred<void>();
    const timerCountsAtDispose: number[] = [];
    const { running, twitch, watcher } = await startHeartbeatDriver({
      dispose: async () => {
        timerCountsAtDispose.push(vi.getTimerCount());
        disposeStarted.resolve();
        await finishDispose.promise;
      },
    });

    expect(vi.getTimerCount()).toBe(2);
    process.emit("SIGTERM");
    await disposeStarted.promise;
    expect(timerCountsAtDispose).toEqual([0]);

    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(twitch.refreshCampaigns).toHaveBeenCalledTimes(1);
    expect(watcher.tick).not.toHaveBeenCalled();

    finishDispose.resolve();
    await running;
  });

  it("removes only its own SIGINT and SIGTERM listeners after shutdown", async () => {
    const existingSigint = vi.fn();
    const existingSigterm = vi.fn();
    process.on("SIGINT", existingSigint);
    process.on("SIGTERM", existingSigterm);
    const sigintListenersBefore = process.listeners("SIGINT");
    const sigtermListenersBefore = process.listeners("SIGTERM");
    const removeRunListeners = () => {
      for (const listener of process.listeners("SIGINT")) {
        if (!sigintListenersBefore.includes(listener)) process.removeListener("SIGINT", listener);
      }
      for (const listener of process.listeners("SIGTERM")) {
        if (!sigtermListenersBefore.includes(listener)) process.removeListener("SIGTERM", listener);
      }
    };

    try {
      const { running } = await startHeartbeatDriver();
      process.emit("SIGTERM");
      await running;

      expect(process.listeners("SIGINT")).toEqual(sigintListenersBefore);
      expect(process.listeners("SIGTERM")).toEqual(sigtermListenersBefore);
      expect(existingSigterm).toHaveBeenCalledOnce();
      expect(existingSigint).not.toHaveBeenCalled();
    } finally {
      removeRunListeners();
      process.removeListener("SIGINT", existingSigint);
      process.removeListener("SIGTERM", existingSigterm);
    }
  });

  it("removes only its own signal listeners when shutdown disposal rejects", async () => {
    const existingSigint = vi.fn();
    const existingSigterm = vi.fn();
    process.on("SIGINT", existingSigint);
    process.on("SIGTERM", existingSigterm);
    const sigintListenersBefore = process.listeners("SIGINT");
    const sigtermListenersBefore = process.listeners("SIGTERM");
    const disposeStarted = deferred<void>();
    const removeRunListeners = () => {
      for (const listener of process.listeners("SIGINT")) {
        if (!sigintListenersBefore.includes(listener)) process.removeListener("SIGINT", listener);
      }
      for (const listener of process.listeners("SIGTERM")) {
        if (!sigtermListenersBefore.includes(listener)) process.removeListener("SIGTERM", listener);
      }
    };

    try {
      const { running } = await startHeartbeatDriver({
        dispose: async () => {
          disposeStarted.resolve();
          throw new Error("transport disposal failed");
        },
      });
      const settlement = running.then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );

      process.emit("SIGTERM");
      await disposeStarted.promise;
      await Promise.resolve();
      await Promise.resolve();

      expect(await Promise.race([
        settlement,
        Promise.resolve({ status: "pending" as const }),
      ])).toEqual({
        status: "rejected",
        error: expect.objectContaining({ message: "transport disposal failed" }),
      });
      expect(process.listeners("SIGINT")).toEqual(sigintListenersBefore);
      expect(process.listeners("SIGTERM")).toEqual(sigtermListenersBefore);
      expect(existingSigterm).toHaveBeenCalledOnce();
      expect(existingSigint).not.toHaveBeenCalled();
    } finally {
      removeRunListeners();
      process.removeListener("SIGINT", existingSigint);
      process.removeListener("SIGTERM", existingSigterm);
    }
  });

  it("runs one discovery tick without starting recurring drivers in once mode", async () => {
    const { running, transport, twitch, watcher } = await startHeartbeatDriver({ once: true });
    await running;

    expect(twitch.refreshCampaigns).toHaveBeenCalledOnce();
    expect(watcher.tick).not.toHaveBeenCalled();
    expect(transport.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
