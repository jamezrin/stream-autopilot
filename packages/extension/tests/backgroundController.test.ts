import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALARM_NAME,
  createBackgroundController,
  KICK_ALARM_NAME,
  TWITCH_ALARM_NAME,
  TWITCH_CHANNEL_POINTS_ALARM_NAME,
  TWITCH_INTEGRITY_ALARM_NAME,
  type BackgroundControllerDeps,
  type CredentialAvailability,
} from "@lurkloot/core/controller";
import { resolveCompatibility } from "@lurkloot/core";
import { heartbeatContextKey } from "@lurkloot/core/heartbeatCadence";
import type { ChannelCandidate, DropCampaign, DropReward, ExtensionSettings, Platform, PlatformAuthHealth, SchedulerState, WatchSession } from "@lurkloot/shared/models";
import type { DiagnosticEvent, EngineEvent, EventEmitter } from "@lurkloot/shared/events";
import type { RuntimeSnapshot } from "@lurkloot/shared/messages";
import { applySettingsPatch, DEFAULT_SETTINGS, isFarmingActive } from "@lurkloot/shared/settings";
import { DEFAULT_STATE } from "../src/core/storage";
import type { PageFetcher, PlatformAdapter } from "@lurkloot/core/adapter";
import { createKickFetcher, KickClaimState, KickDiscoveryState } from "@lurkloot/core/kick";
import { TwitchDiscoveryState } from "@lurkloot/core/twitch";
import { kickAdapter, twitchAdapter } from "./helpers/adapters";
import type { TablessWatchController } from "@lurkloot/core/tablessWatch";
import { selectWatchTargetFromSnapshot, type StopPageContextTabs } from "@lurkloot/core/scheduler";
import {
  cancelTwitchIntegrityAcquisition,
  currentManagedPageContextTabs,
  currentValidTwitchIntegrity,
  ensureTwitchIntegrityWithBrowser,
  forgetManagedPageContextTabs,
  KickWafBlockedError,
  managedTabBreakerOpen,
  recordManagedPageContextFallback,
  registerManagedPageContextTabs,
  resetTwitchIntegrityRefreshBounds,
  setTwitchIntegrity,
  syncManagedTabBreakers,
  type BrowserTabApi,
  type TwitchIntegrityRequest,
} from "@lurkloot/core/tabs";
import { TAB_CHURN_LIMIT } from "@lurkloot/core/criticalHealth";
import type { IntegrityHeader, TwitchIntegrity } from "@lurkloot/core/twitchIntegrity";
import type { DiscoverySignalController, DiscoverySignalTarget } from "@lurkloot/core/discoverySignals";

const reward = (status: DropReward["status"] = "in_progress"): DropReward => ({
  id: "reward",
  name: "Reward",
  requiredMinutes: 60,
  watchedMinutes: 10,
  status,
});

const campaign = (platform: Platform, rewardStatus: DropReward["status"] = "in_progress"): DropCampaign => ({
  id: `${platform}-campaign`,
  platform,
  name: `${platform} campaign`,
  status: "active",
  rewards: [reward(rewardStatus)],
});

const channel = (platform: Platform, patch: Partial<ChannelCandidate> = {}): ChannelCandidate => ({
  platform,
  username: `${platform}-creator`,
  url: platform === "twitch" ? "https://www.twitch.tv/twitch-creator" : "https://kick.com/kick-creator",
  ...patch,
});

class FakeDiscoverySignalController implements DiscoverySignalController {
  readonly platform: Platform;
  targetKey: string | undefined;
  starts: DiscoverySignalTarget[] = [];
  stops = 0;
  private onSignal?: () => void;
  private readonly capturedSignals: Array<() => void> = [];
  private readonly events: DiagnosticEvent[] = [];

  constructor(platform: Platform) {
    this.platform = platform;
  }

  async start(target: DiscoverySignalTarget, onSignal: () => void): Promise<void> {
    this.starts.push(target);
    this.targetKey = target.channel.categoryId;
    this.onSignal = onSignal;
    this.capturedSignals.push(onSignal);
  }

  emitSignal(): void {
    this.onSignal?.();
  }

  emitCapturedSignal(index = 0): void {
    this.capturedSignals[index]?.();
  }

  pushDiagnostic(message: string): void {
    this.events.push({ category: "diagnostic", platform: this.platform, level: "warn", message });
  }

  drainEvents(): DiagnosticEvent[] {
    return this.events.splice(0);
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.targetKey = undefined;
    this.onSignal = undefined;
  }
}

function asSnapshot(value: unknown): RuntimeSnapshot {
  return value as RuntimeSnapshot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function integrityBundle(overrides: Partial<TwitchIntegrity> = {}): TwitchIntegrity {
  return {
    integrity: "test-integrity-token",
    clientSessionId: "test-session",
    deviceId: "test-device",
    expiresAt: Date.now() + 30 * 60_000,
    ...overrides,
  };
}

function integrityHeaders(integrity: TwitchIntegrity): IntegrityHeader[] {
  return [
    { name: "Client-Integrity", value: integrity.integrity },
    { name: "Client-Session-Id", value: integrity.clientSessionId },
    { name: "X-Device-Id", value: integrity.deviceId },
  ];
}

// `running: true` used to be what made a fixture farm; with the master switch
// gone, farming means the platform flags are on. DEFAULT_SETTINGS now ships them
// off (a fresh install sits idle), so fixtures opt in explicitly. Both wrappers
// apply last so they win over any platform block in the literal they wrap.
function farming<T extends ExtensionSettings>(settings: T): T {
  return withPlatformsEnabled(settings, true);
}

function notFarming<T extends ExtensionSettings>(settings: T): T {
  return withPlatformsEnabled(settings, false);
}

function withPlatformsEnabled<T extends ExtensionSettings>(settings: T, enabled: boolean): T {
  return {
    ...settings,
    platform: {
      ...settings.platform,
      twitch: { ...settings.platform.twitch, enabled },
      kick: { ...settings.platform.kick, enabled },
    },
  };
}

function adapter(platform: Platform): PlatformAdapter {
  return {
    platform,
    checkAuthHealth: vi.fn(async () => ({ status: "healthy" as const })),
    refreshCampaigns: vi.fn(async () => [campaign(platform)]),
    listCandidateChannels: vi.fn(async () => [channel(platform)]),
    checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
    claimReward: vi.fn(async () => true),
    prepareWatchTab: vi.fn(async () => ({ tabId: platform === "twitch" ? 10 : 20, managedByExtension: true })),
    stopWatchTab: vi.fn(async () => undefined),
  };
}

function twitchOperation(init?: RequestInit): string {
  return JSON.parse(String(init?.body)).operationName;
}

function twitchInventory(): unknown {
  return {
    data: {
      currentUser: {
        id: "user-id",
        inventory: { dropCampaignsInProgress: [] },
      },
    },
  };
}

function twitchDashboard(campaignIds: string[]): unknown {
  return {
    data: {
      currentUser: {
        id: "user-id",
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

function harness(
  settings: ExtensionSettings = farming(DEFAULT_SETTINGS),
  overrides: {
    saveState?: (state: SchedulerState) => Promise<void>;
    reportEvents?: (events: readonly EngineEvent[]) => Promise<void>;
    stopPageContextTabs?: StopPageContextTabs;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    checkCredentialAvailability?: (platform: Platform) => Promise<CredentialAvailability>;
    authProbeTimeoutMs?: number;
    loadTwitchIntegrity?: () => Promise<TwitchIntegrity | undefined>;
    saveTwitchIntegrity?: (value: TwitchIntegrity) => Promise<void>;
    saveSettings?: (value: ExtensionSettings) => Promise<void>;
    createAlarm?: (
      name: string,
      options: { periodInMinutes: number } | { when: number },
    ) => Promise<void>;
    getAlarm?: (name: string) => Promise<{ scheduledTime: number } | undefined>;
    clearAlarm?: (name: string) => Promise<boolean>;
    ensureTwitchIntegrity?: (
      emit: EventEmitter,
      request?: TwitchIntegrityRequest,
    ) => Promise<boolean>;
    cancelTwitchIntegrityAcquisition?: (reason?: unknown) => void;
    selectWatchTarget?: BackgroundControllerDeps<ExtensionSettings>["selectWatchTarget"];
    initialState?: SchedulerState;
  } = {},
) {
  let currentSettings = settings;
  let currentState: SchedulerState = overrides.initialState ?? {
    ...DEFAULT_STATE,
    sessions: {
      twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
      kick: { platform: "kick", status: "idle", offlineChecks: 0 },
    },
  };
  const twitch = adapter("twitch");
  const kick = adapter("kick");
  const discoverySignalController = new FakeDiscoverySignalController("kick");
  const discoverySignalFactory = vi.fn(() => discoverySignalController);
  kick.createDiscoverySignalController = discoverySignalFactory;
  const reportEvents = vi.fn<(events: readonly EngineEvent[]) => Promise<void>>(async () => undefined);
  const deps = {
    loadSettings: vi.fn(async () => currentSettings),
    saveSettings: vi.fn(async (next: ExtensionSettings) => {
      await overrides.saveSettings?.(next);
      currentSettings = next;
    }),
    loadState: vi.fn(async () => currentState),
    saveState: vi.fn(overrides.saveState ?? (async (next: SchedulerState) => {
      currentState = next;
    })),
    createAlarm: vi.fn(overrides.createAlarm ?? (async (
      _name: string,
      _options: { periodInMinutes: number } | { when: number },
    ) => undefined)),
    getAlarm: vi.fn(overrides.getAlarm ?? (async () => undefined)),
    clearAlarm: vi.fn(overrides.clearAlarm ?? (async () => true)),
    ensureTwitchIntegrity: vi.fn(overrides.ensureTwitchIntegrity ?? (async () => true)),
    cancelTwitchIntegrityAcquisition: vi.fn(overrides.cancelTwitchIntegrityAcquisition ?? (() => undefined)),
    createNotification: vi.fn(async () => undefined),
    closeManagedTabs: vi.fn(async () => undefined),
    applyAdFocus: vi.fn<(platform: Platform, tabId: number | undefined, adActive: boolean, emit: EventEmitter) => Promise<void>>(async () => undefined),
    // Host-owned tab policy + settings-patch application (see background.ts).
    loadTabPlaybackPolicy: vi.fn(async () => ({ keepVideosUnmuted: currentSettings.keepFarmingVideosUnmuted !== false })),
    applySettingsPatch: vi.fn((current: ExtensionSettings, patch) => applySettingsPatch(current, patch)),
    createAdapters: vi.fn((_emit: EventEmitter, nextSettings: ExtensionSettings) => ({
      adapters: { twitch, kick },
      ...resolveCompatibility(nextSettings.compatibility, { host: "extension", twitchIdentity: "web" }),
    })),
    createAdapter: vi.fn((platform: Platform, _emit: EventEmitter, nextSettings: ExtensionSettings) => ({
      adapter: platform === "twitch" ? twitch : kick,
      ...resolveCompatibility(nextSettings.compatibility, { host: "extension", twitchIdentity: "web" }),
    })),
    reportEvents: vi.fn(overrides.reportEvents ?? reportEvents),
    stopPageContextTabs: vi.fn(overrides.stopPageContextTabs ?? forgetManagedPageContextTabs),
    ...(overrides.selectWatchTarget ? { selectWatchTarget: vi.fn(overrides.selectWatchTarget) } : {}),
    wait: overrides.wait,
    ...(overrides.checkCredentialAvailability
      ? { checkCredentialAvailability: vi.fn(overrides.checkCredentialAvailability) }
      : {}),
    ...(overrides.authProbeTimeoutMs === undefined
      ? {}
      : { authProbeTimeoutMs: overrides.authProbeTimeoutMs }),
    ...(overrides.loadTwitchIntegrity
      ? { loadTwitchIntegrity: vi.fn(overrides.loadTwitchIntegrity) }
      : {}),
    ...(overrides.saveTwitchIntegrity
      ? { saveTwitchIntegrity: vi.fn(overrides.saveTwitchIntegrity) }
      : {}),
  };

  const controller = createBackgroundController(deps);
  // User-action messages dispatch their scheduler tick in the background and
  // return the snapshot immediately, so the popup is never held open for a
  // network-bound tick. Tests here assert on what the tick produced, so the
  // harness settles that work before handing control back — keeping every
  // assertion about tick behavior meaningful. Tests that specifically exercise
  // the detachment use `rawHandleMessage`.
  const rawHandleMessage = controller.handleMessage;
  const handleMessage: typeof rawHandleMessage = async (message, sender) => {
    const result = await rawHandleMessage(message, sender);
    await controller.settleBackgroundWork();
    return result;
  };

  return {
    controller: { ...controller, handleMessage },
    rawController: controller,
    deps,
    get settings() {
      return currentSettings;
    },
    get state() {
      return currentState;
    },
    twitch,
    kick,
    discoverySignalController,
    discoverySignalFactory,
    reportEvents: deps.reportEvents,
  };
}

function allDiagnostics(env: ReturnType<typeof harness>): DiagnosticEvent[] {
  return env.reportEvents.mock.calls
    .flatMap(([events]) => events)
    .filter((event): event is DiagnosticEvent => event.category === "diagnostic");
}

function aggregateHeartbeatDiagnostics(
  env: ReturnType<typeof harness>,
  platform: Platform,
): string[] {
  return allDiagnostics(env)
    .filter((event) =>
      event.platform === platform
      && event.message.startsWith("Tabless heartbeat timing "))
    .map((event) => event.message);
}

function lastAggregateDiagnostic(
  env: ReturnType<typeof harness>,
  platform: Platform,
): string | undefined {
  return aggregateHeartbeatDiagnostics(env, platform).at(-1);
}

function dueHeartbeatCadence(session: WatchSession, dueAt = Date.now()) {
  const contextKey = heartbeatContextKey(session);
  if (!contextKey) throw new Error("Expected a complete tabless heartbeat context");
  return {
    generation: 1,
    contextKey,
    nextDueAt: new Date(dueAt).toISOString(),
  };
}

describe("background controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Twitch channel points alarm lifecycle", () => {
    it("creates a fixed one-minute alarm independently of the scheduler interval", async () => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, pollIntervalMinutes: 60 }));

      await env.controller.ensureAlarm();

      expect(env.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_CHANNEL_POINTS_ALARM_NAME,
        { periodInMinutes: 1 },
      );
      expect(env.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_ALARM_NAME,
        { periodInMinutes: 60 },
      );
    });

    it.each([
      { twitchEnabled: false, autoClaimChannelPoints: true },
      { twitchEnabled: true, autoClaimChannelPoints: false },
    ])("clears the alarm when a prerequisite is disabled", async ({ twitchEnabled, autoClaimChannelPoints }) => {
      const enabledSettings = farming(DEFAULT_SETTINGS);
      const env = harness({
        ...enabledSettings,
        platform: {
          ...enabledSettings.platform,
          twitch: {
            ...enabledSettings.platform.twitch,
            enabled: twitchEnabled,
            autoClaimChannelPoints,
          },
        },
      });

      await env.controller.ensureAlarm();

      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_CHANNEL_POINTS_ALARM_NAME);
      expect(env.deps.createAlarm).not.toHaveBeenCalledWith(
        TWITCH_CHANNEL_POINTS_ALARM_NAME,
        expect.anything(),
      );
    });

    it("reconciles the alarm after settings changes", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));

      await env.controller.handleMessage({
        type: "saveSettings",
        settingsPatch: { platform: { twitch: { autoClaimChannelPoints: false } } },
      });

      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_CHANNEL_POINTS_ALARM_NAME);
    });

    it("clears the alarm when startup normalization disables Twitch", async () => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: false }));

      await env.controller.handleStartup();

      expect(env.settings.platform.twitch.enabled).toBe(false);
      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_CHANNEL_POINTS_ALARM_NAME);
    });

    it("clears the alarm during reset and shutdown", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));

      await env.controller.prepareForHostReset();
      env.controller.shutdown();

      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_CHANNEL_POINTS_ALARM_NAME);
    });

    it("continues host reset when clearing the alarm fails", async () => {
      const resetHostStorage = vi.fn(async () => undefined);
      const env = harness(farming(DEFAULT_SETTINGS), {
        clearAlarm: async (name) => {
          if (name === TWITCH_CHANNEL_POINTS_ALARM_NAME) {
            throw new Error("alarm storage unavailable");
          }
          return true;
        },
      });

      await expect(env.controller.prepareForHostReset(resetHostStorage)).resolves.toBeUndefined();

      expect(resetHostStorage).toHaveBeenCalledOnce();
      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        platform: "twitch",
        level: "warn",
        message: "Could not clear the Twitch channel-points alarm",
      }));
    });

    it("contains alarm cleanup failures during shutdown", async () => {
      const env = harness(farming(DEFAULT_SETTINGS), {
        clearAlarm: async (name) => {
          if (name === TWITCH_CHANNEL_POINTS_ALARM_NAME) {
            throw new Error("alarm storage unavailable");
          }
          return true;
        },
      });

      env.controller.shutdown();

      await vi.waitFor(() => expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        platform: "twitch",
        level: "warn",
        message: "Could not clear the Twitch channel-points alarm",
      })));
    });
  });

  describe("Twitch channel points claim-only operation", () => {
    it("claims for a recent manual channel without changing the paused session", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      const manualChannel = channel("twitch", { username: "manual-creator", url: "https://www.twitch.tv/manual-creator" });
      env.state.authHealth = {
        ...env.state.authHealth,
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "paused",
        channel: channel("twitch", { username: "old-managed" }),
        offlineChecks: 0,
        reasonCode: "manual_watch",
        message: "Manual watch detected",
      };
      env.state.manualWatch = {
        twitch: {
          platform: "twitch",
          tabId: 91,
          checkedAt: new Date().toISOString(),
          active: true,
          channel: manualChannel,
        },
      };
      const beforeSession = structuredClone(env.state.sessions.twitch);
      env.twitch.claimChannelPoints = vi.fn(async () => true);

      await env.controller.runTwitchChannelPointsClaim();

      expect(env.twitch.claimChannelPoints).toHaveBeenCalledOnce();
      expect(env.twitch.claimChannelPoints).toHaveBeenCalledWith(manualChannel);
      expect(env.state.sessions.twitch).toEqual(beforeSession);
      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        platform: "twitch",
        level: "info",
        message: "Claimed channel points for manual-creator",
      }));
    });

    it.each(["tab", "tabless"] as const)("claims for a managed %s watch session", async (watchMode) => {
      const env = harness(farming(DEFAULT_SETTINGS));
      const managedChannel = channel("twitch");
      env.state.authHealth = {
        ...env.state.authHealth,
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "watching",
        channel: managedChannel,
        offlineChecks: 0,
        watchMode,
      };
      env.twitch.claimChannelPoints = vi.fn(async () => false);

      await env.controller.runTwitchChannelPointsClaim();

      expect(env.twitch.claimChannelPoints).toHaveBeenCalledOnce();
      expect(env.twitch.claimChannelPoints).toHaveBeenCalledWith(managedChannel);
      expect(allDiagnostics(env).some((event) => event.message.includes("Claimed channel points"))).toBe(false);
    });

    it.each([
      { name: "Twitch is disabled", enabled: false, autoClaim: true, authStatus: "healthy", manual: "recent" },
      { name: "auto-claim is disabled", enabled: true, autoClaim: false, authStatus: "healthy", manual: "recent" },
      { name: "authentication is unknown", enabled: true, autoClaim: true, authStatus: "unknown", manual: "recent" },
      { name: "authentication is unhealthy", enabled: true, autoClaim: true, authStatus: "unhealthy", manual: "recent" },
      { name: "manual telemetry is stale", enabled: true, autoClaim: true, authStatus: "healthy", manual: "stale" },
      { name: "manual telemetry is inactive", enabled: true, autoClaim: true, authStatus: "healthy", manual: "inactive" },
      { name: "the manual channel is unidentified", enabled: true, autoClaim: true, authStatus: "healthy", manual: "unidentified" },
    ] as const)("makes no request when $name", async ({ enabled, autoClaim, authStatus, manual }) => {
      const enabledSettings = farming(DEFAULT_SETTINGS);
      const env = harness({
        ...enabledSettings,
        platform: {
          ...enabledSettings.platform,
          twitch: {
            ...enabledSettings.platform.twitch,
            enabled,
            autoClaimChannelPoints: autoClaim,
          },
        },
      });
      env.state.authHealth = {
        ...env.state.authHealth,
        twitch: {
          status: authStatus,
          checkedAt: new Date().toISOString(),
          ...(authStatus === "unhealthy" ? { reason: "signed out" } : {}),
        } as PlatformAuthHealth,
      };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "paused",
        offlineChecks: 0,
        reasonCode: "manual_watch",
      };
      env.state.manualWatch = {
        twitch: {
          platform: "twitch",
          tabId: 91,
          checkedAt: new Date(manual === "stale" ? Date.now() - 120_000 : Date.now()).toISOString(),
          active: manual !== "inactive",
          ...(manual === "unidentified" ? {} : { channel: channel("twitch") }),
        },
      };
      env.twitch.claimChannelPoints = vi.fn(async () => true);

      await env.controller.runTwitchChannelPointsClaim();

      expect(env.twitch.claimChannelPoints).not.toHaveBeenCalled();
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
      expect(env.twitch.stopWatchTab).not.toHaveBeenCalled();
    });

    it("reports claim failures without changing scheduler state or starting other work", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      env.state.authHealth = {
        ...env.state.authHealth,
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "watching",
        channel: channel("twitch"),
        offlineChecks: 2,
        errorChecks: 3,
        retryAfter: "2026-12-09T23:59:00.000Z",
        heartbeatChecks: 4,
        lastHeartbeatOk: false,
        tablessFallback: true,
        watchMode: "tabless",
      };
      const before = structuredClone(env.state);
      env.twitch.claimChannelPoints = vi.fn(async () => {
        throw new Error("Channel points lookup failed");
      });

      await env.controller.runTwitchChannelPointsClaim();

      expect(env.state).toEqual(before);
      expect(env.deps.saveState).not.toHaveBeenCalled();
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
      expect(env.twitch.stopWatchTab).not.toHaveBeenCalled();
      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        platform: "twitch",
        level: "warn",
        message: "Channel points lookup failed",
      }));
    });

    it("does not fall back to a managed channel during unidentified active manual playback", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      env.state.authHealth = {
        ...env.state.authHealth,
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "watching",
        channel: channel("twitch", { username: "stale-managed" }),
        offlineChecks: 0,
        watchMode: "tab",
      };
      env.state.manualWatch = {
        twitch: {
          platform: "twitch",
          tabId: 91,
          checkedAt: new Date().toISOString(),
          active: true,
        },
      };
      env.twitch.claimChannelPoints = vi.fn(async () => true);

      await env.controller.runTwitchChannelPointsClaim();

      expect(env.twitch.claimChannelPoints).not.toHaveBeenCalled();
    });

    it("serializes repeated claims and normal Twitch scheduler work", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      env.state.authHealth = {
        ...env.state.authHealth,
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "watching",
        channel: channel("twitch"),
        offlineChecks: 0,
        watchMode: "tab",
      };
      const firstClaim = deferred<boolean>();
      let concurrentClaims = 0;
      let maxConcurrentClaims = 0;
      env.twitch.claimChannelPoints = vi.fn(async () => {
        concurrentClaims += 1;
        maxConcurrentClaims = Math.max(maxConcurrentClaims, concurrentClaims);
        const result = await firstClaim.promise;
        concurrentClaims -= 1;
        return result;
      });

      const first = env.controller.runTwitchChannelPointsClaim();
      await vi.waitFor(() => expect(env.twitch.claimChannelPoints).toHaveBeenCalledOnce());
      const second = env.controller.runTwitchChannelPointsClaim();
      const tick = env.controller.tick(["twitch"]);
      await Promise.resolve();

      expect(env.twitch.claimChannelPoints).toHaveBeenCalledOnce();
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
      firstClaim.resolve(false);
      await Promise.all([first, second, tick]);

      expect(maxConcurrentClaims).toBe(1);
      expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    });
  });

  it("attributes Kick discovery duration, skipped inventory and unique channel checks", async () => {
    const env = harness();
    vi.mocked(env.kick.refreshCampaigns).mockResolvedValue([
      campaign("kick"),
      { ...campaign("kick"), id: "expired", status: "expired" },
    ]);
    env.kick.checkChannels = async (requests) => ({
      checks: requests.map(({ channel: candidate }) => ({ candidate, live: true, categoryMatches: true })),
      uniqueChannelChecks: 1,
    });
    await env.controller.tick(["kick"]);
    const diagnostic = allDiagnostics(env).find((event) => event.platform === "kick" && event.message.startsWith("Discovery refresh finished"));
    expect(diagnostic?.message).toMatch(/finished in \d+ms/);
    expect(diagnostic?.message).toContain("campaigns=2");
    expect(diagnostic?.message).toContain("skipped before channel work=1");
    expect(diagnostic?.message).toContain("unique channel checks=1");
    expect(env.state.campaigns.kick).toHaveLength(2);
  });

  it("labels unavailable discovery counters after failure instead of reporting zero work", async () => {
    const env = harness();
    vi.mocked(env.kick.checkChannel).mockRejectedValue(new Error("channel unavailable"));
    await env.controller.tick(["kick"]);
    const diagnostic = allDiagnostics(env).find((event) => event.platform === "kick" && event.message.startsWith("Discovery refresh finished"));
    expect(env.kick.listCandidateChannels).toHaveBeenCalled();
    expect(diagnostic?.message).toContain("work metrics=unavailable");
    expect(diagnostic?.message).not.toContain("campaigns=0");
    expect(diagnostic?.message).not.toContain("candidates=0");
  });

  describe("Twitch integrity expiry scheduling", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
      setTwitchIntegrity(undefined);
    });

    afterEach(() => {
      setTwitchIntegrity(undefined);
      vi.useRealTimers();
    });

    it("schedules integrity refresh from token expiry with stable bounded jitter", async () => {
      const integrity = integrityBundle({
        integrity: "stable-test-token",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });

      await env.controller.settleBackgroundWork();

      const calls = env.deps.createAlarm.mock.calls.filter(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      );
      expect(calls).toHaveLength(1);
      const when = (calls[0][1] as { when: number }).when;
      expect(when).toBeLessThanOrEqual(integrity.expiresAt - 120_000);
      expect(when).toBeGreaterThanOrEqual(integrity.expiresAt - 150_000);
    });

    it("ignores an expired stored token and reports why", async () => {
      const integrity = integrityBundle({
        integrity: "expired-test-token",
        expiresAt: Date.now() - 1,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });

      await env.controller.settleBackgroundWork();

      expect(env.deps.createAlarm.mock.calls.some(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )).toBe(false);
      const events = env.reportEvents.mock.calls.flatMap(([batch]) => batch);
      expect(events).toContainEqual(expect.objectContaining({
        category: "diagnostic",
        platform: "twitch",
        level: "debug",
        message: expect.stringContaining("expired"),
      }));
    });

    it("persists a captured replacement and replaces its one-shot schedule", async () => {
      const stored = integrityBundle({
        integrity: "stored-test-token",
        expiresAt: Date.now() + 25 * 60_000,
      });
      const replacement = integrityBundle({
        integrity: "replacement-test-token",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const saveTwitchIntegrity = vi.fn(async () => undefined);
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => stored,
        saveTwitchIntegrity,
      });
      await env.controller.settleBackgroundWork();

      await env.controller.captureTwitchIntegrity(integrityHeaders(replacement));

      expect(saveTwitchIntegrity).toHaveBeenCalledWith(replacement);
      const calls = env.deps.createAlarm.mock.calls.filter(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      );
      expect(calls).toHaveLength(2);
      expect(calls[1][1]).not.toEqual(calls[0][1]);
    });

    it("installs and persists a fresh capture without scheduling after Twitch is disabled", async () => {
      const integrity = integrityBundle({
        integrity: "captured-while-disabled",
      });
      const saveTwitchIntegrity = vi.fn(async () => undefined);
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        saveTwitchIntegrity,
      });
      await env.controller.settleBackgroundWork();

      await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();

      await env.controller.captureTwitchIntegrity(integrityHeaders(integrity));

      expect(currentValidTwitchIntegrity()).toEqual(integrity);
      expect(saveTwitchIntegrity).toHaveBeenCalledWith(integrity);
      expect(env.deps.createAlarm).not.toHaveBeenCalled();
    });

    it("restores capture scheduling when a concurrent disable save fails", async () => {
      const integrity = integrityBundle({
        integrity: "captured-during-failed-disable",
      });
      const captureSave = deferred<void>();
      const capturePersisted = deferred<void>();
      const disableSave = deferred<void>();
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        saveTwitchIntegrity: async () => {
          await captureSave.promise;
          capturePersisted.resolve();
        },
        saveSettings: async () => {
          await disableSave.promise;
          throw new Error("settings storage unavailable");
        },
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();

      const capturing = env.controller.captureTwitchIntegrity(integrityHeaders(integrity));
      await vi.waitFor(() => expect(env.deps.saveTwitchIntegrity).toHaveBeenCalledOnce());
      const disabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalledOnce());

      captureSave.resolve();
      await capturePersisted.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      disableSave.resolve();

      await expect(disabling).rejects.toThrow("settings storage unavailable");
      await capturing;

      expect(env.settings.platform.twitch.enabled).toBe(true);
      expect(currentValidTwitchIntegrity()).toEqual(integrity);
      expect(env.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
        expect.objectContaining({ when: expect.any(Number) }),
      );
    });

    it("keeps a successful disable authoritative over a capture waiting for persistence", async () => {
      const integrity = integrityBundle({
        integrity: "captured-during-successful-disable",
      });
      const captureSave = deferred<void>();
      const capturePersisted = deferred<void>();
      const disableSave = deferred<void>();
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        saveTwitchIntegrity: async () => {
          await captureSave.promise;
          capturePersisted.resolve();
        },
        saveSettings: async () => disableSave.promise,
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();
      env.deps.clearAlarm.mockClear();

      const capturing = env.controller.captureTwitchIntegrity(integrityHeaders(integrity));
      await vi.waitFor(() => expect(env.deps.saveTwitchIntegrity).toHaveBeenCalledOnce());
      const disabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalledOnce());

      captureSave.resolve();
      await capturePersisted.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      disableSave.resolve();
      await Promise.all([capturing, disabling]);

      expect(env.settings.platform.twitch.enabled).toBe(false);
      expect(currentValidTwitchIntegrity()).toEqual(integrity);
      expect(env.deps.createAlarm.mock.calls.some(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )).toBe(false);
      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_INTEGRITY_ALARM_NAME);
    });

    it("installs valid stored integrity without scheduling when Twitch starts disabled", async () => {
      const integrity = integrityBundle({
        integrity: "stored-while-disabled",
      });
      const env = harness({
        ...farming(DEFAULT_SETTINGS),
        platform: {
          ...DEFAULT_SETTINGS.platform,
          twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
          kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
        },
      }, {
        loadTwitchIntegrity: async () => integrity,
      });

      await env.controller.settleBackgroundWork();

      expect(currentValidTwitchIntegrity()).toEqual(integrity);
      expect(env.deps.createAlarm).not.toHaveBeenCalled();
    });

    it("uses the same refresh jitter for the same token", async () => {
      const integrity = integrityBundle({
        integrity: "same-token-stable-jitter",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const first = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });
      await first.controller.settleBackgroundWork();
      const second = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });
      await second.controller.settleBackgroundWork();

      const firstWhen = (first.deps.createAlarm.mock.calls.find(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )?.[1] as { when: number }).when;
      const secondWhen = (second.deps.createAlarm.mock.calls.find(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )?.[1] as { when: number }).when;
      expect(secondWhen).toBe(firstWhen);
    });

    it("does not recreate or relog an unchanged Twitch integrity alarm", async () => {
      const integrity = integrityBundle({
        integrity: "unchanged-alarm-token",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const first = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });
      await first.controller.settleBackgroundWork();
      const scheduledTime = (first.deps.createAlarm.mock.calls.find(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )?.[1] as { when: number }).when;

      const second = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
        getAlarm: async () => ({ scheduledTime }),
      });
      await second.controller.settleBackgroundWork();

      expect(second.deps.createAlarm).not.toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
        expect.anything(),
      );
      expect(second.reportEvents.mock.calls.flatMap(([events]) => events)).not.toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("Scheduled proactive Twitch integrity refresh"),
        }),
      );
    });

    it("recreates and reports a Twitch integrity alarm when its existing target is stale", async () => {
      const integrity = integrityBundle({
        integrity: "stale-alarm-token",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const first = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });
      await first.controller.settleBackgroundWork();
      const scheduledTime = (first.deps.createAlarm.mock.calls.find(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )?.[1] as { when: number }).when;
      const second = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
        getAlarm: async () => ({ scheduledTime: scheduledTime + 1_001 }),
      });
      await second.controller.settleBackgroundWork();

      expect(second.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
        { when: scheduledTime },
      );
      expect(second.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
        expect.objectContaining({
          message: `Scheduled proactive Twitch integrity refresh for ${new Date(scheduledTime).toISOString()}`,
        }),
      );
    });

    it("recreates and reports a Twitch integrity alarm when lookup fails", async () => {
      const integrity = integrityBundle({
        integrity: "unreadable-alarm-token",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const first = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });
      await first.controller.settleBackgroundWork();
      const scheduledTime = (first.deps.createAlarm.mock.calls.find(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )?.[1] as { when: number }).when;
      const second = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
        getAlarm: async () => {
          throw new Error("browser alarm lookup failed");
        },
      });
      await second.controller.settleBackgroundWork();

      expect(second.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
        { when: scheduledTime },
      );
      expect(second.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
        expect.objectContaining({
          message: `Scheduled proactive Twitch integrity refresh for ${new Date(scheduledTime).toISOString()}`,
        }),
      );
    });

    it("rechecks stored integrity scheduling when the refresh handler runs", async () => {
      const integrity = integrityBundle({
        integrity: "refresh-handler-test-token",
      });
      const loadTwitchIntegrity = vi.fn(async () => integrity);
      const env = harness(undefined, { loadTwitchIntegrity });
      await env.controller.settleBackgroundWork();

      await env.controller.runTwitchIntegrityRefresh();

      expect(loadTwitchIntegrity).toHaveBeenCalledTimes(2);
      expect(env.deps.createAlarm.mock.calls.filter(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )).toHaveLength(2);
    });

    it("clears a prior alarm instead of creating an immediate refresh", async () => {
      const integrity = integrityBundle({
        expiresAt: Date.now() + 60_000,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });

      await env.controller.settleBackgroundWork();

      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_INTEGRITY_ALARM_NAME);
      expect(env.deps.createAlarm.mock.calls.some(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )).toBe(false);
    });

    it("forces the next normal tick to replace a valid token whose refresh target is already due", async () => {
      const integrity = integrityBundle({
        integrity: "due-on-next-normal-tick",
        expiresAt: Date.now() + 60_000,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.ensureTwitchIntegrity.mockClear();

      await env.controller.tick(["twitch"], "alarm");

      expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          forceRefresh: true,
          rejectedToken: integrity.integrity,
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("retries a failed integrity write when the same token is captured again", async () => {
      const integrity = integrityBundle({
        integrity: "retry-persistence-without-exposing-me",
      });
      const saveTwitchIntegrity = vi.fn()
        .mockRejectedValueOnce(new Error("storage unavailable"))
        .mockResolvedValueOnce(undefined);
      const env = harness(undefined, { saveTwitchIntegrity });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();

      await expect(env.controller.captureTwitchIntegrity(integrityHeaders(integrity))).resolves.toBeUndefined();

      expect(currentValidTwitchIntegrity()).toEqual(integrity);
      expect(env.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
        expect.objectContaining({ when: expect.any(Number) }),
      );
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
        expect.objectContaining({
          category: "diagnostic",
          platform: "twitch",
          level: "warn",
          message: "Could not persist the captured Twitch integrity token",
        }),
      );

      await expect(env.controller.captureTwitchIntegrity(integrityHeaders(integrity))).resolves.toBeUndefined();
      expect(saveTwitchIntegrity).toHaveBeenCalledTimes(2);
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events).every(
        (event) => event.category !== "diagnostic" || !event.message.includes(integrity.integrity),
      )).toBe(true);
    });

    it("retains a captured token when alarm creation fails", async () => {
      const integrity = integrityBundle({
        integrity: "retained-after-alarm-failure",
      });
      const saveTwitchIntegrity = vi.fn(async () => undefined);
      const env = harness(undefined, {
        saveTwitchIntegrity,
        createAlarm: async (name) => {
          if (name === TWITCH_INTEGRITY_ALARM_NAME) throw new Error("alarm unavailable");
        },
      });
      await env.controller.settleBackgroundWork();

      await expect(env.controller.captureTwitchIntegrity(integrityHeaders(integrity))).resolves.toBeUndefined();

      expect(saveTwitchIntegrity).toHaveBeenCalledWith(integrity);
      expect(currentValidTwitchIntegrity()).toEqual(integrity);
      expect(env.reportEvents.mock.calls.flatMap(([batch]) => batch)).toContainEqual(
        expect.objectContaining({
          category: "diagnostic",
          platform: "twitch",
          level: "warn",
          message: expect.stringContaining("alarm unavailable"),
        }),
      );
    });

    it("never includes integrity token material in diagnostics", async () => {
      const integrity = integrityBundle({
        integrity: "highly-sensitive-integrity-token",
      });
      const env = harness(undefined, {
        createAlarm: async (name) => {
          if (name === TWITCH_INTEGRITY_ALARM_NAME) throw new Error("alarm unavailable");
        },
      });
      await env.controller.settleBackgroundWork();

      await env.controller.captureTwitchIntegrity(integrityHeaders(integrity));

      const diagnostics = env.reportEvents.mock.calls
        .flatMap(([batch]) => batch)
        .filter((event): event is DiagnosticEvent => event.category === "diagnostic");
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.every((event) => !event.message.includes(integrity.integrity))).toBe(true);
    });
  });

  describe("Twitch integrity readiness", () => {
    beforeEach(() => {
      setTwitchIntegrity(undefined);
    });

    afterEach(() => {
      setTwitchIntegrity(undefined);
    });

    it("keeps a user-tab capture from satisfying a managed refresh wait", async () => {
      const browser = {
        tabs: {
          get: vi.fn(),
          update: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
          query: vi.fn(async () => []),
          create: vi.fn(async () => ({ id: 42 })),
        },
      } satisfies BrowserTabApi;
      const rejected = integrityBundle({ integrity: "controller-rejected-token" });
      const replacement = integrityBundle({ integrity: "controller-user-token" });
      const env = harness(undefined, { loadTwitchIntegrity: async () => undefined });
      await env.controller.settleBackgroundWork();
      setTwitchIntegrity(rejected, { sourceTabId: 7 });

      const pending = ensureTwitchIntegrityWithBrowser(
        browser,
        "https://www.twitch.tv/drops/inventory",
        50,
        undefined,
        { forceRefresh: true, rejectedToken: rejected.integrity },
      );
      await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledOnce());

      await env.controller.captureTwitchIntegrity(integrityHeaders(replacement), 7);

      await expect(pending).resolves.toBe(false);
    });

    it("treats negative tab ids as unattributed integrity captures", async () => {
      const browser = {
        tabs: {
          get: vi.fn(),
          update: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
          query: vi.fn(async () => []),
          create: vi.fn(async () => ({ id: 42 })),
        },
      } satisfies BrowserTabApi;
      const rejected = integrityBundle({ integrity: "controller-rejected-token" });
      const replacement = integrityBundle({ integrity: "controller-unattributed-token" });
      const env = harness(undefined, { loadTwitchIntegrity: async () => undefined });
      await env.controller.settleBackgroundWork();
      setTwitchIntegrity(rejected, { sourceTabId: 7 });

      const pending = ensureTwitchIntegrityWithBrowser(
        browser,
        "https://www.twitch.tv/drops/inventory",
        50,
        undefined,
        { forceRefresh: true, rejectedToken: rejected.integrity },
      );
      await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledOnce());

      await env.controller.captureTwitchIntegrity(integrityHeaders(replacement), -1);

      await expect(pending).resolves.toBe(true);
    });

    it("acquires integrity before Twitch auth and scheduler work", async () => {
      const order: string[] = [];
      const env = harness(undefined, {
        ensureTwitchIntegrity: async () => {
          order.push("integrity");
          return true;
        },
      });
      vi.mocked(env.twitch.checkAuthHealth).mockImplementation(async () => {
        order.push("auth");
        return { status: "healthy", checkedAt: "2026-07-28T12:00:00.000Z" };
      });
      vi.mocked(env.twitch.refreshCampaigns).mockImplementation(async () => {
        order.push("scheduler");
        return [campaign("twitch")];
      });

      await env.controller.tick(["twitch"], "manual_tick");

      expect(order).toEqual(["integrity", "auth", "scheduler"]);
    });

    it("correlates integrity readiness diagnostics with their scheduler tick", async () => {
      const env = harness(undefined, {
        ensureTwitchIntegrity: async (emit) => {
          emit({
            category: "diagnostic",
            platform: "twitch",
            level: "info",
            message: "Integrity readiness probe",
          });
          return true;
        },
      });

      await env.controller.tick(["twitch"], "manual_tick");

      expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
        expect.objectContaining({
          category: "diagnostic",
          message: "Integrity readiness probe",
          globalTickId: 1,
          platformTickId: 1,
        }),
      );
    });

    it("continues the same Twitch tick after successful acquisition", async () => {
      const env = harness(undefined, {
        ensureTwitchIntegrity: async () => true,
      });

      await env.controller.tick(["twitch"], "manual_tick");

      expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledOnce();
      expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
      expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
      expect(env.state.sessions.twitch.status).toBe("watching");
    });

    it("skips Twitch auth and scheduler work when acquisition returns false", async () => {
      const env = harness(undefined, {
        ensureTwitchIntegrity: async () => false,
      });

      await env.controller.tick(["twitch"], "manual_tick");

      expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.deps.createAdapter).not.toHaveBeenCalled();
      expect(env.deps.createAdapters).not.toHaveBeenCalled();
    });

    it("warns that a failed acquisition waits for the next normal scheduler alarm", async () => {
      const env = harness(undefined, {
        ensureTwitchIntegrity: async () => false,
      });

      await env.controller.tick(["twitch"], "manual_tick");

      expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
        expect.objectContaining({
          category: "diagnostic",
          platform: "twitch",
          level: "warn",
          message: expect.stringContaining("next normal scheduler alarm"),
        }),
      );
      expect(env.deps.createAlarm.mock.calls.some(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )).toBe(false);
    });

    it("does not treat acquisition failure as an interruption or unhealthy auth", async () => {
      const env = harness(undefined, {
        ensureTwitchIntegrity: async () => false,
      });
      const before = structuredClone(env.state.authHealth.twitch);

      await env.controller.tick(["twitch"], "manual_tick");

      const events = env.reportEvents.mock.calls.flatMap(([batch]) => batch);
      expect(events).not.toContainEqual(expect.objectContaining({
        category: "activity",
        code: "interruption",
      }));
      expect(env.state.authHealth.twitch).toEqual(before);
      expect(env.deps.saveState).not.toHaveBeenCalled();
    });

    it("continues Kick auth and scheduler work when Twitch acquisition fails", async () => {
      const env = harness(undefined, {
        ensureTwitchIntegrity: async () => false,
      });

      await env.controller.tick(undefined, "manual_tick");

      expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
      expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
      expect(env.state.sessions.kick.status).toBe("watching");
    });

    it("accounts an initial readiness context without labelling it as a proactive refresh", async () => {
      const env = harness(undefined, {
        ensureTwitchIntegrity: async (_emit, request) => {
          await request?.onManagedPageContextOpen?.();
          return false;
        },
      });

      await env.controller.tick(["twitch"], "manual_tick");

      expect(env.state.criticalHealth?.twitch?.records).toContainEqual(
        expect.objectContaining({
          kind: "context_open",
          code: "integrity_readiness",
        }),
      );
      expect(env.state.criticalHealth?.twitch?.records).not.toContainEqual(
        expect.objectContaining({
          kind: "context_open",
          code: "proactive_integrity_refresh",
        }),
      );
    });

    it("correlates nested Twitch integrity accounting diagnostics with their scheduler tick", async () => {
      const env = harness(undefined, {
        ensureTwitchIntegrity: async (_emit, request) => {
          await request?.onManagedPageContextOpen?.();
          return false;
        },
      });
      const now = Date.now();
      env.state.criticalHealth = {
        twitch: {
          status: "ok",
          failingMs: 0,
          failingTicks: 0,
          managedTabOpens: Array.from(
            { length: TAB_CHURN_LIMIT - 1 },
            (_, index) => new Date(now - index * 1_000).toISOString(),
          ),
          breakerOpen: false,
          records: [],
        },
      };

      await env.controller.tick(["twitch"], "manual_tick");

      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        platform: "twitch",
        code: "critical_failure_detected",
        mirroredActivity: true,
        globalTickId: 1,
        platformTickId: 1,
      }));
    });

    it("correlates failed Twitch integrity accounting diagnostics with their scheduler tick", async () => {
      const env = harness(undefined, {
        saveState: vi.fn().mockRejectedValueOnce(new Error("storage unavailable")),
        ensureTwitchIntegrity: async (_emit, request) => {
          await request?.onManagedPageContextOpen?.();
          return false;
        },
      });

      await env.controller.tick(["twitch"], "manual_tick");

      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        platform: "twitch",
        level: "warn",
        message: "Could not account for a managed Twitch integrity page context",
        globalTickId: 1,
        platformTickId: 1,
      }));
    });

    it("continues Kick when disabling Twitch cancels the acquisition awaited by an all-platform tick", async () => {
      const acquisition = deferred<boolean>();
      const env = harness(undefined, {
        ensureTwitchIntegrity: async () => acquisition.promise,
        cancelTwitchIntegrityAcquisition: (reason) => acquisition.reject(reason),
      });
      const ticking = env.controller.tick(undefined, "alarm");
      await vi.waitFor(() => expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledOnce());

      await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });

      await expect(ticking).resolves.toEqual({});
      expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
      expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
      expect(env.state.sessions.kick.status).toBe("watching");
      await env.rawController.settleBackgroundWork();
    });

    it("exits silently when shutdown aborts integrity acquisition", async () => {
      let acquisitionSignal: AbortSignal | undefined;
      const env = harness(undefined, {
        ensureTwitchIntegrity: async (_emit, request) => new Promise<boolean>((_resolve, reject) => {
          acquisitionSignal = request?.signal;
          request?.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
        }),
      });

      const ticking = env.controller.tick(["twitch"], "manual_tick");
      await vi.waitFor(() => expect(acquisitionSignal).toBeDefined());
      env.reportEvents.mockClear();

      env.controller.shutdown();

      await expect(ticking).resolves.toEqual({});
      expect(acquisitionSignal?.aborted).toBe(true);
      expect(env.deps.cancelTwitchIntegrityAcquisition).toHaveBeenCalled();
      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_INTEGRITY_ALARM_NAME);
      const events = env.reportEvents.mock.calls.flatMap(([batch]) => batch);
      expect(events).not.toContainEqual(expect.objectContaining({
        category: "activity",
        code: "interruption",
      }));
      expect(events).not.toContainEqual(expect.objectContaining({
        category: "diagnostic",
        level: "error",
      }));
    });

    it("returns from Twitch enablement before detached acquisition resolves", async () => {
      const acquisition = deferred<boolean>();
      const env = harness(notFarming(DEFAULT_SETTINGS), {
        ensureTwitchIntegrity: async () => acquisition.promise,
      });
      let acquisitionSettled = false;
      acquisition.promise.finally(() => {
        acquisitionSettled = true;
      });

      const snapshot = asSnapshot(await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: true,
      }));

      await vi.waitFor(() => expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledOnce());
      expect(acquisitionSettled).toBe(false);
      expect(snapshot.settings.platform.twitch.enabled).toBe(true);
      expect(snapshot.state.sessions.twitch.status).toBe("starting");

      acquisition.resolve(false);
      await env.rawController.settleBackgroundWork();
    });

    it("does not let a stale Twitch enable reopen integrity or start farming after disable supersedes it", async () => {
      const enableSave = deferred<void>();
      const disableSave = deferred<void>();
      let saveCount = 0;
      let exposeStoredIntegrity = false;
      const stored = integrityBundle({
        integrity: "stale-enable-schedule",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const env = harness(notFarming(DEFAULT_SETTINGS), {
        saveSettings: async () => {
          saveCount += 1;
          await (saveCount === 1 ? enableSave.promise : disableSave.promise);
        },
        loadTwitchIntegrity: async () => exposeStoredIntegrity ? stored : undefined,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();
      env.deps.ensureTwitchIntegrity.mockClear();
      vi.mocked(env.twitch.refreshCampaigns).mockClear();
      env.deps.cancelTwitchIntegrityAcquisition.mockClear();
      exposeStoredIntegrity = true;

      const enabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: true,
      });
      await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalledOnce());

      const disabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      expect(env.deps.cancelTwitchIntegrityAcquisition).toHaveBeenCalledOnce();

      enableSave.resolve();
      await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalledTimes(2));
      await enabling;
      await env.rawController.settleBackgroundWork();

      disableSave.resolve();
      await disabling;
      await env.rawController.settleBackgroundWork();

      expect(env.settings.platform.twitch.enabled).toBe(false);
      expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
      expect(env.deps.createAlarm.mock.calls.some(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )).toBe(false);
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    });

    it("clears an enable alarm creation that finishes after disable supersedes it", async () => {
      const alarmCreate = deferred<void>();
      let alarmScheduled = false;
      let exposeStoredIntegrity = false;
      const stored = integrityBundle({
        integrity: "alarm-create-completion-race",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const env = harness(notFarming(DEFAULT_SETTINGS), {
        loadTwitchIntegrity: async () => exposeStoredIntegrity ? stored : undefined,
        createAlarm: async (name) => {
          if (name !== TWITCH_INTEGRITY_ALARM_NAME) return;
          await alarmCreate.promise;
          alarmScheduled = true;
        },
        clearAlarm: async (name) => {
          if (name === TWITCH_INTEGRITY_ALARM_NAME) alarmScheduled = false;
          return true;
        },
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();
      env.deps.clearAlarm.mockClear();
      env.deps.saveSettings.mockClear();
      exposeStoredIntegrity = true;

      const enabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: true,
      });
      await vi.waitFor(() => expect(env.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
        expect.objectContaining({ when: expect.any(Number) }),
      ));

      const disabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await vi.waitFor(() => expect(env.settings.platform.twitch.enabled).toBe(false));

      alarmCreate.resolve();
      await Promise.all([enabling, disabling]);
      await env.rawController.settleBackgroundWork();

      expect(alarmScheduled).toBe(false);
    });

    it("compensates a starting-state save that finishes after disable supersedes it", async () => {
      const startingSave = deferred<void>();
      const disabledSave = deferred<void>();
      const env = harness(notFarming(DEFAULT_SETTINGS), {
        ensureTwitchIntegrity: async () => true,
      });
      let persistedState = structuredClone(env.state);
      env.deps.loadState.mockImplementation(async () => persistedState);
      env.deps.saveState.mockImplementation(async (next: SchedulerState) => {
        if (next.sessions.twitch.status === "starting") {
          await startingSave.promise;
        } else if (next.sessions.twitch.reasonCode === "automation_disabled") {
          await disabledSave.promise;
        }
        persistedState = next;
      });

      const enabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: true,
      });
      await vi.waitFor(() => expect(env.deps.saveState).toHaveBeenCalledWith(
        expect.objectContaining({
          sessions: expect.objectContaining({
            twitch: expect.objectContaining({ status: "starting" }),
          }),
        }),
      ));

      const disabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await vi.waitFor(() => expect(env.settings.platform.twitch.enabled).toBe(false));

      startingSave.resolve();
      await vi.waitFor(() => expect(env.deps.saveState).toHaveBeenCalledWith(
        expect.objectContaining({
          sessions: expect.objectContaining({
            twitch: expect.objectContaining({ reasonCode: "automation_disabled" }),
          }),
        }),
      ));
      const stateBeforeDisableTickLands = structuredClone(persistedState);

      disabledSave.resolve();
      await Promise.all([enabling, disabling]);
      await env.rawController.settleBackgroundWork();

      expect(stateBeforeDisableTickLands.sessions.twitch.status).not.toBe("starting");
    });

    it.each(["reset", "shutdown"] as const)(
      "does not resume a pending Twitch enable after %s supersedes it",
      async (cleanup) => {
        const enableSave = deferred<void>();
        const env = harness(notFarming(DEFAULT_SETTINGS), {
          saveSettings: async () => enableSave.promise,
          loadTwitchIntegrity: async () => undefined,
          ensureTwitchIntegrity: async () => true,
        });
        await env.controller.settleBackgroundWork();
        env.deps.ensureTwitchIntegrity.mockClear();
        vi.mocked(env.twitch.refreshCampaigns).mockClear();
        env.deps.createAlarm.mockClear();

        const enabling = env.rawController.handleMessage({
          type: "setPlatformEnabled",
          platform: "twitch",
          enabled: true,
        });
        await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalledOnce());

        let cleanupFinished: Promise<void>;
        if (cleanup === "reset") {
          cleanupFinished = env.controller.prepareForHostReset();
          await vi.waitFor(() => expect(env.deps.clearAlarm).toHaveBeenCalledWith(
            TWITCH_INTEGRITY_ALARM_NAME,
          ));
        } else {
          env.controller.shutdown();
          cleanupFinished = Promise.resolve();
        }

        enableSave.resolve();
        await Promise.all([enabling, cleanupFinished]);
        await env.rawController.settleBackgroundWork();

        expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
        expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
        expect(env.state.sessions.twitch.status).not.toBe("starting");
        expect(env.deps.createAlarm.mock.calls.some(
          ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
        )).toBe(false);
      },
    );

    it("does not admit a new platform-toggle tick after shutdown", async () => {
      const env = harness(notFarming(DEFAULT_SETTINGS), {
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.ensureTwitchIntegrity.mockClear();
      vi.mocked(env.twitch.refreshCampaigns).mockClear();

      env.controller.shutdown();
      await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: true,
      });
      await env.rawController.settleBackgroundWork();

      expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.state.sessions.twitch.status).not.toBe("starting");
    });

    it("preserves a newer enable schedule when an older disable clear finishes last", async () => {
      const alarmClear = deferred<void>();
      let holdAlarmClear = false;
      let alarmScheduled = false;
      const stored = integrityBundle({
        integrity: "disable-clear-completion-race",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => stored,
        createAlarm: async (name) => {
          if (name === TWITCH_INTEGRITY_ALARM_NAME) alarmScheduled = true;
        },
        clearAlarm: async (name) => {
          if (name === TWITCH_INTEGRITY_ALARM_NAME) {
            if (holdAlarmClear) await alarmClear.promise;
            alarmScheduled = false;
          }
          return true;
        },
      });
      await env.controller.settleBackgroundWork();
      expect(alarmScheduled).toBe(true);
      env.deps.saveSettings.mockClear();
      env.deps.createAlarm.mockClear();
      env.deps.clearAlarm.mockClear();
      holdAlarmClear = true;

      const disabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await vi.waitFor(() => expect(env.deps.clearAlarm).toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
      ));

      const enabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: true,
      });
      await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalledTimes(2));

      alarmClear.resolve();
      await Promise.all([disabling, enabling]);
      await env.rawController.settleBackgroundWork();

      expect(env.settings.platform.twitch.enabled).toBe(true);
      expect(alarmScheduled).toBe(true);
    });

    it("reconciles lifecycle to persisted enabled state when overlapping disable and enable saves both fail", async () => {
      const disableSave = deferred<void>();
      let saveCount = 0;
      const env = harness(undefined, {
        saveSettings: async () => {
          saveCount += 1;
          if (saveCount === 1) await disableSave.promise;
          throw new Error("settings storage unavailable");
        },
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.ensureTwitchIntegrity.mockClear();

      const disabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalledOnce());
      const enabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: true,
      });

      disableSave.resolve();
      await expect(disabling).rejects.toThrow("settings storage unavailable");
      await expect(enabling).rejects.toThrow("settings storage unavailable");
      expect(env.settings.platform.twitch.enabled).toBe(true);

      await env.controller.runTwitchIntegrityRefresh();

      expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledOnce();
    });

    it("restores lifecycle admission when a current disable fails on its first settings load", async () => {
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.ensureTwitchIntegrity.mockClear();
      env.deps.loadSettings.mockRejectedValueOnce(
        new Error("settings storage unavailable"),
      );

      await expect(env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      })).rejects.toThrow("settings storage unavailable");
      expect(env.settings.platform.twitch.enabled).toBe(true);

      await env.controller.runTwitchIntegrityRefresh();

      expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledOnce();
    });

    it("recreates the refresh schedule from a valid stored token when Twitch is re-enabled", async () => {
      const integrity = integrityBundle({
        integrity: "reschedule-after-enable",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });
      await env.controller.settleBackgroundWork();

      await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await env.rawController.settleBackgroundWork();
      env.deps.createAlarm.mockClear();

      await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: true,
      });

      expect(env.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
        expect.objectContaining({ when: expect.any(Number) }),
      );
      await env.rawController.settleBackgroundWork();
    });
  });

  describe("Twitch integrity refresh alarm", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
      setTwitchIntegrity(undefined);
    });

    afterEach(() => {
      setTwitchIntegrity(undefined);
      vi.useRealTimers();
    });

    it("reloads current settings and stored integrity on every invocation", async () => {
      const loadTwitchIntegrity = vi.fn(async () => integrityBundle());
      const env = harness(undefined, { loadTwitchIntegrity });
      await env.controller.settleBackgroundWork();
      env.deps.loadSettings.mockClear();
      loadTwitchIntegrity.mockClear();

      await env.controller.runTwitchIntegrityRefresh();
      await env.controller.runTwitchIntegrityRefresh();

      expect(env.deps.loadSettings).toHaveBeenCalledTimes(2);
      expect(loadTwitchIntegrity).toHaveBeenCalledTimes(2);
    });

    it("clears the refresh alarm without minting when Twitch is disabled", async () => {
      const loadTwitchIntegrity = vi.fn(async () => integrityBundle());
      const env = harness({
        ...farming(DEFAULT_SETTINGS),
        platform: {
          ...DEFAULT_SETTINGS.platform,
          twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
          kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
        },
      }, { loadTwitchIntegrity });
      await env.controller.settleBackgroundWork();
      env.deps.clearAlarm.mockClear();
      env.deps.createAlarm.mockClear();
      loadTwitchIntegrity.mockClear();

      await env.controller.runTwitchIntegrityRefresh();

      expect(loadTwitchIntegrity).not.toHaveBeenCalled();
      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_INTEGRITY_ALARM_NAME);
      expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
      expect(env.deps.createAlarm).not.toHaveBeenCalled();
    });

    it("reschedules a naturally captured newer token without minting", async () => {
      const newer = integrityBundle({
        integrity: "naturally-captured-newer-token",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => newer,
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();
      env.deps.ensureTwitchIntegrity.mockClear();

      await env.controller.runTwitchIntegrityRefresh();

      expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
      expect(env.deps.createAlarm).toHaveBeenCalledOnce();
      expect(env.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
        expect.objectContaining({ when: expect.any(Number) }),
      );
    });

    it.each([
      ["missing", false],
      ["inside the refresh window", true],
    ])("forces one fresh-context acquisition when the stored token is %s", async (_label, hasNearExpiryToken) => {
      const integrity = hasNearExpiryToken
        ? integrityBundle({ expiresAt: Date.now() + 90_000 })
        : undefined;
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();
      env.deps.clearAlarm.mockClear();
      env.deps.ensureTwitchIntegrity.mockClear();

      await env.controller.runTwitchIntegrityRefresh();

      expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledOnce();
      expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          forceRefresh: true,
          signal: expect.any(AbortSignal),
        }),
      );
      expect(env.deps.createAlarm).not.toHaveBeenCalled();
    });

    it("relies on captured-token persistence to schedule after successful acquisition", async () => {
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();

      await env.controller.runTwitchIntegrityRefresh();

      expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledOnce();
      expect(env.deps.createAlarm).not.toHaveBeenCalled();
    });

    it.each([
      ["returns false", async () => false],
      ["throws", async () => {
        throw new Error("page context failed");
      }],
    ])("does not create a retry alarm when acquisition %s", async (_label, ensureTwitchIntegrity) => {
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity,
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();

      await expect(env.controller.runTwitchIntegrityRefresh()).resolves.toBeUndefined();

      expect(env.deps.createAlarm).not.toHaveBeenCalled();
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
        expect.objectContaining({
          category: "diagnostic",
          platform: "twitch",
          level: "debug",
          message: expect.stringContaining("next normal scheduler alarm"),
        }),
      );
    });

    it("uses the real tabs single-flight while keeping proactive managed opens diagnostic-only and churn-accounted", async () => {
      const browser = {
        tabs: {
          get: vi.fn(),
          update: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
          query: vi.fn(async () => []),
          create: vi.fn(async () => ({ id: 93 })),
        },
      } satisfies BrowserTabApi;
      registerManagedPageContextTabs({});
      resetTwitchIntegrityRefreshBounds();
      setTwitchIntegrity(undefined);
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: (emit, request) => ensureTwitchIntegrityWithBrowser(
          browser,
          "https://www.twitch.tv/drops/inventory",
          5_000,
          emit,
          request,
        ),
        cancelTwitchIntegrityAcquisition,
      });
      await env.controller.settleBackgroundWork();

      const refreshing = env.controller.runTwitchIntegrityRefresh();
      await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledOnce());
      const ticking = env.controller.tick(["twitch"], "manual_tick");
      await vi.waitFor(() => expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledTimes(2));
      setTwitchIntegrity(integrityBundle({
        integrity: "real-composition-replacement",
      }), { isNew: true });
      await Promise.all([refreshing, ticking]);

      const reported = env.reportEvents.mock.calls.flatMap(([events]) => events);
      const emittedActivity = reported.some((event) =>
        event.category === "activity" && event.code === "page_context_opened");
      const proactiveDiagnostic = reported.some((event) =>
        event.category === "diagnostic"
        && event.platform === "twitch"
        && event.message.includes("proactive"));
      const managedTabOpens = env.state.criticalHealth?.twitch?.managedTabOpens.length;
      const recordedProactiveOpen = env.state.criticalHealth?.twitch?.records.some((record) =>
        record.kind === "context_open" && record.code === "proactive_integrity_refresh");
      resetTwitchIntegrityRefreshBounds();
      setTwitchIntegrity(undefined);

      expect(browser.tabs.create).toHaveBeenCalledOnce();
      expect(emittedActivity).toBe(false);
      expect(proactiveDiagnostic).toBe(true);
      expect(reported).not.toContainEqual(expect.objectContaining({
        category: "activity",
        code: "page_context_opened",
      }));
      expect(managedTabOpens).toBeGreaterThanOrEqual(1);
      expect(recordedProactiveOpen).toBe(true);
    });

    it("revalidates the stored token when a late alarm runs", async () => {
      let stored = integrityBundle({
        integrity: "original-near-expiry-token",
        expiresAt: Date.now() + 90_000,
      });
      const loadTwitchIntegrity = vi.fn(async () => stored);
      const env = harness(undefined, { loadTwitchIntegrity });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();
      env.deps.ensureTwitchIntegrity.mockClear();
      stored = integrityBundle({
        integrity: "replacement-captured-while-asleep",
        expiresAt: Date.now() + 30 * 60_000,
      });

      await env.controller.runTwitchIntegrityRefresh();

      expect(loadTwitchIntegrity).toHaveBeenCalledTimes(2);
      expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
      expect(env.deps.createAlarm).toHaveBeenCalledOnce();
    });

    it("does not let alarm preflight overwrite a fresh capture waiting for persistence", async () => {
      const oldIntegrity = integrityBundle({
        integrity: "stored-before-capture",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const replacement = integrityBundle({
        integrity: "captured-before-storage-finishes",
        expiresAt: Date.now() + 40 * 60_000,
      });
      const capturedReplacement = {
        ...replacement,
        expiresAt: Date.now() + 30 * 60_000,
      };
      let stored = oldIntegrity;
      const saveGate = deferred<void>();
      const loadTwitchIntegrity = vi.fn(async () => stored);
      const env = harness(undefined, {
        loadTwitchIntegrity,
        saveTwitchIntegrity: async (value) => {
          await saveGate.promise;
          stored = value;
        },
      });
      await env.controller.settleBackgroundWork();
      loadTwitchIntegrity.mockClear();
      env.deps.createAlarm.mockClear();

      const capturing = env.controller.captureTwitchIntegrity(integrityHeaders(replacement));
      await vi.waitFor(() => expect(env.deps.saveTwitchIntegrity).toHaveBeenCalledOnce());
      const refreshing = env.controller.runTwitchIntegrityRefresh();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const preflightWaitedForCapture = loadTwitchIntegrity.mock.calls.length === 0;
      const memoryStayedFreshWhileSaving = currentValidTwitchIntegrity()?.integrity === replacement.integrity;

      saveGate.resolve();
      await Promise.all([capturing, refreshing]);

      expect(preflightWaitedForCapture).toBe(true);
      expect(memoryStayedFreshWhileSaving).toBe(true);
      expect(stored).toEqual(capturedReplacement);
      expect(currentValidTwitchIntegrity()).toEqual(capturedReplacement);
      const integrityAlarmCalls = env.deps.createAlarm.mock.calls.filter(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      );
      expect(integrityAlarmCalls.length).toBeGreaterThan(0);
      expect(new Set(integrityAlarmCalls.map(([, options]) => JSON.stringify(options))).size).toBe(1);
    });

    // The invariant both of these guard: installing a captured token must never
    // need a lock that a waiting mint's own caller is holding. runTick and
    // runPlatformWatchHeartbeat both hold the platform lock across work that can
    // force a refresh, so a capture that took that lock could not be installed
    // until the holder gave up — which it only did by timing out.
    it("installs a captured token while a tick holds the platform lock", async () => {
      const replacement = integrityBundle({
        integrity: "captured-during-locked-tick",
      });
      const refreshGate = deferred<void>();
      const env = harness(undefined, { loadTwitchIntegrity: async () => undefined });
      await env.controller.settleBackgroundWork();
      setTwitchIntegrity(undefined);

      // refreshCampaigns runs inside runSchedulerTick, which runTick wraps in
      // withStateLock for the whole scheduler run.
      env.twitch.refreshCampaigns = vi.fn(async () => {
        await refreshGate.promise;
        return [campaign("twitch")];
      });

      const ticking = env.controller.tick(["twitch"], "manual_tick");
      await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());

      // Deliberately not awaited: persistence still queues behind the tick, and
      // the install must already have happened by the time the call returns.
      const capturing = env.controller.captureTwitchIntegrity(integrityHeaders(replacement));
      const installedWhileLocked = currentValidTwitchIntegrity()?.integrity;

      refreshGate.resolve();
      await Promise.all([capturing, ticking]);
      setTwitchIntegrity(undefined);

      expect(installedWhileLocked).toBe(replacement.integrity);
    });

    it("satisfies a rejection-recovery mint raised from inside the platform lock", async () => {
      const replacement = integrityBundle({
        integrity: "minted-during-locked-tick",
      });
      const browser = {
        tabs: {
          get: vi.fn(),
          update: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
          query: vi.fn(async () => []),
          create: vi.fn(async () => ({ id: 77 })),
        },
      } satisfies BrowserTabApi;
      registerManagedPageContextTabs({});
      resetTwitchIntegrityRefreshBounds();
      setTwitchIntegrity(undefined);
      const env = harness(undefined, { loadTwitchIntegrity: async () => undefined });
      await env.controller.settleBackgroundWork();

      let mintedInsideLock: boolean | undefined;
      // Stands in for the adapter forcing a refresh after Twitch rejects a token
      // it still considers unexpired (platforms/twitch/index.ts). This runs under
      // the platform lock, so before the fix it could only ever time out.
      env.twitch.refreshCampaigns = vi.fn(async () => {
        mintedInsideLock = await ensureTwitchIntegrityWithBrowser(
          browser,
          "https://www.twitch.tv/drops/inventory",
          1_000,
          () => undefined,
          { forceRefresh: true, reason: "rejection_recovery" },
        );
        return [campaign("twitch")];
      });

      const ticking = env.controller.tick(["twitch"], "manual_tick");
      await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledOnce());
      const capturing = env.controller.captureTwitchIntegrity(integrityHeaders(replacement));

      await ticking;
      await capturing;
      resetTwitchIntegrityRefreshBounds();
      setTwitchIntegrity(undefined);

      expect(mintedInsideLock).toBe(true);
    });

    it("forces the next normal tick after a proactive refresh is deferred", async () => {
      const integrity = integrityBundle({
        integrity: "deferred-proactive-token",
        expiresAt: Date.now() + 90_000,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
        ensureTwitchIntegrity: async () => false,
      });
      await env.controller.settleBackgroundWork();

      await env.controller.runTwitchIntegrityRefresh();
      env.deps.ensureTwitchIntegrity.mockClear();
      await env.controller.tick(["twitch"], "alarm");

      expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          forceRefresh: true,
          rejectedToken: integrity.integrity,
        }),
      );
    });

    it("reports proactive start timing before a debug-level deferral", async () => {
      const integrity = integrityBundle({
        integrity: "timed-proactive-token",
        expiresAt: Date.now() + 90_000,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
        ensureTwitchIntegrity: async () => false,
      });
      await env.controller.settleBackgroundWork();
      env.reportEvents.mockClear();

      await env.controller.runTwitchIntegrityRefresh();

      const diagnostics = env.reportEvents.mock.calls
        .flatMap(([events]) => events)
        .filter((event): event is DiagnosticEvent => event.category === "diagnostic");
      const started = diagnostics.findIndex((event) =>
        event.level === "debug"
        && event.message.includes("Starting proactive Twitch integrity refresh")
        && event.message.includes("90000ms remaining"));
      const deferred = diagnostics.findIndex((event) =>
        event.level === "debug"
        && event.message.includes("next normal scheduler alarm"));
      expect(started).toBeGreaterThanOrEqual(0);
      expect(deferred).toBeGreaterThan(started);
      expect(diagnostics).not.toContainEqual(expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("Could not refresh Twitch integrity"),
      }));
    });

    it.each(["disable", "reset", "shutdown"] as const)(
      "does not schedule from a pending startup token load after %s cleanup",
      async (cleanup) => {
        const stored = integrityBundle({
          integrity: `startup-${cleanup}-future-token`,
          expiresAt: Date.now() + 30 * 60_000,
        });
        const integrityRead = deferred<TwitchIntegrity | undefined>();
        const env = harness(undefined, {
          loadTwitchIntegrity: async () => integrityRead.promise,
          ensureTwitchIntegrity: async () => true,
        });
        await vi.waitFor(() => expect(env.deps.loadTwitchIntegrity).toHaveBeenCalledOnce());
        env.deps.createAlarm.mockClear();
        env.deps.clearAlarm.mockClear();
        env.deps.ensureTwitchIntegrity.mockClear();

        let cleanupFinished: Promise<void> | undefined;
        if (cleanup === "disable") {
          await env.rawController.handleMessage({
            type: "setPlatformEnabled",
            platform: "twitch",
            enabled: false,
          });
        } else if (cleanup === "reset") {
          cleanupFinished = env.controller.prepareForHostReset();
          await vi.waitFor(() => expect(env.deps.clearAlarm).toHaveBeenCalledWith(
            TWITCH_INTEGRITY_ALARM_NAME,
          ));
        } else {
          env.controller.shutdown();
        }

        integrityRead.resolve(stored);
        await cleanupFinished;
        await env.rawController.settleBackgroundWork();

        expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
        expect(env.deps.createAlarm.mock.calls.some(
          ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
        )).toBe(false);
      },
    );

    it.each([
      ["settings", "disable", true],
      ["settings", "reset", false],
      ["settings", "shutdown", false],
      ["integrity", "disable", true],
      ["integrity", "reset", false],
      ["integrity", "shutdown", true],
    ] as const)(
      "does not restart Twitch work when %s preflight resumes after %s",
      async (pausedRead, cleanup, hasFutureToken) => {
        const stored = hasFutureToken
          ? integrityBundle({
              integrity: `${pausedRead}-${cleanup}-future-token`,
              expiresAt: Date.now() + 30 * 60_000,
            })
          : undefined;
        const env = harness(undefined, {
          loadTwitchIntegrity: async () => stored,
          ensureTwitchIntegrity: async () => true,
        });
        await env.controller.settleBackgroundWork();
        env.deps.createAlarm.mockClear();
        env.deps.ensureTwitchIntegrity.mockClear();
        env.deps.loadSettings.mockClear();
        const loadTwitchIntegrity = env.deps.loadTwitchIntegrity!;
        loadTwitchIntegrity.mockClear();
        const settingsRead = deferred<ExtensionSettings>();
        const integrityRead = deferred<TwitchIntegrity | undefined>();
        if (pausedRead === "settings") {
          env.deps.loadSettings.mockImplementationOnce(() => settingsRead.promise);
        } else {
          loadTwitchIntegrity.mockImplementationOnce(() => integrityRead.promise);
        }

        const refreshing = env.controller.runTwitchIntegrityRefresh();
        if (pausedRead === "settings") {
          await vi.waitFor(() => expect(env.deps.loadSettings).toHaveBeenCalledOnce());
        } else {
          await vi.waitFor(() => expect(loadTwitchIntegrity).toHaveBeenCalledOnce());
        }

        let cleanupFinished: Promise<unknown> | undefined;
        if (cleanup === "disable") {
          cleanupFinished = env.rawController.handleMessage({
            type: "setPlatformEnabled",
            platform: "twitch",
            enabled: false,
          });
        } else if (cleanup === "reset") {
          cleanupFinished = env.controller.prepareForHostReset();
        } else {
          env.controller.shutdown();
        }

        if (pausedRead === "settings") {
          settingsRead.resolve(farming(DEFAULT_SETTINGS));
        } else {
          integrityRead.resolve(stored);
        }
        await Promise.all([refreshing, cleanupFinished]);
        if (cleanup === "disable") {
          await env.rawController.settleBackgroundWork();
        }

        expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
        expect(env.deps.createAlarm.mock.calls.some(
          ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
        )).toBe(false);
      },
    );

    it("cancels acquisition and clears the alarm when Twitch is disabled", async () => {
      let acquisitionSignal: AbortSignal | undefined;
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: async (_emit, request) => new Promise<boolean>((_resolve, reject) => {
          acquisitionSignal = request?.signal;
          request?.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
        }),
      });
      await env.controller.settleBackgroundWork();
      env.reportEvents.mockClear();
      const refreshing = env.controller.runTwitchIntegrityRefresh();
      await vi.waitFor(() => expect(acquisitionSignal).toBeDefined());

      await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });

      expect(acquisitionSignal?.aborted).toBe(true);
      expect(env.deps.cancelTwitchIntegrityAcquisition).toHaveBeenCalled();
      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_INTEGRITY_ALARM_NAME);
      await refreshing;
      await env.rawController.settleBackgroundWork();
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
        expect.objectContaining({
          category: "diagnostic",
          platform: "twitch",
          level: "debug",
          message: expect.stringContaining("cancelled because Twitch stopped"),
        }),
      );
    });

    it("does not admit an alarm queued while the Twitch disable write is pending", async () => {
      const settingsSave = deferred<void>();
      const env = harness(undefined, {
        saveSettings: async () => settingsSave.promise,
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.ensureTwitchIntegrity.mockClear();

      const disabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalledOnce());
      const queuedAlarm = env.controller.runTwitchIntegrityRefresh();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const admittedBeforeDisablePersisted = env.deps.ensureTwitchIntegrity.mock.calls.length > 0;

      settingsSave.resolve();
      await Promise.all([disabling, queuedAlarm]);
      await env.rawController.settleBackgroundWork();
      expect(admittedBeforeDisablePersisted).toBe(false);
      expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
    });

    it("does not admit a fresh queued alarm after reset cleanup starts", async () => {
      const alarmClear = deferred<boolean>();
      const env = harness(undefined, {
        clearAlarm: async () => alarmClear.promise,
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.ensureTwitchIntegrity.mockClear();

      const resetting = env.controller.prepareForHostReset();
      await vi.waitFor(() => expect(env.deps.clearAlarm).toHaveBeenCalledOnce());
      const queuedAlarm = env.controller.runTwitchIntegrityRefresh();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const admittedAfterResetStarted = env.deps.ensureTwitchIntegrity.mock.calls.length > 0;

      alarmClear.resolve(true);
      await Promise.all([resetting, queuedAlarm]);
      expect(admittedAfterResetStarted).toBe(false);
      expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
    });

    it("does not admit a fresh queued alarm after shutdown", async () => {
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.ensureTwitchIntegrity.mockClear();

      env.controller.shutdown();
      await env.controller.runTwitchIntegrityRefresh();

      expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
    });

    it("does not abort in-flight Kick work when Twitch is disabled", async () => {
      const kickDiscovery = deferred<DropCampaign[]>();
      let kickSignal: AbortSignal | undefined;
      const env = harness(undefined);
      vi.mocked(env.kick.refreshCampaigns).mockImplementation(async (_session, { signal } = {}) => {
        kickSignal = signal;
        return kickDiscovery.promise;
      });
      const ticking = env.controller.tick(["kick"], "manual_tick");
      await vi.waitFor(() => expect(kickSignal).toBeDefined());

      await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });

      expect(kickSignal?.aborted).toBe(false);
      kickDiscovery.resolve([campaign("kick")]);
      await ticking;
      await env.rawController.settleBackgroundWork();
    });

    it("cancels an owned refresh during host reset", async () => {
      let acquisitionSignal: AbortSignal | undefined;
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: async (_emit, request) => new Promise<boolean>((_resolve, reject) => {
          acquisitionSignal = request?.signal;
          request?.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
        }),
      });
      await env.controller.settleBackgroundWork();
      const refreshing = env.controller.runTwitchIntegrityRefresh();
      await vi.waitFor(() => expect(acquisitionSignal).toBeDefined());

      await env.controller.prepareForHostReset();
      await refreshing;

      expect(acquisitionSignal?.aborted).toBe(true);
      expect(env.deps.cancelTwitchIntegrityAcquisition).toHaveBeenCalled();
      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_INTEGRITY_ALARM_NAME);
    });
  });

  it("retains Twitch discovery when each controller tick constructs a fresh adapter", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true, idleWatchlistChannels: [] },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
      },
    });
    let dashboardFails = false;
    let detailsFail = false;
    const discoveryState = new TwitchDiscoveryState();
    const fetcher: PageFetcher = {
      fetchJson: vi.fn(async (_url: string, init?: RequestInit): Promise<unknown> => {
        const operation = twitchOperation(init);
        if (operation === "CurrentUser") return { data: { currentUser: { id: "user-id" } } };
        if (operation === "Inventory") return twitchInventory();
        if (operation === "ViewerDropsDashboard") {
          if (dashboardFails) throw new Error("service unavailable");
          return twitchDashboard(["retained"]);
        }
        if (operation === "DropCampaignDetails") {
          if (detailsFail) throw new Error("service unavailable");
          return twitchCampaignDetails("retained");
        }
        if (operation === "DirectoryPage_Game") return { data: { game: { streams: { edges: [] } } } };
        throw new Error(`Unexpected Twitch operation ${operation}`);
      }) as PageFetcher["fetchJson"],
    };
    vi.mocked(env.deps.createAdapter).mockImplementation((_platform, emit, settings) => ({
      adapter: twitchAdapter(fetcher, undefined, undefined, { discoveryState }, emit),
      ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
    }));

    await env.controller.tick();
    expect(env.state.campaigns.twitch.map((item) => item.id)).toEqual(["retained"]);

    dashboardFails = true;
    detailsFail = true;
    await env.controller.tick();

    // Each controller tick owns one adapter per requested platform. The disabled
    // Kick adapter is still needed by the combined scheduler reconciliation.
    expect(env.deps.createAdapter).toHaveBeenCalledTimes(4);
    expect(env.state.campaigns.twitch.map((item) => item.id)).toEqual(["retained"]);
  });

  it("reconstructs a tick adapter when settings change before commit", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const discovery = deferred<DropCampaign[]>();
    vi.mocked(env.kick.refreshCampaigns).mockReturnValueOnce(discovery.promise);

    const ticking = env.controller.tick(["kick"]);
    await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
    await env.deps.saveSettings({ ...env.settings, preferKnownChannels: !env.settings.preferKnownChannels });
    discovery.resolve([campaign("kick")]);
    await ticking;

    expect(env.deps.createAdapter).toHaveBeenCalledTimes(2);
    expect(env.deps.createAdapter.mock.calls[0]![2].preferKnownChannels)
      .not.toBe(env.deps.createAdapter.mock.calls[1]![2].preferKnownChannels);
  });

  it("skips redundant target evaluation when a new discovery revision is materially unchanged", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, tablessMode: true }));
    env.twitch.supportsTabless = true;
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([{
      ...campaign("twitch"),
      rewards: [{ ...reward("in_progress"), isWatchBased: false }],
    }]);

    await env.controller.tick(["twitch"]);
    await env.controller.tick(["twitch"]);
    await env.controller.tick(["twitch"]);
    await env.controller.tick(["twitch"]);

    expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
      platform: "twitch",
      message: expect.stringMatching(/^Snapshot selection skipped \(trigger=unknown, revision=\d+, age=\d+ms, material=false\)$/),
    }));
  });

  it("starts enabled auth probes concurrently and persists each before scheduler work", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const twitchHealth = deferred<PlatformAuthHealth>();
    const kickHealth = deferred<PlatformAuthHealth>();
    vi.mocked(env.twitch.checkAuthHealth).mockReturnValue(twitchHealth.promise);
    vi.mocked(env.kick.checkAuthHealth).mockReturnValue(kickHealth.promise);

    const ticking = env.controller.tick();
    await vi.waitFor(() => {
      expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
      expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
    });

    kickHealth.resolve({
      status: "healthy",
      checkedAt: "2026-07-26T12:00:00.000Z",
    });
    await vi.waitFor(() => expect(env.state.authHealth.kick.status).toBe("healthy"));

    expect(env.state.authHealth.twitch.status).toBe("checking");
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();

    twitchHealth.resolve({
      status: "healthy",
      checkedAt: "2026-07-26T12:00:01.000Z",
    });
    await ticking;

    expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
  });

  it("waits for started auth probes before reporting a sibling setup failure", async () => {
    vi.useFakeTimers();
    try {
      const env = harness(
        farming(DEFAULT_SETTINGS),
        { authProbeTimeoutMs: 25 },
      );
      const oldTwitchHealth = deferred<PlatformAuthHealth>();
      vi.mocked(env.twitch.checkAuthHealth)
        .mockReturnValueOnce(oldTwitchHealth.promise)
        .mockResolvedValueOnce({
          status: "healthy",
          checkedAt: "2026-07-26T12:00:01.000Z",
        });
      vi.mocked(env.deps.createAdapter).mockImplementation((platform, emit, settings) => {
        if (platform === "kick") {
          throw new Error("kick adapter setup failed");
        }
        return {
          adapter: env.twitch,
          ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
        };
      });

      let tickSettled = false;
      const ticking = env.controller.tick().then(() => {
        tickSettled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      const settledBeforeDeadline = tickSettled;
      const refreshing = ticking.then(() => env.controller.checkAuthHealth("twitch"));

      await vi.advanceTimersByTimeAsync(25);
      await refreshing;

      expect(env.state.authHealth.twitch).toMatchObject({
        status: "healthy",
        checkedAt: "2026-07-26T12:00:01.000Z",
      });
      expect(settledBeforeDeadline).toBe(false);
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
        category: "activity",
        code: "interruption",
        data: expect.objectContaining({ detail: "kick adapter setup failed" }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out and aborts a stalled auth probe at the configured deadline", async () => {
    vi.useFakeTimers();
    try {
      const env = harness(
        farming(DEFAULT_SETTINGS),
        { authProbeTimeoutMs: 25 },
      );
      let signal: AbortSignal | undefined;
      vi.mocked(env.twitch.checkAuthHealth).mockImplementation((nextSignal) => {
        signal = nextSignal;
        return new Promise(() => undefined);
      });

      const checking = env.controller.checkAuthHealth("twitch");
      await vi.advanceTimersByTimeAsync(24);
      expect(env.state.authHealth.twitch.status).toBe("checking");
      await vi.advanceTimersByTimeAsync(1);
      await checking;

      expect(signal?.aborted).toBe(true);
      expect(env.state.authHealth.twitch).toMatchObject({
        status: "unavailable",
        reasonCode: "network_unavailable",
        message: { key: "authNetworkUnavailable" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shutdown preempts a stalled credential availability check", async () => {
    const checkCredentialAvailability = vi.fn(async () => new Promise<never>(() => undefined));
    const env = harness(
      farming(DEFAULT_SETTINGS),
      {
        authProbeTimeoutMs: 60_000,
        checkCredentialAvailability,
      },
    );

    const ticking = env.controller.tick();
    await vi.waitFor(() => {
      expect(checkCredentialAvailability).toHaveBeenCalled();
    });

    env.controller.shutdown();

    await expect(ticking).resolves.toEqual({});
  });

  it("does not start a Kick page fallback after the auth deadline aborts background fetch", async () => {
    vi.useFakeTimers();
    try {
      const env = harness(
        farming(DEFAULT_SETTINGS),
        { authProbeTimeoutMs: 25 },
      );
      let backgroundStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        backgroundStarted = resolve;
      });
      const pageFetch = vi.fn(async () => ({ id: 42 }));
      const kick = kickAdapter(createKickFetcher({
        background: async (_url, init) => {
          backgroundStarted();
          await new Promise<void>((resolve) => {
            init?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new KickWafBlockedError("background rejected after deadline");
        },
        pageFetch,
      }));
      vi.mocked(env.kick.checkAuthHealth).mockImplementation((signal) => kick.checkAuthHealth(signal));

      const checking = env.controller.checkAuthHealth("kick");
      await started;
      await vi.advanceTimersByTimeAsync(25);
      await checking;
      await vi.advanceTimersByTimeAsync(0);

      expect(pageFetch).not.toHaveBeenCalled();
      expect(env.state.authHealth.kick).toMatchObject({
        status: "unavailable",
        reasonCode: "network_unavailable",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not delay a resolved platform while another probe awaits its own deadline", async () => {
    vi.useFakeTimers();
    try {
      const env = harness(
        farming(DEFAULT_SETTINGS),
        { authProbeTimeoutMs: 25 },
      );
      vi.mocked(env.twitch.checkAuthHealth).mockImplementation(() => new Promise(() => undefined));
      vi.mocked(env.kick.checkAuthHealth).mockResolvedValue({
        status: "healthy",
        checkedAt: "2026-07-26T12:00:00.000Z",
      });

      let settled = false;
      const ticking = env.controller.tick().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(env.state.authHealth.kick.status).toBe("healthy");
      expect(env.state.authHealth.twitch.status).toBe("checking");
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(24);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await ticking;

      expect(settled).toBe(true);
      expect(env.state.authHealth.twitch).toMatchObject({
        status: "unavailable",
        reasonCode: "network_unavailable",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles once when a timed out auth adapter rejects later", async () => {
    vi.useFakeTimers();
    try {
      const env = harness(
        farming(DEFAULT_SETTINGS),
        { authProbeTimeoutMs: 25 },
      );
      const health = deferred<PlatformAuthHealth>();
      vi.mocked(env.twitch.checkAuthHealth).mockReturnValue(health.promise);

      const checking = env.controller.checkAuthHealth("twitch");
      await vi.advanceTimersByTimeAsync(25);
      await checking;
      const saveCount = env.deps.saveState.mock.calls.length;
      const transitionCount = env.reportEvents.mock.calls.flatMap(([events]) => events).filter((event) =>
        event.category === "activity" && event.code === "auth_health_changed"
      ).length;

      health.reject(new Error("late adapter failure"));
      await vi.advanceTimersByTimeAsync(0);

      expect(env.deps.saveState).toHaveBeenCalledTimes(saveCount);
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events).filter((event) =>
        event.category === "activity" && event.code === "auth_health_changed"
      )).toHaveLength(transitionCount);
      expect(env.state.authHealth.twitch.reasonCode).toBe("network_unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("merges a completed auth probe into state written while the probe was pending", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const health = deferred<PlatformAuthHealth>();
    vi.mocked(env.twitch.checkAuthHealth).mockReturnValue(health.promise);

    const checking = env.controller.checkAuthHealth("twitch");
    await vi.waitFor(() => expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce());

    env.state.sessions.kick = {
      platform: "kick",
      status: "watching",
      channel: channel("kick"),
      offlineChecks: 0,
      tabId: 20,
      tabManagedByExtension: true,
    };
    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "kick",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 1,
        unmutedVideoCount: 0,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: true,
        readyState: 4,
        currentTime: 12,
        duration: 1200,
      },
    }, { tab: { id: 20 } });
    health.resolve({ status: "healthy", checkedAt: "2026-07-26T12:00:01.000Z" });
    await checking;

    expect(env.state.authHealth.twitch.status).toBe("healthy");
    expect(env.state.sessions.kick.playback?.videoCount).toBe(1);
  });

  it("keeps a newer same-platform refresh when an older tick probe settles last", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    const older = deferred<PlatformAuthHealth>();
    const newer = deferred<PlatformAuthHealth>();
    vi.mocked(env.twitch.checkAuthHealth)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const ticking = env.controller.tick(["twitch"]);
    await vi.waitFor(() => expect(env.twitch.checkAuthHealth).toHaveBeenCalledTimes(1));
    const cookieRefresh = env.controller.checkAuthHealth("twitch");
    await vi.waitFor(() => expect(env.twitch.checkAuthHealth).toHaveBeenCalledTimes(2));

    newer.resolve({
      status: "healthy",
      checkedAt: "2026-07-26T12:05:00.000Z",
      message: { key: "authHealthy" },
    });
    await cookieRefresh;
    older.resolve({
      status: "invalid_credentials",
      checkedAt: "2026-07-26T12:00:00.000Z",
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    });
    await ticking;

    expect(env.state.authHealth.twitch).toEqual({
      status: "healthy",
      checkedAt: "2026-07-26T12:05:00.000Z",
      message: { key: "authHealthy" },
    });
  });

  it("keeps invalidation checking when it supersedes an in-flight probe", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const older = deferred<PlatformAuthHealth>();
    vi.mocked(env.twitch.checkAuthHealth).mockReturnValueOnce(older.promise);

    const checking = env.controller.checkAuthHealth("twitch");
    await vi.waitFor(() => expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce());
    await env.controller.invalidateAuthHealth("twitch");

    older.resolve({
      status: "healthy",
      checkedAt: "2026-07-26T12:00:00.000Z",
      message: { key: "authHealthy" },
    });
    await checking;

    expect(env.state.authHealth.twitch).toEqual({ status: "checking" });
  });

  it("supersedes an in-flight probe without putting a newly disabled platform in checking", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.authHealth = {
      ...env.state.authHealth,
      twitch: {
        status: "healthy",
        checkedAt: "2026-07-26T12:00:00.000Z",
        message: { key: "authHealthy" },
      },
    };
    const older = deferred<PlatformAuthHealth>();
    vi.mocked(env.twitch.checkAuthHealth).mockReturnValueOnce(older.promise);

    const checking = env.controller.checkAuthHealth("twitch");
    await vi.waitFor(() => expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce());
    await env.deps.saveSettings({
      ...env.settings,
      platform: {
        ...env.settings.platform,
        twitch: { ...env.settings.platform.twitch, enabled: false },
      },
    });
    await env.controller.invalidateAuthHealth("twitch");

    older.resolve({
      status: "invalid_credentials",
      checkedAt: "2026-07-26T12:01:00.000Z",
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    });
    await checking;

    expect(env.state.authHealth.twitch).toEqual({
      status: "healthy",
      checkedAt: "2026-07-26T12:00:00.000Z",
      message: { key: "authHealthy" },
    });
  });

  it("terminalizes direct adapter setup failures with platform context", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    vi.mocked(env.deps.createAdapter).mockImplementation(() => {
      throw new Error("twitch adapter setup failed");
    });

    const error = await env.controller.checkAuthHealth("twitch").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      platform: "twitch",
      message: "twitch adapter setup failed",
    });
    expect(env.state.authHealth.twitch).toMatchObject({
      status: "unavailable",
      reasonCode: "platform_unavailable",
      message: { key: "authPlatformUnavailable" },
    });
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "auth_health_changed",
      platform: "twitch",
      data: expect.objectContaining({ to: "unavailable" }),
    }));
  });

  it("surfaces sibling auth persistence failure alongside adapter setup failure", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const kickHealth = deferred<PlatformAuthHealth>();
    vi.mocked(env.kick.checkAuthHealth).mockReturnValue(kickHealth.promise);
    vi.mocked(env.deps.createAdapter).mockImplementation((platform, emit, settings) => {
      if (platform === "twitch") {
        throw new Error("twitch adapter setup failed");
      }
      return {
        adapter: env.kick,
        ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
      };
    });
    const persist = env.deps.saveState.getMockImplementation();
    if (!persist) throw new Error("Expected harness state persistence");
    env.deps.saveState.mockImplementation(async (state) => {
      if (state.authHealth.kick.status === "healthy") {
        throw new Error("kick auth persistence failed");
      }
      await persist(state);
    });

    const ticking = env.controller.tick();
    await vi.waitFor(() => expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce());
    kickHealth.resolve({
      status: "healthy",
      checkedAt: "2026-07-26T12:00:00.000Z",
    });
    const error = await ticking.catch((caught: unknown) => caught);

    expect(error).toEqual(expect.objectContaining({
      message: "kick auth persistence failed",
    }));
    expect(env.state.authHealth.twitch).toMatchObject({
      status: "unavailable",
      reasonCode: "platform_unavailable",
    });
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "interruption",
      platform: "twitch",
      data: expect.objectContaining({ detail: "twitch adapter setup failed" }),
    }));
  });

  it("isolates a consistently failing Kick constructor from Twitch auth health", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    vi.mocked(env.deps.createAdapters).mockImplementation(() => {
      throw new Error("combined construction reached failing Kick adapter");
    });
    vi.mocked(env.deps.createAdapter).mockImplementation((platform, emit, settings) => {
      if (platform === "kick") throw new Error("kick adapter setup failed");
      return {
        adapter: env.twitch,
        ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
      };
    });

    await env.controller.tick();

    expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.state.authHealth.twitch.status).toBe("healthy");
    expect(env.state.authHealth.kick).toMatchObject({
      status: "unavailable",
      reasonCode: "platform_unavailable",
    });
    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    const interruptions = published.filter((event) =>
      event.category === "activity" && event.code === "interruption");
    expect(interruptions).toEqual([
      expect.objectContaining({ platform: "kick" }),
    ]);
    expect(published.filter((event) =>
      event.category === "diagnostic"
      && event.platform === "kick"
      && event.message.includes("kick adapter setup failed")
    )).toEqual([
      expect.objectContaining({
        code: "interruption",
        mirroredActivity: true,
        message: "Farming interrupted: reason=platform_error (kick adapter setup failed)",
      }),
    ]);
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("terminalizes startup adapter setup failure instead of leaving checking", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    vi.mocked(env.deps.createAdapters).mockImplementation(() => {
      throw new Error("combined startup construction failed");
    });
    vi.mocked(env.deps.createAdapter).mockImplementation(() => {
      throw new Error("twitch startup adapter failed");
    });

    // Startup now runs a tick (the platform is enabled, and auto-start is on),
    // and a tick absorbs adapter setup failures into a reported interruption
    // rather than rethrowing. What matters is the same: the platform lands on a
    // terminal auth status instead of being stranded in "checking".
    await env.controller.handleStartup().catch(() => undefined);

    expect(env.state.authHealth.twitch).toMatchObject({
      status: "unavailable",
      reasonCode: "platform_unavailable",
    });
  });

  it("reports missing credentials without calling the platform probe", async () => {
    const env = harness(farming(DEFAULT_SETTINGS), {
      checkCredentialAvailability: async () => ({ status: "missing" }),
    });

    await env.controller.checkAuthHealth("twitch");

    expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.state.authHealth.twitch).toEqual(expect.objectContaining({
      status: "missing_credentials",
      reasonCode: "credentials_missing",
    }));
  });

  it("reports credential lookup failure without calling the platform probe", async () => {
    const env = harness(farming(DEFAULT_SETTINGS), {
      checkCredentialAvailability: async () => ({ status: "unavailable" }),
    });

    await env.controller.checkAuthHealth("kick");

    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.state.authHealth.kick).toEqual(expect.objectContaining({
      status: "unavailable",
      reasonCode: "credential_lookup_failed",
    }));
  });

  it("continues to the authenticated probe when credentials are available", async () => {
    const env = harness(farming(DEFAULT_SETTINGS), {
      checkCredentialAvailability: async () => ({ status: "available" }),
    });

    await env.controller.checkAuthHealth("twitch");

    expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.state.authHealth.twitch.status).toBe("healthy");
  });

  it("returns the state committed by the current tick invocation", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    const committed = await env.controller.tickAndHandOff(["twitch"]);

    expect(committed).toEqual(env.state);
    expect(committed?.sessions.twitch.campaignId).toBe("twitch-campaign");
  });

  it("does not return a scheduler snapshot when the tick rolls back", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, tablessMode: true }));
    env.twitch.supportsTabless = true;
    env.twitch.createTablessWatcher = () => {
      throw new Error("watcher setup failed");
    };

    const committed = await env.controller.tickAndHandOff(["twitch"]);

    expect(committed).toBeUndefined();
  });

  it("keeps committed results scoped to overlapping tick invocations", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const twitchDiscovery = deferred<DropCampaign[]>();
    const kickDiscovery = deferred<DropCampaign[]>();
    vi.mocked(env.twitch.refreshCampaigns).mockReturnValueOnce(twitchDiscovery.promise);
    vi.mocked(env.kick.refreshCampaigns).mockReturnValueOnce(kickDiscovery.promise);

    const twitchTick = env.controller.tickAndHandOff(["twitch"]);
    const kickTick = env.controller.tickAndHandOff(["kick"]);
    kickDiscovery.resolve([campaign("kick")]);
    const kickCommitted = await kickTick;
    twitchDiscovery.resolve([campaign("twitch")]);
    const twitchCommitted = await twitchTick;

    expect(kickCommitted?.sessions.kick.campaignId).toBe("kick-campaign");
    expect(twitchCommitted?.sessions.twitch.campaignId).toBe("twitch-campaign");
  });

  it("returns the latest committed platform state when Kick completes last", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const discovery = deferred<DropCampaign[]>();
    vi.mocked(env.kick.refreshCampaigns).mockReturnValueOnce(discovery.promise);
    const ticking = env.controller.tickAndHandOff();
    await vi.waitFor(() => expect(env.state.sessions.twitch.campaignId).toBe("twitch-campaign"));
    discovery.resolve([campaign("kick")]);
    const committed = await ticking;
    expect(committed?.sessions.kick.campaignId).toBe("kick-campaign");
    expect(committed?.sessions.twitch.campaignId).toBe("twitch-campaign");
  });

  it("blocks startup account work when credentials are missing without disabling the platform", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    }, {
      checkCredentialAvailability: async () => ({ status: "missing" }),
    });

    await env.controller.tickAndHandOff(["twitch"]);

    expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.settings.platform.twitch.enabled).toBe(true);
    expect(env.state.authHealth.twitch).toMatchObject({
      status: "missing_credentials",
      reasonCode: "credentials_missing",
    });
    expect(env.state.sessions.twitch).toMatchObject({
      status: "paused",
      reasonCode: "authentication_unhealthy",
    });
  });

  it("automatically resumes a platform after a healthy authentication recheck", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    }, {
      checkCredentialAvailability: async () => ({ status: "available" }),
    });
    vi.mocked(env.twitch.checkAuthHealth)
      .mockResolvedValueOnce({
        status: "invalid_credentials",
        checkedAt: "2026-07-22T12:00:00.000Z",
        reasonCode: "credentials_rejected",
        message: { key: "authInvalidCredentials" },
      })
      .mockResolvedValueOnce({
        status: "healthy",
        checkedAt: "2026-07-22T12:01:00.000Z",
        message: { key: "authHealthy" },
      });

    await env.controller.tickAndHandOff(["twitch"]);
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();

    await env.controller.tickAndHandOff(["twitch"]);

    expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.settings.platform.twitch.enabled).toBe(true);
    expect(env.state.authHealth.twitch.status).toBe("healthy");
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events).filter((event) =>
      event.category === "activity" && event.code === "auth_health_changed"
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ data: expect.objectContaining({ to: "invalid_credentials" }) }),
      expect.objectContaining({ data: expect.objectContaining({ to: "healthy" }) }),
    ]));
  });

  it("publishes authentication transitions when diagnostic logging is disabled", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, diagnosticLogging: false }));
    vi.mocked(env.kick.checkAuthHealth).mockResolvedValueOnce({
      status: "blocked",
      checkedAt: "2026-07-22T12:00:00.000Z",
      reasonCode: "security_policy_blocked",
      message: { key: "authSecurityPolicyBlocked", values: { reference: "safe-ref" } },
    });

    await env.controller.checkAuthHealth("kick");

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "auth_health_changed",
      platform: "kick",
      data: expect.objectContaining({ to: "blocked" }),
    }));
  });

  it("does not strand the popup on \"checking\" when the credential probe throws", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    }, {
      checkCredentialAvailability: async () => {
        throw new Error("cookie read failed");
      },
    });

    await env.controller.tickAndHandOff(["twitch"]);

    // A transient failure reading the session cookies must not roll the whole
    // tick back and leave auth health pinned on its prior "checking" value —
    // that is what keeps the popup stuck on "Checking your signed-in session…".
    expect(env.state.authHealth.twitch.status).not.toBe("checking");
    expect(env.state.authHealth.twitch).toMatchObject({ status: "unavailable" });
  });

  it("preserves a healthy auth-health probe when a later scheduler step throws", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
      },
    });
    // The probe resolves healthy, but reconciling the tabless watcher (which
    // runs after the probe, once the scheduler has decided to watch) throws.
    env.twitch.supportsTabless = true;
    env.twitch.createTablessWatcher = () => {
      throw new Error("tabless watcher boom");
    };
    expect(env.state.authHealth.twitch.status).toBe("checking");

    await env.controller.tickAndHandOff(["twitch"]);

    // The tick rolled back, but the resolved auth health must survive it —
    // otherwise the popup snaps back to "Checking your signed-in session…".
    expect(env.twitch.checkAuthHealth).toHaveBeenCalled();
    expect(env.state.authHealth.twitch.status).toBe("healthy");
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
      expect.objectContaining({ category: "activity", code: "interruption" }),
    );
  });

  it("reports authentication as the reason farming stopped after logout", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    vi.mocked(env.twitch.checkAuthHealth)
      .mockResolvedValueOnce({ status: "healthy", checkedAt: "2026-07-22T12:00:00.000Z" })
      .mockResolvedValueOnce({
        status: "invalid_credentials",
        checkedAt: "2026-07-22T12:01:00.000Z",
        reasonCode: "credentials_rejected",
        message: { key: "authInvalidCredentials" },
      });

    await env.controller.tickAndHandOff(["twitch"]);
    await env.controller.tickAndHandOff(["twitch"]);

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "farming_stopped",
      platform: "twitch",
      data: expect.objectContaining({ reason: "authentication_unhealthy" }),
    }));
  });

  it("recovers Twitch authentication health after login without changing enabled settings", async () => {
    const env = harness(farming(DEFAULT_SETTINGS), {
      checkCredentialAvailability: async () => ({ status: "available" }),
    });
    vi.mocked(env.twitch.checkAuthHealth)
      .mockResolvedValueOnce({
        status: "invalid_credentials",
        checkedAt: "2026-07-22T12:00:00.000Z",
        reasonCode: "credentials_rejected",
        message: { key: "authInvalidCredentials" },
      })
      .mockResolvedValueOnce({
        status: "healthy",
        checkedAt: "2026-07-22T12:05:00.000Z",
        message: { key: "authHealthy" },
      });

    await env.controller.checkAuthHealth("twitch");
    await env.controller.invalidateAuthHealth("twitch");
    await env.controller.checkAuthHealth("twitch");

    expect(env.state.authHealth.twitch).toEqual({
      status: "healthy",
      checkedAt: "2026-07-22T12:05:00.000Z",
      message: { key: "authHealthy" },
    });
    expect(env.settings.platform.twitch.enabled).toBe(true);
    expect(env.settings.platform.kick.enabled).toBe(true);
    expect(env.twitch.checkAuthHealth).toHaveBeenCalledTimes(2);
    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
  });

  it("invalidates only the requested authentication health and reports the transition once", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    vi.mocked(env.twitch.checkAuthHealth).mockResolvedValueOnce({ status: "healthy", checkedAt: "2026-07-22T12:00:00.000Z" });
    vi.mocked(env.kick.checkAuthHealth).mockResolvedValueOnce({
      status: "missing_credentials",
      checkedAt: "2026-07-22T12:00:00.000Z",
      reasonCode: "credentials_missing",
    });
    await env.controller.checkAuthHealth("twitch");
    await env.controller.checkAuthHealth("kick");
    const previousKickHealth = env.state.authHealth.kick;
    env.reportEvents.mockClear();

    await env.controller.invalidateAuthHealth("twitch");

    expect(env.state.authHealth.twitch).toEqual({ status: "checking" });
    expect(env.state.authHealth.kick).toEqual(previousKickHealth);
    expect(env.reportEvents).toHaveBeenCalledWith([
      {
        category: "activity",
        code: "auth_health_changed",
        level: "info",
        platform: "twitch",
        data: { from: "healthy", to: "checking" },
        emittedAt: expect.any(String),
      },
      {
        category: "diagnostic",
        code: "auth_health_changed",
        level: "info",
        platform: "twitch",
        mirroredActivity: true,
        message: "twitch authentication health changed from healthy to checking",
        controllerRunId: expect.any(String),
        data: { from: "healthy", to: "checking" },
        emittedAt: expect.any(String),
      },
    ]);

    env.reportEvents.mockClear();
    await env.controller.invalidateAuthHealth("twitch");
    expect(env.reportEvents).not.toHaveBeenCalled();
  });

  it("checks and persists authentication health for only the requested platform", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    vi.mocked(env.kick.checkAuthHealth).mockResolvedValueOnce({
      status: "blocked",
      checkedAt: "2026-07-22T12:00:00.000Z",
      reasonCode: "security_policy_blocked",
      message: { key: "authSecurityPolicyBlocked", values: { reference: "safe-ref" } },
    });

    await env.controller.checkAuthHealth("kick");

    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.state.authHealth.kick).toEqual(expect.objectContaining({
      status: "blocked",
      reasonCode: "security_policy_blocked",
    }));
    expect(env.reportEvents).toHaveBeenCalledWith([
      {
        category: "activity",
        code: "auth_health_changed",
        level: "error",
        platform: "kick",
        data: { from: "checking", to: "blocked", reason: "security_policy_blocked" },
        emittedAt: expect.any(String),
      },
      {
        category: "diagnostic",
        code: "auth_health_changed",
        level: "error",
        platform: "kick",
        mirroredActivity: true,
        message: "kick authentication health changed from checking to blocked: reason=security_policy_blocked",
        controllerRunId: expect.any(String),
        data: { from: "checking", to: "blocked", reason: "security_policy_blocked" },
        emittedAt: expect.any(String),
      },
    ]);
  });

  it("stores timestamp-only auth refreshes without repeating activity", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    vi.mocked(env.kick.checkAuthHealth)
      .mockResolvedValueOnce({ status: "healthy", checkedAt: "2026-07-22T12:00:00.000Z" })
      .mockResolvedValueOnce({ status: "healthy", checkedAt: "2026-07-22T12:05:00.000Z" });

    await env.controller.checkAuthHealth("kick");
    env.reportEvents.mockClear();
    await env.controller.checkAuthHealth("kick");

    expect(env.state.authHealth.kick.checkedAt).toBe("2026-07-22T12:05:00.000Z");
    expect(env.reportEvents).not.toHaveBeenCalled();
  });

  it("strips hostile adapter fields before auth state and events are persisted", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    vi.mocked(env.twitch.checkAuthHealth).mockResolvedValueOnce({
      status: "healthy",
      checkedAt: "2026-07-22T12:00:00.000Z",
      token: "do-not-store",
      headers: { authorization: "Bearer do-not-store" },
    } as never);

    await env.controller.checkAuthHealth("twitch");

    expect(JSON.stringify(env.state.authHealth.twitch)).not.toContain("do-not-store");
    expect(JSON.stringify(env.reportEvents.mock.calls)).not.toContain("do-not-store");
  });

  it("reports the effective compatibility profile and capability once per enabled platform", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.tick();
    await env.controller.tick();

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      compatibilityProfile: "twitch-2026-07",
      compatibilityCapability: "twitch-heartbeat-spade-v1",
    }));
    expect(published).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "kick",
      compatibilityProfile: "kick-2026-07",
      compatibilityCapability: "kick-claim-v2",
      compatibilityCapabilities: ["kick-claim-v2"],
    }));
    expect(published.filter((event) =>
      event.category === "diagnostic"
      && "compatibilityProfile" in event
      && event.platform === "twitch"
    )).toHaveLength(1);
    expect(published.filter((event) =>
      event.category === "diagnostic"
      && "compatibilityProfile" in event
      && event.platform === "kick"
    )).toHaveLength(1);
    expect(JSON.stringify(published)).not.toContain("auth-token");
  });

  it("reports enabled compatibility selections on startup while farming is paused", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.handleStartup();

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      compatibilityProfile: "twitch-2026-07",
      compatibilityCapability: "twitch-heartbeat-spade-v1",
    }));
  });

  it("reports compatibility again only when the effective selection changes", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.tick();
    await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { compatibility: { twitch: { heartbeatTransport: "twitch-heartbeat-gql-v1" } } },
      tickAfterSave: true,
    });

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published.filter((event) =>
      event.category === "diagnostic"
      && "compatibilityCapability" in event
      && event.compatibilityCapability === "twitch-heartbeat-gql-v1"
    )).toHaveLength(1);
  });

  it("emits credential-safe resolver warnings without echoing persisted selections", async () => {
    const hostileSelection = "unknown-auth-token=secret-cookie";
    const env = harness(farming({
      ...DEFAULT_SETTINGS,
      compatibility: {
        ...DEFAULT_SETTINGS.compatibility,
        twitch: {
          ...DEFAULT_SETTINGS.compatibility.twitch,
          heartbeatTransport: hostileSelection,
        },
      },
    }));

    await env.controller.handleStartup();

    const serialized = JSON.stringify(env.reportEvents.mock.calls.flatMap(([events]) => events));
    expect(serialized).not.toContain(hostileSelection);
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: "Unknown Twitch heartbeat compatibility selection; using twitch-heartbeat-spade-v1",
      compatibilityCapability: "twitch-heartbeat-spade-v1",
    }));
  });

  it("uses profile metadata for profile resolver warnings", async () => {
    const env = harness(farming({
      ...DEFAULT_SETTINGS,
      compatibility: {
        ...DEFAULT_SETTINGS.compatibility,
        twitch: { ...DEFAULT_SETTINGS.compatibility.twitch, profile: "unknown-profile" },
      },
    }));

    await env.controller.handleStartup();

    const warning = env.reportEvents.mock.calls.flatMap(([events]) => events).find((event) =>
      event.category === "diagnostic" && event.platform === "twitch" && event.level === "warn");
    expect(warning).toEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      compatibilityProfile: "twitch-2026-07",
    }));
    expect(warning).not.toHaveProperty("compatibilityCapability");
    expect(warning).not.toHaveProperty("compatibilityVersion");
  });

  it("preserves compatibility diagnostics when a scheduler tick fails", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.twitch.refreshCampaigns = vi.fn(async () => { throw new Error("discovery failed"); });

    await env.controller.tick();

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      compatibilityProfile: "twitch-2026-07",
    }));
  });

  it("does not emit resolver warnings for a disabled platform", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
      },
      compatibility: {
        ...DEFAULT_SETTINGS.compatibility,
        twitch: { ...DEFAULT_SETTINGS.compatibility.twitch, heartbeatTransport: "invalid-secret" },
      },
    });

    await env.controller.handleStartup();

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events).filter((event) =>
      event.category === "diagnostic" && event.platform === "twitch" && event.level === "warn"
    )).toEqual([]);
  });

  it("emits a fresh warning when a different invalid selection resolves identically", async () => {
    const env = harness(farming({
      ...DEFAULT_SETTINGS,
      compatibility: {
        ...DEFAULT_SETTINGS.compatibility,
        twitch: { ...DEFAULT_SETTINGS.compatibility.twitch, heartbeatTransport: "first-secret" },
      },
    }));

    await env.controller.handleStartup();
    await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { compatibility: { twitch: { heartbeatTransport: "second-secret" } } },
      tickAfterSave: true,
    });

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published.filter((event) =>
      event.category === "diagnostic"
      && event.platform === "twitch"
      && event.level === "warn"
      && event.message === "Unknown Twitch heartbeat compatibility selection; using twitch-heartbeat-spade-v1"
    )).toHaveLength(2);
    expect(JSON.stringify(published)).not.toContain("first-secret");
    expect(JSON.stringify(published)).not.toContain("second-secret");
  });

  it("emits a fixed host-incompatible warning with only the safe fallback identifier", async () => {
    const env = harness(farming({
      ...DEFAULT_SETTINGS,
      compatibility: {
        ...DEFAULT_SETTINGS.compatibility,
        twitch: {
          ...DEFAULT_SETTINGS.compatibility.twitch,
          heartbeatTransport: "twitch-heartbeat-trowel-v1",
        },
      },
    }));

    await env.controller.handleStartup();

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: "Host-incompatible Twitch heartbeat compatibility selection; using twitch-heartbeat-spade-v1",
    }));
  });

  it("saves each operational state before publishing its ordered batch", async () => {
    const calls: string[] = [];
    const env = harness(farming(DEFAULT_SETTINGS), {
      saveState: async () => { calls.push("state"); },
      // Controller-run and tick lifecycle diagnostics are published as they
      // happen and describe no state, so they are outside the
      // state-before-events batching invariant this test guards. Only
      // operational batches are recorded.
      reportEvents: async (events) => {
        if (events.every((event) =>
          event.category === "diagnostic"
          && /^(?:Background controller run |Tick #)/.test(event.message))) return;
        calls.push("events");
      },
    });

    await env.controller.tick();

    expect(calls).toEqual([
      "state", "events",
      "state", "events",
      "state", "events",
      "state", "events",
    ]);
  });

  it("does not publish tick events when the corresponding state save fails", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    let saveCalls = 0;
    env.deps.saveState.mockImplementation(async (next: SchedulerState) => {
      saveCalls += 1;
      if (saveCalls === 2) throw new Error("storage unavailable");
      Object.assign(env.state, next);
    });

    await expect(env.controller.tick(["twitch"])).rejects.toThrow("storage unavailable");

    expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.deps.saveState).toHaveBeenCalledTimes(2);
    // Controller-run and tick lifecycle diagnostics publish independently of
    // state, so the invariant under test is about operational batches only.
    const operationalBatches = env.reportEvents.mock.calls
      .map(([events]) => events)
      .filter((events) => !events.every((event) =>
        event.category === "diagnostic"
        && /^(?:Background controller run |Tick #)/.test(event.message)));
    expect(operationalBatches).toHaveLength(1);
    expect(operationalBatches[0]).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "auth_health_changed",
      platform: "twitch",
    }));
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events).some((event) =>
      event.category === "diagnostic" && event.message.startsWith("Campaign inventory changed")
    )).toBe(false);
  });

  it("never persists an event outbox in scheduler state", async () => {
    const env = harness();

    await env.controller.tick();

    expect(env.deps.saveState).toHaveBeenCalledWith(expect.not.objectContaining({ events: expect.anything() }));
  });

  it("publishes adapter construction events in the auth phase without leaking into the scheduler batch", async () => {
    const env = harness();
    vi.mocked(env.deps.createAdapter).mockImplementation((platform, emit, settings) => {
      emit({ category: "diagnostic", level: "debug", message: "adapter-created" });
      return {
        adapter: platform === "twitch" ? env.twitch : env.kick,
        ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
      };
    });

    await env.controller.tick();

    const batches = env.reportEvents.mock.calls.map(([events]) => events);
    const authBatchIndex = batches.findIndex((events) =>
      events.some((event) => event.category === "diagnostic" && event.message === "adapter-created"));
    const schedulerBatchIndex = batches.findIndex((events) =>
      events.some((event) => event.category === "diagnostic" && event.message.startsWith("Campaign inventory changed"))
    );
    expect(authBatchIndex).toBeGreaterThanOrEqual(0);
    expect(schedulerBatchIndex).toBeGreaterThan(authBatchIndex);
    expect(batches[schedulerBatchIndex]).not.toContainEqual(expect.objectContaining({ message: "adapter-created" }));
  });

  it("flushes standalone Kick search and manual claim successes into their own reports", async () => {
    const env = harness(DEFAULT_SETTINGS, { initialState: {
      ...DEFAULT_STATE,
      campaigns: { twitch: [], kick: [campaign("kick", "claimable")] },
    } });
    const discoveryState = new KickDiscoveryState();
    env.deps.createAdapters.mockImplementation((emit, settings) => ({
      adapters: { twitch: env.twitch, kick: kickAdapter(createKickFetcher({
        background: async (url) => url.includes("/search") ? { categories: [] } : { success: true },
        routeState: discoveryState.routeDiagnostics,
      }), undefined, undefined, emit, { discoveryState }) },
      ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
    }));
    await env.controller.handleMessage({ type: "searchCategories", platform: "kick", query: "private-query" });
    const searchReports = allDiagnostics(env).filter((event) => event.code === "kick_fetch_summary");
    expect(searchReports.map((event) => event.data)).toEqual([{ "kick.com.background": 1 }]);
    await env.controller.handleMessage({ type: "claimReward", platform: "kick", campaignId: "kick-campaign", rewardId: "reward" });
    const summaries = allDiagnostics(env).filter((event) => event.code === "kick_fetch_summary");
    expect(summaries.map((event) => event.data)).toEqual([{ "kick.com.background": 1 }, { "web.kick.com.background": 1 }]);
    expect(JSON.stringify(summaries)).not.toContain("private-query");
    env.controller.shutdown();
  });

  it("publishes category-search diagnostics in their own operation without leaking into the next tick", async () => {
    const env = harness();
    env.twitch.searchCategories = vi.fn(async () => {
      throw new Error("category lookup failed");
    });

    await env.controller.handleMessage({ type: "searchCategories", platform: "twitch", query: "game" });

    expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: "Category search failed: category lookup failed",
      }),
    ]));

    env.reportEvents.mockClear();
    await env.controller.tick();

    const tickEvents = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(tickEvents.some((event) => event.category === "diagnostic" && event.message.includes("category lookup failed"))).toBe(false);
  });

  it("publishes lifecycle events through the host sink without persisting log history", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([{
      ...campaign("twitch"),
      url: "https://example.test/campaign",
      rewards: [{ ...reward(), imageUrl: "https://cdn.example.test/reward.png" }],
    }]);

    await env.controller.tick();
    await env.controller.tick();

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published.filter((event) => event.category === "activity" && event.code === "farming_started")).toHaveLength(1);
    expect(published).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "farming_started",
      platform: "twitch",
      data: expect.objectContaining({
        rewardImageUrl: "https://cdn.example.test/reward.png",
        campaignUrl: "https://example.test/campaign",
      }),
    }));
    // The activity entry always brings its English diagnostic mirror along.
    expect(published.filter((event) => event.category === "diagnostic" && event.code === "farming_started")).toHaveLength(1);
    expect(env.deps.saveState).toHaveBeenCalledWith(expect.not.objectContaining({ events: expect.anything() }));
  });

  it("does not commit pending-claim diagnostics when scheduler state persistence fails", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([campaign("twitch", "claimable")]);
    env.twitch.isClaimReady = vi.fn(() => false);
    env.deps.saveState.mockRejectedValueOnce(new Error("state write failed"));

    await expect(env.controller.tick()).rejects.toThrow("state write failed");
    await env.controller.tick();

    const waitingEvents = env.reportEvents.mock.calls
      .flatMap(([events]) => events)
      .filter((event) => event.category === "diagnostic" && event.message.includes("waiting for"));
    expect(waitingEvents).toHaveLength(1);
  });

  it("preserves route transition and lifecycle failure evidence when scheduler publication fails", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      preferKnownChannels: false,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
      },
    });
    const discoveryState = new KickDiscoveryState();
    env.deps.createAdapter.mockImplementation((platform, emit, settings) => {
      const kick = kickAdapter(createKickFetcher({
        routeState: discoveryState.routeDiagnostics,
        background: async (url) => {
          if (url.endsWith("/user")) return { id: 42 };
          throw new KickWafBlockedError("secret");
        },
        pageFetch: async () => ({ data: [] }),
        onPageFallback: () => { throw new Error("secret lifecycle"); },
      }), undefined, undefined, emit, { discoveryState });
      // Simulate a host capability becoming unavailable during reconciliation,
      // after network discovery but before scheduler publication.
      Object.defineProperty(kick, "createDiscoverySignalController", { get: () => { throw new Error("publication failed"); } });
      return {
        adapter: platform === "kick" ? kick : env.twitch,
        ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
      };
    });
    await env.controller.tick(["kick"]);
    const diagnostics = allDiagnostics(env);
    expect(diagnostics.some((event) => event.code === "kick_fetch_route" && event.message.includes("using page tab"))).toBe(true);
    expect(diagnostics.filter((event) => event.code === "kick_fetch_lifecycle_failed").length).toBeGreaterThanOrEqual(2);
    expect(diagnostics.some((event) => event.code === "kick_fetch_summary" && Number(event.data?.["web.kick.com.page"]) >= 2)).toBe(true);
    expect(JSON.stringify(diagnostics.filter((event) => event.code?.startsWith("kick_fetch_")))).not.toContain("secret");
    env.controller.shutdown();
  });

  it("reports bounded complete route counts from fresh Kick adapters across repeated ticks", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      preferKnownChannels: false,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true, idleWatchlistChannels: Array.from({ length: 50 }, (_, index) => `channel-${index}`) },
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
      },
    });
    const discoveryState = new KickDiscoveryState();
    let requests = 0;
    env.deps.createAdapter.mockImplementation((platform, emit, settings) => ({
      adapter: platform === "kick" ? kickAdapter(createKickFetcher({
        routeState: discoveryState.routeDiagnostics,
        background: async (url) => {
          requests += 1;
          if (url.endsWith("/user")) return { id: 42 };
          if (url.includes("/channels/")) return { livestream: null };
          return { data: [] };
        },
        pageFetch: async () => { throw new Error("unexpected fallback"); },
      }), undefined, undefined, emit, { discoveryState }) : env.twitch,
      ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
    }));
    for (let tick = 0; tick < 50; tick += 1) await env.controller.tick(["kick"]);
    const events = env.reportEvents.mock.calls.flatMap(([batch]) => batch);
    const summaries = events.filter((event) => event.category === "diagnostic" && event.code === "kick_fetch_summary") as DiagnosticEvent[];
    expect(requests).toBeGreaterThan(2500);
    expect(summaries.length).toBeGreaterThanOrEqual(50);
    expect(summaries.length).toBeLessThanOrEqual(150);
    const summarized = summaries.reduce((total, event) => total + Object.values(event.data ?? {}).reduce<number>((sum, count) => sum + Number(count), 0), 0);
    expect(summarized).toBe(requests);
    expect(events.filter((event) => event.category === "diagnostic" && event.code === "kick_fetch_route")).toHaveLength(2);
    expect(summaries.every((event) => event.controllerRunId && event.platformTickId)).toBe(true);
    env.controller.shutdown();
  });

  it("publishes one actionable link-required diagnostic while repeated automatic claims are suppressed", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
      },
    });
    let claimPosts = 0;
    let affirmativelyLinked = false;
    const fetcher: PageFetcher = {
      fetchJson: vi.fn(async (url: string) => {
        if (url === "https://kick.com/api/v1/user") {
          return { id: 123, username: "tester" };
        }
        if (url === "https://web.kick.com/api/v1/drops/claim") {
          claimPosts += 1;
          return { data: { connect_url: "https://accounts.example/link" } };
        }
        if (url === "https://web.kick.com/api/v1/drops/campaigns") {
          return {
            data: [{
              id: "kick-campaign",
              name: "Kick campaign",
              status: "active",
              rewards: [{
                id: "kick-reward",
                name: "Reward",
                required_minutes: 1,
              }],
            }],
          };
        }
        if (url === "https://web.kick.com/api/v1/drops/progress") {
          return {
            data: [{
              campaign_id: "kick-campaign",
              progress_units: 2,
              ...(affirmativelyLinked ? { user_app_connected: true } : {}),
            }],
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      }) as PageFetcher["fetchJson"],
    };
    const claimState = new KickClaimState();
    env.deps.createAdapter.mockImplementation((platform, emit, settings) => {
      const kick = kickAdapter(fetcher, undefined, undefined, emit, { claimState });
      kick.listCandidateChannels = vi.fn(async () => []);
      return {
        adapter: platform === "kick" ? kick : env.twitch,
        ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
      };
    });

    await env.controller.tick();
    await env.controller.tick();

    expect(claimPosts).toBe(1);
    const events = env.reportEvents.mock.calls.flatMap(([batch]) => batch);
    expect(events.filter((event) =>
      event.category === "diagnostic"
      && event.level === "warn"
      && event.message.includes("using the account-link action")
    )).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("https://accounts.example/link");
    expect(env.state.campaigns.kick[0].rewards[0].claimGuidance).toEqual({
      kind: "link_required",
      url: "https://accounts.example/link",
    });

    affirmativelyLinked = true;
    await env.controller.tick();
    expect(claimPosts).toBe(2);

    const separateState = new KickClaimState();
    const separateAdapter = kickAdapter(fetcher, undefined, undefined, () => {}, { claimState: separateState });
    await separateAdapter.claimReward(campaign("kick", "claimable"), campaign("kick", "claimable").rewards[0]);
    expect(claimPosts).toBe(3);
  });

  it("publishes a farming stop reason when automation is disabled", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([{
      ...campaign("twitch"),
      url: "https://example.test/campaign",
      rewards: [{ ...reward(), imageUrl: "https://cdn.example.test/reward.png" }],
    }]);
    await env.controller.tick();

    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: false });

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "farming_stopped",
      data: expect.objectContaining({
        reason: "automation_disabled",
        rewardImageUrl: "https://cdn.example.test/reward.png",
        campaignUrl: "https://example.test/campaign",
      }),
    }));
    expect(env.deps.saveState).toHaveBeenCalledWith(expect.not.objectContaining({ events: expect.anything() }));
  });

  it("publishes an interruption when an idle platform is paused by manual watch", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      pauseOnManualWatch: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    env.state.manualWatch = {
      twitch: {
        platform: "twitch",
        tabId: 99,
        checkedAt: new Date().toISOString(),
        active: true,
      },
    };

    await env.controller.tick();

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "interruption",
      platform: "twitch",
      data: expect.objectContaining({ reason: "manual_watch" }),
    }));
  });

  it("creates the scheduler alarm from persisted settings", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, pollIntervalMinutes: 11 }));

    await env.controller.ensureAlarm();

    expect(env.deps.clearAlarm).toHaveBeenCalledWith(ALARM_NAME);
    expect(env.deps.createAlarm).toHaveBeenCalledWith(TWITCH_ALARM_NAME, { periodInMinutes: 11 });
    expect(env.deps.createAlarm).toHaveBeenCalledWith(KICK_ALARM_NAME, { periodInMinutes: 11 });
  });

  it("stamps the install time once through the serialized controller lifecycle", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.ensureInstalledAt("2026-07-26T12:00:00.000Z");
    await env.controller.ensureInstalledAt("2026-07-26T13:00:00.000Z");

    expect(env.state.installedAt).toBe("2026-07-26T12:00:00.000Z");
  });

  it("preserves a state write that lands while startup setup reporting is pending", async () => {
    const setupReported = deferred<void>();
    const env = harness(
      farming(DEFAULT_SETTINGS),
      { reportEvents: async () => setupReported.promise },
    );
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 44,
      tabManagedByExtension: true,
    };

    const startup = env.controller.handleStartup();
    await vi.waitFor(() => expect(env.reportEvents).toHaveBeenCalled());
    await env.deps.saveState({
      ...env.state,
      installedAt: "2026-07-26T12:00:00.000Z",
    });
    setupReported.resolve();
    await startup;

    expect(env.state.installedAt).toBe("2026-07-26T12:00:00.000Z");
  });

  it("preserves a settings patch that lands while startup setup reporting is pending", async () => {
    const setupReported = deferred<void>();
    const env = harness(
      farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: true }),
      { reportEvents: async () => setupReported.promise },
    );

    const startup = env.controller.handleStartup();
    await vi.waitFor(() => expect(env.reportEvents).toHaveBeenCalled());
    await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { diagnosticLogging: false },
      tickAfterSave: false,
    });
    setupReported.resolve();
    await startup;

    expect(isFarmingActive(env.settings)).toBe(true);
    expect(env.settings.diagnosticLogging).toBe(false);
  });

  it("refreshes enabled auth health from ensureAlarm while farming is stopped", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      autoStartDropFarming: false,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });

    await env.controller.ensureAlarm();

    expect(env.state.authHealth.twitch.status).toBe("healthy");
    expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
  });

  // Auth health is only probed for enabled platforms, and auto-start off now
  // disables them on launch — so startup neither farms nor probes, and the popup
  // reports auth once the user switches a platform back on.
  it("neither farms nor probes on startup when auto-start disabled every platform", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: false }));

    await env.controller.handleStartup();

    expect(isFarmingActive(env.settings)).toBe(false);
    expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("refreshes enabled auth health on startup while auto-start keeps farming", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: true }));

    await env.controller.handleStartup();

    expect(env.state.authHealth.twitch.status).toBe("healthy");
    expect(env.state.authHealth.kick.status).toBe("healthy");
  });

  it("auto-starts on launch only when a platform is enabled", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: true }));

    await env.controller.ensureAlarm();

    expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
  });

  it("clears stale restart tabs and auto-resumes with fresh tabs when auto-start is enabled", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: true }));
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      campaignId: "old-campaign",
      rewardId: "old-reward",
      offlineChecks: 2,
      playbackChecks: 1,
      errorChecks: 1,
      retryAfter: new Date(Date.now() + 60_000).toISOString(),
      tabId: 44,
      tabManagedByExtension: true,
      playback: {
        platform: "twitch",
        checkedAt: new Date().toISOString(),
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
      },
    };
    env.state.campaigns.twitch = [{
      ...campaign("twitch"),
      id: "old-campaign",
      rewards: [{ ...reward(), id: "old-reward" }],
    }];
    env.state.managedWatchTabs = {
      twitch: {
        platform: "twitch",
        tabId: 44,
        channelUrl: "https://www.twitch.tv/twitch-creator",
        ownedByExtension: true,
      },
    };

    await env.controller.handleStartup();

    expect(env.deps.createAlarm).toHaveBeenCalledWith(TWITCH_ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.deps.createAlarm).toHaveBeenCalledWith(KICK_ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.deps.closeManagedTabs).toHaveBeenCalledWith([
      expect.objectContaining({ tabId: 44, channelUrl: "https://www.twitch.tv/twitch-creator", ownedByExtension: true }),
    ]);
    expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.state.sessions.twitch.status).toBe("watching");
    expect(env.state.sessions.twitch.tabId).toBe(10);
    expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        category: "activity",
        code: "farming_stopped",
        data: expect.objectContaining({ reason: "runtime_restart" }),
      }),
    ]));
  });

  it("pauses stale restart sessions and disables running when auto-start is disabled", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: false }));
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 44,
      tabManagedByExtension: true,
    };
    env.state.managedWatchTabs = {
      twitch: {
        platform: "twitch",
        tabId: 44,
        channelUrl: "https://www.twitch.tv/twitch-creator",
        ownedByExtension: true,
      },
    };

    await env.controller.handleStartup();

    expect(isFarmingActive(env.settings)).toBe(false);
    expect(env.deps.closeManagedTabs).toHaveBeenCalledWith([
      expect.objectContaining({ tabId: 44, channelUrl: "https://www.twitch.tv/twitch-creator", ownedByExtension: true }),
    ]);
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.state.managedWatchTabs).toEqual({});
    expect(env.state.sessions.twitch).toMatchObject({
      status: "paused",
      tabId: undefined,
      tabManagedByExtension: undefined,
      message: "Browser restarted; farming paused",
    });
  });

  it("cleans stale restart state without starting farming when automation is already stopped", async () => {
    const env = harness(notFarming({ ...DEFAULT_SETTINGS, autoStartDropFarming: true }));
    env.state.sessions.kick = {
      platform: "kick",
      status: "paused",
      channel: channel("kick"),
      offlineChecks: 0,
      tabId: 55,
      tabManagedByExtension: true,
    };
    env.state.managedWatchTabs = {
      kick: {
        platform: "kick",
        tabId: 55,
        channelUrl: "https://kick.com/kick-creator",
        ownedByExtension: true,
      },
    };

    await env.controller.handleStartup();

    expect(isFarmingActive(env.settings)).toBe(false);
    expect(env.deps.closeManagedTabs).toHaveBeenCalledWith([
      expect.objectContaining({ tabId: 55, channelUrl: "https://kick.com/kick-creator", ownedByExtension: true }),
    ]);
    expect(env.kick.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.state.sessions.kick.status).toBe("paused");
    expect(env.state.sessions.kick.tabId).toBeUndefined();
  });

  it("clears stale retained page-context tabs on startup", async () => {
    const env = harness(notFarming({ ...DEFAULT_SETTINGS, autoStartDropFarming: true }));
    env.state.managedPageContextTabs = {
      twitch: {
        platform: "twitch",
        tabId: 66,
        originUrl: "https://www.twitch.tv/drops/inventory",
        origin: "https://www.twitch.tv",
        ownedByExtension: true,
      },
    };

    await env.controller.handleStartup();

    expect(env.deps.closeManagedTabs).not.toHaveBeenCalled();
    expect(env.deps.stopPageContextTabs).toHaveBeenCalledWith(
      expect.objectContaining({ twitch: expect.objectContaining({ tabId: 66 }) }),
      expect.objectContaining({ platforms: ["twitch", "kick"], reason: "runtime_restart", emit: expect.any(Function) }),
    );
    expect(env.state.managedPageContextTabs).toEqual({});
    expect(env.state.sessions.twitch).toMatchObject({
      status: "paused",
      tabId: undefined,
      message: "Browser restarted; farming paused",
    });
  });

  it("preserves a retained Kick page context across a running service-worker restart", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      autoStartDropFarming: true,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false, idleWatchlistChannels: [] },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
      },
    });
    const context = {
      platform: "kick" as const,
      tabId: 91,
      originUrl: "https://kick.com/drops/inventory",
      origin: "https://kick.com",
      ownedByExtension: true as const,
      lastFallbackAt: "2026-07-22T08:00:00.000Z",
      fallbackHost: "web.kick.com",
      backgroundSuccesses: 0,
    };
    env.state.managedPageContextTabs = { kick: context };

    await env.controller.handleStartup();

    expect(env.deps.stopPageContextTabs).not.toHaveBeenCalledWith(
      expect.objectContaining({ kick: expect.objectContaining({ tabId: 91 }) }),
      expect.objectContaining({ reason: "runtime_restart" }),
    );
    expect(env.state.managedPageContextTabs?.kick).toEqual(context);
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
  });

  it("does not log startup cleanup when there is no stale farming state", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: true }));

    await env.controller.handleStartup();

    expect(env.deps.createAlarm).toHaveBeenCalledWith(TWITCH_ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.deps.createAlarm).toHaveBeenCalledWith(KICK_ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.deps.closeManagedTabs).not.toHaveBeenCalled();
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events).some((event) =>
      event.category === "diagnostic" && event.message.includes("Browser restarted")
    )).toBe(false);
  });

  it("disables every platform on startup when auto-start is disabled even without stale tabs", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: false }));

    await env.controller.handleStartup();

    expect(isFarmingActive(env.settings)).toBe(false);
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("answers an automation toggle without waiting for the scheduler tick", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    let startDiscovery = (): void => {};
    const discoveryStarted = new Promise<void>((resolve) => {
      const blocked = new Promise<void>((release) => { startDiscovery = () => release(); });
      vi.mocked(env.twitch.refreshCampaigns).mockImplementation(async () => {
        resolve();
        await blocked;
        return [];
      });
    });

    // The raw controller, so the harness does not settle the background tick for
    // us — that is exactly what this test is about.
    const snapshot = asSnapshot(await env.rawController.handleMessage({
      type: "setAutomation",
      platform: "twitch",
      enabled: true,
    }));

    // The reply landed while discovery is still blocked: a slow tick can no
    // longer hold the popup open (the 65s stall reported in the wild).
    await discoveryStarted;
    expect(env.twitch.refreshCampaigns).toHaveBeenCalled();
    expect(isFarmingActive(snapshot.settings)).toBe(true);
    // And the session already reflects the toggle rather than the pre-toggle
    // "Automation disabled" the popup used to render for the whole tick.
    expect(snapshot.state.sessions.twitch.status).toBe("starting");

    startDiscovery();
    await env.rawController.settleBackgroundWork();
  });

  it.each([
    ["twitch", true, "Twitch automation enable"],
    ["kick", false, "Kick automation disable"],
  ] as const)("logs the requested and completed %s automation transition", async (platform, enabled, transition) => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.handleMessage({
      type: "setAutomation",
      platform,
      enabled,
    });

    const diagnostics = env.reportEvents.mock.calls
      .flatMap(([events]) => events)
      .filter((event): event is DiagnosticEvent => event.category === "diagnostic");
    expect(diagnostics).toContainEqual(expect.objectContaining({
      platform,
      level: "info",
      message: `User requested ${transition}`,
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      platform,
      level: "info",
      message: `${transition} completed`,
    }));
  });

  it("logs when a Twitch enable tick queues behind existing Twitch work", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const twitchDiscovery = deferred<DropCampaign[]>();
    env.twitch.refreshCampaigns = vi.fn(() => twitchDiscovery.promise);

    const alarmTick = env.rawController.tick(["twitch"], "alarm");
    await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());
    const enabling = env.rawController.handleMessage({
      type: "setAutomation",
      platform: "twitch",
      enabled: true,
    });

    try {
      await vi.waitFor(() => {
        expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
          expect.objectContaining({
            category: "diagnostic",
            platform: "twitch",
            level: "info",
            message: "Twitch automation enable queued behind an active tick",
          }),
        );
      });
    } finally {
      twitchDiscovery.resolve([]);
      await Promise.all([alarmTick, enabling]);
      await env.rawController.settleBackgroundWork();
    }
  });

  it("brackets every tick with a lifecycle diagnostic naming its trigger and duration", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.tick(["twitch"], "manual_tick");

    const diagnostics = env.reportEvents.mock.calls
      .flatMap(([events]) => events)
      .filter((event): event is DiagnosticEvent => event.category === "diagnostic");
    expect(diagnostics).toContainEqual(expect.objectContaining({
      platform: "twitch",
      globalTickId: 1,
      platformTickId: 1,
      message: expect.stringMatching(/^Tick #\d+ started \(trigger=manual_tick, platforms=twitch\)$/),
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      platform: "twitch",
      globalTickId: 1,
      platformTickId: 1,
      code: "auth_health_changed",
      mirroredActivity: true,
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      platform: "twitch",
      globalTickId: 1,
      platformTickId: 1,
      message: expect.stringMatching(/^Tick #\d+ refreshed auth health in \d+ms$/),
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      platform: "twitch",
      globalTickId: 1,
      platformTickId: 1,
      message: expect.stringMatching(/^Campaign refresh finished in \d+ms/),
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      platform: "twitch",
      globalTickId: 1,
      platformTickId: 1,
      message: expect.stringMatching(/^Tick #\d+ finished after \d+ms \(trigger=manual_tick, platforms=twitch\)$/),
    }));
  });

  it("coalesces same-platform ticks before discovery or the scheduler lock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
    const env = harness(farming(DEFAULT_SETTINGS));
    const twitchDiscovery = deferred<DropCampaign[]>();
    const firstDiscoveryStarted = deferred<void>();
    let discoveryCalls = 0;
    env.twitch.refreshCampaigns = vi.fn(async () => {
      discoveryCalls += 1;
      if (discoveryCalls === 1) {
        firstDiscoveryStarted.resolve();
        await twitchDiscovery.promise;
      }
      return [];
    });
    const firstTick = env.rawController.tick(["twitch"], "manual_tick");
    let secondTick: ReturnType<typeof env.rawController.tick> | undefined;

    try {
      await firstDiscoveryStarted.promise;
      secondTick = env.rawController.tick(["twitch"], "manual_tick");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await vi.advanceTimersByTimeAsync(75);
      twitchDiscovery.resolve([]);
      await Promise.all([firstTick, secondTick]);

      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        category: "diagnostic",
        platform: "twitch",
        message: "Coalesced scheduler triggers (count=1, reasons=manual_tick:1)",
      }));
      expect(allDiagnostics(env).some((event) =>
        event.message.includes("waited") && event.message.includes("platform work"),
      )).toBe(false);
    } finally {
      twitchDiscovery.resolve([]);
      await Promise.allSettled(secondTick ? [firstTick, secondTick] : [firstTick]);
      vi.useRealTimers();
    }
  });

  it("admits one Twitch tick and one follow-up across repeated alarm intervals while Kick progresses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const env = harness(farming(DEFAULT_SETTINGS));
    const discovery = deferred<DropCampaign[]>();
    vi.mocked(env.twitch.refreshCampaigns).mockReturnValueOnce(discovery.promise);
    const first = env.controller.tickAndHandOff(["twitch"], "alarm");
    await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());
    const pending: Promise<unknown>[] = [];
    for (let interval = 0; interval < 5; interval += 1) {
      vi.setSystemTime(Date.now() + 60_000);
      pending.push(env.controller.tickAndHandOff(["twitch"], "alarm"));
    }
    const sharedPending = pending.every((request) => request === pending[0]);
    await env.controller.tickAndHandOff(["kick"], "alarm");
    expect(env.state.sessions.kick.campaignId).toBe("kick-campaign");
    const starts = () => allDiagnostics(env).filter((event) => event.platform === "twitch" && /Tick #\d+ started/.test(event.message));
    const activeStarts = starts().length;
    discovery.resolve([campaign("twitch")]);
    await Promise.all([first, ...pending]);
    expect(activeStarts).toBe(1);
    expect(sharedPending).toBe(true);
    expect(starts()).toHaveLength(2);
    expect(env.twitch.checkAuthHealth).toHaveBeenCalledTimes(2);
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(2);
    expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
      platform: "twitch",
      message: expect.stringContaining("Coalesced scheduler triggers (count=5, reasons=alarm:5)"),
    }));
    expect(allDiagnostics(env).filter((event) => event.platform === "twitch" && /Tick #2 finished/.test(event.message))[0]?.message).toContain("after 0ms");
  });

  it.each(["manual_tick", "manual_resume", "claim_handoff"] as const)("preserves %s backoff overrides behind a pending alarm", async (trigger) => {
    const env = harness(farming(DEFAULT_SETTINGS), { selectWatchTarget: selectWatchTargetFromSnapshot });
    const discovery = deferred<DropCampaign[]>();
    vi.mocked(env.twitch.refreshCampaigns).mockReturnValueOnce(discovery.promise);
    const first = env.controller.tick(["twitch"], "alarm");
    await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());
    const pending = env.controller.tick(["twitch"], "alarm");
    const manual = env.controller.tick(["twitch"], trigger);
    const laterAlarm = env.controller.tick(["twitch"], "alarm");
    discovery.resolve([campaign("twitch")]);
    await Promise.all([first, pending, manual, laterAlarm]);
    expect(env.deps.selectWatchTarget).toHaveBeenCalledTimes(2);
    expect(env.deps.selectWatchTarget).toHaveBeenLastCalledWith(expect.objectContaining({ bypassBackoff: true }));
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(2);
  });

  it("reloads settings and state and selects from the newest discovery revision for the follow-up", async () => {
    const env = harness(farming(DEFAULT_SETTINGS), { selectWatchTarget: selectWatchTargetFromSnapshot });
    const discovery = deferred<DropCampaign[]>();
    vi.mocked(env.twitch.refreshCampaigns)
      .mockReturnValueOnce(discovery.promise)
      .mockResolvedValue([{ ...campaign("twitch"), id: "new-campaign" }]);
    const first = env.controller.tickAndHandOff(["twitch"], "alarm");
    await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());
    const pending = env.controller.tickAndHandOff(["twitch"], "alarm");
    await env.rawController.handleMessage({
      type: "saveSettings", settingsPatch: { autoClaim: false }, tickAfterSave: true, tickAfterSavePlatforms: ["twitch"],
    });
    await env.deps.saveState({ ...env.state, sessions: { ...env.state.sessions, twitch: { ...env.state.sessions.twitch, offlineChecks: 7 } } });
    discovery.resolve([campaign("twitch")]);
    await Promise.all([first, pending]);
    await env.controller.settleBackgroundWork();
    expect(env.deps.selectWatchTarget).toHaveBeenLastCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ autoClaim: false }),
      previous: expect.objectContaining({ offlineChecks: 7 }),
      snapshot: expect.objectContaining({ campaigns: [expect.objectContaining({ campaign: expect.objectContaining({ id: "new-campaign" }) })] }),
    }));
    expect(env.state.sessions.twitch.campaignId).toBe("new-campaign");
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(2);
  });

  it("executes the pending request after the active selection rejects", async () => {
    const selection = deferred<void>();
    const started = deferred<void>();
    let attempts = 0;
    const env = harness(farming(DEFAULT_SETTINGS), {
      selectWatchTarget: async (input) => {
        attempts += 1;
        if (attempts === 1) {
          started.resolve();
          await selection.promise;
        }
        return selectWatchTargetFromSnapshot(input);
      },
    });
    const first = env.controller.tickAndHandOff(["twitch"], "alarm");
    await started.promise;
    const pending = env.controller.tickAndHandOff(["twitch"], "alarm");
    const results = Promise.allSettled([first, pending]);
    selection.reject(new Error("selection failed"));
    expect((await results).map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(env.state.sessions.twitch.campaignId).toBe("twitch-campaign");
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(2);
  });

  it.each(["shutdown", "reset", "disable"] as const)("discards obsolete pending alarm work on %s", async (action) => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const discovery = deferred<DropCampaign[]>();
    vi.mocked(env.twitch.refreshCampaigns).mockReturnValueOnce(discovery.promise);
    const first = env.controller.tickAndHandOff(["twitch"], "alarm");
    await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());
    const pending = env.controller.tickAndHandOff(["twitch"], "alarm");
    if (action === "shutdown") env.controller.shutdown();
    else if (action === "reset") await env.controller.prepareForHostReset();
    else await env.rawController.handleMessage({ type: "setAutomation", platform: "twitch", enabled: false });
    discovery.resolve([campaign("twitch")]);
    await Promise.all([first, pending]);
    await env.controller.settleBackgroundWork();
    expect(allDiagnostics(env).filter((event) => event.platform === "twitch" && event.message.includes("started (trigger=alarm"))).toHaveLength(1);
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
      message: expect.stringMatching(/Discarded pending scheduler triggers .*count=1, reasons=alarm:1/),
    }));
  });

  it("does not report platform-lock waits for an uncontended tick", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.tick(["twitch"], "manual_tick");

    expect(allDiagnostics(env).some((event) =>
      event.message.includes("waited") && event.message.includes("platform work"),
    )).toBe(false);
  });

  it("assigns global and platform-local identifiers to interleaved platform ticks", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.tick(["twitch"], "manual_tick");
    await env.controller.tick(["kick"], "manual_tick");
    await env.controller.tick(["twitch"], "manual_tick");

    const starts = env.reportEvents.mock.calls
      .flatMap(([events]) => events)
      .filter((event): event is DiagnosticEvent =>
        event.category === "diagnostic" && event.message.includes("started (trigger=manual_tick"));

    expect(starts.map((event) => ({
      platform: event.platform,
      globalTickId: event.globalTickId,
      platformTickId: event.platformTickId,
      message: event.message,
    }))).toEqual([
      {
        platform: "twitch",
        globalTickId: 1,
        platformTickId: 1,
        message: "Tick #1 started (trigger=manual_tick, platforms=twitch)",
      },
      {
        platform: "kick",
        globalTickId: 2,
        platformTickId: 1,
        message: "Tick #1 started (trigger=manual_tick, platforms=kick)",
      },
      {
        platform: "twitch",
        globalTickId: 3,
        platformTickId: 2,
        message: "Tick #2 started (trigger=manual_tick, platforms=twitch)",
      },
    ]);
  });

  it("announces one controller run and correlates all of its diagnostics", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.handleMessage({
      type: "setAutomation",
      platform: "twitch",
      enabled: true,
    });
    await env.controller.settleBackgroundWork();

    const diagnostics = env.reportEvents.mock.calls
      .flatMap(([events]) => events)
      .filter((event): event is DiagnosticEvent => event.category === "diagnostic");
    const boundaries = diagnostics.filter((event) =>
      event.message.startsWith("Background controller run "));
    const runId = boundaries[0]?.controllerRunId;

    expect(boundaries).toHaveLength(1);
    expect(diagnostics.findIndex((event) =>
      event.message.startsWith("Background controller run "))).toBe(0);
    expect(runId).toEqual(expect.any(String));
    expect(diagnostics.every((event) => event.controllerRunId === runId)).toBe(true);
    const requested = diagnostics.find((event) =>
      event.message === "User requested Twitch automation enable");
    expect(requested).toBeDefined();
    expect(requested).not.toHaveProperty("globalTickId");
    expect(requested).not.toHaveProperty("platformTickId");
  });

  it("gives independent controller runs different IDs despite identical first tick labels", async () => {
    const first = harness(farming(DEFAULT_SETTINGS));
    const second = harness(farming(DEFAULT_SETTINGS));

    await first.controller.tick(["twitch"], "manual_tick");
    await second.controller.tick(["twitch"], "manual_tick");

    const tickStart = (env: ReturnType<typeof harness>) => env.reportEvents.mock.calls
      .flatMap(([events]) => events)
      .find((event): event is DiagnosticEvent =>
        event.category === "diagnostic"
        && event.message === "Tick #1 started (trigger=manual_tick, platforms=twitch)");
    const firstTick = tickStart(first);
    const secondTick = tickStart(second);

    expect(firstTick).toBeDefined();
    expect(secondTick).toBeDefined();
    expect(firstTick?.message).toBe("Tick #1 started (trigger=manual_tick, platforms=twitch)");
    expect(secondTick?.message).toBe("Tick #1 started (trigger=manual_tick, platforms=twitch)");
    expect(firstTick?.controllerRunId).toEqual(expect.any(String));
    expect(secondTick?.controllerRunId).toEqual(expect.any(String));
    expect(firstTick?.controllerRunId).not.toBe(secondTick?.controllerRunId);
  });

  it("reports a tick lifecycle even when the tick throws", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.deps.saveState.mockRejectedValue(new Error("storage unavailable"));

    await expect(env.controller.tick(["twitch"], "alarm")).rejects.toThrow("storage unavailable");

    const messages = env.reportEvents.mock.calls
      .flatMap(([events]) => events)
      .filter((event) => event.category === "diagnostic")
      .map((event) => event.message);
    expect(messages).toContainEqual(expect.stringMatching(/^Tick #\d+ finished after \d+ms \(trigger=alarm/));
  });

  it("starts automation, persists settings, creates alarm, and runs an immediate tick", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    const snapshot = asSnapshot(await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true }));

    expect(env.settings.platform.twitch.enabled).toBe(true);
    expect(env.deps.createAlarm).toHaveBeenCalledWith(TWITCH_ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.deps.createAlarm).toHaveBeenCalledWith(KICK_ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    // The snapshot returns ahead of the tick, reporting the prompt "starting"
    // transition; the watching status lands once the tick settles.
    expect(snapshot.state.sessions.twitch.status).toBe("starting");
    expect(env.state.sessions.twitch.status).toBe("watching");
  });

  it("stops automation immediately and applies auto-close behavior to active watch tabs", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoCloseFinishedDrops: false }));
    await env.controller.tick();
    env.state.managedPageContextTabs = {
      twitch: {
        platform: "twitch",
        tabId: 66,
        originUrl: "https://www.twitch.tv/drops/inventory",
        origin: "https://www.twitch.tv",
        ownedByExtension: true,
      },
    };

    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: false });
    await env.controller.handleMessage({ type: "setAutomation", platform: "kick", enabled: false });

    expect(isFarmingActive(env.settings)).toBe(false);
    expect(env.twitch.stopWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 10 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(env.kick.stopWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 20 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // Read from settled state rather than the returned snapshot: the snapshot is
    // now taken before the tick that applies the stop.
    expect(env.state.sessions.twitch.status).toBe("paused");
    expect(env.state.sessions.kick.status).toBe("paused");
    expect(env.state.managedPageContextTabs?.twitch).toBeUndefined();
  });

  it("prepares a host reset by force-closing managed tabs", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoCloseFinishedDrops: false }));
    await env.controller.tick();
    env.state.managedPageContextTabs = {
      twitch: {
        platform: "twitch",
        tabId: 66,
        originUrl: "https://www.twitch.tv/drops/inventory",
        origin: "https://www.twitch.tv",
        ownedByExtension: true,
      },
    };

    await env.controller.prepareForHostReset();

    expect(env.twitch.stopWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 10 }),
      expect.objectContaining({ closeManagedTabs: true }),
    );
    expect(env.kick.stopWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 20 }),
      expect.objectContaining({ closeManagedTabs: true }),
    );
    expect(env.deps.stopPageContextTabs).toHaveBeenCalledWith(
      expect.objectContaining({ twitch: expect.objectContaining({ tabId: 66 }) }),
      expect.objectContaining({ platforms: ["twitch", "kick"], emit: expect.any(Function) }),
    );
  });

  it("preempts an in-flight scheduler tick before resetting host storage", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    let tickSignal: AbortSignal | undefined;
    vi.mocked(env.twitch.refreshCampaigns).mockImplementation(
      async (_session, { signal } = {}) => new Promise((_resolve, reject) => {
        tickSignal = signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    );

    const ticking = env.controller.tick();
    await vi.waitFor(() => expect(tickSignal).toBeDefined());
    env.reportEvents.mockClear();

    const resetHostStorage = vi.fn();
    await env.controller.prepareForHostReset(resetHostStorage);
    await ticking;

    expect(tickSignal?.aborted).toBe(true);
    expect(resetHostStorage).toHaveBeenCalledOnce();
    const resetEvents = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(resetEvents).not.toContainEqual(expect.objectContaining({
      category: "activity",
      code: "interruption",
    }));
    expect(resetEvents).not.toContainEqual(expect.objectContaining({
      category: "diagnostic",
      level: "error",
    }));
  });

  it("restores scheduler admission when resetting host storage fails", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const resetFailure = new Error("storage reset failed");

    await expect(env.controller.prepareForHostReset(async () => {
      throw resetFailure;
    })).rejects.toBe(resetFailure);

    vi.mocked(env.kick.refreshCampaigns).mockClear();
    await env.controller.tick(["kick"], "manual_tick");

    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
  });

  it("aborts in-flight scheduler work when the controller shuts down", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    let tickSignal: AbortSignal | undefined;
    vi.mocked(env.twitch.refreshCampaigns).mockImplementation(
      async (_session, { signal } = {}) => new Promise((_resolve, reject) => {
        tickSignal = signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    );

    const ticking = env.controller.tick();
    await vi.waitFor(() => expect(tickSignal).toBeDefined());

    env.controller.shutdown();
    env.controller.shutdown();
    await ticking;

    expect(tickSignal?.aborted).toBe(true);
  });

  it("allows host-reset cleanup to be retried", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.tick();

    await env.controller.prepareForHostReset();

    await expect(env.controller.prepareForHostReset()).resolves.toBeUndefined();
  });

  it("force-closes registry-owned tabs even when no live session references them", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.managedWatchTabs = {
      twitch: {
        platform: "twitch",
        tabId: 71,
        channelUrl: "https://www.twitch.tv/stale-channel",
        ownedByExtension: true,
      },
    };

    await env.controller.prepareForHostReset();

    expect(env.deps.closeManagedTabs).toHaveBeenCalledWith([expect.objectContaining({ tabId: 71 })]);
  });

  it("holds controller mutations until host storage reset finishes", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    let releaseReset!: () => void;
    const resetBlocked = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    const resetStarted = vi.fn();
    const resetting = env.controller.prepareForHostReset(async () => {
      resetStarted();
      await resetBlocked;
      await env.deps.saveSettings(DEFAULT_SETTINGS);
      await env.deps.saveState(DEFAULT_STATE);
    });
    await vi.waitFor(() => expect(resetStarted).toHaveBeenCalledOnce());
    vi.mocked(env.twitch.refreshCampaigns).mockClear();

    const ticking = env.controller.tick();
    await Promise.resolve();

    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    releaseReset();
    await Promise.all([resetting, ticking]);
    expect(env.settings).toEqual(DEFAULT_SETTINGS);
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("toggles one platform and immediately applies the scheduler when running", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.tick();

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "setPlatformEnabled",
      platform: "twitch",
      enabled: false,
    }));

    expect(snapshot.settings.platform.twitch.enabled).toBe(false);
    expect(snapshot.settings.platform.kick.enabled).toBe(true);
    // Settings are applied synchronously; the session statuses follow from the
    // background tick, so they are read from settled state.
    expect(env.state.sessions.twitch.status).toBe("paused");
    expect(env.state.sessions.kick.status).toBe("watching");
  });

  it("enables popup automation with one settings save and one initial scheduler pass", async () => {
    const env = harness(notFarming({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false, idleWatchlistChannels: [] },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
      },
    }));

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "setAutomation",
      platform: "twitch",
      enabled: true,
    }));

    expect(env.deps.saveSettings).toHaveBeenCalledTimes(1);
    expect(isFarmingActive(env.settings)).toBe(true);
    expect(env.settings.platform.twitch.enabled).toBe(true);
    expect(env.settings.platform.kick.enabled).toBe(false);
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(1);
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
    // Returned ahead of the tick, so the enabled platform reads as starting.
    expect(snapshot.state.sessions.twitch.status).toBe("starting");
    expect(env.state.sessions.twitch.status).toBe("watching");
    // Untouched: the toggle ticks only the platform it changed.
    expect(env.state.sessions.kick.status).toBe("idle");
  });

  it("saves and normalizes settings without forcing a scheduler tick", async () => {
    const env = harness();
    const nextSettings = {
      ...DEFAULT_SETTINGS,
      pollIntervalMinutes: Number.NaN,
      offlineRetryLimit: 0,
      tablessFallbackFailureLimit: 99,
    };

    await env.controller.handleMessage({ type: "saveSettings", settingsPatch: nextSettings });

    expect(env.settings.pollIntervalMinutes).toBe(DEFAULT_SETTINGS.pollIntervalMinutes);
    expect(env.settings.offlineRetryLimit).toBe(1);
    expect(env.settings.tablessFallbackFailureLimit).toBe(10);
    expect(env.deps.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ tablessFallbackFailureLimit: 10 }),
    );
    expect(env.deps.createAlarm).toHaveBeenCalledWith(TWITCH_ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.deps.createAlarm).toHaveBeenCalledWith(KICK_ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("recreates the scheduler alarm when saving a custom tick interval", async () => {
    const env = harness();

    await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { pollIntervalMinutes: 17 },
    });

    expect(env.settings.pollIntervalMinutes).toBe(17);
    expect(env.deps.clearAlarm).toHaveBeenCalledWith(ALARM_NAME);
    expect(env.deps.createAlarm).toHaveBeenCalledWith(TWITCH_ALARM_NAME, { periodInMinutes: 17 });
    expect(env.deps.createAlarm).toHaveBeenCalledWith(KICK_ALARM_NAME, { periodInMinutes: 17 });
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("merges overlapping settings patches without clobbering previous saves", async () => {
    const env = harness(farming({
      ...DEFAULT_SETTINGS,
      notifyRewardEarned: true,
      notifyNoDropsLeft: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, excludedChannels: [] },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
      },
    }));

    await Promise.all([
      env.controller.handleMessage({
        type: "saveSettings",
        settingsPatch: {
          notifyRewardEarned: false,
          platform: { twitch: { excludedChannels: ["skipme"] } },
        },
      }),
      env.controller.handleMessage({
        type: "saveSettings",
        settingsPatch: {
          notifyNoDropsLeft: false,
          platform: { kick: { enabled: false } },
        },
      }),
    ]);

    expect(env.settings.notifyRewardEarned).toBe(false);
    expect(env.settings.notifyNoDropsLeft).toBe(false);
    expect(env.settings.platform.twitch.excludedChannels).toEqual(["skipme"]);
    expect(env.settings.platform.kick.enabled).toBe(false);
  });

  it("preserves rapid scheduling patches without overlapping reconciliation", async () => {
    const env = harness(farming({
      ...DEFAULT_SETTINGS,
      notifyRewardEarned: true,
      notifyNoDropsLeft: true,
    }));
    let activeDiscoveries = 0;
    let maxActiveDiscoveries = 0;
    let discoveryCalls = 0;
    let markFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(env.twitch.refreshCampaigns).mockImplementation(async () => {
      discoveryCalls += 1;
      activeDiscoveries += 1;
      maxActiveDiscoveries = Math.max(maxActiveDiscoveries, activeDiscoveries);
      if (discoveryCalls === 1) {
        markFirstStarted();
        await firstGate;
      }
      activeDiscoveries -= 1;
      return [];
    });

    const first = env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { notifyRewardEarned: false },
      tickAfterSave: true,
      tickAfterSavePlatforms: ["twitch"],
    });
    await firstStarted;
    const second = env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { notifyNoDropsLeft: false },
      tickAfterSave: true,
      tickAfterSavePlatforms: ["twitch"],
    });
    await drainMicrotasks();
    releaseFirst();
    await Promise.all([first, second]);

    expect(env.settings.notifyRewardEarned).toBe(false);
    expect(env.settings.notifyNoDropsLeft).toBe(false);
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(2);
    expect(maxActiveDiscoveries).toBe(1);
  });

  it("runs a scheduler tick after saving settings when requested and automation is active", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const nextSettings = {
      ...env.settings,
      platform: {
        ...env.settings.platform,
        twitch: { ...env.settings.platform.twitch, idleWatchlistChannels: ["fallback"] },
      },
    };

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: nextSettings,
      tickAfterSave: true,
    }));

    expect(env.twitch.refreshCampaigns).toHaveBeenCalled();
    expect(snapshot.settings.platform.twitch.idleWatchlistChannels).toEqual(["fallback"]);
  });

  it("only ticks requested platforms after saving settings with targeted platforms", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const nextSettings = {
      ...env.settings,
      platform: {
        ...env.settings.platform,
        kick: { ...env.settings.platform.kick, idleWatchlistChannels: ["fallback"] },
      },
    };

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: nextSettings,
      tickAfterSave: true,
      tickAfterSavePlatforms: ["kick"],
    }));

    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).toHaveBeenCalled();
    expect(snapshot.settings.platform.kick.idleWatchlistChannels).toEqual(["fallback"]);
  });

  it("does not start automation after saving Idle Watchlist settings while paused", async () => {
    const env = harness(notFarming(DEFAULT_SETTINGS));
    const nextSettings = {
      ...env.settings,
      platform: {
        ...env.settings.platform,
        twitch: { ...env.settings.platform.twitch, idleWatchlistChannels: ["fallback"] },
      },
    };

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: nextSettings,
      tickAfterSave: true,
    }));

    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(isFarmingActive(snapshot.settings)).toBe(false);
    expect(snapshot.settings.platform.twitch.idleWatchlistChannels).toEqual(["fallback"]);
  });

  it("keeps active farming untouched when saving a non-scheduling setting", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      tabId: 10,
      tabManagedByExtension: true,
      offlineChecks: 0,
    };

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { notifyRewardEarned: false },
    }));

    expect(env.twitch.stopWatchTab).not.toHaveBeenCalled();
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(snapshot.state.sessions.twitch.status).toBe("watching");
  });

  it("runs an immediate scheduler tick when requested from the popup", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    const snapshot = asSnapshot(await env.controller.handleMessage({ type: "tickNow" }));

    expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(1);
    expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(1);
    expect(snapshot.state.sessions.twitch.status).toBe("watching");
    expect(snapshot.state.sessions.kick.status).toBe("watching");
    expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ category: "activity", code: "farming_started" }),
    ]));
  });

  it("reports scheduler diagnostics without consulting host diagnostic settings", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, diagnosticLogging: false }));

    await env.controller.handleMessage({ type: "tickNow" });

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published.some((event) => event.category === "diagnostic" && event.level === "debug")).toBe(true);
  });

  it("records playback telemetry only for the managed watch tab", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: true,
        readyState: 4,
        currentTime: 12,
        duration: 1200,
      },
    }, { tab: { id: 10 } });

    expect(env.state.sessions.twitch.playback).toMatchObject({
      platform: "twitch",
      videoCount: 1,
      mutedVideoCount: 0,
      unmutedVideoCount: 1,
      playingVideoCount: 1,
    });

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 0,
        mutedVideoCount: 0,
        unmutedVideoCount: 0,
        playingVideoCount: 0,
        blockedPlaybackCount: 0,
        documentHidden: true,
      },
    }, { tab: { id: 999 } });

    expect(env.state.sessions.twitch.playback?.videoCount).toBe(1);
  });

  it("clears accumulated playback checks as soon as the watch tab reports playback (#250)", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });
    env.state.sessions.twitch = { ...env.state.sessions.twitch, playbackChecks: 2 };

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 0,
        mutedVideoCount: 0,
        unmutedVideoCount: 0,
        playingVideoCount: 0,
        blockedPlaybackCount: 0,
        documentHidden: true,
      },
    }, { tab: { id: 10 } });

    expect(env.state.sessions.twitch.playbackChecks).toBe(2);

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 1,
        unmutedVideoCount: 0,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: true,
      },
    }, { tab: { id: 10 } });

    expect(env.state.sessions.twitch.playbackChecks).toBe(0);
  });

  it("pauses Twitch immediately when visible playback starts in a non-managed tab", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
    await env.controller.tick();
    vi.mocked(env.kick.refreshCampaigns).mockClear();

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
      },
    }, { tab: { id: 999, url: "https://www.twitch.tv/FirstCreator" } });

    expect(env.state.manualWatch?.twitch).toMatchObject({
      platform: "twitch",
      tabId: 999,
      active: true,
      channel: {
        platform: "twitch",
        username: "firstcreator",
        url: "https://www.twitch.tv/firstcreator",
      },
    });
    expect(env.state.sessions.twitch).toMatchObject({
      status: "paused",
      reasonCode: "manual_watch",
      channel: undefined,
    });
    expect(env.state.sessions.kick.status).toBe("watching");
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.state.sessions.twitch.playback).toBeUndefined();
  });

  it("replaces or clears the manual Twitch channel when the same tab navigates", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
    const telemetry = {
      videoCount: 1,
      mutedVideoCount: 0,
      unmutedVideoCount: 1,
      playingVideoCount: 1,
      blockedPlaybackCount: 0,
      documentHidden: false,
    };

    await env.controller.handleMessage(
      { type: "playbackTelemetry", platform: "twitch", telemetry },
      { tab: { id: 999, url: "https://www.twitch.tv/FirstCreator" } },
    );
    await env.controller.settleBackgroundWork();
    await env.controller.handleMessage(
      { type: "playbackTelemetry", platform: "twitch", telemetry },
      { tab: { id: 999, url: "https://www.twitch.tv/SecondCreator" } },
    );

    expect(env.state.manualWatch?.twitch?.channel).toEqual({
      platform: "twitch",
      username: "secondcreator",
      url: "https://www.twitch.tv/secondcreator",
    });
    env.twitch.claimChannelPoints = vi.fn(async () => false);
    await env.controller.runTwitchChannelPointsClaim();
    expect(env.twitch.claimChannelPoints).toHaveBeenCalledWith(expect.objectContaining({
      username: "secondcreator",
    }));

    await env.controller.handleMessage(
      { type: "playbackTelemetry", platform: "twitch", telemetry },
      { tab: { id: 999, url: "https://www.twitch.tv/directory" } },
    );

    expect(env.state.manualWatch?.twitch?.channel).toBeUndefined();
  });

  it("runs only one immediate tick while the same manual playback stays active", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
    await env.controller.tick(["twitch"]);
    env.reportEvents.mockClear();
    const telemetry = {
      videoCount: 1,
      mutedVideoCount: 0,
      unmutedVideoCount: 1,
      playingVideoCount: 1,
      blockedPlaybackCount: 0,
      documentHidden: false,
    };

    await env.controller.handleMessage({ type: "playbackTelemetry", platform: "twitch", telemetry }, { tab: { id: 999 } });
    await env.controller.handleMessage({ type: "playbackTelemetry", platform: "twitch", telemetry }, { tab: { id: 999 } });

    const immediateTickStarts = allDiagnostics(env).filter((event) =>
      event.message.includes("started (trigger=manual_watch"));
    expect(immediateTickStarts).toHaveLength(1);
  });

  it("does not tick when non-managed Twitch playback is inactive", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
    await env.controller.tick(["twitch"]);
    env.reportEvents.mockClear();

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 0,
        blockedPlaybackCount: 0,
        documentHidden: false,
      },
    }, { tab: { id: 999 } });

    expect(env.state.sessions.twitch.status).toBe("watching");
    expect(allDiagnostics(env).some((event) =>
      event.message.includes("started (trigger=manual_watch"))).toBe(false);
  });

  it("clears manual watch activity when the source tab is closed", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
    env.state.manualWatch = {
      twitch: {
        platform: "twitch",
        tabId: 999,
        active: true,
        checkedAt: new Date().toISOString(),
      },
    };

    await env.controller.handleTabRemoved(999);

    expect(env.state.manualWatch?.twitch).toBeUndefined();
  });

  it("marks manual watch inactive when the same tab stops visible playback", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
    env.state.manualWatch = {
      twitch: {
        platform: "twitch",
        tabId: 999,
        active: true,
        checkedAt: new Date().toISOString(),
      },
    };

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 0,
        blockedPlaybackCount: 0,
        documentHidden: false,
      },
    }, { tab: { id: 999 } });

    expect(env.state.manualWatch?.twitch).toMatchObject({
      tabId: 999,
      active: false,
    });
  });

  // A clock rollback can leave the stored manual-watch `checkedAt` in the
  // future. Reading that as "recently active" would keep a stale record
  // winning over fresher telemetry from a different tab, so a future stamp
  // counts as stale and the new telemetry is applied instead.
  it("overrides manual watch activity stamped in the future with fresh telemetry", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
    env.state.manualWatch = {
      twitch: {
        platform: "twitch",
        tabId: 999,
        active: true,
        checkedAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
    };

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 0,
        blockedPlaybackCount: 0,
        documentHidden: false,
      },
    }, { tab: { id: 1000 } });

    expect(env.state.manualWatch?.twitch).toMatchObject({
      tabId: 1000,
      active: false,
    });
  });

  it("logs playback transitions such as ad starts and blocked playback", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });

    // Baseline healthy telemetry — no ad, nothing blocked.
    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: { videoCount: 1, mutedVideoCount: 0, unmutedVideoCount: 1, playingVideoCount: 1, blockedPlaybackCount: 0, documentHidden: false, adActive: false },
    }, { tab: { id: 10 } });

    // Ad starts and the browser blocks playback (re-muted).
    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: { videoCount: 1, mutedVideoCount: 1, unmutedVideoCount: 0, playingVideoCount: 1, blockedPlaybackCount: 1, documentHidden: false, adActive: true },
    }, { tab: { id: 10 } });

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    const messages = published.filter((event) => event.category === "diagnostic").map((event) => event.message);
    expect(messages).toContain("Ad started; keeping the watch tab counting down");
    expect(published.some((event) => event.category === "diagnostic" && event.level === "warn" && event.message.startsWith("Playback was blocked"))).toBe(true);
  });

  it("publishes focus diagnostics exactly once in the telemetry operation batch", async () => {
    const reported: EngineEvent[][] = [];
    const env = harness(farming(DEFAULT_SETTINGS), {
      reportEvents: async (events) => { reported.push([...events]); },
    });
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });
    reported.length = 0;
    env.deps.applyAdFocus.mockImplementation(async (_platform, _tabId, _adActive, emit) => {
      emit({ category: "diagnostic", level: "info", message: "focus-adjusted", platform: "twitch" });
    });

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
        adActive: true,
      },
    }, { tab: { id: 10 } });

    const focusDiagnostics = reported
      .flatMap((events) => events)
      .filter((event) => event.category === "diagnostic" && event.message === "focus-adjusted");
    expect(focusDiagnostics).toHaveLength(1);
  });

  it("keeps persisted playback telemetry when applying ad focus fails", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });
    env.deps.applyAdFocus.mockRejectedValue(new Error("focus callback failed"));

    await expect(env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
        adActive: true,
      },
    }, { tab: { id: 10 } })).resolves.toBeUndefined();

    expect(env.state.sessions.twitch.playback?.adActive).toBe(true);
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: "focus callback failed",
    }));
  });

  it("focuses the watch tab when an ad is reported on the managed tab", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, adFocusMode: "window" }));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });
    env.deps.applyAdFocus.mockClear();

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: true,
        adActive: true,
      },
    }, { tab: { id: 10 } });

    expect(env.deps.applyAdFocus).toHaveBeenCalledWith("twitch", 10, true, expect.any(Function));
  });

  it("releases ad focus when telemetry reports no ad", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, adFocusMode: "tab" }));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });
    env.deps.applyAdFocus.mockClear();

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: true,
        adActive: false,
      },
    }, { tab: { id: 10 } });

    expect(env.deps.applyAdFocus).toHaveBeenCalledWith("twitch", 10, false, expect.any(Function));
  });

  it("does not focus for telemetry from a tab that is not the watch tab", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });
    env.deps.applyAdFocus.mockClear();

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: true,
        adActive: true,
      },
    }, { tab: { id: 999 } });

    expect(env.deps.applyAdFocus).not.toHaveBeenCalled();
  });

  it("ignores playback telemetry without a sender tab", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });
    env.deps.applyAdFocus.mockClear();

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
        adActive: true,
      },
    });

    expect(env.state.sessions.twitch.playback).toBeUndefined();
    expect(env.state.manualWatch?.twitch).toBeUndefined();
    expect(env.deps.applyAdFocus).not.toHaveBeenCalled();
    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published.some((event) => event.category === "diagnostic" && event.message.startsWith("Ad started"))).toBe(false);
  });

  it("does not treat tabless sessions as managed playback telemetry targets", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      watchMode: "tabless",
    };

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
        adActive: true,
      },
    }, { tab: { id: 10 } });

    expect(env.state.sessions.twitch.playback).toBeUndefined();
    expect(env.state.manualWatch?.twitch).toMatchObject({
      tabId: 10,
      active: true,
    });
    expect(env.deps.applyAdFocus).not.toHaveBeenCalledWith(
      "twitch",
      10,
      true,
      expect.any(Function),
    );
  });

  it("re-applies ad focus from playback state on each scheduler tick", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.handleMessage({ type: "tickNow" });

    expect(env.deps.applyAdFocus).toHaveBeenCalledWith("twitch", 10, false, expect.any(Function));
    expect(env.deps.applyAdFocus).toHaveBeenCalledWith("kick", 20, false, expect.any(Function));
  });

  it("applies ad focus only for each concurrent tick's own platform", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const twitchDiscovery = deferred<DropCampaign[]>();
    vi.mocked(env.twitch.refreshCampaigns).mockReturnValue(twitchDiscovery.promise);
    env.deps.applyAdFocus.mockClear();

    const ticking = env.controller.tick(undefined, "manual_tick");

    try {
      await vi.waitFor(() => {
        expect(env.deps.applyAdFocus).toHaveBeenCalledWith(
          "kick",
          20,
          false,
          expect.any(Function),
        );
      });
      expect(env.deps.applyAdFocus.mock.calls.map(([platform]) => platform)).toEqual(["kick"]);
    } finally {
      twitchDiscovery.resolve([campaign("twitch")]);
      await ticking;
    }

    expect(env.deps.applyAdFocus.mock.calls.map(([platform]) => platform)).toEqual([
      "kick",
      "twitch",
    ]);
  });

  it("keeps successful scheduler state when re-applying ad focus fails", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.deps.applyAdFocus.mockRejectedValue(new Error("focus refresh failed"));

    await env.controller.tick();

    expect(env.state.sessions.twitch.status).toBe("watching");
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: "focus refresh failed",
    }));
  });

  it("allows playback control only for the current watch tab", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });

    await expect(env.controller.handleMessage(
      { type: "getPlaybackControl", platform: "twitch" },
      { tab: { id: 10 } },
    )).resolves.toEqual({ managed: true, keepVideosUnmuted: true });

    await expect(env.controller.handleMessage(
      { type: "getPlaybackControl", platform: "twitch" },
      { tab: { id: 999 } },
    )).resolves.toEqual({ managed: false, keepVideosUnmuted: true });
  });

  it("passes the playback control setting to managed watch tabs", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, keepFarmingVideosUnmuted: false }));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });

    await expect(env.controller.handleMessage(
      { type: "getPlaybackControl", platform: "twitch" },
      { tab: { id: 10 } },
    )).resolves.toEqual({ managed: true, keepVideosUnmuted: false });
  });

  it("defaults playback control on when stored settings are missing the advanced flag", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.deps.loadSettings.mockResolvedValueOnce(farming({
      ...DEFAULT_SETTINGS,
      keepFarmingVideosUnmuted: undefined,
    } as unknown as typeof DEFAULT_SETTINGS));
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
    };

    await expect(env.controller.handleMessage(
      { type: "getPlaybackControl", platform: "twitch" },
      { tab: { id: 10 } },
    )).resolves.toEqual({ managed: true, keepVideosUnmuted: true });
  });

  it("pauses the platform when the user closes the active managed farming tab", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
    };
    env.state.managedWatchTabs = {
      twitch: {
        platform: "twitch",
        tabId: 10,
        channelUrl: "https://www.twitch.tv/twitch-creator",
        ownedByExtension: true,
      },
    };

    await env.controller.handleTabRemoved(10);

    // The removal itself never runs the scheduler (#193).
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.state.manualClosePause?.twitch).toMatchObject({ platform: "twitch" });
    expect(env.state.sessions.twitch).toMatchObject({
      platform: "twitch",
      status: "paused",
      reasonCode: "manual_tab_close",
    });
    expect(env.state.managedWatchTabs?.twitch).toBeUndefined();
    // The user's enabled/running settings are untouched: this is a pause.
    expect(isFarmingActive(env.settings)).toBe(true);
    expect(env.settings.platform.twitch.enabled).toBe(true);

    await env.controller.tick();

    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.state.sessions.twitch.status).toBe("paused");
    expect(env.state.sessions.twitch.reasonCode).toBe("manual_tab_close");
    // The other platform keeps farming.
    expect(env.kick.prepareWatchTab).toHaveBeenCalledOnce();
  });

  it("resumes farming for the platform when the user asks to resume", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
    };

    await env.controller.handleTabRemoved(10);
    expect(env.state.manualClosePause?.twitch).toBeDefined();

    const snapshot = asSnapshot(await env.controller.handleMessage({ type: "resumeAfterManualClose", platform: "twitch" }));

    expect(snapshot.state.manualClosePause?.twitch).toBeUndefined();
    expect(env.state.manualClosePause?.twitch).toBeUndefined();
    expect(env.twitch.prepareWatchTab).toHaveBeenCalledOnce();
    expect(env.state.sessions.twitch.status).toBe("watching");
  });

  it("does not pause when a watch tab the extension does not own is closed", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: false,
    };

    await env.controller.handleTabRemoved(10);

    expect(env.state.manualClosePause?.twitch).toBeUndefined();

    await env.controller.tick();

    expect(env.twitch.prepareWatchTab).toHaveBeenCalledOnce();
  });

  it("does not pause when a managed page-context tab is closed", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.sessions.kick = {
      platform: "kick",
      status: "watching",
      channel: channel("kick"),
      offlineChecks: 0,
      tabId: 20,
      tabManagedByExtension: true,
    };
    env.state.managedPageContextTabs = {
      kick: {
        platform: "kick",
        tabId: 91,
        originUrl: "https://kick.com/drops/inventory",
        origin: "https://kick.com",
        ownedByExtension: true,
      },
    };

    await env.controller.handleTabRemoved(91);

    expect(env.state.manualClosePause?.kick).toBeUndefined();

    await env.controller.tick();

    expect(env.kick.prepareWatchTab).toHaveBeenCalledOnce();
  });

  it("does not confuse a removed page-context tab with the active farming tab", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.sessions.kick = {
      platform: "kick",
      status: "watching",
      channel: channel("kick"),
      offlineChecks: 0,
      tabId: 20,
      tabManagedByExtension: true,
    };
    env.state.managedWatchTabs = {
      kick: {
        platform: "kick",
        tabId: 20,
        channelUrl: "https://kick.com/kick-creator",
        ownedByExtension: true,
      },
    };
    env.state.managedPageContextTabs = {
      kick: {
        platform: "kick",
        tabId: 91,
        originUrl: "https://kick.com/drops/inventory",
        origin: "https://kick.com",
        ownedByExtension: true,
      },
    };

    await env.controller.handleTabRemoved(91);

    expect(env.state.sessions.kick.tabId).toBe(20);
    expect(env.state.managedWatchTabs?.kick?.tabId).toBe(20);
    expect(env.kick.prepareWatchTab).not.toHaveBeenCalled();
  });

  it("ignores removed tabs that are not the active managed watch tab", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
    };

    await env.controller.handleTabRemoved(999);

    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
  });

  it("does not reopen a closed tab for a disabled platform", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false, idleWatchlistChannels: [] },
      },
    });
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
    };

    await env.controller.handleTabRemoved(10);

    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
  });

  it("tracks one managed watch tab per running platform", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.tick();

    expect(env.state.sessions.twitch.tabId).toBe(10);
    expect(env.state.sessions.kick.tabId).toBe(20);
    expect(env.state.managedWatchTabs).toMatchObject({
      twitch: {
        platform: "twitch",
        tabId: 10,
        channelUrl: "https://www.twitch.tv/twitch-creator",
        ownedByExtension: true,
      },
      kick: {
        platform: "kick",
        tabId: 20,
        channelUrl: "https://kick.com/kick-creator",
        ownedByExtension: true,
      },
    });
  });

  it("completes a campaign after manually claiming its last subscription reward", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: false }));
    const subscriptionReward: DropReward = {
      ...reward("claimable"),
      id: "subscription-reward",
      imageUrl: "https://cdn.example.test/reward.png",
      requirement: "subscription",
      requiredSubs: 1,
      requiredMinutes: 0,
      watchedMinutes: 0,
      isWatchBased: false,
    };
    const twitchCampaign = {
      ...campaign("twitch", "claimed"),
      url: "https://example.test/campaign",
      rewards: [reward("claimed"), subscriptionReward],
    };
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([twitchCampaign]);

    await env.controller.tick();
    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "twitch-campaign",
      rewardId: "subscription-reward",
    }));

    expect(env.twitch.claimReward).toHaveBeenCalledWith(
      expect.objectContaining({ id: "twitch-campaign" }),
      expect.objectContaining({ id: "subscription-reward", status: "claimable", requirement: "subscription" }),
    );
    expect(snapshot.state.campaigns.twitch[0]).toMatchObject({
      status: "completed",
      rewards: [
        { id: "reward", status: "claimed" },
        { id: "subscription-reward", status: "claimed", watchedMinutes: 0 },
      ],
    });
    expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        category: "activity",
        code: "reward_claimed",
        data: expect.objectContaining({
          method: "manual",
          rewardImageUrl: "https://cdn.example.test/reward.png",
          campaignUrl: "https://example.test/campaign",
        }),
      }),
    ]));
  });

  it("keeps a mixed campaign active after manually claiming its subscription reward", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: false }));
    const subscriptionReward: DropReward = {
      ...reward("claimable"),
      id: "subscription-reward",
      requirement: "subscription",
      requiredSubs: 1,
      requiredMinutes: 0,
      watchedMinutes: 0,
      isWatchBased: false,
    };
    const twitchCampaign = {
      ...campaign("twitch"),
      rewards: [subscriptionReward, { ...reward("locked"), id: "watch-reward", requirement: "watch" as const }],
    };
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([twitchCampaign]);

    await env.controller.tick();
    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "twitch-campaign",
      rewardId: "subscription-reward",
    }));

    expect(snapshot.state.campaigns.twitch[0]).toMatchObject({
      status: "active",
      rewards: [
        { id: "subscription-reward", status: "claimed" },
        { id: "watch-reward", status: "locked" },
      ],
    });
  });

  it("unlocks a dependent watch reward immediately after a manual subscription claim", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: false }));
    const subscriptionReward: DropReward = {
      ...reward("claimable"),
      id: "subscription-reward",
      requirement: "subscription",
      requiredSubs: 1,
      requiredMinutes: 0,
      watchedMinutes: 0,
      isWatchBased: false,
    };
    const twitchCampaign: DropCampaign = {
      ...campaign("twitch"),
      eligibility: "eligible",
      rewards: [
        subscriptionReward,
        {
          ...reward("locked"),
          id: "watch-reward",
          requirement: "watch",
          preconditionRewardIds: [subscriptionReward.id],
          preconditionsMet: false,
        },
      ],
    };
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([twitchCampaign]);

    await env.controller.tick();
    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "twitch-campaign",
      rewardId: subscriptionReward.id,
    }));

    expect(snapshot.state.campaigns.twitch[0]).toMatchObject({
      status: "active",
      eligibility: "eligible",
      rewards: [
        { id: subscriptionReward.id, status: "claimed" },
        { id: "watch-reward", status: "locked", preconditionsMet: true },
      ],
    });
  });

  it("does not publish manual-claim events when the corresponding state save fails", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: false }), {
      saveState: vi.fn().mockRejectedValueOnce(new Error("storage unavailable")),
    });
    env.state.campaigns.twitch = [campaign("twitch", "claimable")];

    await expect(env.controller.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "twitch-campaign",
      rewardId: "reward",
    })).rejects.toThrow("storage unavailable");

    expect(env.deps.saveState).toHaveBeenCalledTimes(1);
    expect(env.reportEvents).not.toHaveBeenCalled();
  });

  it("records a warning when a manual claim target is stale", async () => {
    const env = harness();

    await env.controller.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "missing-campaign",
      rewardId: "reward",
    });

    expect(env.twitch.claimReward).not.toHaveBeenCalled();
    expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: "Reward claim skipped because the campaign or reward is no longer available",
      }),
    ]));
  });

  it("emits reward notifications best-effort when rewards become earned", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, notifyRewardEarned: true }));
    env.state.campaigns.twitch = [campaign("twitch", "in_progress")];
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([campaign("twitch", "claimable")]);

    await env.controller.tick();

    expect(env.deps.createNotification).toHaveBeenCalledWith({
      title: "Reward earned",
      message: "Reward from twitch campaign",
    });
  });

  it("emits a notification when a Kick challenge is claimed", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, notifyRewardEarned: true }));
    env.kick.claimChallenges = vi.fn(async () => [{ id: "daily", rarity: "mythic", recurrence: "daily" }]);

    await env.controller.tick();

    expect(env.deps.createNotification).toHaveBeenCalledWith({
      title: "Challenge reward claimed",
      message: "You won a mythic card from your daily challenge.",
    });
  });

  it("does not emit a challenge notification when reward notifications are off", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, notifyRewardEarned: false }));
    env.kick.claimChallenges = vi.fn(async () => [{ id: "daily", rarity: "mythic", recurrence: "daily" }]);

    await env.controller.tick();

    expect(env.deps.createNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Challenge reward claimed" }),
    );
  });

  it("does not emit disabled reward notifications", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, notifyRewardEarned: false }));
    env.state.campaigns.twitch = [campaign("twitch", "in_progress")];
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([campaign("twitch", "claimable")]);

    await env.controller.tick();

    expect(env.deps.createNotification).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Reward earned" }));
  });

  it("emits the no-drops-left notification once when entering the exhausted state", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      notifyNoDropsLeft: true,
      platform: { ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true }, kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false } },
    });
    // A fully claimed campaign is present but has nothing earnable, so the
    // scheduler goes idle into the "no drops left" condition.
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([campaign("twitch", "claimed")]);

    await env.controller.tick();

    expect(env.deps.createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: "No drops left" }));
  });

  it("does not re-emit the no-drops-left notification while the exhausted state persists", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      notifyNoDropsLeft: true,
      notifyRewardEarned: false,
      platform: { ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true }, kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false } },
    });
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([campaign("twitch", "claimed")]);

    await env.controller.tick();
    await env.controller.tick();

    // The exhausted state persists across both ticks; the notification must fire
    // only on the transition, not once per tick. No other notifications are
    // enabled, so the no-drops notification is the only expected call.
    expect(env.deps.createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: "No drops left" }));
    expect(env.deps.createNotification).toHaveBeenCalledTimes(1);
  });

  it("reports a controller-fatal interruption even when diagnostics are filtered by the host", async () => {
    const env = harness();
    vi.mocked(env.deps.createAdapter).mockImplementation(() => {
      throw new Error("adapter factory failed");
    });

    await env.controller.tick();

    expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ category: "activity", code: "interruption", level: "error" }),
      expect.objectContaining({
        category: "diagnostic",
        level: "error",
        message: expect.stringContaining("adapter factory failed"),
      }),
    ]));
  });

  function fakeTablessWatcher(
    tick: () => Promise<{ ok: boolean; live?: boolean; message?: string }>,
    platform: Platform = "twitch",
  ) {
    const watcher = {
      platform,
      channelUrl: undefined as string | undefined,
      start: vi.fn(async (ch: { url: string }) => {
        watcher.channelUrl = ch.url;
      }),
      tick: vi.fn(tick),
      drainEvents: vi.fn<() => DiagnosticEvent[]>(() => []),
      stop: vi.fn(async () => {
        watcher.channelUrl = undefined;
      }),
    };
    return watcher;
  }

  function advanceToNextHeartbeatDue(): void {
    const nextDueAt = Date.now() + 60_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nextDueAt);
  }

  it("stops a tabless watcher without another heartbeat when authentication degrades", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    env.twitch.supportsTabless = true;
    env.twitch.createTablessWatcher = vi.fn(() => watcher);

    await env.controller.tick();
    expect(env.state.sessions.twitch.watchMode).toBe("tabless");
    env.state.authHealth.twitch = {
      status: "invalid_credentials",
      checkedAt: "2026-07-22T12:00:00.000Z",
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    };

    await env.controller.runWatchHeartbeat();

    expect(watcher.stop).toHaveBeenCalledOnce();
    expect(watcher.tick).not.toHaveBeenCalled();
  });

  // Drains every pending microtask. setTimeout stays real under the Date-only
  // fake timers these handoff tests install, so one turn of the macrotask queue
  // is enough to let an async loop run to its next park.
  const drainMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  // A `wait` the test releases by hand, so handoff loops advance
  // deterministically instead of racing real timers.
  function manualWait() {
    const pending: Array<() => void> = [];
    const wait = vi.fn(async (ms: number, signal: AbortSignal) => {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        pending.push(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      // The delay still consumes the handoff's time budget, so a loop driven
      // entirely by flush() still reaches its deadline.
      vi.setSystemTime(Date.now() + ms);
    });
    // Drain FIRST so the loop has actually parked — runClaimHandoff suspends on
    // loadSettings well before it reaches its first wait, and releasing an empty
    // queue would leave it parked forever.
    const flush = async () => {
      await drainMicrotasks();
      for (const resolve of pending.splice(0)) resolve();
      await drainMicrotasks();
    };
    return { wait, flush, get parked() { return pending.length; } };
  }

  function tablessEnv(overrides: Partial<ExtensionSettings> = {}) {
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
      },
      ...overrides,
    });
    env.twitch.supportsTabless = true;
    return env;
  }

  async function establishedTablessEnv(platform: Platform) {
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: platform === "twitch" },
        kick: {
          ...DEFAULT_SETTINGS.platform.kick,
          enabled: platform === "kick",
          idleWatchlistChannels: [],
        },
      },
    });
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }), platform);
    const adapter = platform === "twitch" ? env.twitch : env.kick;
    adapter.supportsTabless = true;
    adapter.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    await env.controller.tick([platform]);
    advanceToNextHeartbeatDue();
    return { env, adapter, watcher };
  }

  describe("tabless heartbeat cadence", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function cadenceEnv(
      heartbeat: () => Promise<{ ok: boolean; live?: boolean; message?: string }>,
    ) {
      const watcher = fakeTablessWatcher(heartbeat);
      const env = tablessEnv();
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      await env.controller.tick(["twitch"]);
      return { env, watcher };
    }

    function aggregateHeartbeatDiagnostics(env: ReturnType<typeof harness>): string[] {
      return allDiagnostics(env)
        .map((event) => event.message)
        .filter((message) => message.startsWith("Tabless heartbeat timing "));
    }

    it("keeps heartbeat cadence anchored to the scheduled due time after slow completion", async () => {
      const result = deferred<{ ok: boolean; live?: boolean; message?: string }>();
      const { env, watcher } = await cadenceEnv(() => result.promise);
      vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));

      const heartbeat = env.controller.runWatchHeartbeat();
      await drainMicrotasks();
      expect(watcher.tick).toHaveBeenCalledOnce();
      vi.setSystemTime(new Date("2026-09-02T12:01:07.000Z"));
      result.resolve({ ok: true, live: true });
      await heartbeat;

      expect(env.state.sessions.twitch.tablessHeartbeat?.nextDueAt)
        .toBe("2026-09-02T12:02:00.000Z");
    });

    it("skips missed heartbeat slots after a late wake without a catch-up burst", async () => {
      const { env, watcher } = await cadenceEnv(async () => ({ ok: true, live: true }));
      vi.setSystemTime(new Date("2026-09-02T12:04:15.000Z"));

      await env.controller.runWatchHeartbeat();

      expect(watcher.tick).toHaveBeenCalledOnce();
      expect(env.state.sessions.twitch.tablessHeartbeat?.nextDueAt)
        .toBe("2026-09-02T12:05:00.000Z");
    });

    it("coalesces three concurrent heartbeat calls into one transport attempt", async () => {
      const result = deferred<{ ok: boolean; live?: boolean; message?: string }>();
      const { env, watcher } = await cadenceEnv(() => result.promise);
      vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));

      const firstHeartbeat = env.controller.runWatchHeartbeat();
      await drainMicrotasks();
      expect(watcher.tick).toHaveBeenCalledOnce();
      const heartbeats = [
        firstHeartbeat,
        env.controller.runWatchHeartbeat(),
        env.controller.runWatchHeartbeat(),
      ];
      await drainMicrotasks();
      result.resolve({ ok: true, live: true });
      await Promise.all(heartbeats);

      expect(watcher.tick).toHaveBeenCalledOnce();
      expect(aggregateHeartbeatDiagnostics(env)).toEqual([
        expect.stringContaining("coalescedCalls=2"),
      ]);
    });

    it("performs no heartbeat transport before the scheduled due time", async () => {
      const { env, watcher } = await cadenceEnv(async () => ({ ok: true, live: true }));
      vi.setSystemTime(new Date("2026-09-02T12:00:59.999Z"));

      await env.controller.runWatchHeartbeat();

      expect(watcher.tick).not.toHaveBeenCalled();
      expect(env.state.sessions.twitch.tablessHeartbeat?.nextDueAt)
        .toBe("2026-09-02T12:01:00.000Z");
      expect(aggregateHeartbeatDiagnostics(env)).toEqual([]);
    });

    it("emits exactly one aggregate heartbeat timing diagnostic per attempt", async () => {
      const result = deferred<{ ok: boolean; live?: boolean; message?: string }>();
      const { env, watcher } = await cadenceEnv(() => result.promise);
      vi.setSystemTime(new Date("2026-09-02T12:04:15.000Z"));

      const firstHeartbeat = env.controller.runWatchHeartbeat();
      await drainMicrotasks();
      expect(watcher.tick).toHaveBeenCalledOnce();
      const heartbeats = [
        firstHeartbeat,
        env.controller.runWatchHeartbeat(),
        env.controller.runWatchHeartbeat(),
      ];
      await drainMicrotasks();
      result.resolve({ ok: true, live: true });
      await Promise.all(heartbeats);

      expect(aggregateHeartbeatDiagnostics(env)).toEqual([
        expect.stringMatching(
          /scheduledDueAt=2026-09-02T12:01:00.000Z actualAttemptAt=2026-09-02T12:04:15.000Z latenessMs=195000 synchronizationDelayMs=\d+ coalescedCalls=2 outcome=ok staleResult=false/,
        ),
      ]);
    });
  });

  it.each([
    { outcome: "success", result: { ok: true, live: true } },
    { outcome: "failure", result: { ok: false, live: true, message: "old heartbeat rejected" } },
  ] as const)(
    "rejects a stale heartbeat $outcome without changing the replacement session",
    async ({ outcome, result }) => {
      const oldResult = deferred<{ ok: boolean; live?: boolean; message?: string }>();
      const oldWatcher = fakeTablessWatcher(() => oldResult.promise);
      const newWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = tablessEnv({ tablessFallbackFailureLimit: 1 });
      env.twitch.createTablessWatcher = vi.fn()
        .mockReturnValueOnce(oldWatcher)
        .mockReturnValueOnce(newWatcher);
      env.state.authHealth.twitch = { status: "healthy" };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "watching",
        offlineChecks: 0,
        watchMode: "tabless",
        channel: channel("twitch", { broadcastId: "old-broadcast" }),
        campaignId: "old-campaign",
        rewardId: "old-reward",
        heartbeatChecks: outcome === "success" ? 1 : 0,
        lastHeartbeatAt: "2026-09-02T11:59:00.000Z",
        lastHeartbeatOk: false,
      };
      env.state.sessions.twitch.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.twitch);

      const oldHeartbeat = env.controller.runWatchHeartbeat();
      await vi.waitFor(() => expect(oldWatcher.tick).toHaveBeenCalledOnce());
      env.reportEvents.mockClear();
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "watching",
        offlineChecks: 0,
        watchMode: "tabless",
        channel: channel("twitch", {
          username: "new-creator",
          url: "https://www.twitch.tv/new-creator",
          broadcastId: "new-broadcast",
        }),
        campaignId: "new-campaign",
        rewardId: "new-reward",
        heartbeatChecks: 0,
      };
      const replacementHeartbeat = env.controller.runWatchHeartbeat();
      await vi.waitFor(() => expect(newWatcher.tick).toHaveBeenCalledOnce());

      oldResult.resolve(result);
      await Promise.all([oldHeartbeat, replacementHeartbeat]);

      expect(env.state.sessions.twitch).toMatchObject({
        channel: expect.objectContaining({
          username: "new-creator",
          broadcastId: "new-broadcast",
        }),
        campaignId: "new-campaign",
        rewardId: "new-reward",
        heartbeatChecks: 0,
        lastHeartbeatOk: true,
        tablessHeartbeat: expect.objectContaining({ generation: 2 }),
      });
      expect(env.state.sessions.twitch.lastHeartbeatAt).toBeDefined();
      expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
      const diagnostics = allDiagnostics(env).map((event) => event.message);
      expect(diagnostics).not.toContain("Tabless watch heartbeat recovered");
      expect(diagnostics).not.toContain("old heartbeat rejected");
      expect(diagnostics).not.toContain(
        "Tabless watch heartbeat keeps failing; falling back to a watch tab",
      );
      expect(env.reportEvents.mock.calls
        .flatMap(([events]) => events)
        .filter((event) => event.category === "activity")).toEqual([]);
      expect(aggregateHeartbeatDiagnostics(env, "twitch")).toHaveLength(2);
      expect(lastAggregateDiagnostic(env, "twitch")).toContain(
        `outcome=${outcome === "success" ? "ok" : "failed"}`,
      );
      expect(lastAggregateDiagnostic(env, "twitch")).toContain("staleResult=true");
    },
  );

  it("rejects a stale heartbeat after the same context advances generation", async () => {
    const oldResult = deferred<{ ok: boolean; live?: boolean; message?: string }>();
    const watcher = fakeTablessWatcher(() => oldResult.promise);
    const env = tablessEnv({ tablessFallbackFailureLimit: 1 });
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    env.state.authHealth.twitch = { status: "healthy" };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("twitch", { broadcastId: "same-broadcast" }),
      campaignId: "same-campaign",
      rewardId: "same-reward",
      heartbeatChecks: 0,
    };
    env.state.sessions.twitch.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.twitch);

    const heartbeat = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(watcher.tick).toHaveBeenCalledOnce());
    env.reportEvents.mockClear();
    env.state.sessions.twitch = {
      ...env.state.sessions.twitch,
      lastHeartbeatAt: "2026-09-02T12:00:30.000Z",
      lastHeartbeatOk: true,
      tablessHeartbeat: {
        ...env.state.sessions.twitch.tablessHeartbeat!,
        generation: 2,
      },
    };

    oldResult.resolve({ ok: false, live: true, message: "obsolete generation failed" });
    await heartbeat;

    expect(env.state.sessions.twitch).toMatchObject({
      channel: expect.objectContaining({ broadcastId: "same-broadcast" }),
      campaignId: "same-campaign",
      rewardId: "same-reward",
      heartbeatChecks: 0,
      lastHeartbeatAt: "2026-09-02T12:00:30.000Z",
      lastHeartbeatOk: true,
      tablessHeartbeat: expect.objectContaining({ generation: 2 }),
    });
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(allDiagnostics(env).map((event) => event.message))
      .not.toContain("obsolete generation failed");
    expect(aggregateHeartbeatDiagnostics(env, "twitch")).toHaveLength(1);
    expect(lastAggregateDiagnostic(env, "twitch")).toContain("outcome=failed");
    expect(lastAggregateDiagnostic(env, "twitch")).toContain("staleResult=true");
  });

  it("replaces a Kick watcher when the same channel URL changes category", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const oldResult = deferred<{ ok: boolean; live?: boolean; message?: string }>();
    const oldWatcher = fakeTablessWatcher(() => oldResult.promise, "kick");
    const replacement = fakeTablessWatcher(async () => ({ ok: true, live: true }), "kick");
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true, idleWatchlistChannels: [] },
      },
    });
    env.kick.supportsTabless = true;
    env.kick.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(oldWatcher)
      .mockReturnValueOnce(replacement);
    env.state.authHealth.kick = { status: "healthy" };
    env.state.sessions.kick = {
      platform: "kick",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("kick", { categoryId: "category-a" }),
      campaignId: "kick-campaign",
      rewardId: "reward",
      heartbeatChecks: 0,
    };
    env.state.sessions.kick.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.kick);

    const oldHeartbeat = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(oldWatcher.tick).toHaveBeenCalledOnce());
    env.state.sessions.kick = {
      ...env.state.sessions.kick,
      channel: { ...env.state.sessions.kick.channel!, categoryId: "category-b" },
    };
    const replacementHeartbeat = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(replacement.tick).toHaveBeenCalledOnce());

    oldResult.resolve({ ok: false, live: true, message: "obsolete category failed" });
    await Promise.all([oldHeartbeat, replacementHeartbeat]);

    expect(oldWatcher.stop).toHaveBeenCalledOnce();
    expect(replacement.start).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://kick.com/kick-creator",
        categoryId: "category-b",
      }),
      expect.any(Object),
    );
    expect(env.state.sessions.kick).toMatchObject({
      channel: expect.objectContaining({ categoryId: "category-b" }),
      heartbeatChecks: 0,
      lastHeartbeatOk: true,
      tablessHeartbeat: expect.objectContaining({ generation: 2 }),
    });
    expect(lastAggregateDiagnostic(env, "kick")).toContain("staleResult=true");
  });

  it("completes a due heartbeat while unchanged-target scheduler persistence is blocked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const { env, watcher } = await establishedTablessEnv("twitch");
    const schedulerSaveStarted = deferred<void>();
    const allowSchedulerSave = deferred<void>();
    const persist = env.deps.saveState.getMockImplementation()!;
    let blockNextSave = false;
    env.deps.applyAdFocus.mockImplementation(async () => {
      blockNextSave = true;
    });
    env.deps.saveState.mockImplementation(async (next) => {
      if (blockNextSave) {
        blockNextSave = false;
        schedulerSaveStarted.resolve();
        await allowSchedulerSave.promise;
      }
      await persist(next);
    });
    let transportCompleted = false;
    watcher.tick.mockClear();
    watcher.tick.mockImplementation(async () => {
      transportCompleted = true;
      return { ok: true, live: true };
    });

    const schedulerTick = env.controller.tick(["twitch"]);
    await schedulerSaveStarted.promise;
    const heartbeat = env.controller.runWatchHeartbeat();
    try {
      await drainMicrotasks();
      expect(watcher.tick).toHaveBeenCalledOnce();
      expect(transportCompleted).toBe(true);
    } finally {
      allowSchedulerSave.resolve();
      await Promise.all([schedulerTick, heartbeat]);
    }

    expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
  });

  it("completes a due heartbeat while snapshot selection is blocked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const selectionStarted = deferred<void>();
    const allowSelection = deferred<void>();
    let blockSelection = false;
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
      },
    }, {
      selectWatchTarget: async (...args) => {
        if (blockSelection) {
          selectionStarted.resolve();
          await allowSelection.promise;
        }
        return selectWatchTargetFromSnapshot(...args);
      },
    });
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    env.twitch.supportsTabless = true;
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    await env.controller.tick(["twitch"]);
    advanceToNextHeartbeatDue();
    watcher.tick.mockClear();

    blockSelection = true;
    const selection = env.controller.tick(["twitch"], "manual_tick");
    await selectionStarted.promise;
    const heartbeat = env.controller.runWatchHeartbeat();
    try {
      await drainMicrotasks();
      expect(watcher.tick).toHaveBeenCalledOnce();
      await heartbeat;
    } finally {
      allowSelection.resolve();
      await selection;
    }
    expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
    expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
      platform: "twitch",
      message: expect.stringContaining("Snapshot selection discarded stale lifecycle work"),
    }));
  });

  it("coalesces concurrent snapshot selection requests to one pending evaluation", async () => {
    const selectionStarted = deferred<void>();
    const allowSelection = deferred<void>();
    let blockSelection = false;
    const env = harness(farming(DEFAULT_SETTINGS), {
      selectWatchTarget: async (...args) => {
        if (blockSelection) {
          selectionStarted.resolve();
          await allowSelection.promise;
        }
        return selectWatchTargetFromSnapshot(...args);
      },
    });
    await env.controller.tick(["twitch"]);
    const selectWatchTarget = env.deps.selectWatchTarget!;
    selectWatchTarget.mockClear();

    blockSelection = true;
    const first = env.controller.tick(["twitch"], "manual_tick");
    await selectionStarted.promise;
    const second = env.controller.tick(["twitch"], "manual_tick");
    const third = env.controller.tick(["twitch"], "manual_tick");
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(2);
    allowSelection.resolve();
    await Promise.all([first, second, third]);

    expect(selectWatchTarget).toHaveBeenCalledTimes(2);
    expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
      platform: "twitch",
      message: "Coalesced scheduler triggers (count=2, reasons=manual_tick:2)",
    }));
  });

  it("passes persisted backoff state and bypasses it for explicit selection triggers", async () => {
    const inputs: Array<{ previousBackoff?: unknown; bypassBackoff?: boolean }> = [];
    const env = harness(farming(DEFAULT_SETTINGS), {
      selectWatchTarget: async (input) => {
        inputs.push(input as typeof input & { previousBackoff?: unknown; bypassBackoff?: boolean });
        const result = await selectWatchTargetFromSnapshot(input);
        return {
          ...result,
          backoff: { campaignId: "higher", retryAt: "2099-01-01T00:00:00.000Z", fingerprint: "material" },
        };
      },
    });
    env.state.campaignSearchBackoffs = {
      twitch: { campaignId: "higher", retryAt: "2099-01-01T00:00:00.000Z", fingerprint: "material" },
    };

    await env.controller.tick(["twitch"], "alarm");
    await env.controller.tick(["twitch"], "manual_tick");

    expect(inputs[0]).toMatchObject({
      previousBackoff: { campaignId: "higher", fingerprint: "material" },
      bypassBackoff: false,
    });
    expect(inputs.at(-1)).toMatchObject({ bypassBackoff: true });
    expect(env.state.campaignSearchBackoffs?.twitch).toMatchObject({ campaignId: "higher" });
  });

  it("skips backed-off Twitch candidate discovery across controller restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-08T04:00:00.000Z");
    const higher = { ...campaign("twitch"), id: "higher" };
    const current = { ...campaign("twitch"), id: "current" };
    const currentChannel = channel("twitch");
    const configured = farming({ ...DEFAULT_SETTINGS, campaignPriorities: { higher: 10 } });
    const initialState: SchedulerState = {
      ...structuredClone(DEFAULT_STATE),
      campaigns: { ...DEFAULT_STATE.campaigns, twitch: [higher, current] },
      sessions: {
        ...DEFAULT_STATE.sessions,
        twitch: {
          platform: "twitch",
          status: "watching",
          channel: currentChannel,
          campaignId: current.id,
          rewardId: current.rewards[0]?.id,
          offlineChecks: 0,
          watchMode: "tab",
          playback: {
            platform: "twitch",
            videoCount: 1,
            playingVideoCount: 1,
            mutedVideoCount: 1,
            unmutedVideoCount: 0,
            blockedPlaybackCount: 0,
            documentHidden: false,
            checkedAt: new Date().toISOString(),
          },
        },
      },
    };
    const configure = (env: ReturnType<typeof harness>) => {
      env.twitch.refreshCampaigns = vi.fn(async () => [higher, current]);
      env.twitch.listCandidateChannels = vi.fn(async (selected) => [
        selected.id === current.id ? currentChannel : { ...currentChannel, username: "higher", url: "https://www.twitch.tv/higher" },
      ]);
      env.twitch.checkChannel = vi.fn(async (candidate, options) => ({
        live: true,
        categoryMatches: true,
        campaignMatches: options?.campaign?.id === higher.id ? false : true,
        candidate,
      }));
    };
    const first = harness(configured, { initialState });
    configure(first);
    await first.controller.tick(["twitch"], "alarm");
    expect(first.twitch.listCandidateChannels).toHaveBeenCalledTimes(2);
    expect(first.state.campaignSearchBackoffs?.twitch?.campaignId).toBe("higher");

    const restarted = harness(configured, { initialState: structuredClone(first.state) });
    configure(restarted);
    await restarted.controller.tick(["twitch"], "startup");

    expect(vi.mocked(restarted.twitch.listCandidateChannels).mock.calls.map(([item]) => item.id)).toEqual(["current"]);
    expect(restarted.twitch.listCandidateChannels).toHaveBeenCalledWith(
      expect.objectContaining({ id: "current" }),
      expect.anything(),
    );
    expect(allDiagnostics(restarted)).toContainEqual(expect.objectContaining({
      message: expect.stringMatching(/^Skipped authoritative negative campaign search for higher \(\d+ms remaining\)$/),
    }));

    await restarted.controller.tick(["twitch"], "manual_tick");
    expect(vi.mocked(restarted.twitch.listCandidateChannels).mock.calls.map(([item]) => item.id)).toEqual([
      "current",
      "higher",
      "current",
    ]);
  });

  it("completes a due initial heartbeat while discovery-signal start is blocked after publication", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const observerStartReached = deferred<void>();
    const allowObserverStart = deferred<void>();
    let transportCompleted = false;
    const watcher = fakeTablessWatcher(async () => {
      transportCompleted = true;
      return { ok: true, live: true };
    }, "kick");
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true, idleWatchlistChannels: [] },
      },
    });
    env.kick.supportsTabless = true;
    env.kick.createTablessWatcher = vi.fn(() => watcher);
    const startObserver = env.discoverySignalController.start.bind(env.discoverySignalController);
    vi.spyOn(env.discoverySignalController, "start").mockImplementation(async (target, onSignal) => {
      await startObserver(target, onSignal);
      observerStartReached.resolve();
      await allowObserverStart.promise;
    });

    const schedulerTick = env.controller.tick(["kick"]);
    await observerStartReached.promise;
    expect(watcher.start).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));
    const heartbeat = env.controller.runWatchHeartbeat();
    try {
      await drainMicrotasks();
      expect(watcher.tick).toHaveBeenCalledOnce();
      expect(transportCompleted).toBe(true);
    } finally {
      allowObserverStart.resolve();
      await Promise.all([schedulerTick, heartbeat]);
    }

    expect(env.kick.createTablessWatcher).toHaveBeenCalledOnce();
    expect(env.state.sessions.kick.lastHeartbeatOk).toBe(true);
  });

  it("publishes a successor before an old heartbeat result can block the handoff", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const oldResult = deferred<{ ok: boolean; live?: boolean; message?: string }>();
    const allowSuccessorStart = deferred<void>();
    const allowOldResultSave = deferred<void>();
    const oldWatcher = fakeTablessWatcher(() => oldResult.promise);
    const successorWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    successorWatcher.start.mockImplementation(async (candidate) => {
      await allowSuccessorStart.promise;
      successorWatcher.channelUrl = candidate.url;
    });
    const successorChannel = channel("twitch", {
      username: "unpublished-successor",
      url: "https://www.twitch.tv/unpublished-successor",
      broadcastId: "unpublished-successor-broadcast",
    });
    const successorCampaign: DropCampaign = {
      ...campaign("twitch"),
      id: "unpublished-successor-campaign",
      rewards: [{ ...reward(), id: "unpublished-successor-reward" }],
    };
    const env = tablessEnv();
    env.twitch.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(oldWatcher)
      .mockReturnValueOnce(successorWatcher);
    await env.controller.tick(["twitch"]);
    vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));

    const oldHeartbeat = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(oldWatcher.tick).toHaveBeenCalledOnce());
    const persist = env.deps.saveState.getMockImplementation()!;
    let oldResultSaveBlocked = false;
    env.deps.saveState.mockImplementation(async (next) => {
      if (
        next.sessions.twitch.campaignId === "twitch-campaign"
        && next.sessions.twitch.lastHeartbeatAt !== undefined
      ) {
        oldResultSaveBlocked = true;
        await allowOldResultSave.promise;
      }
      await persist(next);
    });
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([successorCampaign]);
    vi.mocked(env.twitch.listCandidateChannels).mockResolvedValue([successorChannel]);

    const successorTick = env.controller.tick(["twitch"]);
    await vi.waitFor(() => expect(successorWatcher.start).toHaveBeenCalledOnce());
    oldResult.resolve({ ok: true, live: true });
    await drainMicrotasks();
    allowSuccessorStart.resolve();
    try {
      await drainMicrotasks();
      expect(oldWatcher.stop).toHaveBeenCalledOnce();
      expect(oldResultSaveBlocked).toBe(false);
    } finally {
      allowOldResultSave.resolve();
      await Promise.all([successorTick, oldHeartbeat]);
    }

    expect(env.state.sessions.twitch).toMatchObject({
      campaignId: "unpublished-successor-campaign",
      rewardId: "unpublished-successor-reward",
      tablessHeartbeat: expect.objectContaining({ generation: 2 }),
    });
    expect(env.state.sessions.twitch.lastHeartbeatAt).toBeUndefined();
    expect(lastAggregateDiagnostic(env, "twitch")).toContain("staleResult=true");
  });

  it("rejects an old heartbeat while a successor lane waits to save scheduler state", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const oldResult = deferred<{ ok: boolean; live?: boolean; message?: string }>();
    const allowSuccessorSave = deferred<void>();
    const oldWatcher = fakeTablessWatcher(() => oldResult.promise);
    oldWatcher.stop.mockImplementation(async () => {
      await allowSuccessorSave.promise;
      oldWatcher.channelUrl = undefined;
    });
    const successorWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const successorChannel = channel("twitch", {
      username: "successor-creator",
      url: "https://www.twitch.tv/successor-creator",
      broadcastId: "successor-broadcast",
    });
    const successorCampaign: DropCampaign = {
      ...campaign("twitch"),
      id: "successor-campaign",
      rewards: [{ ...reward(), id: "successor-reward" }],
    };
    const env = tablessEnv({ tablessFallbackFailureLimit: 1 });
    env.twitch.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(oldWatcher)
      .mockReturnValueOnce(successorWatcher);
    env.state.authHealth.twitch = { status: "healthy" };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("twitch", { broadcastId: "old-broadcast" }),
      campaignId: "old-campaign",
      rewardId: "old-reward",
      heartbeatChecks: 0,
    };
    env.state.sessions.twitch.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.twitch);

    const oldHeartbeat = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(oldWatcher.tick).toHaveBeenCalledOnce());
    env.reportEvents.mockClear();
    env.deps.saveState.mockClear();
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([successorCampaign]);
    vi.mocked(env.twitch.listCandidateChannels).mockResolvedValue([successorChannel]);

    const successorTick = env.controller.tick(["twitch"]);
    // Displaced-watcher cleanup starts only after commitHeartbeatContext has
    // published the complete successor, and scheduler persistence follows it.
    await vi.waitFor(() => expect(oldWatcher.stop).toHaveBeenCalledOnce());
    expect(successorWatcher.start).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "successor-creator",
        broadcastId: "successor-broadcast",
      }),
      expect.any(Object),
    );
    const savesBeforeOldResult = env.deps.saveState.mock.calls.length;

    try {
      oldResult.resolve({
        ok: false,
        live: true,
        message: "obsolete lane heartbeat failed",
      });
      await oldHeartbeat;

      expect(env.state.sessions.twitch).toMatchObject({
        channel: expect.objectContaining({ broadcastId: "old-broadcast" }),
        campaignId: "old-campaign",
        rewardId: "old-reward",
        heartbeatChecks: 0,
      });
      expect(env.state.sessions.twitch.lastHeartbeatAt).toBeUndefined();
      expect(env.state.sessions.twitch.lastHeartbeatOk).toBeUndefined();
      expect(env.state.sessions.twitch.tablessHeartbeat).toEqual({
        generation: 1,
        contextKey: "[\"twitch\",\"https://www.twitch.tv/twitch-creator\",\"twitch-creator\",\"old-broadcast\",\"\",\"\",\"old-campaign\",\"old-reward\"]",
        nextDueAt: "2026-09-02T12:00:00.000Z",
      });
      expect(env.deps.saveState).toHaveBeenCalledTimes(savesBeforeOldResult);
      expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
      const diagnostics = allDiagnostics(env).map((event) => event.message);
      expect(diagnostics).not.toContain("obsolete lane heartbeat failed");
      expect(diagnostics).not.toContain(
        "Tabless watch heartbeat keeps failing; falling back to a watch tab",
      );
      expect(env.reportEvents.mock.calls
        .flatMap(([events]) => events)
        .filter((event) => event.category === "activity")).toEqual([]);
      expect(aggregateHeartbeatDiagnostics(env, "twitch")).toHaveLength(1);
      expect(lastAggregateDiagnostic(env, "twitch")).toContain("outcome=failed");
      expect(lastAggregateDiagnostic(env, "twitch")).toContain("staleResult=true");
    } finally {
      allowSuccessorSave.resolve();
      await successorTick;
    }

    expect(env.state.sessions.twitch).toMatchObject({
      channel: expect.objectContaining({
        username: "successor-creator",
        broadcastId: "successor-broadcast",
      }),
      campaignId: "successor-campaign",
      rewardId: "successor-reward",
      heartbeatChecks: 0,
    });
    expect(env.state.sessions.twitch.lastHeartbeatAt).toBeUndefined();
    expect(env.state.sessions.twitch.lastHeartbeatOk).toBeUndefined();
  });

  it("keeps a scheduler target switch authoritative while its watcher start is blocked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const allowSuccessorStart = deferred<void>();
    const oldWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const successorWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    successorWatcher.start.mockImplementation(async (candidate) => {
      await allowSuccessorStart.promise;
      successorWatcher.channelUrl = candidate.url;
    });
    const successorChannel = channel("twitch", {
      username: "lease-successor",
      url: "https://www.twitch.tv/lease-successor",
      broadcastId: "lease-successor-broadcast",
    });
    const successorCampaign: DropCampaign = {
      ...campaign("twitch"),
      id: "lease-successor-campaign",
      rewards: [{ ...reward(), id: "lease-successor-reward" }],
    };
    const env = tablessEnv();
    env.twitch.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(oldWatcher)
      .mockReturnValueOnce(successorWatcher);
    await env.controller.tick(["twitch"]);
    vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([successorCampaign]);
    vi.mocked(env.twitch.listCandidateChannels).mockResolvedValue([successorChannel]);

    const successorTick = env.controller.tick(["twitch"]);
    await vi.waitFor(() => expect(successorWatcher.start).toHaveBeenCalledOnce());
    const alarm = env.controller.runWatchHeartbeat();
    try {
      await drainMicrotasks();
      expect(oldWatcher.tick).not.toHaveBeenCalled();
    } finally {
      allowSuccessorStart.resolve();
      await Promise.all([successorTick, alarm]);
    }

    expect(oldWatcher.stop).toHaveBeenCalledOnce();
    expect(successorWatcher.stop).not.toHaveBeenCalled();
    expect(env.state.sessions.twitch).toMatchObject({
      channel: expect.objectContaining({ username: "lease-successor" }),
      campaignId: "lease-successor-campaign",
      rewardId: "lease-successor-reward",
      tablessHeartbeat: expect.objectContaining({ generation: 2 }),
    });
    // The blocked-start wait uses Vitest's polling clock, so the new anchor can
    // be a few fake milliseconds after 12:02:00. Advance past that slot.
    vi.setSystemTime(new Date("2026-09-02T12:03:00.000Z"));
    await env.controller.runWatchHeartbeat();
    expect(oldWatcher.tick).not.toHaveBeenCalled();
    expect(successorWatcher.tick).toHaveBeenCalledOnce();
  });

  it("keeps an initial published watcher authoritative until scheduler persistence", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const allowSchedulerSave = deferred<void>();
    const schedulerSaveStarted = deferred<void>();
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const obsoleteRecovery = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv({ postClaimHandoff: true });
    env.twitch.supportsPostClaimHandoff = true;
    env.twitch.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(watcher)
      .mockReturnValueOnce(obsoleteRecovery);
    const persist = env.deps.saveState.getMockImplementation()!;
    env.deps.saveState.mockImplementation(async (next) => {
      if (
        next.sessions.twitch.status === "watching"
        && next.sessions.twitch.tablessHeartbeat !== undefined
      ) {
        schedulerSaveStarted.resolve();
        await allowSchedulerSave.promise;
      }
      await persist(next);
    });

    const schedulerTick = env.controller.tick(["twitch"]);
    await schedulerSaveStarted.promise;
    expect(watcher.start).toHaveBeenCalledOnce();
    const alarm = env.controller.runWatchHeartbeat();
    try {
      await drainMicrotasks();
      expect(watcher.stop).not.toHaveBeenCalled();
      expect(obsoleteRecovery.start).not.toHaveBeenCalled();
    } finally {
      allowSchedulerSave.resolve();
      await Promise.all([schedulerTick, alarm]);
    }

    expect(watcher.tick).not.toHaveBeenCalled();
    expect(watcher.stop).not.toHaveBeenCalled();
    expect(obsoleteRecovery.start).not.toHaveBeenCalled();
    expect(env.twitch.createTablessWatcher).toHaveBeenCalledOnce();

    await env.controller.runClaimHandoff("twitch");
    expect(watcher.tick).toHaveBeenCalledOnce();
    expect(env.state.sessions.twitch.tablessHeartbeat?.nextDueAt)
      .toBe("2026-09-02T12:01:00.000Z");

    vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));
    await env.controller.runWatchHeartbeat();
    expect(watcher.tick).toHaveBeenCalledTimes(2);
  });

  it("keeps the published successor authoritative while its scheduler save is pending", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const allowSuccessorSave = deferred<void>();
    const successorSaveStarted = deferred<void>();
    const oldWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const successorWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const obsoleteRecovery = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const successorChannel = channel("twitch", {
      username: "successor-creator",
      url: "https://www.twitch.tv/successor-creator",
      broadcastId: "successor-broadcast",
    });
    const successorCampaign: DropCampaign = {
      ...campaign("twitch"),
      id: "successor-campaign",
      rewards: [{ ...reward(), id: "successor-reward" }],
    };
    const env = tablessEnv({ postClaimHandoff: true });
    env.twitch.supportsPostClaimHandoff = true;
    env.twitch.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(oldWatcher)
      .mockReturnValueOnce(successorWatcher)
      .mockReturnValueOnce(obsoleteRecovery);
    await env.controller.tick(["twitch"]);
    vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([successorCampaign]);
    vi.mocked(env.twitch.listCandidateChannels).mockResolvedValue([successorChannel]);
    const persist = env.deps.saveState.getMockImplementation()!;
    env.deps.saveState.mockImplementation(async (next) => {
      if (next.sessions.twitch.rewardId === "successor-reward") {
        successorSaveStarted.resolve();
        await allowSuccessorSave.promise;
      }
      await persist(next);
    });

    const successorTick = env.controller.tick(["twitch"]);
    await successorSaveStarted.promise;
    expect(successorWatcher.start).toHaveBeenCalledOnce();
    // The lane now owns generation 2, while loadState still returns the old
    // generation-1 session until the blocked scheduler save completes.
    const alarm = env.controller.runWatchHeartbeat();
    await drainMicrotasks();
    allowSuccessorSave.resolve();
    await Promise.all([successorTick, alarm]);

    expect(successorWatcher.stop).not.toHaveBeenCalled();
    expect(obsoleteRecovery.start).not.toHaveBeenCalled();
    expect(obsoleteRecovery.tick).not.toHaveBeenCalled();
    expect(env.twitch.createTablessWatcher).toHaveBeenCalledTimes(2);

    await env.controller.runClaimHandoff("twitch", ["reward"]);

    expect(successorWatcher.tick).toHaveBeenCalledOnce();
    expect(env.state.sessions.twitch).toMatchObject({
      campaignId: "successor-campaign",
      rewardId: "successor-reward",
      lastHeartbeatOk: true,
      tablessHeartbeat: expect.objectContaining({ generation: 2 }),
    });
  });

  it("advances generation when the same context is recreated after detachment", async () => {
    const oldResult = deferred<{ ok: boolean; live?: boolean; message?: string }>();
    const oldWatcher = fakeTablessWatcher(() => oldResult.promise);
    const replacement = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv({ tablessFallbackFailureLimit: 1 });
    env.twitch.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(oldWatcher)
      .mockReturnValueOnce(replacement);
    env.state.authHealth.twitch = { status: "healthy" };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("twitch", { broadcastId: "same-broadcast" }),
      campaignId: "same-campaign",
      rewardId: "same-reward",
      heartbeatChecks: 0,
    };
    env.state.sessions.twitch.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.twitch);

    const oldHeartbeat = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(oldWatcher.tick).toHaveBeenCalledOnce());
    env.state.authHealth.twitch = {
      status: "invalid_credentials",
      checkedAt: "2026-09-02T12:00:01.000Z",
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    };
    await env.controller.runWatchHeartbeat();
    expect(oldWatcher.stop).toHaveBeenCalledOnce();

    env.state.authHealth.twitch = { status: "healthy" };
    const replacementHeartbeat = env.controller.runWatchHeartbeat();
    try {
      await drainMicrotasks();
      expect(replacement.tick).toHaveBeenCalledOnce();
    } finally {
      oldResult.resolve({ ok: false, live: true, message: "obsolete recreation failed" });
      await Promise.all([oldHeartbeat, replacementHeartbeat]);
    }

    expect(env.state.sessions.twitch).toMatchObject({
      lastHeartbeatOk: true,
      heartbeatChecks: 0,
      tablessHeartbeat: expect.objectContaining({ generation: 2 }),
    });
    expect(lastAggregateDiagnostic(env, "twitch")).toContain("staleResult=true");
  });

  it("serializes service-worker restart recovery without letting a slow old target win", async () => {
    const slowStart = deferred<void>();
    const oldWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    oldWatcher.start.mockImplementation(async (candidate) => {
      await slowStart.promise;
      oldWatcher.channelUrl = candidate.url;
    });
    const newWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(oldWatcher)
      .mockReturnValueOnce(newWatcher);
    env.state.authHealth.twitch = { status: "healthy" };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("twitch", { broadcastId: "old-broadcast" }),
      campaignId: "old-campaign",
      rewardId: "old-reward",
    };
    env.state.sessions.twitch.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.twitch);

    const oldRecovery = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(oldWatcher.start).toHaveBeenCalled());
    env.state.sessions.twitch = {
      ...env.state.sessions.twitch,
      channel: channel("twitch", {
        username: "new-creator",
        url: "https://www.twitch.tv/new-creator",
        broadcastId: "new-broadcast",
      }),
      campaignId: "new-campaign",
      rewardId: "new-reward",
      tablessHeartbeat: undefined,
    };
    env.state.sessions.twitch.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.twitch);
    const newRecovery = env.controller.runWatchHeartbeat();
    await drainMicrotasks();
    expect(newWatcher.start).not.toHaveBeenCalled();

    slowStart.resolve();
    await Promise.all([oldRecovery, newRecovery]);

    expect(oldWatcher.stop).toHaveBeenCalledOnce();
    expect(newWatcher.stop).not.toHaveBeenCalled();
    expect(newWatcher.tick).toHaveBeenCalledOnce();
    oldWatcher.tick.mockClear();
    newWatcher.tick.mockClear();
    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat();
    expect(oldWatcher.tick).not.toHaveBeenCalled();
    expect(newWatcher.tick).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent same-context service-worker restart recovery", async () => {
    const slowStart = deferred<void>();
    const slowWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }), "kick");
    slowWatcher.start.mockImplementation(async (candidate) => {
      await slowStart.promise;
      slowWatcher.channelUrl = candidate.url;
    });
    const winner = fakeTablessWatcher(async () => ({ ok: true, live: true }), "kick");
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true, idleWatchlistChannels: [] },
      },
    });
    env.kick.supportsTabless = true;
    env.kick.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(slowWatcher)
      .mockReturnValueOnce(winner);
    env.state.authHealth.kick = { status: "healthy" };
    env.state.sessions.kick = {
      platform: "kick",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("kick"),
      campaignId: "kick-campaign",
      rewardId: "reward",
    };
    env.state.sessions.kick.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.kick);

    const slowRecovery = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(slowWatcher.start).toHaveBeenCalled());
    const winningRecovery = env.controller.runWatchHeartbeat();
    await drainMicrotasks();
    expect(winner.start).not.toHaveBeenCalled();

    slowStart.resolve();
    await Promise.all([slowRecovery, winningRecovery]);

    expect(slowWatcher.stop).not.toHaveBeenCalled();
    expect(slowWatcher.tick).toHaveBeenCalledOnce();
    expect(winner.stop).not.toHaveBeenCalled();
    expect(winner.tick).not.toHaveBeenCalled();
    expect(env.kick.createTablessWatcher).toHaveBeenCalledOnce();
    slowWatcher.tick.mockClear();
    winner.tick.mockClear();
    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat();
    expect(slowWatcher.tick).toHaveBeenCalledOnce();
    expect(winner.tick).not.toHaveBeenCalled();
  });

  it("does not let a stale non-tabless removal clear a newer committed winner", async () => {
    const winnerStart = deferred<void>();
    const winner = fakeTablessWatcher(async () => ({ ok: true, live: true }), "kick");
    winner.start.mockImplementation(async (candidate) => {
      await winnerStart.promise;
      winner.channelUrl = candidate.url;
    });
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true, idleWatchlistChannels: [] },
      },
    });
    env.kick.supportsTabless = true;
    env.kick.createTablessWatcher = vi.fn(() => winner);
    const winningState = structuredClone(env.state);
    winningState.authHealth.kick = { status: "healthy" };
    winningState.sessions.kick = {
      platform: "kick",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("kick"),
      campaignId: "kick-campaign",
      rewardId: "reward",
    };
    winningState.sessions.kick.tablessHeartbeat = dueHeartbeatCadence(winningState.sessions.kick);
    const staleState = structuredClone(winningState);
    staleState.sessions.kick = {
      platform: "kick",
      status: "paused",
      offlineChecks: 0,
    };
    const staleRead = deferred<SchedulerState>();
    env.deps.loadState
      .mockResolvedValueOnce(winningState)
      .mockResolvedValueOnce(winningState)
      .mockImplementationOnce(() => staleRead.promise)
      .mockImplementationOnce(() => staleRead.promise)
      .mockResolvedValueOnce(winningState);

    const winningRecovery = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(winner.start).toHaveBeenCalled());
    const staleRemoval = env.controller.runWatchHeartbeat();
    staleRead.resolve(staleState);
    winnerStart.resolve();
    await Promise.all([winningRecovery, staleRemoval]);

    expect(winner.stop).not.toHaveBeenCalled();
    winner.tick.mockClear();
    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat();
    expect(winner.tick).toHaveBeenCalledOnce();
  });

  it("does not let a stale removal revision reject a newer candidate", async () => {
    const candidate = fakeTablessWatcher(async () => ({ ok: true, live: true }), "kick");
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true, idleWatchlistChannels: [] },
      },
    });
    env.kick.supportsTabless = true;
    env.kick.createTablessWatcher = vi.fn(() => candidate);
    const candidateState = structuredClone(env.state);
    candidateState.authHealth.kick = { status: "healthy" };
    candidateState.sessions.kick = {
      platform: "kick",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("kick"),
      campaignId: "kick-campaign",
      rewardId: "reward",
    };
    candidateState.sessions.kick.tablessHeartbeat = dueHeartbeatCadence(candidateState.sessions.kick);
    const staleState = structuredClone(candidateState);
    staleState.sessions.kick = {
      platform: "kick",
      status: "paused",
      offlineChecks: 0,
    };
    const staleRead = deferred<SchedulerState>();
    const candidateRead = deferred<SchedulerState>();
    env.deps.loadState
      .mockImplementationOnce(() => staleRead.promise)
      .mockImplementationOnce(() => staleRead.promise)
      .mockImplementationOnce(() => candidateRead.promise)
      .mockImplementationOnce(() => candidateRead.promise)
      .mockResolvedValueOnce(candidateState);

    const staleRemoval = env.controller.runWatchHeartbeat();
    const winningRecovery = env.controller.runWatchHeartbeat();
    staleRead.resolve(staleState);
    candidateRead.resolve(candidateState);
    await Promise.all([staleRemoval, winningRecovery]);

    expect(candidate.stop).not.toHaveBeenCalled();
    candidate.tick.mockClear();
    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat();
    expect(candidate.tick).toHaveBeenCalledOnce();
  });

  it.each(["startup", "host reset"] as const)(
    "%s atomically clears heartbeat ownership before a later heartbeat",
    async (lifecycle) => {
      const stoppedWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const replacement = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = tablessEnv({ autoStartDropFarming: true });
      env.twitch.createTablessWatcher = vi.fn()
        .mockReturnValueOnce(stoppedWatcher)
        .mockReturnValueOnce(replacement);
      await env.controller.tick(["twitch"]);
      stoppedWatcher.tick.mockClear();

      if (lifecycle === "startup") {
        await env.controller.handleStartup();
      } else {
        await env.controller.prepareForHostReset();
      }
      advanceToNextHeartbeatDue();
      await env.controller.runWatchHeartbeat();

      expect(stoppedWatcher.stop).toHaveBeenCalledOnce();
      expect(stoppedWatcher.tick).not.toHaveBeenCalled();
      expect(replacement.tick).toHaveBeenCalledOnce();
      expect(replacement.stop).not.toHaveBeenCalled();
      expect(env.twitch.createTablessWatcher).toHaveBeenCalledTimes(2);
    },
  );

  it("shutdown atomically detaches heartbeat ownership before watcher cleanup", async () => {
    const cleanup = deferred<void>();
    const { env, watcher } = await establishedTablessEnv("twitch");
    watcher.stop.mockImplementation(async () => cleanup.promise);

    env.controller.shutdown();
    await vi.waitFor(() => expect(watcher.stop).toHaveBeenCalledOnce());
    await env.controller.runWatchHeartbeat();

    expect(watcher.tick).not.toHaveBeenCalled();
    cleanup.resolve();
    await env.controller.settleBackgroundWork();
  });

  it.each(["scheduled", "immediate"] as const)(
    "does not reserve a queued %s heartbeat after shutdown wins lane admission",
    async (kind) => {
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = tablessEnv({ postClaimHandoff: true });
      env.twitch.supportsPostClaimHandoff = true;
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      await env.controller.tick(["twitch"]);
      if (kind === "scheduled") advanceToNextHeartbeatDue();

      // Queue shutdown immediately before withHeartbeatLane queues its callback.
      // The request therefore entered the common path while live, but the lane
      // reservation itself must observe shutdown and avoid even reading attemptAt.
      const now = Date.now();
      let reads = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
        reads += 1;
        if (reads === 1) queueMicrotask(() => env.controller.shutdown());
        return now;
      });
      try {
        if (kind === "scheduled") {
          await env.controller.runWatchHeartbeat();
        } else {
          await env.controller.runClaimHandoff("twitch", ["claimed-reward"]);
        }
      } finally {
        nowSpy.mockRestore();
        await env.controller.settleBackgroundWork();
      }

      expect(watcher.tick).not.toHaveBeenCalled();
      expect(aggregateHeartbeatDiagnostics(env, "twitch")).toEqual([]);
    },
  );

  it.each(["scheduled", "immediate"] as const)(
    "does not launch an admitted %s heartbeat when shutdown begins before transport",
    async (kind) => {
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = tablessEnv({ postClaimHandoff: true });
      env.twitch.supportsPostClaimHandoff = true;
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      await env.controller.tick(["twitch"]);
      if (kind === "scheduled") advanceToNextHeartbeatDue();

      // Date.now is read once before queueing and once while reserving. Landing
      // shutdown on the latter exercises the final pre-transport admission
      // check after the lane has already created an attempt.
      const now = Date.now();
      let reads = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
        reads += 1;
        if (reads === 2) env.controller.shutdown();
        return now;
      });
      try {
        if (kind === "scheduled") {
          await env.controller.runWatchHeartbeat();
        } else {
          await env.controller.runClaimHandoff("twitch", ["claimed-reward"]);
        }
      } finally {
        nowSpy.mockRestore();
        await env.controller.settleBackgroundWork();
      }

      expect(watcher.tick).not.toHaveBeenCalled();
      expect(aggregateHeartbeatDiagnostics(env, "twitch")).toEqual([]);
    },
  );

  it("farms tablessly without opening a tab and records heartbeat health", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;

    await env.controller.tick();

    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.state.sessions.twitch.watchMode).toBe("tabless");
    expect(watcher.start).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://www.twitch.tv/twitch-creator" }),
      expect.any(Object),
    );

    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat();

    expect(watcher.tick).toHaveBeenCalled();
    expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
    expect(env.state.sessions.twitch.heartbeatChecks).toBe(0);
  });

  it("lets Kick heartbeat and persist while Twitch heartbeat is still pending", async () => {
    const twitchHeartbeat = deferred<{ ok: boolean; live?: boolean; message?: string }>();
    const twitchWatcher = fakeTablessWatcher(() => twitchHeartbeat.promise, "twitch");
    const kickWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }), "kick");
    const env = harness(farming({ ...DEFAULT_SETTINGS, tablessMode: true }));
    env.twitch.supportsTabless = true;
    env.kick.supportsTabless = true;
    env.twitch.createTablessWatcher = () => twitchWatcher as unknown as TablessWatchController;
    env.kick.createTablessWatcher = () => kickWatcher as unknown as TablessWatchController;
    await env.controller.tick(["twitch"]);
    await env.controller.tick(["kick"]);

    advanceToNextHeartbeatDue();
    const heartbeat = env.controller.runWatchHeartbeat();

    try {
      await vi.waitFor(() => expect(twitchWatcher.tick).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(kickWatcher.tick).toHaveBeenCalledOnce());
      expect(env.state.sessions.kick.lastHeartbeatOk).toBe(true);
      expect(env.state.sessions.twitch.lastHeartbeatAt).toBeUndefined();
    } finally {
      twitchHeartbeat.resolve({ ok: true, live: true });
      await heartbeat;
    }

    expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
    expect(env.state.sessions.kick.lastHeartbeatOk).toBe(true);
  });

  it.each(["twitch", "kick"] as const)(
    "attempts a due %s heartbeat while discovery holds the platform lock",
    async (platform) => {
      const blocked = deferred<DropCampaign[]>();
      const { env, adapter, watcher } = await establishedTablessEnv(platform);
      adapter.refreshCampaigns = vi.fn(() => blocked.promise);
      const discovery = env.controller.tick([platform]);
      await vi.waitFor(() => expect(adapter.refreshCampaigns).toHaveBeenCalled());

      const heartbeat = env.controller.runWatchHeartbeat();
      try {
        await vi.waitFor(() => expect(watcher.tick).toHaveBeenCalled());
      } finally {
        blocked.resolve([]);
        await Promise.all([discovery, heartbeat]);
      }
    },
  );

  it.each(["twitch", "kick"] as const)(
    "runs %s discovery while the platform heartbeat transport is pending",
    async (platform) => {
      const blocked = deferred<{ ok: boolean; live?: boolean; message?: string }>();
      const { env, adapter, watcher } = await establishedTablessEnv(platform);
      watcher.tick.mockImplementation(() => blocked.promise);

      const heartbeat = env.controller.runWatchHeartbeat();
      await vi.waitFor(() => expect(watcher.tick).toHaveBeenCalled());
      const discovery = env.controller.tick([platform]);
      try {
        await vi.waitFor(() => expect(adapter.refreshCampaigns).toHaveBeenCalledTimes(2));
      } finally {
        blocked.resolve({ ok: true, live: true });
        await Promise.all([heartbeat, discovery]);
      }
    },
  );

  it("merge-safely persists page-context lifecycle metadata changed during a heartbeat", async () => {
    const heartbeatResult = deferred<{ ok: boolean; live?: boolean; message?: string }>();
    const watcher = fakeTablessWatcher(async () => {
      recordManagedPageContextFallback("twitch", "gql.twitch.tv", undefined, Date.parse("2026-07-21T12:00:00.000Z"));
      return heartbeatResult.promise;
    });
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    await env.controller.tick();
    const context = {
      platform: "twitch" as const,
      tabId: 66,
      originUrl: "https://www.twitch.tv/drops/inventory",
      origin: "https://www.twitch.tv",
      ownedByExtension: true as const,
    };
    env.state.managedPageContextTabs = { twitch: context };
    registerManagedPageContextTabs({ twitch: context });

    advanceToNextHeartbeatDue();
    const heartbeat = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(watcher.tick).toHaveBeenCalledOnce());
    env.state.sessions.twitch.offlineChecks = 3;
    heartbeatResult.resolve({ ok: true, live: true });
    await heartbeat;

    expect(env.state.sessions.twitch.offlineChecks).toBe(3);
    expect(env.state.managedPageContextTabs?.twitch).toMatchObject({
      tabId: 66,
      fallbackHost: "gql.twitch.tv",
      backgroundSuccesses: 0,
      lastFallbackAt: "2026-07-21T12:00:00.000Z",
    });
  });

  it("does not hydrate an old persisted page context over a newer registry update", async () => {
    const staleRead = deferred<SchedulerState>();
    const env = tablessEnv();
    const oldContext = {
      platform: "twitch" as const,
      tabId: 66,
      originUrl: "https://www.twitch.tv/old-context",
      origin: "https://www.twitch.tv",
      ownedByExtension: true as const,
    };
    const newerContext = {
      ...oldContext,
      tabId: 77,
      originUrl: "https://www.twitch.tv/newer-context",
      lastFallbackAt: "2026-09-02T12:00:00.000Z",
      fallbackHost: "gql.twitch.tv",
      backgroundSuccesses: 0,
    };
    const staleState = structuredClone(env.state);
    staleState.managedPageContextTabs = { twitch: oldContext };
    env.deps.loadState
      .mockImplementationOnce(() => staleRead.promise)
      .mockResolvedValue(env.state);

    const heartbeat = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(env.deps.loadState).toHaveBeenCalled());
    registerManagedPageContextTabs({ twitch: newerContext });
    staleRead.resolve(staleState);
    try {
      await heartbeat;
      expect(currentManagedPageContextTabs().twitch).toEqual(newerContext);
    } finally {
      registerManagedPageContextTabs({});
    }
  });

  it("retains a heartbeat page-context update when a completed scheduler snapshot persists later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const allowScheduler = deferred<void>();
    const schedulerReachedPostTickWork = deferred<void>();
    const baseContext = {
      platform: "twitch" as const,
      tabId: 66,
      originUrl: "https://www.twitch.tv/drops/inventory",
      origin: "https://www.twitch.tv",
      ownedByExtension: true as const,
    };
    const watcher = fakeTablessWatcher(async () => {
      recordManagedPageContextFallback(
        "twitch",
        "gql.twitch.tv",
        undefined,
        Date.parse("2026-09-02T12:01:00.000Z"),
      );
      return { ok: true, live: true };
    });
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    env.state.managedPageContextTabs = { twitch: baseContext };
    registerManagedPageContextTabs({ twitch: baseContext });
    await env.controller.tick(["twitch"]);
    env.deps.applyAdFocus.mockImplementation(async () => {
      schedulerReachedPostTickWork.resolve();
      await allowScheduler.promise;
    });
    vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));

    const schedulerTick = env.controller.tick(["twitch"]);
    await schedulerReachedPostTickWork.promise;
    await env.controller.runWatchHeartbeat();
    expect(env.state.managedPageContextTabs?.twitch).toMatchObject({
      fallbackHost: "gql.twitch.tv",
      backgroundSuccesses: 0,
      lastFallbackAt: "2026-09-02T12:01:00.000Z",
    });

    allowScheduler.resolve();
    await schedulerTick;

    expect(env.state.managedPageContextTabs?.twitch).toMatchObject({
      fallbackHost: "gql.twitch.tv",
      backgroundSuccesses: 0,
      lastFallbackAt: "2026-09-02T12:01:00.000Z",
    });
    registerManagedPageContextTabs({});
  });

  it("retains a current heartbeat when a stale scheduler snapshot persists the same target", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const blockedDiscovery = deferred<DropCampaign[]>();
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    await env.controller.tick(["twitch"]);

    vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));
    env.twitch.refreshCampaigns = vi.fn(() => blockedDiscovery.promise);
    const schedulerTick = env.controller.tick(["twitch"]);
    await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());

    vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));
    await env.controller.runWatchHeartbeat();
    expect(env.state.sessions.twitch).toMatchObject({
      heartbeatChecks: 0,
      lastHeartbeatAt: "2026-09-02T12:01:00.000Z",
      lastHeartbeatOk: true,
      tablessHeartbeat: {
        generation: 1,
        contextKey: "[\"twitch\",\"https://www.twitch.tv/twitch-creator\",\"twitch-creator\",\"\",\"\",\"\",\"twitch-campaign\",\"reward\"]",
        nextDueAt: "2026-09-02T12:02:00.000Z",
      },
    });

    blockedDiscovery.resolve([campaign("twitch")]);
    await schedulerTick;

    expect(env.state.sessions.twitch).toMatchObject({
      heartbeatChecks: 0,
      lastHeartbeatAt: "2026-09-02T12:01:00.000Z",
      lastHeartbeatOk: true,
      tablessHeartbeat: {
        generation: 1,
        contextKey: "[\"twitch\",\"https://www.twitch.tv/twitch-creator\",\"twitch-creator\",\"\",\"\",\"\",\"twitch-campaign\",\"reward\"]",
        nextDueAt: "2026-09-02T12:02:00.000Z",
      },
    });
  });

  it("records the first current-generation failure before heartbeat fallback", async () => {
    const watcher = fakeTablessWatcher(async () => ({
      ok: false,
      live: true,
      message: "heartbeat transport rejected",
    }));
    const env = tablessEnv({ tablessFallbackFailureLimit: 2 });
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    await env.controller.tick();
    env.reportEvents.mockClear();

    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat();

    expect(env.state.sessions.twitch).toMatchObject({
      lastHeartbeatOk: false,
      heartbeatChecks: 1,
    });
    expect(allDiagnostics(env).filter((event) =>
      event.message === "heartbeat transport rejected")).toHaveLength(1);
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
  });

  it("reports heartbeat recovered for a current-generation result", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    env.state.authHealth.twitch = { status: "healthy" };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("twitch"),
      campaignId: "twitch-campaign",
      rewardId: "reward",
      heartbeatChecks: 1,
      lastHeartbeatAt: "2026-09-02T11:59:00.000Z",
      lastHeartbeatOk: false,
    };
    env.state.sessions.twitch.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.twitch);

    await env.controller.runWatchHeartbeat();

    expect(env.state.sessions.twitch).toMatchObject({
      lastHeartbeatOk: true,
      heartbeatChecks: 0,
    });
    expect(allDiagnostics(env).filter((event) =>
      event.message === "Tabless watch heartbeat recovered")).toHaveLength(1);
  });

  it("publishes persistent watcher diagnostics once through the current operation batch", async () => {
    const reported: EngineEvent[][] = [];
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
      },
    }, {
      reportEvents: async (events) => { reported.push([...events]); },
    });
    const pending: DiagnosticEvent[] = [];
    const watcher = fakeTablessWatcher(async () => {
      pending.push({ category: "diagnostic", platform: "twitch", level: "debug", message: "heartbeat-detail" });
      return { ok: true, live: true };
    });
    watcher.drainEvents.mockImplementation(() => pending.splice(0));
    env.twitch.supportsTabless = true;
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;

    await env.controller.tick();
    pending.push({ category: "diagnostic", platform: "twitch", level: "info", message: "connected-after-start" });
    expect(reported.flat().some((event) => event.category === "diagnostic" && event.message === "connected-after-start")).toBe(false);

    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat();
    expect(reported.flat().filter((event) =>
      event.category === "diagnostic"
      && (event.message === "connected-after-start" || event.message === "heartbeat-detail"))
    ).toEqual([
      expect.objectContaining({ message: "connected-after-start" }),
      expect.objectContaining({ message: "heartbeat-detail" }),
    ]);

    await env.controller.runWatchHeartbeat();
    expect(reported.flat().filter((event) => event.category === "diagnostic" && event.message === "connected-after-start")).toHaveLength(1);
  });

  it("starts heartbeat fallback at the configured failure limit", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: false, live: true }));
    const env = tablessEnv({ offlineRetryLimit: 1, tablessFallbackFailureLimit: 2 });
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;

    await env.controller.tick();
    expect(env.state.sessions.twitch.watchMode).toBe("tabless");

    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat(); // heartbeatChecks -> 1
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();

    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat(); // heartbeatChecks -> 2, triggers fallback

    expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    expect(env.state.sessions.twitch.watchMode).toBe("tab");
    expect(env.state.sessions.twitch.tablessFallback).toBe(true);
    expect(watcher.stop).toHaveBeenCalled();
  });

  it.each(["generation", "context"] as const)(
    "skips heartbeat fallback when the persisted $authority changes after result commit",
    async (authority) => {
      let env!: ReturnType<typeof harness>;
      let replaceAuthorityAfterCommit = false;
      env = tablessEnv({ tablessFallbackFailureLimit: 1 });
      env.twitch.createTablessWatcher = () => fakeTablessWatcher(
        async () => ({ ok: false, live: true }),
      ) as unknown as TablessWatchController;
      const reportEvents = env.deps.reportEvents.getMockImplementation()!;
      env.deps.reportEvents.mockImplementation(async (events) => {
        await reportEvents(events);
        if (
          replaceAuthorityAfterCommit
          && events.some((event) =>
            event.category === "diagnostic"
            && event.message.startsWith("Tabless heartbeat timing "))
        ) {
          replaceAuthorityAfterCommit = false;
          const current = env.state.sessions.twitch;
          const nextSession: WatchSession = authority === "generation"
            ? {
                ...current,
                tablessHeartbeat: {
                  ...current.tablessHeartbeat!,
                  generation: current.tablessHeartbeat!.generation + 1,
                },
              }
            : {
                ...current,
                campaignId: "replacement-campaign",
                rewardId: "replacement-reward",
              };
          if (authority === "context") {
            nextSession.tablessHeartbeat = {
              ...current.tablessHeartbeat!,
              contextKey: heartbeatContextKey(nextSession)!,
            };
          }
          env.state.sessions.twitch = nextSession;
        }
      });
      await env.controller.tick();
      vi.mocked(env.twitch.refreshCampaigns).mockClear();
      vi.mocked(env.twitch.prepareWatchTab).mockClear();
      replaceAuthorityAfterCommit = true;

      advanceToNextHeartbeatDue();
      await env.controller.runWatchHeartbeat();

      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
      expect(env.state.sessions.twitch.tablessHeartbeat).toMatchObject(
        authority === "generation"
          ? { generation: 2 }
          : { contextKey: expect.stringContaining("replacement-campaign") },
      );
    },
  );

  it("keeps successful scheduler state when stopping a tabless watcher fails", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    await env.controller.tick();
    watcher.stop.mockRejectedValue(new Error("watcher stop failed"));

    await expect(env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: false })).resolves.toBeDefined();

    expect(env.state.sessions.twitch.status).toBe("paused");
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: "watcher stop failed",
    }));
  });

  it.each(["twitch", "kick"] as const)(
    "rebuilds the %s watcher from its normalized session after a service-worker restart without discovery",
    async (platform) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }), platform);
      const env = harness({
        ...DEFAULT_SETTINGS,
        tablessMode: true,
        platform: {
          ...DEFAULT_SETTINGS.platform,
          twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: platform === "twitch" },
          kick: {
            ...DEFAULT_SETTINGS.platform.kick,
            enabled: platform === "kick",
            idleWatchlistChannels: [],
          },
        },
      });
      const adapter = platform === "twitch" ? env.twitch : env.kick;
      adapter.supportsTabless = true;
      adapter.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      env.state.authHealth[platform] = { status: "healthy" };
      env.state.sessions[platform] = {
        platform,
        status: "watching",
        offlineChecks: 0,
        watchMode: "tabless",
        channel: channel(platform),
        campaignId: `${platform}-campaign`,
        rewardId: "reward",
      };
      env.state.sessions[platform].tablessHeartbeat = dueHeartbeatCadence(
        env.state.sessions[platform],
      );
      vi.mocked(adapter.refreshCampaigns).mockClear();
      env.discoverySignalFactory.mockClear();

      await env.controller.runWatchHeartbeat();

      expect(watcher.start).toHaveBeenCalledOnce();
      expect(watcher.tick).toHaveBeenCalledOnce();
      expect(env.state.sessions[platform]).toMatchObject({
        lastHeartbeatOk: true,
        heartbeatChecks: 0,
      });
      expect(adapter.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.discoverySignalFactory).not.toHaveBeenCalled();
    },
  );

  it("treats a missing persisted cadence as immediately due after a service-worker restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    env.state.authHealth.twitch = { status: "healthy" };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("twitch"),
      campaignId: "twitch-campaign",
      rewardId: "reward",
    };
    env.deps.loadState.mockImplementation(async () => structuredClone(env.state));

    await env.controller.runWatchHeartbeat();

    expect(watcher.tick).toHaveBeenCalledOnce();
    expect(env.state.sessions.twitch.tablessHeartbeat?.nextDueAt)
      .toBe("2026-09-02T12:01:00.000Z");
  });

  it("normalizes an invalid persisted due time with exactly one immediate restart attempt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    env.state.authHealth.twitch = { status: "healthy" };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("twitch"),
      campaignId: "twitch-campaign",
      rewardId: "reward",
    };
    const contextKey = heartbeatContextKey(env.state.sessions.twitch)!;
    env.state.sessions.twitch.tablessHeartbeat = {
      generation: 7,
      contextKey,
      nextDueAt: "not-a-date",
    };
    env.deps.loadState.mockImplementation(async () => structuredClone(env.state));

    await env.controller.runWatchHeartbeat();

    expect(watcher.tick).toHaveBeenCalledOnce();
    expect(env.state.sessions.twitch.tablessHeartbeat).toEqual({
      generation: 8,
      contextKey,
      nextDueAt: "2026-09-02T12:01:00.000Z",
    });
  });

  it.each([
    { metadata: "missing cadence", build: () => undefined, expectedGeneration: 1 },
    {
      metadata: "missing generation",
      build: (contextKey: string) => ({ contextKey, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 1,
    },
    {
      metadata: "null generation",
      build: (contextKey: string) => ({ generation: null, contextKey, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 1,
    },
    {
      metadata: "string generation",
      build: (contextKey: string) => ({ generation: "7", contextKey, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 1,
    },
    {
      metadata: "fractional generation",
      build: (contextKey: string) => ({ generation: 7.5, contextKey, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 1,
    },
    {
      metadata: "unsafe generation",
      build: (contextKey: string) => ({ generation: Number.MAX_SAFE_INTEGER + 1, contextKey, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 1,
    },
    {
      metadata: "NaN generation",
      build: (contextKey: string) => ({ generation: Number.NaN, contextKey, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 1,
    },
    {
      metadata: "zero generation",
      build: (contextKey: string) => ({ generation: 0, contextKey, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 1,
    },
    {
      metadata: "negative generation",
      build: (contextKey: string) => ({ generation: -7, contextKey, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 1,
    },
    {
      metadata: "mismatched context key",
      build: () => ({ generation: 7, contextKey: "obsolete-context", nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 8,
    },
    {
      metadata: "missing context key",
      build: () => ({ generation: 7, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 8,
    },
    {
      metadata: "null context key",
      build: () => ({ generation: 7, contextKey: null, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 8,
    },
    {
      metadata: "numeric context key",
      build: () => ({ generation: 7, contextKey: 42, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 8,
    },
    {
      metadata: "missing due timestamp",
      build: (contextKey: string) => ({ generation: 7, contextKey }),
      expectedGeneration: 8,
    },
    {
      metadata: "null due timestamp",
      build: (contextKey: string) => ({ generation: 7, contextKey, nextDueAt: null }),
      expectedGeneration: 8,
    },
    {
      metadata: "numeric due timestamp",
      build: (contextKey: string) => ({ generation: 7, contextKey, nextDueAt: 0 }),
      expectedGeneration: 8,
    },
  ] as const)(
    "reconstructs $metadata with a safe generation and one immediate heartbeat",
    async ({ build, expectedGeneration }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = tablessEnv();
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      env.state.authHealth.twitch = { status: "healthy" };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "watching",
        offlineChecks: 0,
        watchMode: "tabless",
        channel: channel("twitch"),
        campaignId: "twitch-campaign",
        rewardId: "reward",
      };
      const contextKey = heartbeatContextKey(env.state.sessions.twitch)!;
      env.state.sessions.twitch.tablessHeartbeat = build(contextKey) as WatchSession["tablessHeartbeat"];
      env.deps.loadState.mockImplementation(async () => structuredClone(env.state));

      await env.controller.runWatchHeartbeat();

      expect(watcher.tick).toHaveBeenCalledOnce();
      expect(env.state.sessions.twitch.tablessHeartbeat).toEqual({
        generation: expectedGeneration,
        contextKey,
        nextDueAt: "2026-09-02T12:01:00.000Z",
      });
      expect(Number.isSafeInteger(env.state.sessions.twitch.tablessHeartbeat?.generation)).toBe(true);
    },
  );

  it.each([
    {
      timing: "before",
      now: "2026-09-02T12:00:59.999Z",
      attempts: 0,
      nextDueAt: "2026-09-02T12:01:00.000Z",
    },
    {
      timing: "after",
      now: "2026-09-02T12:04:15.000Z",
      attempts: 1,
      nextDueAt: "2026-09-02T12:05:00.000Z",
    },
  ] as const)(
    "honors persisted cadence $timing its due time on service-worker restart",
    async ({ now, attempts, nextDueAt }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(now));
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = tablessEnv();
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      env.state.authHealth.twitch = { status: "healthy" };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "watching",
        offlineChecks: 0,
        watchMode: "tabless",
        channel: channel("twitch"),
        campaignId: "twitch-campaign",
        rewardId: "reward",
      };
      env.state.sessions.twitch.tablessHeartbeat = dueHeartbeatCadence(
        env.state.sessions.twitch,
        Date.parse("2026-09-02T12:01:00.000Z"),
      );

      await env.controller.runWatchHeartbeat();

      expect(watcher.tick).toHaveBeenCalledTimes(attempts);
      expect(env.state.sessions.twitch.tablessHeartbeat?.nextDueAt).toBe(nextDueAt);
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    },
  );

  it("serializes concurrent state writers so neither update is lost", async () => {
    const env = harness();
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
      channel: channel("twitch"),
      campaignId: "twitch-campaign",
      rewardId: "reward",
    };

    // Model storage snapshot semantics: each load returns an isolated copy, so
    // an unserialized handler building on a stale snapshot would clobber a newer
    // save. Trace load/save ordering to prove the lock serializes them.
    const trace: string[] = [];
    const originalSave = env.deps.saveState.getMockImplementation()!;
    env.deps.loadState.mockImplementation(async () => {
      trace.push("load");
      return structuredClone(env.state);
    });
    env.deps.saveState.mockImplementation(async (next: SchedulerState) => {
      trace.push("save");
      await Promise.resolve();
      await originalSave(next);
    });

    await Promise.all([
      env.controller.handleMessage(
        {
          type: "playbackTelemetry",
          platform: "twitch",
          telemetry: {
            videoCount: 1,
            mutedVideoCount: 0,
            unmutedVideoCount: 1,
            playingVideoCount: 1,
            blockedPlaybackCount: 0,
            documentHidden: false,
          },
        },
        { tab: { id: 10 } },
      ),
      env.controller.tick(),
    ]);

    expect(trace.filter((entry) => entry === "load").length)
      .toBeGreaterThanOrEqual(trace.filter((entry) => entry === "save").length);
    // Both writers' changes survive in the final persisted state.
    expect(env.state.sessions.twitch.playback).toBeDefined();
    expect(env.state.lastTickAt).toBeDefined();
  });

  it("lets Kick complete while Twitch discovery is still pending", async () => {
    const env = harness();
    const twitchDiscovery = deferred<DropCampaign[]>();
    env.twitch.refreshCampaigns = vi.fn(() => twitchDiscovery.promise);

    const ticking = env.controller.tick(undefined, "manual_tick");

    try {
      await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(env.state.sessions.kick.lastCheckedAt).toBeDefined());
      expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    } finally {
      twitchDiscovery.resolve([]);
      await ticking;
    }
  });

  it("lets a Kick auth refresh start while Twitch scheduler work is pending", async () => {
    const env = harness();
    const twitchDiscovery = deferred<DropCampaign[]>();
    env.twitch.refreshCampaigns = vi.fn(() => twitchDiscovery.promise);

    const ticking = env.controller.tick(["twitch"], "manual_tick");
    await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());
    const checkingKick = env.controller.checkAuthHealth("kick");
    let kickRefreshCompleted = false;
    void checkingKick.then(() => {
      kickRefreshCompleted = true;
    });
    try {
      await vi.waitFor(() => expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(kickRefreshCompleted).toBe(true));
    } finally {
      twitchDiscovery.resolve([]);
      await Promise.all([ticking, checkingKick]);
    }
  });

  it("lets Kick scheduler work complete while Twitch playback focus is pending", async () => {
    const focus = deferred<void>();
    const env = harness();
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
      channel: channel("twitch"),
    };
    env.deps.applyAdFocus.mockImplementation(async (platform) => {
      if (platform === "twitch") await focus.promise;
    });
    const telemetry = env.rawController.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
      },
    }, { tab: { id: 10 } });
    await vi.waitFor(() => expect(env.deps.applyAdFocus).toHaveBeenCalledWith(
      "twitch",
      10,
      false,
      expect.any(Function),
    ));

    const kickTick = env.rawController.tick(["kick"], "manual_tick");
    try {
      await vi.waitFor(() => expect(env.state.sessions.kick.lastCheckedAt).toBeDefined());
      expect(env.state.sessions.twitch.playback?.videoCount).toBe(1);
    } finally {
      focus.resolve();
      await Promise.all([telemetry, kickTick]);
    }

    expect(env.state.sessions.twitch.playback?.videoCount).toBe(1);
    expect(env.state.sessions.kick.lastCheckedAt).toBeDefined();
  });

  it("lets Kick scheduler work complete while a Twitch manual claim is pending", async () => {
    const claim = deferred<boolean>();
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: false }));
    env.state.campaigns.twitch = [campaign("twitch", "claimable")];
    vi.mocked(env.twitch.claimReward).mockReturnValue(claim.promise);

    const claiming = env.rawController.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "twitch-campaign",
      rewardId: "reward",
    });
    await vi.waitFor(() => expect(env.twitch.claimReward).toHaveBeenCalledOnce());

    const kickTick = env.rawController.tick(["kick"], "manual_tick");
    try {
      await vi.waitFor(() => expect(env.state.sessions.kick.lastCheckedAt).toBeDefined());
      expect(env.state.campaigns.twitch[0].rewards[0].status).toBe("claimable");
    } finally {
      claim.resolve(true);
      await Promise.all([claiming, kickTick]);
    }

    expect(env.state.sessions.kick.lastCheckedAt).toBeDefined();
    expect(env.state.campaigns.twitch[0].rewards[0].status).toBe("claimed");
  });

  it("serializes handleTabRemoved against a concurrent tick so neither write is lost", async () => {
    const env = harness();
    env.state.manualWatch = {
      kick: { platform: "kick", tabId: 50, checkedAt: new Date().toISOString(), active: true },
    };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
      channel: channel("twitch"),
      campaignId: "twitch-campaign",
      rewardId: "reward",
    };

    // Same snapshot-isolation trace as the writer-serialization test above: an
    // unserialized handleTabRemoved would build on a stale snapshot and clobber
    // tick()'s save (or vice versa).
    const trace: string[] = [];
    const originalSave = env.deps.saveState.getMockImplementation()!;
    env.deps.loadState.mockImplementation(async () => {
      trace.push("load");
      return structuredClone(env.state);
    });
    env.deps.saveState.mockImplementation(async (next: SchedulerState) => {
      trace.push("save");
      await Promise.resolve();
      await originalSave(next);
    });

    await Promise.all([
      env.controller.handleTabRemoved(50),
      env.controller.tick(),
    ]);

    expect(trace.filter((entry) => entry === "load").length)
      .toBeGreaterThanOrEqual(trace.filter((entry) => entry === "save").length);
    // Both writers' changes survive: the manual-watch entry is removed AND the
    // concurrent tick committed its progress.
    expect(env.state.manualWatch?.kick).toBeUndefined();
    expect(env.state.lastTickAt).toBeDefined();
  });

  it("reports the reward ids claimed during a tick, per platform", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: true }));
    env.twitch.refreshCampaigns = vi.fn(async () => [campaign("twitch", "claimable")]);

    const claimed = await env.controller.tick();

    expect(claimed).toEqual({ twitch: ["reward"] });
  });

  it("starts post-claim handoffs independently for both platforms", async () => {
    const waitingSignals: AbortSignal[] = [];
    const env = harness(
      farming({
        ...DEFAULT_SETTINGS,
        autoClaim: true,
        postClaimHandoff: true,
      }),
      {
        wait: async (_ms, signal) => new Promise<void>((resolve) => {
          waitingSignals.push(signal);
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      },
    );
    env.twitch.supportsPostClaimHandoff = true;
    env.kick.supportsPostClaimHandoff = true;
    env.twitch.refreshCampaigns = vi.fn(async () => [campaign("twitch", "claimable")]);
    env.kick.refreshCampaigns = vi.fn(async () => [campaign("kick", "claimable")]);

    const running = env.controller.tickAndHandOff();
    try {
      await vi.waitFor(() => expect(waitingSignals).toHaveLength(2));
    } finally {
      env.controller.shutdown();
      await running;
    }
  });

  it("reports a platform-scoped diagnostic when a post-claim handoff fails", async () => {
    const env = harness(farming({
      ...DEFAULT_SETTINGS,
      autoClaim: true,
      postClaimHandoff: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    }));
    env.twitch.supportsPostClaimHandoff = true;
    env.twitch.refreshCampaigns = vi.fn(async () => [campaign("twitch", "claimable")]);
    env.deps.createAdapters.mockImplementation(() => {
      throw new Error("handoff adapter failed");
    });

    await env.controller.tickAndHandOff(["twitch"]);

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
      expect.objectContaining({
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: "Post-claim handoff failed: handoff adapter failed",
      }),
    );
  });

  describe("post-claim handoff", () => {
    // Date only: the handoff's deadline is wall-clock based, but its delays are
    // injected, so setTimeout must stay real for drainMicrotasks.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // Twitch-only environment whose adapter opts into the handoff.
    function handoffEnv(overrides: Partial<ExtensionSettings> = {}) {
      const timer = manualWait();
      const env = harness({
        ...DEFAULT_SETTINGS,
        autoClaim: true,
        platform: {
          ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
          kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
        },
        ...overrides,
      }, { wait: timer.wait });
      env.twitch.supportsPostClaimHandoff = true;
      // Re-declare the getters: spreading `env` would evaluate them once and
      // freeze the initial snapshot, so every assertion would read stale state.
      return {
        ...env,
        timer,
        get state() { return env.state; },
        get settings() { return env.settings; },
      };
    }

    // A campaign whose first reward is claimable and whose second reward only
    // becomes visible on a later inventory read — the Twitch behavior the
    // handoff exists to absorb.
    function chainedCampaign(revealSecond: boolean): DropCampaign {
      const first: DropReward = { id: "reward-1", name: "First", requiredMinutes: 60, watchedMinutes: 60, status: "claimable" };
      const second: DropReward = { id: "reward-2", name: "Second", requiredMinutes: 60, watchedMinutes: 0, status: "in_progress" };
      return {
        id: "twitch-campaign",
        platform: "twitch",
        name: "twitch campaign",
        status: "active",
        rewards: revealSecond ? [first, second] : [first],
      };
    }

    it("starts earning the next reward before the next heartbeat alarm", async () => {
      const env = handoffEnv();
      let reveal = false;
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(reveal)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      reveal = true;
      await env.timer.flush();
      await handoff;

      expect(env.state.sessions.twitch.rewardId).toBe("reward-2");
    });

    it("stops at the deadline when no next reward appears", async () => {
      const env = handoffEnv({ postClaimHandoffIntervalSeconds: 5, postClaimHandoffMaxSeconds: 15 });
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      for (let index = 0; index < 10; index += 1) await env.timer.flush();
      await handoff;

      // A 15s budget at a 5s interval is three refreshes, never ten.
      expect(env.timer.wait.mock.calls.length).toBeLessThanOrEqual(3);
      expect(env.deps.createAlarm).not.toHaveBeenCalled();
    });

    it("exits early when the platform has no eligible reward left", async () => {
      const env = handoffEnv();
      env.twitch.refreshCampaigns = vi.fn(async () => []);

      const handoff = env.controller.runClaimHandoff("twitch");
      await env.timer.flush();
      await handoff;

      expect(env.timer.wait).toHaveBeenCalledTimes(1);
    });

    it("aborts in flight when farming stops", async () => {
      const env = handoffEnv();
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      // Let the loop actually park before aborting, so this exercises an
      // in-flight cancellation rather than a pre-start one.
      await drainMicrotasks();
      env.controller.abortClaimHandoffs();
      await env.timer.flush();
      await handoff;

      expect(env.timer.parked).toBe(0);
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    });

    it("does not run for a platform without the capability", async () => {
      const env = handoffEnv();
      env.twitch.supportsPostClaimHandoff = undefined;

      await env.controller.runClaimHandoff("twitch");

      expect(env.timer.wait).not.toHaveBeenCalled();
    });

    it("does not suppress compatibility diagnostics when probing the capability", async () => {
      const env = handoffEnv();
      // Bails right after the capability probe, which is the call that could
      // poison the controller's compatibility dedup cache.
      env.twitch.supportsPostClaimHandoff = undefined;

      await env.controller.runClaimHandoff("twitch", ["reward-1"]);
      await env.controller.tick();

      const published = env.reportEvents.mock.calls.flatMap(([events]: [readonly EngineEvent[]]) => events);
      expect(published).toContainEqual(expect.objectContaining({
        category: "diagnostic",
        platform: "twitch",
        message: expect.stringContaining("Using compatibility profile"),
      }));
    });

    it("does not run when the setting is disabled", async () => {
      const env = handoffEnv({ postClaimHandoff: false });

      await env.controller.runClaimHandoff("twitch");

      expect(env.timer.wait).not.toHaveBeenCalled();
    });

    it("anchors one immediate heartbeat 60 seconds after the switched target attempt", async () => {
      vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
      const watcher = fakeTablessWatcher(async () => {
        vi.setSystemTime(new Date("2026-09-02T12:00:17.000Z"));
        return { ok: true, live: true };
      });
      const env = handoffEnv({ tablessMode: true });
      env.twitch.supportsTabless = true;
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      let reveal = false;
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(reveal)]);
      const persist = env.deps.saveState.getMockImplementation()!;
      env.deps.saveState.mockImplementation(async (next) => {
        await persist(next);
        if (next.sessions.twitch.rewardId === "reward-2") {
          vi.setSystemTime(new Date("2026-09-02T12:00:10.000Z"));
        }
      });

      const handoff = env.controller.runClaimHandoff("twitch");
      reveal = true;
      await env.timer.flush();
      await handoff;

      expect(watcher.tick).toHaveBeenCalledTimes(1);
      expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
      expect(env.state.sessions.twitch.lastHeartbeatAt).toBe("2026-09-02T12:00:17.000Z");
      expect(env.state.sessions.twitch.tablessHeartbeat?.nextDueAt)
        .toBe("2026-09-02T12:01:10.000Z");
      expect(aggregateHeartbeatDiagnostics(env, "twitch")).toEqual([
        expect.stringContaining(
          "scheduledDueAt=2026-09-02T12:00:10.000Z actualAttemptAt=2026-09-02T12:00:10.000Z",
        ),
      ]);
    });

    it("coalesces a scheduled alarm concurrent with an immediate heartbeat", async () => {
      vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
      const heartbeatResult = deferred<{ ok: boolean; live?: boolean; message?: string }>();
      const watcher = fakeTablessWatcher(() => heartbeatResult.promise);
      const env = handoffEnv({
        tablessMode: true,
        postClaimHandoffIntervalSeconds: 5,
      });
      env.twitch.supportsTabless = true;
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      let reveal = false;
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(reveal)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      reveal = true;
      await env.timer.flush();
      await vi.waitFor(() => expect(watcher.tick).toHaveBeenCalledOnce());
      vi.setSystemTime(new Date("2026-09-02T12:01:05.000Z"));
      const alarm = env.controller.runWatchHeartbeat();
      await drainMicrotasks();

      expect(watcher.tick).toHaveBeenCalledOnce();
      heartbeatResult.resolve({ ok: true, live: true });
      await Promise.all([handoff, alarm]);
      expect(aggregateHeartbeatDiagnostics(env, "twitch")).toEqual([
        expect.stringContaining("coalescedCalls=1"),
      ]);
    });

    it("does not let a recent old-generation heartbeat suppress the switched target immediate heartbeat", async () => {
      vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
      const oldWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const nextWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = handoffEnv({ tablessMode: true });
      env.twitch.supportsTabless = true;
      env.twitch.createTablessWatcher = vi.fn()
        .mockReturnValueOnce(oldWatcher)
        .mockReturnValueOnce(nextWatcher);
      await env.controller.tick(["twitch"]);
      vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));
      await env.controller.runWatchHeartbeat();
      expect(oldWatcher.tick).toHaveBeenCalledOnce();

      const nextCampaign: DropCampaign = {
        ...campaign("twitch"),
        rewards: [{ ...reward(), id: "next-reward" }],
      };
      vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([nextCampaign]);
      vi.setSystemTime(new Date("2026-09-02T12:01:05.000Z"));
      await env.controller.tick(["twitch"]);
      expect(env.state.sessions.twitch).toMatchObject({
        rewardId: "next-reward",
        lastHeartbeatAt: "2026-09-02T12:01:00.000Z",
      });

      await env.controller.runClaimHandoff("twitch", ["reward"]);

      expect(nextWatcher.tick).toHaveBeenCalledOnce();
      expect(env.state.sessions.twitch.tablessHeartbeat?.generation).toBe(2);
      expect(env.state.sessions.twitch.tablessHeartbeat?.nextDueAt)
        .toBe("2026-09-02T12:02:05.000Z");
    });

    it("skips the immediate heartbeat when one just landed on the same channel", async () => {
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = handoffEnv({ tablessMode: true });
      env.twitch.supportsTabless = true;
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      // Both rewards visible from the start, so the triggering tick already
      // selects the successor and the handoff takes its fast path.
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(true)]);

      // Establish the tabless session and land a heartbeat seconds ago.
      await env.controller.tick();
      vi.setSystemTime(Date.now() + 60_000);
      await env.controller.runWatchHeartbeat();
      watcher.tick.mockClear();

      await env.controller.runClaimHandoff("twitch", ["reward-1"]);

      expect(watcher.tick).not.toHaveBeenCalled();
    });

    it("starts a handoff after an automatic claim", async () => {
      const env = handoffEnv();
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.tickAndHandOff();
      for (let index = 0; index < 12; index += 1) await env.timer.flush();
      const committed = await handoff;

      expect(env.timer.wait).toHaveBeenCalled();
      expect(committed).toEqual(env.state);
    });

    it("starts one handoff for a shared platform tick across overlapping batches", async () => {
      const kickRefresh = deferred<DropCampaign[]>();
      const env = handoffEnv({
        postClaimHandoffIntervalSeconds: 5,
        postClaimHandoffMaxSeconds: 15,
        platform: {
          twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
          kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true, idleWatchlistChannels: [] },
        },
      });
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);
      env.kick.refreshCampaigns = vi.fn(() => kickRefresh.promise);

      const twitchOnly = env.controller.tickAndHandOff(["twitch"]);
      const bothPlatforms = env.controller.tickAndHandOff();
      for (let index = 0; index < 6; index += 1) await env.timer.flush();
      await twitchOnly;
      kickRefresh.resolve([]);
      for (let index = 0; index < 6; index += 1) await env.timer.flush();
      await bothPlatforms;

      expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(4);
    });

    it("does not start a nested handoff for a claim inside a handoff", async () => {
      const env = handoffEnv({ postClaimHandoffIntervalSeconds: 5, postClaimHandoffMaxSeconds: 15 });
      // Every refresh yields another claimable reward, which would restart the
      // deadline forever if a nested handoff were allowed.
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      for (let index = 0; index < 10; index += 1) await env.timer.flush();
      await handoff;

      expect(env.timer.wait.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it("keeps an active handoff running during an ordinary settings save", async () => {
      const env = handoffEnv({ postClaimHandoffIntervalSeconds: 5, postClaimHandoffMaxSeconds: 15 });
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      await drainMicrotasks();
      expect(env.timer.parked).toBe(1);

      await env.controller.handleMessage({
        type: "saveSettings",
        settingsPatch: { notifyRewardEarned: false },
      });

      expect(env.timer.parked).toBe(1);
      for (let index = 0; index < 4; index += 1) await env.timer.flush();
      await handoff;
      expect(env.twitch.refreshCampaigns).toHaveBeenCalled();
    });

    it("aborts running handoffs when farming is switched off", async () => {
      const env = handoffEnv();
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      await drainMicrotasks();
      await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: false });
      await env.timer.flush();
      await handoff;

      expect(env.timer.parked).toBe(0);
    });

    it("does not start a second handoff while the first is still starting", async () => {
      const env = handoffEnv();
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      // Both calls are made before either has finished its async setup.
      const first = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      const second = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      await drainMicrotasks();
      env.controller.abortClaimHandoffs();
      await env.timer.flush();
      await Promise.all([first, second]);

      expect(env.timer.wait).toHaveBeenCalledTimes(1);
    });

    it("honors an abort issued while the handoff is still starting", async () => {
      const env = handoffEnv();
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      // Synchronously, before any setup await has resolved.
      env.controller.abortClaimHandoffs();
      await env.timer.flush();
      await handoff;

      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    });

    it("never refreshes after the maximum duration has elapsed", async () => {
      // A 30s interval against a 45s budget: a second full-length wait would
      // land a refresh at 60s, past the deadline the setting promises.
      const env = handoffEnv({ postClaimHandoffIntervalSeconds: 30, postClaimHandoffMaxSeconds: 45 });
      // The session keeps watching the reward that was just claimed, so the loop
      // never succeeds and never sees "nothing left" — only the deadline can end
      // it. Without that, the early exit would mask any overshoot.
      env.twitch.refreshCampaigns = vi.fn(async () => [campaign("twitch")]);

      const handoff = env.controller.runClaimHandoff("twitch", ["reward"]);
      for (let index = 0; index < 5; index += 1) await env.timer.flush();
      await handoff;

      expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(1);
    });

    it("sends no heartbeat when the abort lands while state is being read", async () => {
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = handoffEnv({ tablessMode: true });
      env.twitch.supportsTabless = true;
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(true)]);

      await env.controller.tick();
      watcher.tick.mockClear();

      // Cancel at the moment the successor becomes visible to the handoff.
      const loadState = env.deps.loadState.getMockImplementation()!;
      env.deps.loadState.mockImplementation(async () => {
        const state = await loadState();
        if (state.sessions.twitch.rewardId === "reward-2") env.controller.abortClaimHandoffs();
        return state;
      });

      await env.controller.runClaimHandoff("twitch", ["reward-1"]);

      expect(watcher.tick).not.toHaveBeenCalled();
    });

    it("sends no heartbeat when the next reward runs in a visible tab", async () => {
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = handoffEnv({ tablessMode: false });
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      let reveal = false;
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(reveal)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      reveal = true;
      await env.timer.flush();
      await handoff;

      expect(watcher.tick).not.toHaveBeenCalled();
      // The tick that detected the successor already re-pointed the tab.
      expect(env.state.sessions.twitch.rewardId).toBe("reward-2");
      expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    });
  });
});

describe("discovery signal lifecycle", () => {
  function kickOnlySettings(tablessMode = false): ExtensionSettings {
    return {
      ...DEFAULT_SETTINGS,
      tablessMode,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
      },
    };
  }

  function configureKickDiscoverySession(
    env: ReturnType<typeof harness>,
    categoryId = "42",
  ): void {
    vi.mocked(env.kick.listCandidateChannels).mockResolvedValue([
      channel("kick", { categoryId }),
    ]);
  }

  async function startKickDiscoverySession(env: ReturnType<typeof harness>): Promise<void> {
    configureKickDiscoverySession(env);
    await env.controller.tick(["kick"], "manual_tick");
    expect(env.state.sessions.kick).toMatchObject({
      status: "watching",
      channel: { categoryId: "42" },
    });
    expect(env.discoverySignalController.starts).toEqual([
      expect.objectContaining({
        platform: "kick",
        channel: expect.objectContaining({ categoryId: "42" }),
      }),
    ]);
  }

  it.each(["tab", "tabless"] as const)("starts the Kick observer for an active %s watch session", async (watchMode) => {
    const env = harness(kickOnlySettings(watchMode === "tabless"));
    configureKickDiscoverySession(env);
    if (watchMode === "tabless") {
      const watcher = {
        platform: "kick" as const,
        channelUrl: undefined as string | undefined,
        async start(candidate: ChannelCandidate) {
          watcher.channelUrl = candidate.url;
        },
        async tick() {
          return { ok: true, live: true };
        },
        drainEvents() {
          return [];
        },
        async stop() {
          watcher.channelUrl = undefined;
        },
      } satisfies TablessWatchController;
      env.kick.supportsTabless = true;
      env.kick.createTablessWatcher = () => watcher;
    }

    await env.controller.tick(["kick"], "manual_tick");

    expect(env.state.sessions.kick).toMatchObject({
      status: "watching",
      watchMode,
      channel: { categoryId: "42" },
    });
    expect(env.discoverySignalController.starts).toEqual([
      expect.objectContaining({
        platform: "kick",
        channel: expect.objectContaining({ categoryId: "42" }),
      }),
    ]);
  });

  it("does not create an observer for an idle session", async () => {
    const env = harness(kickOnlySettings());
    vi.mocked(env.kick.refreshCampaigns).mockResolvedValue([]);

    await env.controller.tick(["kick"], "manual_tick");

    expect(env.state.sessions.kick.status).toBe("idle");
    expect(env.discoverySignalFactory).not.toHaveBeenCalled();
    expect(env.discoverySignalController.starts).toEqual([]);
  });

  it.each(["disabled", "authentication_unhealthy"] as const)(
    "stops the observer when Kick becomes %s",
    async (transition) => {
      const env = harness(kickOnlySettings());
      await startKickDiscoverySession(env);

      if (transition === "disabled") {
        await env.controller.handleMessage({
          type: "setPlatformEnabled",
          platform: "kick",
          enabled: false,
        });
      } else {
        vi.mocked(env.kick.checkAuthHealth).mockResolvedValue({
          status: "invalid_credentials",
          checkedAt: "2026-08-12T12:00:00.000Z",
          reasonCode: "credentials_rejected",
          message: { key: "authInvalidCredentials" },
        });
        await env.controller.tick(["kick"], "manual_tick");
      }

      expect(env.discoverySignalController.stops).toBe(1);
      expect(env.discoverySignalController.targetKey).toBeUndefined();
      const refreshesAfterStop = vi.mocked(env.kick.refreshCampaigns).mock.calls.length;
      env.discoverySignalController.emitSignal();
      await env.controller.settleBackgroundWork();
      expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(refreshesAfterStop);
    },
  );

  it("stops the observer when adapter setup makes authentication unavailable", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    vi.mocked(env.deps.createAdapter).mockImplementation(() => {
      throw new Error("adapter setup failed");
    });

    await env.controller.tick(["kick"], "manual_tick");

    expect(env.state.authHealth.kick.status).toBe("unavailable");
    expect(env.discoverySignalController.stops).toBe(1);
    expect(env.discoverySignalController.targetKey).toBeUndefined();
  });

  it("direct auth checks stop the observer and drop pending signal work when health becomes unhealthy", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    const activeRefresh = deferred<DropCampaign[]>();
    vi.mocked(env.kick.refreshCampaigns)
      .mockClear()
      .mockImplementationOnce(() => activeRefresh.promise);

    env.discoverySignalController.emitSignal();
    await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
    vi.mocked(env.kick.checkAuthHealth).mockClear().mockResolvedValue({
      status: "invalid_credentials",
      checkedAt: "2026-08-12T12:00:00.000Z",
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    });
    env.discoverySignalController.emitSignal();
    const checking = env.controller.checkAuthHealth("kick");

    activeRefresh.resolve([campaign("kick")]);
    await checking;
    await env.controller.settleBackgroundWork();

    expect(env.state.authHealth.kick.status).toBe("invalid_credentials");
    expect(env.discoverySignalController.stops).toBe(1);
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();

    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();
    env.discoverySignalController.emitCapturedSignal();
    await env.controller.settleBackgroundWork();
    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("invalidating auth stops the observer while health is checking", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();

    await env.controller.invalidateAuthHealth("kick");

    expect(env.state.authHealth.kick.status).toBe("checking");
    expect(env.discoverySignalController.stops).toBe(1);
    expect(env.discoverySignalController.targetKey).toBeUndefined();
    env.discoverySignalController.emitCapturedSignal();
    await env.controller.settleBackgroundWork();
    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("blocks signal admission before auth invalidation acquires the platform lock", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    const activeRefresh = deferred<DropCampaign[]>();
    vi.mocked(env.kick.refreshCampaigns)
      .mockClear()
      .mockImplementationOnce(() => activeRefresh.promise);
    vi.mocked(env.kick.checkAuthHealth).mockClear();

    const ticking = env.controller.tick(["kick"], "manual_tick");
    await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
    const invalidating = env.controller.invalidateAuthHealth("kick");
    env.discoverySignalController.emitSignal();

    activeRefresh.resolve([campaign("kick")]);
    await Promise.all([ticking, invalidating]);
    await env.controller.settleBackgroundWork();

    expect(env.state.authHealth.kick.status).toBe("checking");
    expect(env.discoverySignalController.stops).toBe(1);
    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
  });

  it("rechecks signal admission after loading settings and before launching a tick", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    const settingsRead = deferred<ExtensionSettings>();
    env.deps.loadSettings.mockClear();
    env.deps.loadSettings.mockImplementationOnce(() => settingsRead.promise);
    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();

    env.discoverySignalController.emitSignal();
    await vi.waitFor(() => expect(env.deps.loadSettings).toHaveBeenCalledOnce());
    await env.controller.invalidateAuthHealth("kick");

    settingsRead.resolve(env.settings);
    await env.controller.settleBackgroundWork();

    expect(env.state.authHealth.kick.status).toBe("checking");
    expect(env.discoverySignalController.stops).toBe(1);
    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("does not reopen a paused signal loop after a healthy direct auth check", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    const settingsRead = deferred<ExtensionSettings>();
    env.deps.loadSettings.mockClear();
    env.deps.loadSettings.mockImplementationOnce(() => settingsRead.promise);
    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();

    env.discoverySignalController.emitSignal();
    await vi.waitFor(() => expect(env.deps.loadSettings).toHaveBeenCalledOnce());
    await env.controller.checkAuthHealth("kick");
    expect(env.state.authHealth.kick.status).toBe("healthy");
    expect(env.discoverySignalController.stops).toBe(0);
    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();

    settingsRead.resolve(env.settings);
    await env.controller.settleBackgroundWork();

    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();

    env.discoverySignalController.emitSignal();
    await env.controller.settleBackgroundWork();
    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
  });

  it("does not transfer a paused signal loop to a restarted observer lifecycle", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    const settingsRead = deferred<ExtensionSettings>();
    env.deps.loadSettings.mockClear();
    env.deps.loadSettings.mockImplementationOnce(() => settingsRead.promise);
    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();

    env.discoverySignalController.emitSignal();
    await vi.waitFor(() => expect(env.deps.loadSettings).toHaveBeenCalledOnce());
    vi.mocked(env.kick.checkAuthHealth).mockResolvedValue({
      status: "invalid_credentials",
      checkedAt: "2026-08-12T12:00:00.000Z",
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    });
    await env.controller.tick(["kick"], "manual_tick");
    expect(env.discoverySignalController.stops).toBe(1);

    vi.mocked(env.kick.checkAuthHealth).mockResolvedValue({
      status: "healthy",
      checkedAt: "2026-08-12T12:01:00.000Z",
    });
    await env.controller.tick(["kick"], "manual_tick");
    expect(env.discoverySignalController.starts).toHaveLength(2);
    expect(env.discoverySignalController.targetKey).toBe("42");
    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();

    settingsRead.resolve(env.settings);
    await env.controller.settleBackgroundWork();

    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();

    env.discoverySignalController.emitSignal();
    await env.controller.settleBackgroundWork();
    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
  });

  it("stops the observer when removing its active managed watch tab", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();

    await env.controller.handleTabRemoved(20);

    expect(env.state.sessions.kick).toMatchObject({
      status: "paused",
      reasonCode: "manual_tab_close",
    });
    expect(env.discoverySignalController.stops).toBe(1);
    expect(env.discoverySignalController.targetKey).toBeUndefined();
    env.discoverySignalController.emitCapturedSignal();
    await env.controller.settleBackgroundWork();
    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("updates the observer when the watched channel category changes", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    vi.mocked(env.kick.refreshCampaigns).mockResolvedValue([
      { ...campaign("kick"), id: "kick-campaign-next" },
    ]);
    configureKickDiscoverySession(env, "84");
    vi.mocked(env.kick.checkChannel).mockImplementation(async (candidate) => ({
      live: true,
      categoryMatches: candidate.categoryId === "84",
      candidate,
    }));

    await env.controller.tick(["kick"], "manual_tick");

    expect(env.discoverySignalController.starts).toHaveLength(2);
    expect(env.discoverySignalController.starts[1]).toMatchObject({
      platform: "kick",
      channel: { categoryId: "84" },
    });
    expect(env.discoverySignalController.targetKey).toBe("84");
  });

  it.each(["reset", "shutdown"] as const)("stops observers during host %s", async (cleanup) => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    vi.mocked(env.kick.refreshCampaigns).mockClear();

    if (cleanup === "reset") {
      await env.controller.prepareForHostReset();
    } else {
      env.controller.shutdown();
    }
    await env.rawController.settleBackgroundWork();

    expect(env.discoverySignalController.stops).toBe(1);
    expect(env.discoverySignalController.targetKey).toBeUndefined();
    env.discoverySignalController.emitSignal();
    await env.rawController.settleBackgroundWork();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("restarts the Kick observer after a host reset", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);

    await env.controller.prepareForHostReset();
    await env.controller.tick(["kick"], "manual_tick");

    expect(env.discoverySignalController.stops).toBe(1);
    expect(env.discoverySignalController.starts).toHaveLength(2);
    expect(env.discoverySignalController.targetKey).toBe("42");
  });

  it("does not restore Kick discovery during tabless heartbeat restart recovery", async () => {
    const env = harness(kickOnlySettings(true));
    const watcher = {
      platform: "kick" as const,
      channelUrl: undefined as string | undefined,
      start: vi.fn(async (candidate: ChannelCandidate) => {
        watcher.channelUrl = candidate.url;
      }),
      tick: vi.fn(async () => ({ ok: true, live: true })),
      drainEvents: () => [],
      stop: vi.fn(async () => {
        watcher.channelUrl = undefined;
      }),
    } satisfies TablessWatchController;
    env.kick.supportsTabless = true;
    env.kick.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    env.state.authHealth.kick = { status: "healthy" };
    env.state.sessions.kick = {
      platform: "kick",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("kick", { categoryId: "42" }),
      campaignId: "kick-campaign",
      rewardId: "reward",
    };
    env.state.sessions.kick.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.kick);

    await env.controller.runWatchHeartbeat();

    expect(watcher.start).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: "42" }),
      expect.any(Object),
    );
    expect(watcher.tick).toHaveBeenCalledOnce();
    expect(env.discoverySignalController.starts).toEqual([]);
  });

  it("does not make discovery failure count as a watch-heartbeat failure", async () => {
    const env = harness(kickOnlySettings(true));
    configureKickDiscoverySession(env);
    const watcher = {
      platform: "kick" as const,
      channelUrl: undefined as string | undefined,
      async start(candidate: ChannelCandidate) {
        watcher.channelUrl = candidate.url;
      },
      async tick() {
        return { ok: true, live: true };
      },
      drainEvents() {
        return [];
      },
      async stop() {
        watcher.channelUrl = undefined;
      },
    } satisfies TablessWatchController;
    env.kick.supportsTabless = true;
    env.kick.createTablessWatcher = () => watcher;
    env.discoverySignalController.pushDiagnostic("observer transport unavailable");
    vi.spyOn(env.discoverySignalController, "start").mockRejectedValueOnce(
      new Error("observer start failed"),
    );

    await env.controller.tick(["kick"], "manual_tick");

    expect(env.state.sessions.kick).toMatchObject({
      status: "watching",
      watchMode: "tabless",
    });
    expect(env.state.sessions.kick.heartbeatChecks).toBe(0);
    expect(env.state.sessions.kick.lastHeartbeatOk).toBeUndefined();
    expect(allDiagnostics(env)).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: "kick", message: "observer transport unavailable" }),
      expect.objectContaining({ platform: "kick", message: "observer start failed" }),
    ]));
  });
});

describe("discovery signal refresh scheduling", () => {
  function kickOnlySettings(): ExtensionSettings {
    return {
      ...DEFAULT_SETTINGS,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
      },
    };
  }

  async function startedEnv() {
    const env = harness(kickOnlySettings());
    vi.mocked(env.kick.listCandidateChannels).mockResolvedValue([
      channel("kick", { categoryId: "42" }),
    ]);
    await env.controller.tick(["kick"], "manual_tick");
    expect(env.discoverySignalController.targetKey).toBe("42");
    return env;
  }

  it("turns a Kick discovery signal into a Kick-only canonical tick", async () => {
    const env = await startedEnv();
    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();
    env.discoverySignalController.pushDiagnostic("observer warning between ticks");

    env.discoverySignalController.emitSignal();
    await env.controller.settleBackgroundWork();

    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
      platform: "kick",
      message: "observer warning between ticks",
    }));
  });

  it("coalesces a burst into one pending Kick refresh", async () => {
    const env = await startedEnv();
    const firstRefresh = deferred<DropCampaign[]>();
    const secondRefresh = deferred<DropCampaign[]>();
    let activeRefreshes = 0;
    let maximumActiveRefreshes = 0;
    const blockOn = async (pending: ReturnType<typeof deferred<DropCampaign[]>>) => {
      activeRefreshes += 1;
      maximumActiveRefreshes = Math.max(maximumActiveRefreshes, activeRefreshes);
      try {
        return await pending.promise;
      } finally {
        activeRefreshes -= 1;
      }
    };
    vi.mocked(env.kick.refreshCampaigns)
      .mockClear()
      .mockImplementationOnce(() => blockOn(firstRefresh))
      .mockImplementationOnce(() => blockOn(secondRefresh));
    vi.mocked(env.twitch.refreshCampaigns).mockClear();

    env.discoverySignalController.emitSignal();
    await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
    env.discoverySignalController.emitSignal();
    env.discoverySignalController.emitSignal();
    env.discoverySignalController.emitSignal();

    try {
      firstRefresh.resolve([campaign("kick")]);
      await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(2));
      expect(activeRefreshes).toBe(1);
    } finally {
      firstRefresh.resolve([campaign("kick")]);
      secondRefresh.resolve([campaign("kick")]);
      await env.controller.settleBackgroundWork();
    }

    expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(2);
    expect(maximumActiveRefreshes).toBe(1);
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("runs exactly one follow-up when a signal arrives during an active Kick tick", async () => {
    const env = await startedEnv();
    const activeRefresh = deferred<DropCampaign[]>();
    vi.mocked(env.kick.refreshCampaigns)
      .mockClear()
      .mockImplementationOnce(() => activeRefresh.promise);

    const ticking = env.controller.tick(["kick"], "manual_tick");
    await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
    env.discoverySignalController.emitSignal();

    activeRefresh.resolve([campaign("kick")]);
    await ticking;
    await env.controller.settleBackgroundWork();

    expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(2);
    expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
      message: "Coalesced scheduler triggers (count=1, reasons=discovery_signal:1)",
    }));
  });

  it("merges discovery signals and pending alarms into the same follow-up", async () => {
    const env = await startedEnv();
    const discovery = deferred<DropCampaign[]>();
    vi.mocked(env.kick.refreshCampaigns).mockClear().mockReturnValueOnce(discovery.promise);
    const first = env.controller.tick(["kick"], "alarm");
    await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
    const pending = env.controller.tick(["kick"], "alarm");
    env.discoverySignalController.emitSignal();
    env.discoverySignalController.emitSignal();
    discovery.resolve([campaign("kick")]);
    await Promise.all([first, pending]);
    await env.controller.settleBackgroundWork();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "alarm", "manual_tick"] as const)("invalidates an admitted signal while retaining an independent %s trigger", async (independentTrigger) => {
    const env = await startedEnv();
    const settingsRead = deferred<ExtensionSettings>();
    const settingsReadStarted = deferred<void>();
    const discovery = deferred<DropCampaign[]>();
    env.deps.loadSettings.mockImplementationOnce(() => {
      settingsReadStarted.resolve();
      return settingsRead.promise;
    });
    env.discoverySignalController.emitSignal();
    await settingsReadStarted.promise;
    vi.mocked(env.kick.refreshCampaigns).mockClear().mockReturnValueOnce(discovery.promise);
    env.reportEvents.mockClear();
    const first = env.controller.tick(["kick"], "alarm");
    let independent: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
      settingsRead.resolve(env.settings);
      // Let the paused signal finish admission behind the blocked alarm.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (independentTrigger) independent = env.controller.tick(["kick"], independentTrigger);
      await env.controller.invalidateAuthHealth("kick");
      discovery.resolve([campaign("kick")]);
      await Promise.all([first, independent]);
      await env.controller.settleBackgroundWork();

      expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(independentTrigger ? 2 : 1);
      const starts = allDiagnostics(env).filter((event) => /Tick #\d+ started/.test(event.message));
      expect(starts).toHaveLength(independentTrigger ? 2 : 1);
      if (independentTrigger) expect(starts.at(-1)?.message).toContain(`trigger=${independentTrigger}`);
    } finally {
      settingsRead.resolve(env.settings);
      discovery.resolve([campaign("kick")]);
      await Promise.allSettled([first, independent]);
      await env.controller.settleBackgroundWork();
    }
  });

  it("coalesces bursts before and after an ordinary Kick tick fetch into one non-overlapping follow-up", async () => {
    const env = await startedEnv();
    const ordinaryAuth = deferred<void>();
    const ordinaryRefresh = deferred<DropCampaign[]>();
    let authCalls = 0;
    let activeAuthProbes = 0;
    let maximumActiveAuthProbes = 0;
    vi.mocked(env.kick.checkAuthHealth)
      .mockClear()
      .mockImplementation(async () => {
        authCalls += 1;
        activeAuthProbes += 1;
        maximumActiveAuthProbes = Math.max(maximumActiveAuthProbes, activeAuthProbes);
        try {
          if (authCalls === 1) await ordinaryAuth.promise;
          return { status: "healthy", checkedAt: "2026-08-12T12:00:00.000Z" };
        } finally {
          activeAuthProbes -= 1;
        }
      });
    vi.mocked(env.kick.refreshCampaigns)
      .mockClear()
      .mockImplementationOnce(() => ordinaryRefresh.promise)
      .mockResolvedValue([campaign("kick")]);

    const ticking = env.controller.tick(["kick"], "manual_tick");
    try {
      await vi.waitFor(() => expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce());
      env.discoverySignalController.emitSignal();
      env.discoverySignalController.emitSignal();
      env.discoverySignalController.emitSignal();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();

      ordinaryAuth.resolve();
      await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
      env.discoverySignalController.emitSignal();
      env.discoverySignalController.emitSignal();
      env.discoverySignalController.emitSignal();
      ordinaryRefresh.resolve([campaign("kick")]);

      await ticking;
      await env.controller.settleBackgroundWork();

      expect(env.kick.checkAuthHealth).toHaveBeenCalledTimes(2);
      expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(2);
      expect(maximumActiveAuthProbes).toBe(1);
    } finally {
      ordinaryAuth.resolve();
      ordinaryRefresh.resolve([campaign("kick")]);
      await Promise.allSettled([ticking]);
      await env.controller.settleBackgroundWork();
    }
  });

  it("keeps Twitch refresh calls unchanged by a Kick signal", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    vi.mocked(env.kick.listCandidateChannels).mockResolvedValue([
      channel("kick", { categoryId: "42" }),
    ]);
    await env.controller.tick(undefined, "manual_tick");
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();

    env.discoverySignalController.emitSignal();
    await env.controller.settleBackgroundWork();

    expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(2);
  });

  it.each(["disablement", "shutdown"] as const)("drops pending signal work after %s", async (cleanup) => {
    const env = await startedEnv();
    const activeRefresh = deferred<DropCampaign[]>();
    vi.mocked(env.kick.refreshCampaigns)
      .mockClear()
      .mockImplementationOnce(() => activeRefresh.promise);

    env.discoverySignalController.emitSignal();
    await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
    env.discoverySignalController.emitSignal();

    if (cleanup === "disablement") {
      await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "kick",
        enabled: false,
      });
    } else {
      env.controller.shutdown();
    }
    activeRefresh.resolve([campaign("kick")]);
    await env.rawController.settleBackgroundWork();

    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.discoverySignalController.stops).toBe(1);
  });

  it("records discovery_signal in tick lifecycle diagnostics", async () => {
    const env = await startedEnv();
    env.reportEvents.mockClear();

    env.discoverySignalController.emitSignal();
    await env.controller.settleBackgroundWork();

    const messages = allDiagnostics(env).map((event) => event.message);
    expect(messages).toContainEqual(expect.stringContaining("started (trigger=discovery_signal"));
    expect(messages).toContainEqual(expect.stringContaining("finished after"));
    expect(messages).toContainEqual(expect.stringContaining("trigger=discovery_signal"));
  });
});

describe("background controller critical health", () => {
  afterEach(() => {
    syncManagedTabBreakers({});
  });

  it("records page context opens into the critical health detector", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    // Adapters are constructed with the tick's emitter before discovery runs, so
    // the last recorded call carries the live emitter for this tick.
    const emitFromTick = (): EventEmitter => env.deps.createAdapter.mock.calls.at(-1)![1];
    env.kick.refreshCampaigns = vi.fn(async () => {
      emitFromTick()({
        category: "activity",
        code: "page_context_opened",
        level: "info",
        platform: "kick",
        data: { host: "kick.com", reason: "background_rejected" },
      });
      return [campaign("kick")];
    });

    await env.controller.tick(["kick"]);

    // This tick also opens a watch tab for the discovered campaign, and watch
    // tabs share the churn window with page contexts by design — so assert the
    // page-context breadcrumb specifically rather than assuming it is the only one.
    expect(env.state.criticalHealth?.kick?.records).toContainEqual(
      expect.objectContaining({ kind: "context_open", code: "background_rejected" }),
    );
    expect(env.state.criticalHealth?.kick?.managedTabOpens.length).toBeGreaterThanOrEqual(1);
  });

  it("opens the breaker and syncs the registry after repeated page context opens", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const emitFromTick = (): EventEmitter => env.deps.createAdapter.mock.calls.at(-1)![1];
    env.kick.refreshCampaigns = vi.fn(async () => {
      emitFromTick()({
        category: "activity",
        code: "page_context_opened",
        level: "info",
        platform: "kick",
        data: { host: "kick.com", reason: "background_rejected" },
      });
      return [campaign("kick")];
    });

    for (let index = 0; index < TAB_CHURN_LIMIT; index += 1) {
      await env.controller.tick(["kick"]);
    }

    expect(env.state.criticalHealth?.kick?.breakerOpen).toBe(true);
    expect(managedTabBreakerOpen("kick")).toBe(true);
  });
});
