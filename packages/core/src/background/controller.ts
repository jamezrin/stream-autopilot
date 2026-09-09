import type { CategorySearchResult, CoreRuntimeMessage, PlaybackControl, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { DropCampaign, DropReward, EngineSettings, ManagedWatchTab, Platform, PlatformAuthHealth, PlaybackTelemetry, SchedulerState, TablessHeartbeatCadence, WatchReasonCode, WatchSession } from "@lurkloot/shared/models";
import type { ActivityEvent, DiagnosticEvent, EngineEvent, EventEmitter, EventReporter, FarmingStopReason, PageContextOpenReason } from "@lurkloot/shared/events";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { isFarmingActive } from "@lurkloot/shared/settings";
import type { CompatibilityResolution, ResolvedCompatibility } from "@lurkloot/shared/compatibility";
import { isWatchReward, reconcileCampaignAfterClaims } from "@lurkloot/shared/rewards";
import { campaignSearchBackoffApplies, isPlaybackTelemetryHealthy, MANUAL_WATCH_TTL_MS, runSchedulerTick, selectWatchTargetFromSnapshot, type SnapshotSelectionResult, type StopPageContextTabs } from "../core/scheduler";
import { isTimestampStale } from "../core/timestamps";
import {
  currentManagedPageContextTabs,
  currentManagedPageContextTabsRevision,
  hydrateManagedPageContextTabs,
  INTEGRITY_REFRESH_TIMEOUT_MS,
  isValidTwitchIntegrity,
  noteTwitchGqlRequest,
  registerManagedPageContextTabs,
  setTwitchIntegrity,
  syncManagedTabBreakers,
  type TwitchIntegrityRequest,
} from "../core/tabs";
import { dismissCriticalFailure, recordManagedTabOpen } from "../core/criticalHealth";
import { integrityFromHeaders } from "../core/twitchIntegrity";
import type { IntegrityHeader, TwitchIntegrity } from "../core/twitchIntegrity";
import type { PlatformAdapter } from "../platforms/adapter";
import type { TablessWatchController, WatchContext } from "../core/tablessWatch";
import type { DiscoverySignalController } from "../core/discoverySignals";
import { applyPlatformAuthHealth } from "../core/authHealth";
import { withActivityDiagnostics } from "../core/activityDiagnostics";
import {
  heartbeatContextKey,
  HEARTBEAT_INTERVAL_MS,
  nextHeartbeatDueAt,
  nextHeartbeatGeneration,
  validHeartbeatGeneration,
  validTablessHeartbeatCadence,
} from "../core/heartbeatCadence";
import { mergePlatformState } from "./platformState";
import {
  collectDiscoverySnapshot,
  adapterFromDiscoverySnapshot,
  DiscoverySnapshotLane,
  type DiscoverySnapshot,
  type DiscoverySnapshotState,
} from "../core/discoverySnapshot";

export const ALARM_NAME = "lurkloot.tick";
export const TWITCH_ALARM_NAME = "lurkloot.tick.twitch";
export const KICK_ALARM_NAME = "lurkloot.tick.kick";
// A separate, fixed 1-minute alarm drives tabless watch heartbeats independently
// of the (heavier, configurable) discovery tick. chrome.alarms clamps to a
// 1-minute minimum, close enough to TwitchDropsMiner's 59s send cadence.
export const WATCH_ALARM_NAME = "lurkloot.watch";
export const TWITCH_INTEGRITY_ALARM_NAME = "lurkloot.twitch-integrity";
export const TWITCH_INTEGRITY_REFRESH_LEAD_MS = 120_000;
export const TWITCH_INTEGRITY_REFRESH_JITTER_MAX_MS = 30_000;

interface BackgroundAlarmController {
  tickAndHandOff(platforms?: Platform[], trigger?: TickTrigger): Promise<SchedulerState | undefined>;
  runWatchHeartbeat(): Promise<void>;
  runTwitchIntegrityRefresh(): Promise<void>;
}

export function createBackgroundAlarmListener(controller: BackgroundAlarmController) {
  return (alarm: { name: string }): void => {
    if (alarm.name === TWITCH_ALARM_NAME) {
      void controller.tickAndHandOff(["twitch"], "alarm");
    } else if (alarm.name === KICK_ALARM_NAME) {
      void controller.tickAndHandOff(["kick"], "alarm");
    } else if (alarm.name === WATCH_ALARM_NAME) {
      void controller.runWatchHeartbeat();
    } else if (alarm.name === TWITCH_INTEGRITY_ALARM_NAME) {
      void controller.runTwitchIntegrityRefresh();
    }
  };
}
// Reward ids claimed during one tick, per platform. The post-claim handoff needs
// the ids (not just the platforms) so it can tell a genuine successor from the
// reward that was just claimed.
export type ClaimedRewards = Partial<Record<Platform, string[]>>;
// What caused a tick to run. Recorded in the tick's lifecycle diagnostics so an
// exported log distinguishes a user action from a timer or a post-claim handoff.
export type TickTrigger =
  | "alarm"
  | "watch_alarm"
  | "startup"
  | "install"
  | "automation_toggle"
  | "platform_toggle"
  | "settings_saved"
  | "manual_watch"
  | "manual_resume"
  | "manual_tick"
  | "critical_failure_dismissed"
  | "tabless_fallback"
  | "claim_handoff"
  | "discovery_signal"
  | "unknown";
type TickDiagnosticContext = Required<Pick<
  DiagnosticEvent,
  "globalTickId" | "platformTickId"
>>;
export type CredentialAvailability =
  | { status: "available" }
  | { status: "missing" }
  | { status: "unavailable" };
// Reasons a refreshed platform has nothing left to farm. Reaching one of these
// means further refreshes would return the same answer, so the post-claim
// handoff stops instead of spending the rest of its budget.
const NOTHING_LEFT_REASON_CODES: WatchReasonCode[] = ["campaign_ineligible", "no_eligible_channel"];
function isNothingLeftToFarm(reasonCode: WatchReasonCode | undefined): boolean {
  return reasonCode != null && NOTHING_LEFT_REASON_CODES.includes(reasonCode);
}
// How recently a heartbeat must have landed for the post-claim handoff to treat
// the channel as already covered. Half the fixed one-minute alarm period: long
// enough to suppress a genuine double-send, short enough that a real handoff
// still transmits.
const RECENT_HEARTBEAT_MS = 30_000;
const PLATFORMS: Platform[] = ["twitch", "kick"];

interface CommittedHeartbeatContext {
  readonly generation: number;
  readonly contextKey: string;
  readonly session: Readonly<WatchSession>;
  readonly watcher: TablessWatchController;
}

type HeartbeatAttemptKind = "scheduled" | "immediate";

interface HeartbeatAttempt {
  readonly generation: number;
  readonly contextKey: string;
  readonly dueAt: number;
  readonly attemptAt: number;
  readonly synchronizationDelayMs: number;
  coalescedCalls: number;
  readonly promise: Promise<HeartbeatFallback | undefined>;
}

interface HeartbeatFallback {
  readonly platform: Platform;
  readonly generation: number;
  readonly contextKey: string;
}

interface HeartbeatResultCommit {
  readonly attempt: HeartbeatAttempt;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

interface HeartbeatRecoveryCommit {
  readonly generation: number;
  readonly contextKey: string;
  readonly expectedPersistedCadence?: Readonly<TablessHeartbeatCadence>;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

interface HeartbeatPublicationLease {
  published?: CommittedHeartbeatContext;
  readonly admissionReady: Promise<void>;
  readonly markPublished: (context: CommittedHeartbeatContext) => void;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

interface HeartbeatContextPublication {
  accepted: boolean;
  cadence?: TablessHeartbeatCadence;
  committed?: CommittedHeartbeatContext;
  replaced?: TablessWatchController;
}

type HeartbeatContextPublicationDecision = HeartbeatContextPublication | {
  waitFor: Promise<void>;
};

interface HeartbeatWatcherRemoval {
  accepted: boolean;
  watcher?: TablessWatchController;
}

type HeartbeatWatcherRemovalDecision = HeartbeatWatcherRemoval | {
  waitFor: Promise<void>;
};

interface HeartbeatLane {
  mutation: Promise<unknown>;
  revision: number;
  committed?: CommittedHeartbeatContext;
  // Discovery reserves this before starting, switching, or stopping a watcher
  // and holds it until the corresponding scheduler state has been persisted.
  // Recovery waits while a new owner is unpublished, while a heartbeat may use
  // the complete published context before persistence finishes. Its result then
  // waits for lease settlement outside provider I/O and every lock.
  publicationLease?: HeartbeatPublicationLease;
  inFlight?: HeartbeatAttempt;
  // Reserved only after transport completes. Context publishers wait for this
  // promise outside the lane, so either publication wins and rejects the old
  // result or the current result persists before publication becomes visible.
  resultCommit?: HeartbeatResultCommit;
  recoveryCommit?: HeartbeatRecoveryCommit;
  generationHighWater?: number;
  lastCompletedGeneration?: number;
  lastCompletedContextKey?: string;
  coalescedWithoutAttempt: number;
}

function correlateTickDiagnostics(
  events: readonly EngineEvent[],
  tickContext: TickDiagnosticContext,
): EngineEvent[] {
  return events.map((event) =>
    event.category === "diagnostic" ? { ...event, ...tickContext } : event);
}

// Must stay strictly greater than INTEGRITY_REFRESH_TIMEOUT_MS. A Twitch probe
// runs through gqlWithIntegrityRetry, so a rejection makes it wait on a page
// context minting a token; when this deadline was the shorter of the two (10s
// against a 12s wait) the probe could never observe that wait succeed. It
// aborted first, every time, and — because the wait takes no AbortSignal (#293)
// — left the wait and its tab running unowned behind it.
const DEFAULT_AUTH_PROBE_TIMEOUT_MS = INTEGRITY_REFRESH_TIMEOUT_MS + 5_000;
class AuthProbeSetupError extends Error {
  constructor(
    readonly platform: Platform,
    message: string,
  ) {
    super(message);
    this.name = "AuthProbeSetupError";
  }
}
const FARMING_STOP_REASON_CODES: Record<FarmingStopReason, true> = {
  automation_disabled: true,
  platform_disabled: true,
  authentication_unhealthy: true,
  platform_backoff: true,
  platform_error: true,
  campaign_ineligible: true,
  channel_excluded: true,
  channel_offline: true,
  channel_mismatch: true,
  watch_unhealthy: true,
  no_progress: true,
  higher_priority_reward: true,
  higher_priority_idle_watchlist: true,
  watch_requirement_completed: true,
  runtime_restart: true,
  target_changed: true,
  manual_watch: true,
  manual_tab_close: true,
  critical_failure: true,
};
const EN_RUNTIME_MESSAGES: Record<string, string> = {
  notificationRewardClaimed: "Reward claimed",
  notificationRewardEarned: "Reward earned",
  notificationNoDropsLeft: "No drops left",
  notificationRewardFromCampaign: "$1 from $2",
  notificationNoDropsLeftMessage: "$1 has no eligible drops to farm.",
  notificationChallengeClaimed: "Challenge reward claimed",
  notificationChallengeReward: "You won a $1 card from your $2 challenge.",
};

function emitHostCallbackError(
  emit: EventEmitter,
  platform: Platform,
  error: unknown,
  fallbackMessage: string,
): void {
  emit({
    category: "diagnostic",
    platform,
    level: "warn",
    message: error instanceof Error ? error.message : fallbackMessage,
  });
}

// Generic over the host's settings type `S`, which must satisfy the engine
// contract (EngineSettings). The extension parametrizes it with its fuller
// ExtensionSettings (load/save round-trip the host-only fields); the CLI uses the
// bare EngineSettings. The engine itself only ever reads EngineSettings fields.
export interface BackgroundControllerDeps<S extends EngineSettings = EngineSettings> {
  loadSettings(): Promise<S>;
  saveSettings(settings: S): Promise<void>;
  loadState(): Promise<SchedulerState>;
  saveState(state: SchedulerState): Promise<void>;
  authProbeTimeoutMs?: number;
  reportEvents?: EventReporter;
  createAlarm(
    name: string,
    options: { periodInMinutes: number } | { when: number },
  ): Promise<void>;
  getAlarm?(name: string): Promise<{ scheduledTime: number } | undefined>;
  clearAlarm?(name: string): Promise<boolean>;
  ensureTwitchIntegrity?(
    emit: EventEmitter,
    request?: TwitchIntegrityRequest,
  ): Promise<boolean>;
  cancelTwitchIntegrityAcquisition?(reason?: unknown): void;
  createAdapters(emit: EventEmitter, settings: S): {
    adapters: Record<Platform, PlatformAdapter>;
    compatibility: ResolvedCompatibility;
    warnings: CompatibilityResolution["warnings"];
  };
  createAdapter(platform: Platform, emit: EventEmitter, settings: S): {
    adapter: PlatformAdapter;
    compatibility: ResolvedCompatibility;
    warnings: CompatibilityResolution["warnings"];
  };
  checkCredentialAvailability?(platform: Platform): Promise<CredentialAvailability>;
  createNotification?(notification: { title: string; message: string }): Promise<void>;
  translate?(key: string, substitutions?: string | string[]): string | Promise<string>;
  closeManagedTabs?(tabs: ManagedWatchTab[]): Promise<void>;
  // Tab-mode ad focus. The host (extension) owns the focus policy (adFocusMode),
  // so the engine only reports whether an ad is active for a given watch tab.
  applyAdFocus?(platform: Platform, tabId: number | undefined, adActive: boolean, emit: EventEmitter): Promise<void>;
  // Tab-mode playback policy the host supplies to managed watch tabs. Defaults to
  // keeping videos unmuted when the host does not provide it.
  loadTabPlaybackPolicy?(): Promise<{ keepVideosUnmuted: boolean }>;
  // Applies a popup settings patch to the host's full settings. Host-only; the
  // CLI never sends settings-mutating messages, so it can omit this.
  applySettingsPatch?(current: S, patch: SettingsPatch): S;
  loadTwitchIntegrity?(): Promise<TwitchIntegrity | undefined>;
  saveTwitchIntegrity?(value: TwitchIntegrity): Promise<void>;
  // Browser-bound page-context tab teardown, injected into the scheduler tick.
  // Omitted in headless/test runs, where the scheduler forgets contexts from
  // state only (see runSchedulerTick / StopPageContextTabs).
  stopPageContextTabs?: StopPageContextTabs;
  reconcilePageContextRecovery?(
    platform: Platform,
    observation: import("../platforms/adapter").KickPageContextCycleObservation,
    settings: S,
    emit: EventEmitter,
  ): Promise<void>;
  selectWatchTarget?: typeof selectWatchTargetFromSnapshot;
  // Delay used by the bounded post-claim handoff. Injected so tests can drive
  // the loop deterministically instead of racing real timers. Resolves early
  // (without throwing) when the signal aborts, so callers check `signal.aborted`
  // after awaiting rather than catching.
  wait?(ms: number, signal: AbortSignal): Promise<void>;
}

export function createBackgroundController<S extends EngineSettings = EngineSettings>(deps: BackgroundControllerDeps<S>) {
  const controllerRunId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const controllerRunLabel = controllerRunId.slice(0, 8);
  let controllerRunAnnouncement: Promise<void> | undefined;
  const platformMutations: Record<Platform, Promise<unknown>> = {
    twitch: Promise.resolve(),
    kick: Promise.resolve(),
  };
  let stateCommit: Promise<unknown> = Promise.resolve();

  function withPlatformLock<T>(platform: Platform, operation: () => Promise<T>): Promise<T> {
    const run = platformMutations[platform].then(operation, operation);
    platformMutations[platform] = run.then(() => undefined, () => undefined);
    return run;
  }

  function withStateLock<T>(
    operation: () => Promise<T>,
    platforms: readonly Platform[] = PLATFORMS,
  ): Promise<T> {
    const targets = PLATFORMS.filter((platform) => platforms.includes(platform));
    const acquire = (index: number): Promise<T> => {
      const platform = targets[index];
      if (!platform) return operation();
      return withPlatformLock(platform, () => acquire(index + 1));
    };
    return acquire(0);
  }

  function withStateCommit<T>(operation: () => Promise<T>): Promise<T> {
    const run = stateCommit.then(operation, operation);
    stateCommit = run.then(() => undefined, () => undefined);
    return run;
  }

  const reportedCompatibility = new Map<Platform, string>();
  const reportedCompatibilityWarnings = new Set<string>();
  const authRefreshGeneration: Record<Platform, number> = {
    twitch: 0,
    kick: 0,
  };
  // In-flight post-claim handoffs, one per platform. A claim arriving while a
  // handoff is already running for that platform is absorbed by the running
  // loop rather than starting a second one, which is what keeps the work
  // bounded. Per-controller, unlike the storage lock: these loops coordinate
  // only with each other.
  const claimHandoffs = new Map<Platform, AbortController>();

  const wait: NonNullable<BackgroundControllerDeps<S>["wait"]> = deps.wait ?? ((ms, signal) => new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }));

  const selectionFingerprint = (value: string): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };

  const warningFieldLabel = (platform: Platform, field: string): string => {
    if (platform === "twitch") {
      if (field === "profile") return "Twitch profile";
      if (field === "heartbeatTransport") return "Twitch heartbeat";
      return "Twitch inventory";
    }
    return field === "profile" ? "Kick profile" : "Kick claim";
  };

  function reportAdapterCompatibility(
    construction: {
      compatibility: ResolvedCompatibility;
      warnings: CompatibilityResolution["warnings"];
    },
    settings: S,
    emit: EventEmitter,
    platforms: readonly Platform[],
  ): void {
    for (const warning of construction.warnings) {
      if (!platforms.includes(warning.platform) || !settings.platform[warning.platform].enabled) continue;
      const key = `${warning.code}:${warning.platform}:${warning.field}:${warning.resolved}:${selectionFingerprint(warning.requested)}`;
      if (reportedCompatibilityWarnings.has(key)) continue;
      const reason = warning.code === "unknown_selection" ? "Unknown" : "Host-incompatible";
      emit({
        category: "diagnostic",
        platform: warning.platform,
        level: "warn",
        message: `${reason} ${warningFieldLabel(warning.platform, warning.field)} compatibility selection; using ${warning.resolved}`,
        ...(warning.field === "profile"
          ? { compatibilityProfile: warning.resolved }
          : { compatibilityCapability: warning.resolved, compatibilityVersion: warning.resolved }),
      });
      reportedCompatibilityWarnings.add(key);
    }
    for (const platform of platforms) {
      if (!settings.platform[platform].enabled) continue;
      const profile = construction.compatibility[platform].profile;
      const capabilities = platform === "twitch"
        ? [construction.compatibility.twitch.heartbeat, construction.compatibility.twitch.inventory]
        : [construction.compatibility.kick.claim];
      const capability = capabilities[0];
      const key = [profile, ...capabilities].join(":");
      if (reportedCompatibility.get(platform) === key) continue;
      emit({
        category: "diagnostic",
        platform,
        level: "info",
        message: `Using compatibility profile ${profile} (${capabilities.join(", ")})`,
        compatibilityProfile: profile,
        compatibilityCapability: capability,
        compatibilityCapabilities: capabilities,
        compatibilityVersion: capability,
      });
      reportedCompatibility.set(platform, key);
    }
  }

  function createAdapters(settings: S, emit: EventEmitter): Record<Platform, PlatformAdapter> {
    const construction = deps.createAdapters(emit, settings);
    reportAdapterCompatibility(construction, settings, emit, PLATFORMS);
    return construction.adapters;
  }

  function createAdapter(
    platform: Platform,
    settings: S,
    emit: EventEmitter,
    reportCompatibility = false,
  ): PlatformAdapter {
    const construction = deps.createAdapter(platform, emit, settings);
    if (reportCompatibility) {
      reportAdapterCompatibility(construction, settings, emit, [platform]);
    }
    return construction.adapter;
  }

  function createSelectedAdapters(
    settings: S,
    emit: EventEmitter,
    platforms: readonly Platform[],
  ): Record<Platform, PlatformAdapter> {
    if (platforms.length === PLATFORMS.length) return createAdapters(settings, emit);
    const adapters: Partial<Record<Platform, PlatformAdapter>> = {};
    for (const platform of platforms) {
      adapters[platform] = createAdapter(platform, settings, emit, true);
    }
    return adapters as Record<Platform, PlatformAdapter>;
  }

  interface TickAdapterHandle {
    readonly platform: Platform;
    adapter(settings: S, emit: EventEmitter, reportCompatibility?: boolean): PlatformAdapter;
    drain(emit: EventEmitter): void;
  }

  function createTickAdapterHandle(platform: Platform): TickAdapterHandle {
    const pendingEvents: EngineEvent[] = [];
    let adapter: PlatformAdapter | undefined;
    let construction: ReturnType<BackgroundControllerDeps<S>["createAdapter"]> | undefined;
    let compatibilityReported = false;
    let settingsFingerprint: string | undefined;
    return {
      platform,
      adapter(settings, emit, reportCompatibility = false) {
        const nextFingerprint = JSON.stringify(settings);
        if (!adapter || settingsFingerprint !== nextFingerprint) {
          this.drain(emit);
          construction = deps.createAdapter(platform, (event) => pendingEvents.push(event), settings);
          adapter = construction.adapter;
          settingsFingerprint = nextFingerprint;
          compatibilityReported = false;
        }
        if (reportCompatibility && !compatibilityReported && construction) {
          reportAdapterCompatibility(construction, settings, (event) => pendingEvents.push(event), [platform]);
          compatibilityReported = true;
        }
        this.drain(emit);
        return adapter;
      },
      drain(emit) {
        for (const event of pendingEvents.splice(0)) emit(event);
      },
    };
  }

  async function withEventCollector<T>(operation: (emit: EventEmitter, events: EngineEvent[]) => Promise<T>): Promise<T> {
    const events: EngineEvent[] = [];
    const emit = withActivityDiagnostics((event) => events.push(event));
    return operation(emit, events);
  }

  function clearOperationalEvents(events: EngineEvent[]): void {
    const compatibilityEvents = events.filter((event) =>
      event.category === "diagnostic"
      && (event.compatibilityProfile !== undefined || event.compatibilityCapability !== undefined));
    events.splice(0, events.length, ...compatibilityEvents);
  }

  // Persistent tabless watchers, one per platform, kept alive across discovery
  // ticks (the WebSocket-based Kick watcher in particular must not be recreated
  // each tick). Reconciled against the scheduler's per-platform session state.
  const tablessWatchers = new Map<Platform, TablessWatchController>();
  const heartbeatLanes: Record<Platform, HeartbeatLane> = {
    twitch: { mutation: Promise.resolve(), revision: 0, coalescedWithoutAttempt: 0 },
    kick: { mutation: Promise.resolve(), revision: 0, coalescedWithoutAttempt: 0 },
  };

  function withHeartbeatLane<T>(
    platform: Platform,
    operation: (lane: HeartbeatLane) => Promise<T>,
  ): Promise<T> {
    const lane = heartbeatLanes[platform];
    const run = lane.mutation.then(() => operation(lane), () => operation(lane));
    lane.mutation = run.then(() => undefined, () => undefined);
    return run;
  }

  function newHeartbeatPublicationLease(): HeartbeatPublicationLease {
    let signalAdmission!: () => void;
    let settleLease!: () => void;
    let admissionSignalled = false;
    const admissionReady = new Promise<void>((resolve) => {
      signalAdmission = resolve;
    });
    const settled = new Promise<void>((resolve) => {
      settleLease = resolve;
    });
    const signalAdmissionOnce = () => {
      if (admissionSignalled) return;
      admissionSignalled = true;
      signalAdmission();
    };
    const lease: HeartbeatPublicationLease = {
      admissionReady,
      markPublished: (context) => {
        lease.published = context;
        signalAdmissionOnce();
      },
      settled,
      settle: () => {
        signalAdmissionOnce();
        settleLease();
      },
    };
    return lease;
  }

  async function releaseHeartbeatPublicationLease(
    platform: Platform,
    lease: HeartbeatPublicationLease,
  ): Promise<void> {
    await withHeartbeatLane(platform, async (lane) => {
      if (lane.publicationLease !== lease) return;
      lane.publicationLease = undefined;
      lease.settle();
    });
  }

  async function cancelHeartbeatPublicationLeases(
    platforms: readonly Platform[],
  ): Promise<void> {
    await Promise.all(platforms.map((platform) => withHeartbeatLane(platform, async (lane) => {
      const lease = lane.publicationLease;
      if (!lease) return;
      lane.publicationLease = undefined;
      lease.settle();
    })));
  }

  function frozenHeartbeatSession(
    session: WatchSession,
    cadence: TablessHeartbeatCadence,
  ): Readonly<WatchSession> {
    return Object.freeze({
      ...session,
      channel: session.channel ? Object.freeze({ ...session.channel }) : undefined,
      tablessHeartbeat: Object.freeze({ ...cadence }),
    });
  }

  async function commitHeartbeatContext(
    platform: Platform,
    session: WatchSession,
    watcher: TablessWatchController,
    expectedRevision: number,
    publicationLease?: HeartbeatPublicationLease,
  ): Promise<HeartbeatContextPublication> {
    const contextKey = heartbeatContextKey(session);
    while (true) {
      const decision: HeartbeatContextPublicationDecision = await withHeartbeatLane(
        platform,
        async (lane) => {
          if (lane.revision !== expectedRevision) {
            return { accepted: false, committed: lane.committed };
          }
          if (lane.publicationLease && lane.publicationLease !== publicationLease) {
            return { waitFor: lane.publicationLease.settled };
          }
          if (lane.recoveryCommit) return { waitFor: lane.recoveryCommit.settled };
          if (lane.resultCommit) return { waitFor: lane.resultCommit.settled };
          const previous = lane.committed;
          if (!contextKey) {
            lane.committed = undefined;
            tablessWatchers.set(platform, watcher);
            lane.revision += 1;
            return {
              accepted: true,
              replaced: previous?.watcher === watcher ? undefined : previous?.watcher,
            };
          }

          const persistedMetadata = session.tablessHeartbeat;
          const persisted = validTablessHeartbeatCadence(session);
          const previousCadence = previous?.contextKey === contextKey
            ? previous.session.tablessHeartbeat
            : undefined;
          const mayRestorePersisted = persisted !== undefined
            && (lane.generationHighWater === undefined
              || persisted.generation > lane.generationHighWater);
          const generation = previousCadence?.generation
            ?? (mayRestorePersisted
              ? persisted.generation
              : nextHeartbeatGeneration(
                  lane.generationHighWater,
                  previous?.generation,
                  persistedMetadata?.generation,
                ));
          const cadence: TablessHeartbeatCadence = Object.freeze(previousCadence
            ? { ...previousCadence }
            : mayRestorePersisted
              ? { ...persisted }
              : {
                  generation,
                  contextKey,
                  nextDueAt: persisted
                    ? persisted.nextDueAt
                    : new Date(Date.now() + HEARTBEAT_INTERVAL_MS).toISOString(),
                });
          const committed = Object.freeze({
            generation,
            contextKey,
            session: frozenHeartbeatSession(session, cadence),
            watcher,
          });
          lane.generationHighWater = Math.max(lane.generationHighWater ?? 0, generation);
          lane.committed = committed;
          tablessWatchers.set(platform, watcher);
          if (publicationLease && lane.publicationLease === publicationLease) {
            publicationLease.markPublished(committed);
          }
          lane.revision += 1;
          return {
            accepted: true,
            cadence,
            committed,
            replaced: previous?.watcher === watcher ? undefined : previous?.watcher,
          };
        },
      );
      if ("waitFor" in decision) {
        await decision.waitFor;
        continue;
      }
      return decision;
    }
  }

  async function takeHeartbeatWatcher(
    platform: Platform,
    expectedRevision?: number,
  ): Promise<HeartbeatWatcherRemoval> {
    while (true) {
      const decision: HeartbeatWatcherRemovalDecision = await withHeartbeatLane(
        platform,
        async (lane) => {
          if (expectedRevision !== undefined && lane.revision !== expectedRevision) {
            return { accepted: false };
          }
          if (lane.resultCommit) return { waitFor: lane.resultCommit.settled };
          const watcher = lane.committed?.watcher ?? tablessWatchers.get(platform);
          lane.committed = undefined;
          tablessWatchers.delete(platform);
          lane.revision += 1;
          return { accepted: true, watcher };
        },
      );
      if ("waitFor" in decision) {
        await decision.waitFor;
        continue;
      }
      return decision;
    }
  }
  const campaignEvaluationFingerprints: Partial<Record<Platform, string>> = {};
  const discoverySignalControllers = new Map<Platform, DiscoverySignalController>();
  const discoverySignalPlatformBlocked: Record<Platform, boolean> = {
    twitch: false,
    kick: false,
  };
  const waitingClaimRewardIds: Record<Platform, Set<string>> = {
    twitch: new Set<string>(),
    kick: new Set<string>(),
  };
  let settingsMutation: Promise<unknown> = Promise.resolve();
  let twitchIntegrityAlarmMutation: Promise<unknown> = Promise.resolve();
  let twitchSettingsTransitionGeneration = 0;
  let lastPersistedTwitchEnabled: boolean | undefined;
  let integrityRefreshAbort: AbortController | undefined;
  let integrityLifecycleGeneration = 0;
  let integrityLifecycleOpen = true;
  let discoverySignalLifecycleOpen = true;
  let controllerShutdown = false;
  const discoveryEvents: Record<Platform, EngineEvent[]> = { twitch: [], kick: [] };
  const discoveryLanes: Record<Platform, DiscoverySnapshotLane<TickAdapterHandle | undefined>> = {
    twitch: createDiscoveryLane("twitch"),
    kick: createDiscoveryLane("kick"),
  };
  const discoveryBackoffBypasses: Record<Platform, number> = { twitch: 0, kick: 0 };
  interface SelectionInput {
    platform: Platform;
    trigger: TickTrigger;
    snapshot: DiscoverySnapshot;
    settings: S;
    state: SchedulerState;
    key: string;
    force: boolean;
    signal: AbortSignal;
    generation: number;
  }
  interface CommittedSelection {
    key: string;
    snapshotRevision: number;
    generation: number;
    result: SnapshotSelectionResult;
  }
  const selectionCache: Partial<Record<Platform, CommittedSelection>> = {};
  const selectionRuns: Partial<Record<Platform, Promise<CommittedSelection>>> = {};
  const pendingSelections: Partial<Record<Platform, SelectionInput>> = {};
  const selectionGeneration: Record<Platform, number> = { twitch: 0, kick: 0 };
  const reconciledPageContextSnapshotRevision: Partial<Record<Platform, number>> = {};
  let installedTwitchIntegrity: TwitchIntegrity | undefined;
  let persistedIntegrityToken: string | undefined;
  // A missing rejectedToken means there was no usable bundle when the refresh
  // became due. Keeping the wrapper object distinguishes that from "not due."
  let twitchIntegrityRefreshDue: { rejectedToken?: string } | undefined;

  function createDiscoveryLane(platform: Platform): DiscoverySnapshotLane<TickAdapterHandle | undefined> {
    return new DiscoverySnapshotLane<TickAdapterHandle | undefined>(
      platform,
      async ({ signal, request: tickAdapter }) => {
        const [settings, state] = await withSettingsLock(() => withStateCommit(() =>
          Promise.all([deps.loadSettings(), deps.loadState()])));
        if (!settings.platform[platform].enabled) {
          return {
            campaigns: [],
            idleCandidates: [],
            followedChannels: [],
            complete: false,
            failure: "Platform disabled",
            metrics: { campaigns: 0, candidates: 0, cacheHits: 0, cacheMisses: 0, batchRequests: 0, singleFallbacks: 0 },
          };
        }
        return withEventCollector(async (emit, events) => {
          const adapter = tickAdapter?.adapter(settings, emit, true)
            ?? createAdapter(platform, settings, emit, true);
          try {
            return await collectDiscoverySnapshot(
              adapter,
              state.sessions[platform],
              signal,
              Date.now,
              settings.preferKnownChannels,
              settings.platform[platform].idleWatchlistChannels
                .map((username) => username.trim().toLowerCase())
                .filter(Boolean)
                .map((username) => ({
                  platform,
                  username,
                  displayName: username,
                  url: platform === "twitch"
                    ? `https://www.twitch.tv/${username}`
                    : `https://kick.com/${username}`,
                })),
              (campaign, campaigns) => {
                const backoff = state.campaignSearchBackoffs?.[platform];
                if (!campaignSearchBackoffApplies(
                  campaign,
                  settings,
                  state.sessions[platform],
                  backoff,
                  discoveryBackoffBypasses[platform] > 0,
                  campaigns.find((candidate) => candidate.id === state.sessions[platform].campaignId),
                )) return undefined;
                return discoveryLanes[platform].current().snapshot?.campaigns
                  .find(({ campaign: previous }) => previous.id === campaign.id)
                  ?.candidates ?? [];
              },
            );
          } finally {
            tickAdapter?.drain(emit);
            discoveryEvents[platform].push(...events);
          }
        });
      },
      async (discoveryState) => queueDiscoveryAttempt(platform, discoveryState),
    );
  }

  function queueDiscoveryAttempt(
    platform: Platform,
    discoveryState: Readonly<DiscoverySnapshotState>,
  ): void {
    const attempt = discoveryState.lastAttempt;
    if (!attempt) return;
    const snapshot = discoveryState.snapshot;
    const metrics = attempt.metrics;
    const duration = attempt.finishedAt - attempt.startedAt;
    const age = snapshot ? Math.max(0, Date.now() - snapshot.observedAt) : 0;
    const outcome = attempt.discarded
      ? `discarded=${attempt.discarded}`
      : attempt.complete
        ? "complete"
        : `incomplete (${attempt.failure ?? "unknown failure"})`;
    discoveryEvents[platform].push({
      category: "diagnostic",
      platform,
      level: attempt.complete ? "debug" : "warn",
      message: `Discovery refresh finished in ${duration}ms (${outcome}, revision=${snapshot?.revision ?? 0}, age=${age}ms, coalesced=${attempt.coalesced}, campaigns=${metrics?.campaigns ?? 0}, candidates=${metrics?.candidates ?? 0}, cache hits=${metrics?.cacheHits ?? 0}, cache misses=${metrics?.cacheMisses ?? 0}, batch requests=${metrics?.batchRequests ?? 0}, single fallbacks=${metrics?.singleFallbacks ?? 0})`,
    });
    if (attempt.complete && snapshot) {
      discoveryEvents[platform].push({
        category: "diagnostic",
        platform,
        level: "debug",
        message: `Campaign refresh finished in ${duration}ms (${snapshot.metrics.campaigns} ${snapshot.metrics.campaigns === 1 ? "campaign" : "campaigns"})`,
      });
    }
  }

  // Prime the in-memory integrity token from storage whenever the background
  // script (re)evaluates, so a claim right after a service-worker wake can use
  // the last captured token before any fresh page traffic is observed.
  const initialTwitchIntegrityLoad = loadStoredTwitchIntegrity(
    integrityLifecycleGeneration,
    twitchSettingsTransitionGeneration,
  );

  function integrityRefreshJitter(token: string): number {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % (TWITCH_INTEGRITY_REFRESH_JITTER_MAX_MS + 1);
  }

  function twitchIntegrityRefreshTarget(integrity: TwitchIntegrity): number {
    return integrity.expiresAt
      - TWITCH_INTEGRITY_REFRESH_LEAD_MS
      - integrityRefreshJitter(integrity.integrity);
  }

  function installTwitchIntegrity(
    integrity: TwitchIntegrity,
    isNew = false,
    emit?: EventEmitter,
    sourceTabId?: number,
  ): void {
    installedTwitchIntegrity = integrity;
    setTwitchIntegrity(integrity, { isNew, sourceTabId }, emit);
  }

  function currentInstalledTwitchIntegrity(): TwitchIntegrity | undefined {
    return isValidTwitchIntegrity(installedTwitchIntegrity)
      ? installedTwitchIntegrity
      : undefined;
  }

  function reconcileStoredTwitchIntegrity(stored: TwitchIntegrity | undefined): TwitchIntegrity | undefined {
    const current = currentInstalledTwitchIntegrity();
    if (!isValidTwitchIntegrity(stored)) return current;
    const storedSupersedesCurrent = !current
      || (
        stored.integrity !== current.integrity
        && persistedIntegrityToken === current.integrity
      );
    persistedIntegrityToken = stored.integrity;
    if (storedSupersedesCurrent) {
      installTwitchIntegrity(stored);
      return stored;
    }
    return current;
  }

  function markTwitchIntegrityRefreshDue(integrity?: TwitchIntegrity): void {
    twitchIntegrityRefreshDue = {
      ...(integrity ? { rejectedToken: integrity.integrity } : {}),
    };
  }

  function withTwitchIntegrityAlarmLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = twitchIntegrityAlarmMutation.then(operation, operation);
    twitchIntegrityAlarmMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  async function clearTwitchIntegrityAlarm(): Promise<void> {
    await withTwitchIntegrityAlarmLock(async () => {
      await deps.clearAlarm?.(TWITCH_INTEGRITY_ALARM_NAME);
    });
  }

  async function clearTwitchIntegrityAlarmBestEffort(emit?: EventEmitter): Promise<void> {
    try {
      await clearTwitchIntegrityAlarm();
    } catch {
      const event: DiagnosticEvent = {
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: "Could not clear the Twitch integrity refresh alarm",
      };
      if (emit) {
        emit(event);
      } else {
        await reportBestEffort([event]);
      }
    }
  }

  async function scheduleTwitchIntegrityRefresh(
    integrity: TwitchIntegrity,
    emit?: EventEmitter,
  ): Promise<void> {
    const when = twitchIntegrityRefreshTarget(integrity);
    if (when <= Date.now()) {
      markTwitchIntegrityRefreshDue(integrity);
      await clearTwitchIntegrityAlarm();
      return;
    }
    const scheduled = await withTwitchIntegrityAlarmLock(async () => {
      let existing: { scheduledTime: number } | undefined;
      try {
        existing = await deps.getAlarm?.(TWITCH_INTEGRITY_ALARM_NAME);
      } catch {
        existing = undefined;
      }
      if (existing && Math.abs(existing.scheduledTime - when) <= 1_000) {
        twitchIntegrityRefreshDue = undefined;
        return false;
      }
      await deps.createAlarm(TWITCH_INTEGRITY_ALARM_NAME, { when });
      return true;
    });
    if (!scheduled) return;
    twitchIntegrityRefreshDue = undefined;
    emit?.({
      category: "diagnostic",
      platform: "twitch",
      level: "debug",
      message: `Scheduled proactive Twitch integrity refresh for ${new Date(when).toISOString()}`,
    });
  }

  async function scheduleTwitchIntegrityRefreshBestEffort(
    integrity: TwitchIntegrity,
    emit?: EventEmitter,
  ): Promise<void> {
    try {
      await scheduleTwitchIntegrityRefresh(integrity, emit);
    } catch (error) {
      const event: DiagnosticEvent = {
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: `Could not schedule Twitch integrity refresh (${error instanceof Error ? error.message : String(error)})`,
      };
      if (emit) {
        emit(event);
      } else {
        await reportBestEffort([event]);
      }
    }
  }

  async function loadStoredTwitchIntegrity(
    lifecycleGeneration: number,
    settingsTransitionGeneration: number,
  ): Promise<void> {
    let twitchEnabled: boolean | undefined;
    let settingsReadError: unknown;
    await withSettingsLock(async () => {
      try {
        twitchEnabled = (await deps.loadSettings()).platform.twitch.enabled;
      } catch (error) {
        settingsReadError = error;
      }
    });
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const ownsStartupLoad = (): boolean =>
        !controllerShutdown
        && integrityLifecycleGeneration === lifecycleGeneration
        && twitchSettingsTransitionGeneration === settingsTransitionGeneration;
      let integrity: TwitchIntegrity | undefined;
      if (settingsReadError) {
        emit({
          category: "diagnostic",
          level: "debug",
          platform: "twitch",
          message: `Could not read Twitch settings while priming integrity (${settingsReadError instanceof Error ? settingsReadError.message : String(settingsReadError)})`,
        });
      }
      try {
        integrity = await deps.loadTwitchIntegrity?.();
      } catch (error) {
        // A missing/corrupt stored token is non-fatal: fresh page traffic will
        // re-capture one, and claims simply stay best-effort until then.
        emit({
          category: "diagnostic",
          level: "debug",
          platform: "twitch",
          message: `No stored Twitch integrity token to prime (${error instanceof Error ? error.message : String(error)})`,
        });
      }
      if (!ownsStartupLoad()) return;
      if (isValidTwitchIntegrity(integrity)) {
        const current = reconcileStoredTwitchIntegrity(integrity);
        if (twitchEnabled === true && integrityLifecycleOpen) {
          await scheduleTwitchIntegrityRefreshBestEffort(current!, emit);
        }
      } else if (integrity) {
        emit({
          category: "diagnostic",
          level: "debug",
          platform: "twitch",
          message: "Stored Twitch integrity token is expired or too close to expiry; ignoring it",
        });
      }
      await reportBestEffort(events);
    }));
  }

  async function runTwitchIntegrityRefresh(): Promise<void> {
    if (!integrityLifecycleOpen || integrityRefreshAbort) return;
    const abort = new AbortController();
    integrityRefreshAbort = abort;
    const lifecycleGeneration = integrityLifecycleGeneration;
    const ownsRefresh = (): boolean =>
      integrityRefreshAbort === abort
      && !abort.signal.aborted
      && integrityLifecycleGeneration === lifecycleGeneration
      && integrityLifecycleOpen;

    try {
      await initialTwitchIntegrityLoad;
      if (!ownsRefresh()) return;
      await withEventCollector(async (emit, events) => {
        let integrity: TwitchIntegrity | undefined;
        let shouldAcquire = false;
        try {
          await withSettingsLock(async () => {
            if (!ownsRefresh()) return;
            const settings = await deps.loadSettings();
            if (!ownsRefresh()) return;
            if (!settings.platform.twitch.enabled) {
              closeTwitchIntegrityLifecycle("Twitch disabled");
              await clearTwitchIntegrityAlarmBestEffort(emit);
              return;
            }

            await withStateLock(async () => {
              if (!ownsRefresh()) return;
              let stored: TwitchIntegrity | undefined;
              try {
                stored = await deps.loadTwitchIntegrity?.();
              } catch {
                emit({
                  category: "diagnostic",
                  platform: "twitch",
                  level: "debug",
                  message: "Could not reload stored Twitch integrity before proactive refresh",
                });
              }
              if (!ownsRefresh()) return;

              integrity = reconcileStoredTwitchIntegrity(stored);
              if (integrity && twitchIntegrityRefreshTarget(integrity) > Date.now()) {
                await scheduleTwitchIntegrityRefreshBestEffort(integrity, emit);
                return;
              }
              markTwitchIntegrityRefreshDue(integrity);
              shouldAcquire = true;
            });
          });

          if (!shouldAcquire || !deps.ensureTwitchIntegrity || !ownsRefresh()) return;
          const remainingMs = integrity
            ? Math.max(0, integrity.expiresAt - Date.now())
            : 0;
          emit({
            category: "diagnostic",
            platform: "twitch",
            level: "debug",
            message: integrity
              ? `Starting proactive Twitch integrity refresh with ${remainingMs}ms remaining`
              : "Starting proactive Twitch integrity refresh with no valid token available",
          });
          const ready = await deps.ensureTwitchIntegrity(emit, {
            forceRefresh: true,
            reason: "proactive_refresh",
            ...(integrity ? { rejectedToken: integrity.integrity } : {}),
            onManagedPageContextOpen: () =>
              recordTwitchIntegrityManagedTabOpen("proactive_integrity_refresh"),
            signal: abort.signal,
          });
          if (!ready && !abort.signal.aborted) {
            emit({
              category: "diagnostic",
              platform: "twitch",
              level: "debug",
              message: "Proactive Twitch integrity refresh was deferred; the next normal scheduler alarm will retry",
            });
          }
        } catch {
          if (abort.signal.aborted) {
            emit({
              category: "diagnostic",
              platform: "twitch",
              level: "debug",
              message: "Proactive Twitch integrity refresh was cancelled because Twitch stopped",
            });
          } else {
            emit({
              category: "diagnostic",
              platform: "twitch",
              level: "debug",
              message: "Proactive Twitch integrity refresh was deferred; the next normal scheduler alarm will retry",
            });
          }
        } finally {
          await reportBestEffort(events);
        }
      });
    } finally {
      if (integrityRefreshAbort === abort) {
        integrityRefreshAbort = undefined;
      }
    }
  }

  // Fed by the background's webRequest listener with the outgoing headers of
  // gql.twitch.tv requests. Only genuine page-minted requests carry a
  // Client-Integrity header, so integrityFromHeaders returns undefined (and we
  // ignore) our own background fetch and anonymous queries.
  // `tabId` is optional so hosts that cannot attribute a request to a tab still
  // capture tokens; when present it also lets a managed refresh distinguish its
  // own replacement from a concurrent user-tab replay.
  async function captureTwitchIntegrity(headers: IntegrityHeader[] | undefined, tabId?: number): Promise<void> {
    // Noted before the integrity filter: an anonymous GQL request carries no
    // Client-Integrity header but still proves the SPA has booted.
    noteTwitchGqlRequest(tabId);
    const integrity = integrityFromHeaders(headers);
    if (!integrity) return;
    // Installed outside withStateLock, and synchronously before the first await.
    //
    // A mint waits on setTwitchIntegrity waking its waiters (see core/tabs.ts),
    // and the two paths that can force a refresh — runTick around
    // runSchedulerTick, and runPlatformWatchHeartbeat around watcher.tick — both
    // hold the platform lock across that wait. Installing under the same lock
    // made the waiter depend on a lock its own holder owns: the token arrived,
    // sat queued behind the tick, and the wait could only ever time out. Each
    // timeout then booted another page-context tab, which is what users saw as
    // twitch.tv/drops/inventory opening and closing every tick.
    //
    // The compare and the install must stay in one uninterrupted synchronous
    // block: webRequest fires on every GQL request, so an await between them
    // would let two captures interleave and both report themselves as new.
    let isNew = false;
    await withEventCollector(async (emit, events) => {
      isNew = integrity.integrity !== installedTwitchIntegrity?.integrity;
      const sourceTabId = tabId != null && tabId >= 0 ? tabId : undefined;
      installTwitchIntegrity(integrity, isNew, emit, sourceTabId);
      await reportBestEffort(events);
    });
    // Persistence still takes the lock: persistedIntegrityToken is read and
    // written by reconcileStoredTwitchIntegrity under it. Scoped to twitch —
    // this touches no Kick state, and holding both locks let a busy Kick tick
    // delay Twitch token bookkeeping. Nothing waits on this, so queueing behind
    // an in-flight tick is harmless.
    await withStateLock(() => withEventCollector(async (emit, events) => {
      if (integrity.integrity === persistedIntegrityToken || !deps.saveTwitchIntegrity) return;
      try {
        await deps.saveTwitchIntegrity(integrity);
        persistedIntegrityToken = integrity.integrity;
      } catch {
        emit({
          category: "diagnostic",
          platform: "twitch",
          level: "warn",
          message: "Could not persist the captured Twitch integrity token",
        });
      }
      await reportBestEffort(events);
    }), ["twitch"]);
    if (!isNew) return;
    const lifecycleGeneration = integrityLifecycleGeneration;
    const settingsTransitionGeneration = twitchSettingsTransitionGeneration;
    const ownsScheduling = (): boolean =>
      !controllerShutdown
      && integrityLifecycleOpen
      && integrityLifecycleGeneration === lifecycleGeneration
      && twitchSettingsTransitionGeneration === settingsTransitionGeneration;
    await withSettingsLock(() => withEventCollector(async (emit, events) => {
      try {
        if (!ownsScheduling()) return;
        const settings = await deps.loadSettings();
        if (!ownsScheduling() || !settings.platform.twitch.enabled) return;
        await scheduleTwitchIntegrityRefreshBestEffort(integrity, emit);
      } catch (error) {
        emit({
          category: "diagnostic",
          platform: "twitch",
          level: "warn",
          message: `Could not check Twitch settings before scheduling integrity refresh (${error instanceof Error ? error.message : String(error)})`,
        });
      }
      await reportBestEffort(events);
    }));
  }

  async function recordTwitchIntegrityManagedTabOpen(
    reason: "integrity_readiness" | "proactive_integrity_refresh",
    tickContext?: TickDiagnosticContext,
  ): Promise<void> {
    try {
      await withStateLock(() => withEventCollector(async (emit, events) => {
        if (!integrityLifecycleOpen) return;
        const settings = await deps.loadSettings();
        if (!integrityLifecycleOpen || !settings.criticalFailurePromptEnabled) return;
        const state = await deps.loadState();
        const transition = recordManagedTabOpen(state, "twitch", Date.now(), {
          source: "page_context",
          reason,
        });
        if (transition.event) emit(transition.event);
        syncManagedTabBreakers(transition.state, ["twitch"]);
        await persistAndReport(
          transition.state,
          tickContext ? correlateTickDiagnostics(events, tickContext) : events,
        );
      }));
    } catch {
      await reportBestEffort([{
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: "Could not account for a managed Twitch integrity page context",
        ...tickContext,
      }]);
    }
  }

  async function persistAndReport(state: SchedulerState, events: readonly EngineEvent[] = []): Promise<void> {
    await saveOperationalState(state);
    await reportBestEffort(events);
  }

  async function persistPlatformAndReport(
    platform: Platform,
    state: SchedulerState,
    events: readonly EngineEvent[] = [],
    isCurrent?: () => boolean,
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<boolean> {
    const persisted = await persistPlatformState(platform, state, isCurrent, onPersisted);
    if (!persisted) return false;
    await reportBestEffort(events);
    return true;
  }

  async function persistPlatformState(
    platform: Platform,
    state: SchedulerState,
    isCurrent?: () => boolean,
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<boolean> {
    return withStateCommit(async () => {
      // The registry can change while storage I/O is in flight (for example a
      // page-context fallback reported by the heartbeat watcher). Retry the
      // short merge when its revision moved, so the last write is a compare-
      // and-swap style recapture rather than a stale snapshot overwrite.
      while (true) {
        const latest = await deps.loadState();
        const currentSession = latest.sessions[platform];
        const nextSession = state.sessions[platform];
        const currentCadence = validTablessHeartbeatCadence(currentSession);
        const nextCadence = validTablessHeartbeatCadence(nextSession);
        const retainsHeartbeatAuthority = currentCadence !== undefined
          && nextCadence !== undefined
          && currentCadence.generation === nextCadence.generation
          && currentCadence.contextKey === nextCadence.contextKey
          && heartbeatContextKey(currentSession) === currentCadence.contextKey
          && heartbeatContextKey(nextSession) === nextCadence.contextKey;
        const pageContextRevision = currentManagedPageContextTabsRevision();
        const livePageContexts = currentManagedPageContextTabs();
        const mergeSourcePageContexts = { ...state.managedPageContextTabs };
        const livePageContext = livePageContexts[platform];
        if (livePageContext) mergeSourcePageContexts[platform] = livePageContext;
        else delete mergeSourcePageContexts[platform];
        const stateForMerge = {
          ...state,
          managedPageContextTabs: mergeSourcePageContexts,
        };
        const mergeSource = retainsHeartbeatAuthority
          ? {
              ...stateForMerge,
              sessions: {
                ...state.sessions,
                [platform]: {
                  ...nextSession,
                  lastHeartbeatAt: currentSession.lastHeartbeatAt,
                  lastHeartbeatOk: currentSession.lastHeartbeatOk,
                  heartbeatChecks: currentSession.heartbeatChecks,
                  tablessHeartbeat: currentCadence,
                },
              },
            }
          : stateForMerge;
        if (isCurrent?.() === false) return false;
        const merged = mergePlatformState(latest, mergeSource, platform);
        await saveOperationalStateDirect(merged);
        if (currentManagedPageContextTabsRevision() === pageContextRevision) {
          onPersisted?.(merged);
          return true;
        }
      }
    });
  }

  async function saveOperationalState(state: SchedulerState): Promise<void> {
    await withStateCommit(() => saveOperationalStateDirect(state));
  }

  async function saveOperationalStateDirect(state: SchedulerState): Promise<void> {
    const { events: _legacyEvents, ...operationalState } = state as SchedulerState & { events?: unknown };
    await deps.saveState(operationalState);
  }

  // Reports a single diagnostic immediately rather than collecting it into a
  // tick's event batch. Tick lifecycle lines must land as they happen: batching
  // them would defeat the point of timing a tick that is still running.
  function diagnosticEvent(
    level: "debug" | "info" | "warn",
    message: string,
    platform?: Platform,
    tickContext?: TickDiagnosticContext,
    data?: DiagnosticEvent["data"],
  ): void {
    void reportBestEffort([{
      category: "diagnostic",
      level,
      message,
      platform,
      ...tickContext,
      ...(data === undefined ? {} : { data }),
    }]);
  }

  async function reportBestEffort(events: readonly EngineEvent[]): Promise<void> {
    if (events.length === 0 || !deps.reportEvents) return;
    const correlateControllerRun = (events: readonly EngineEvent[]): EngineEvent[] =>
      events.map((event) =>
        event.category === "diagnostic"
          ? { ...event, controllerRunId }
          : event);
    const correlatedEvents = correlateControllerRun(events);
    if (correlatedEvents.some((event) => event.category === "diagnostic")) {
      controllerRunAnnouncement ??= (async () => {
        try {
          await deps.reportEvents?.([{
            category: "diagnostic",
            level: "debug",
            message: `Background controller run ${controllerRunLabel} started`,
            controllerRunId,
          }]);
        } catch {
          // Host event persistence/output is best-effort.
        }
      })();
      await controllerRunAnnouncement;
    }
    try {
      await deps.reportEvents(correlatedEvents);
    } catch {
      // Host event persistence/output is best-effort.
    }
  }

  function playbackEvents(
    platform: Platform,
    previous: PlaybackTelemetry | undefined,
    telemetry: Omit<PlaybackTelemetry, "platform" | "checkedAt">,
  ): DiagnosticEvent[] {
    const events: DiagnosticEvent[] = [];
    const log = (level: DiagnosticEvent["level"], message: string) => {
      events.push({ category: "diagnostic", platform, level, message });
    };

    if (telemetry.adActive && !previous?.adActive) {
      log("info", "Ad started; keeping the watch tab counting down");
    } else if (!telemetry.adActive && previous?.adActive) {
      log("debug", "Ad finished");
    }
    if (telemetry.blockedPlaybackCount > 0 && (previous?.blockedPlaybackCount ?? 0) === 0) {
      log("warn", `Playback was blocked for ${telemetry.blockedPlaybackCount} video(s); re-muted to keep farming`);
    }
    if (telemetry.videoCount === 0 && (previous?.videoCount ?? -1) !== 0) {
      log("warn", "No video element found in the watch tab");
    }
    if (telemetry.playingVideoCount !== (previous?.playingVideoCount ?? -1) || telemetry.videoCount !== (previous?.videoCount ?? -1)) {
      log("debug", `Playback telemetry: ${telemetry.playingVideoCount}/${telemetry.videoCount} videos playing${telemetry.documentHidden ? " (tab hidden)" : ""}`);
    }
    return events;
  }

  async function ensureAlarm(): Promise<void> {
    const settings = await deps.loadSettings();
    await ensureSchedulerAlarms(settings.pollIntervalMinutes);
    await deps.createAlarm(WATCH_ALARM_NAME, { periodInMinutes: 1 });
    if (settings.autoStartDropFarming && isFarmingActive(settings)) {
      await tick(undefined, "install");
    } else {
      await refreshAuthHealth(PLATFORMS, settings);
    }
  }

  async function ensureSchedulerAlarms(periodInMinutes: number): Promise<void> {
    await deps.clearAlarm?.(ALARM_NAME);
    await Promise.all([
      deps.createAlarm(TWITCH_ALARM_NAME, { periodInMinutes }),
      deps.createAlarm(KICK_ALARM_NAME, { periodInMinutes }),
    ]);
  }

  async function ensureInstalledAt(installedAt = new Date().toISOString()): Promise<void> {
    await withStateLock(async () => {
      const state = await deps.loadState();
      if (state.installedAt) return;
      await saveOperationalState({ ...state, installedAt });
    });
  }

  // On restart, autoStartDropFarming decides what happens to the platforms that
  // were farming: enabled means keep going, disabled means switch them off. It
  // used to clear a global `running` flag instead, which left the per-platform
  // flags set — so the popup showed everything off while a stale enabled flag
  // waited to resurrect a platform the moment the master switch came back.
  async function normalizeStartupSettings(): Promise<S> {
    return withSettingsLock(async () => {
      const settings = await deps.loadSettings();
      if (settings.autoStartDropFarming || !isFarmingActive(settings)) return settings;
      const nextSettings = {
        ...settings,
        platform: {
          ...settings.platform,
          twitch: { ...settings.platform.twitch, enabled: false },
          kick: { ...settings.platform.kick, enabled: false },
        },
      };
      await deps.saveSettings(nextSettings);
      return nextSettings;
    });
  }

  async function handleStartup(): Promise<void> {
    // A restart kills the watchers a handoff would transmit through, so leave
    // no loop running against them.
    abortClaimHandoffs();
    const settings = await deps.loadSettings();
    await ensureSchedulerAlarms(settings.pollIntervalMinutes);
    await deps.createAlarm(WATCH_ALARM_NAME, { periodInMinutes: 1 });
    // A restart kills any in-memory watchers; atomically release their lane
    // ownership before host cleanup, then let tick() rebuild fresh instances.
    await clearHeartbeatOwnership(PLATFORMS);

    const preservePageContexts = isFarmingActive(settings) && settings.autoStartDropFarming;
    const { state, cleanup } = await withStateLock(async () => {
      const state = await deps.loadState();
      registerManagedPageContextTabs(preservePageContexts ? state.managedPageContextTabs ?? {} : {});
      const cleanup = staleStartupCleanup(state, preservePageContexts);
      if (cleanup.hasStaleSession) {
        const restartEvents = farmingLifecycleEvents(state, cleanup.state);
        await persistAndReport(cleanup.state, restartEvents);
      }
      return { state, cleanup };
    });
    if (!cleanup.hasStaleSession) {
      const nextSettings = await normalizeStartupSettings();
      if (nextSettings.autoStartDropFarming && isFarmingActive(nextSettings)) {
        await tick(undefined, "startup");
      } else {
        await refreshAuthHealth(PLATFORMS, nextSettings, true);
      }
      return;
    }

    if (deps.closeManagedTabs && cleanup.managedTabs.length > 0) {
      await deps.closeManagedTabs(cleanup.managedTabs);
    }
    if (!preservePageContexts && deps.stopPageContextTabs && Object.keys(state.managedPageContextTabs ?? {}).length > 0) {
      await withEventCollector(async (emit, events) => {
        await deps.stopPageContextTabs!(state.managedPageContextTabs ?? {}, {
          platforms: ["twitch", "kick"],
          reason: "runtime_restart",
          emit,
        });
        await reportBestEffort(events);
      });
    }

    const nextSettings = await normalizeStartupSettings();

    if (isFarmingActive(nextSettings) && nextSettings.autoStartDropFarming) {
      await tick(undefined, "startup");
    } else {
      await refreshAuthHealth(PLATFORMS, nextSettings, true);
    }
  }

  async function snapshot(): Promise<RuntimeSnapshot<S>> {
    return {
      settings: await deps.loadSettings(),
      state: await deps.loadState(),
    };
  }

  function withSettingsLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = settingsMutation.then(operation, operation);
    settingsMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  async function updateStoredSettings(
    patch: SettingsPatch,
    afterPersist?: (settings: S) => void,
    afterLoad?: (settings: S) => void,
  ): Promise<S> {
    return withSettingsLock(async () => {
      const patchKeys = Object.keys(patch);
      const invalidatedPlatforms = patchKeys.every((key) => key === "platform") && patch.platform
        ? PLATFORMS.filter((platform) => patch.platform?.[platform] !== undefined)
        : PLATFORMS;
      for (const platform of invalidatedPlatforms) {
        discoveryLanes[platform].invalidate();
        invalidateSelection(platform);
      }
      if (!deps.applySettingsPatch) {
        throw new Error("applySettingsPatch dependency is required to mutate settings");
      }
      const current = await deps.loadSettings();
      afterLoad?.(current);
      const settings = deps.applySettingsPatch(current, patch);
      await deps.saveSettings(settings);
      afterPersist?.(settings);
      await ensureSchedulerAlarms(settings.pollIntervalMinutes);
      return settings;
    });
  }

  async function restoreTwitchIntegritySchedule(
    transitionIsCurrent: () => boolean,
  ): Promise<void> {
    await withStateLock(() => withEventCollector(async (emit, events) => {
      if (!integrityLifecycleOpen || !transitionIsCurrent()) return;
      let stored: TwitchIntegrity | undefined;
      try {
        stored = await deps.loadTwitchIntegrity?.();
      } catch {
        emit({
          category: "diagnostic",
          platform: "twitch",
          level: "debug",
          message: "Could not reload stored Twitch integrity after Twitch was enabled",
        });
      }
      if (!integrityLifecycleOpen || !transitionIsCurrent()) return;
      const integrity = reconcileStoredTwitchIntegrity(stored);
      if (integrity && transitionIsCurrent()) {
        await scheduleTwitchIntegrityRefreshBestEffort(integrity, emit);
      }
      await reportBestEffort(events);
    }));
  }

  async function probeAuthHealth(
    platform: Platform,
    adapter: PlatformAdapter,
    signal?: AbortSignal,
  ): Promise<PlatformAuthHealth> {
    // A probe must always resolve to a terminal status. If reading the session
    // cookies (or the adapter probe) throws, mapping it to "unavailable" here
    // keeps the failure from propagating into the tick, where a rollback would
    // strand the popup on "Checking your signed-in session…" indefinitely.
    const abort = new AbortController();
    let rejectCancelled: (reason?: unknown) => void = () => {};
    const cancelled = new Promise<PlatformAuthHealth>((_resolve, reject) => {
      rejectCancelled = reject;
    });
    const abortFromTick = () => {
      abort.abort(signal?.reason);
      rejectCancelled(signal?.reason);
    };
    signal?.throwIfAborted();
    signal?.addEventListener("abort", abortFromTick, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const terminalProbe = (async (): Promise<PlatformAuthHealth> => {
      try {
        const availability = await deps.checkCredentialAvailability?.(platform);
        if (availability?.status === "missing") {
          return {
            status: "missing_credentials",
            checkedAt: new Date().toISOString(),
            reasonCode: "credentials_missing",
            message: { key: "authMissingCredentials" },
          };
        }
        if (availability?.status === "unavailable") {
          return {
            status: "unavailable",
            checkedAt: new Date().toISOString(),
            reasonCode: "credential_lookup_failed",
            message: { key: "authCredentialLookupFailed" },
          };
        }
        return await adapter.checkAuthHealth(abort.signal);
      } catch {
        signal?.throwIfAborted();
        return {
          status: "unavailable",
          checkedAt: new Date().toISOString(),
          reasonCode: "credential_lookup_failed",
          message: { key: "authCredentialLookupFailed" },
        };
      }
    })();
    const timedOut = new Promise<PlatformAuthHealth>((resolve) => {
      timeout = setTimeout(() => {
        abort.abort();
        resolve({
          status: "unavailable",
          checkedAt: new Date().toISOString(),
          reasonCode: "network_unavailable",
          message: { key: "authNetworkUnavailable" },
        });
      }, deps.authProbeTimeoutMs ?? DEFAULT_AUTH_PROBE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([terminalProbe, timedOut, cancelled]);
    } finally {
      signal?.removeEventListener("abort", abortFromTick);
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async function persistAuthHealth(
    platform: Platform,
    health: PlatformAuthHealth,
    probeEvents: readonly EngineEvent[] = [],
    generation: number,
    tickContext?: TickDiagnosticContext,
  ): Promise<boolean> {
    return withStateLock(() => withEventCollector(async (emit, events) => {
      if (authRefreshGeneration[platform] !== generation) return false;
      events.push(...probeEvents);
      await withStateCommit(async () => {
        const state = await deps.loadState();
        const transition = applyPlatformAuthHealth(state, platform, health);
        if (transition.event) emit(transition.event);
        await saveOperationalStateDirect(transition.state);
      });
      if (health.status !== "healthy") {
        await stopDiscoverySignalController(platform, emit);
      }
      await reportBestEffort(tickContext
        ? correlateTickDiagnostics(events, tickContext)
        : events);
      return true;
    }), [platform]);
  }

  async function beginAuthRefresh(platforms: readonly Platform[]): Promise<Partial<Record<Platform, number>>> {
    return withStateLock(async () => {
      const generations: Partial<Record<Platform, number>> = {};
      for (const platform of platforms) {
        authRefreshGeneration[platform] += 1;
        generations[platform] = authRefreshGeneration[platform];
      }
      return generations;
    }, platforms);
  }

  function unavailableAfterAdapterSetup(): PlatformAuthHealth {
    return {
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      reasonCode: "platform_unavailable",
      message: { key: "authPlatformUnavailable" },
    };
  }

  function flattenedRefreshFailures(error: unknown): unknown[] {
    if (error instanceof AggregateError) {
      return error.errors.flatMap((failure) => flattenedRefreshFailures(failure));
    }
    return [error];
  }

  function throwRefreshFailures(results: PromiseSettledResult<void>[]): void {
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? flattenedRefreshFailures(result.reason) : []);
    if (failures.length === 0) return;
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "Authentication refresh failed");
  }

  async function refreshAuthHealth(
    platforms: Platform[],
    loadedSettings?: S,
    reportCompatibility = false,
    signal?: AbortSignal,
    tickContext?: TickDiagnosticContext,
    tickAdapters?: Partial<Record<Platform, TickAdapterHandle>>,
  ): Promise<void> {
    signal?.throwIfAborted();
    const lockStartedAt = Date.now();
    const generations = await beginAuthRefresh(platforms);
    const lockWaitMs = Date.now() - lockStartedAt;
    if (tickContext && lockWaitMs >= 50) {
      for (const platform of platforms) {
        diagnosticEvent(
          "debug",
          `Tick #${tickContext.platformTickId} waited ${lockWaitMs}ms for ${platformLabel(platform)} platform work`,
          platform,
          tickContext,
          { waitMs: lockWaitMs },
        );
      }
    }
    const settings = loadedSettings ?? await deps.loadSettings();
    const enabled = platforms.filter((platform) => settings.platform[platform].enabled);
    const results = await Promise.allSettled(enabled.map(async (platform) => {
      const result = await withEventCollector(async (emit, events) => {
        let setupFailure: AuthProbeSetupError | undefined;
        let health: PlatformAuthHealth;
        let adapter: PlatformAdapter | undefined;
        try {
          adapter = tickAdapters?.[platform]?.adapter(settings, emit, reportCompatibility)
            ?? createAdapter(platform, settings, emit, reportCompatibility);
        } catch (error) {
          setupFailure = new AuthProbeSetupError(
            platform,
            error instanceof Error ? error.message : "Adapter factory failed",
          );
        }
        try {
          health = adapter
            ? await probeAuthHealth(platform, adapter, signal)
            : unavailableAfterAdapterSetup();
        } finally {
          tickAdapters?.[platform]?.drain(emit);
        }
        return { health, events, setupFailure };
      });
      const generation = generations[platform];
      if (generation === undefined) return;
      signal?.throwIfAborted();
      let accepted: boolean;
      try {
        accepted = await persistAuthHealth(
          platform,
          result.health,
          result.events,
          generation,
          tickContext,
        );
      } catch (error) {
        if (result.setupFailure) {
          throw new AggregateError(
            [result.setupFailure, error],
            `${platform} authentication setup and persistence failed`,
          );
        }
        throw error;
      }
      if (accepted && result.setupFailure) throw result.setupFailure;
    }));
    throwRefreshFailures(results);
  }

  async function reportAuthSetupFailures(
    failures: readonly AuthProbeSetupError[],
    tickContext?: TickDiagnosticContext,
  ): Promise<void> {
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const state = await deps.loadState();
      for (const failure of failures) {
        emit({
          category: "activity",
          code: "interruption",
          level: "error",
          platform: failure.platform,
          data: { reason: "platform_error", detail: failure.message },
        });
        await stopDiscoverySignalController(failure.platform, emit);
      }
      await persistAndReport(
        state,
        tickContext ? correlateTickDiagnostics(events, tickContext) : events,
      );
    }));
  }

  async function prepareTwitchIntegrity(
    settings: S,
    signal: AbortSignal,
    tickContext: TickDiagnosticContext,
  ): Promise<boolean> {
    const ensureTwitchIntegrity = deps.ensureTwitchIntegrity;
    if (!settings.platform.twitch.enabled || !ensureTwitchIntegrity) return true;
    return withEventCollector(async (emit, events) => {
      const lifecycleGeneration = integrityLifecycleGeneration;
      const due = twitchIntegrityRefreshDue;
      try {
        const ready = await ensureTwitchIntegrity(emit, {
          signal,
          reason: due ? "proactive_refresh" : "readiness",
          onManagedPageContextOpen: () => recordTwitchIntegrityManagedTabOpen(
            due ? "proactive_integrity_refresh" : "integrity_readiness",
            tickContext,
          ),
          ...(due
            ? {
                forceRefresh: true,
                ...(due.rejectedToken ? { rejectedToken: due.rejectedToken } : {}),
              }
            : {}),
        });
        if (!ready) {
          emit({
            category: "diagnostic",
            platform: "twitch",
            level: "warn",
            message: "No valid Twitch integrity token; delaying authenticated Twitch work until the next normal scheduler alarm",
          });
        }
        return ready;
      } catch {
        signal.throwIfAborted();
        const currentSettings = await deps.loadSettings();
        if (
          lifecycleGeneration !== integrityLifecycleGeneration
          || !integrityLifecycleOpen
          || !currentSettings.platform.twitch.enabled
        ) {
          emit({
            category: "diagnostic",
            platform: "twitch",
            level: "debug",
            message: "Twitch integrity acquisition was cancelled because Twitch stopped; continuing other platform work",
          });
          return false;
        }
        emit({
          category: "diagnostic",
          platform: "twitch",
          level: "warn",
          message: "No valid Twitch integrity token; delaying authenticated Twitch work until the next normal scheduler alarm",
        });
        return false;
      } finally {
        await reportBestEffort(correlateTickDiagnostics(events, tickContext));
      }
    });
  }

  // Every tick is bracketed by a start/finish diagnostic carrying its trigger and
  // elapsed time. A tick that succeeds otherwise emits nothing about itself, which
  // makes a slow one indistinguishable from an idle gap in an exported log.
  let globalTickSequence = 0;
  const platformTickSequence: Record<Platform, number> = {
    twitch: 0,
    kick: 0,
  };
  // Chain of detached ticks, drained by settleBackgroundWork().
  let backgroundWork: Promise<unknown> = Promise.resolve();
  const discoverySignalRefreshRunning: Record<Platform, boolean> = {
    twitch: false,
    kick: false,
  };
  type DiscoverySignalRefreshRequest = {
    controller: DiscoverySignalController;
    generation: number;
  };
  const discoverySignalRefreshPending: Record<Platform, DiscoverySignalRefreshRequest | undefined> = {
    twitch: undefined,
    kick: undefined,
  };
  const discoverySignalAuthRefreshes: Record<Platform, number> = {
    twitch: 0,
    kick: 0,
  };
  const discoverySignalAdmissionGeneration: Record<Platform, number> = {
    twitch: 0,
    kick: 0,
  };
  const activeTicks = new Set<AbortController>();
  const activePlatformTicks: Record<Platform, number> = {
    twitch: 0,
    kick: 0,
  };

  async function tick(
    platforms?: Platform[],
    trigger: TickTrigger = "unknown",
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<ClaimedRewards> {
    const requestedPlatforms = platforms ?? PLATFORMS;
    const settled = await Promise.allSettled(requestedPlatforms.map((platform) =>
      tickPlatform(platform, trigger, onPersisted)));
    const failures = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Platform scheduler ticks failed");
    }
    return settled.reduce<ClaimedRewards>((claimed, result) => {
      if (result.status !== "fulfilled") return claimed;
      const [platform, rewards] = result.value;
      if (rewards.length > 0) claimed[platform] = rewards;
      return claimed;
    }, {});
  }

  async function refreshDiscovery(
    platforms: Platform[] = PLATFORMS,
    bypassBackoff = false,
    tickAdapters?: Partial<Record<Platform, TickAdapterHandle>>,
  ): Promise<void> {
    if (controllerShutdown) return;
    const settings = await deps.loadSettings();
    await Promise.all(platforms.map(async (platform) => {
      if (bypassBackoff) discoveryBackoffBypasses[platform] += 1;
      try {
        if (!settings.platform[platform].enabled) {
          discoveryLanes[platform].invalidate();
          invalidateSelection(platform);
          return;
        }
        await discoveryLanes[platform].requestAndWait(tickAdapters?.[platform]);
      } finally {
        if (bypassBackoff) discoveryBackoffBypasses[platform] -= 1;
      }
    }));
  }

  function discoverySnapshot(platform: Platform): Readonly<DiscoverySnapshotState> {
    return discoveryLanes[platform].current();
  }

  function selectionKey(platform: Platform, snapshot: DiscoverySnapshot, settings: S, state: SchedulerState): string {
    const session = state.sessions[platform];
    return JSON.stringify({
      discovery: {
        campaigns: snapshot.campaigns.map(({ campaign, candidates }) => ({
          campaign,
          candidates: candidates.map(({ observedAt: _observedAt, ...candidate }) => candidate),
        })),
        idleCandidates: snapshot.idleCandidates.map(({ observedAt: _observedAt, ...candidate }) => candidate),
        followedChannels: snapshot.followedChannels,
      },
      persistedCampaigns: state.campaigns[platform],
      campaignSearchBackoff: state.campaignSearchBackoffs?.[platform],
      settings,
      target: {
        status: session.status,
        channel: session.channel,
        campaignId: session.campaignId,
        rewardId: session.rewardId,
        watchMode: session.watchMode,
        offlineChecks: session.offlineChecks,
        playbackHealthy: session.playback ? isPlaybackTelemetryHealthy(session.playback) : undefined,
        playbackChecks: session.playbackChecks,
        heartbeatChecks: session.heartbeatChecks,
        lastHeartbeatOk: session.lastHeartbeatOk,
        noProgressChecks: session.noProgressChecks,
        lastWatchedMinutes: session.lastWatchedMinutes,
      },
    });
  }

  function selectionIsForced(trigger: TickTrigger): boolean {
    return trigger === "manual_tick" || trigger === "manual_resume" || trigger === "claim_handoff" || trigger === "startup";
  }

  function selectionBypassesBackoff(trigger: TickTrigger): boolean {
    return trigger === "manual_tick" || trigger === "manual_resume" || trigger === "claim_handoff";
  }

  function selectionBackoffDue(platform: Platform, state: SchedulerState): boolean {
    const retryAt = state.campaignSearchBackoffs?.[platform]?.retryAt;
    return retryAt !== undefined && Date.parse(retryAt) <= Date.now();
  }

  function invalidateSelection(platform: Platform): void {
    selectionGeneration[platform] += 1;
    delete selectionCache[platform];
    delete pendingSelections[platform];
  }

  async function evaluateSelection(input: SelectionInput): Promise<CommittedSelection> {
    const startedAt = Date.now();
    const result = await (deps.selectWatchTarget ?? selectWatchTargetFromSnapshot)({
      snapshot: input.snapshot,
      previous: input.state.sessions[input.platform],
      previousCampaigns: input.state.campaigns[input.platform],
      settings: input.settings,
      signal: input.signal,
      previousBackoff: input.state.campaignSearchBackoffs?.[input.platform],
      bypassBackoff: selectionBypassesBackoff(input.trigger),
    });
    discoveryEvents[input.platform].push({
      category: "diagnostic",
      platform: input.platform,
      level: "debug",
      message: `Snapshot selection finished in ${Date.now() - startedAt}ms (trigger=${input.trigger}, revision=${input.snapshot.revision}, age=${Math.max(0, Date.now() - input.snapshot.observedAt)}ms, material=${selectionCache[input.platform]?.key !== input.key}, campaigns=${result.campaignsChecked}, candidates=${result.candidatesChecked}, outcome=${result.decision.action}, retention=${result.retention.reasonCode})`,
    });
    if (result.backoffSkippedMs !== undefined && result.backoff) {
      discoveryEvents[input.platform].push({
        category: "diagnostic",
        platform: input.platform,
        level: "debug",
        message: `Skipped authoritative negative campaign search for ${result.backoff.campaignId} (${result.backoffSkippedMs}ms remaining)`,
      });
    } else if (result.backoff && input.state.campaignSearchBackoffs?.[input.platform]?.fingerprint !== result.backoff.fingerprint) {
      discoveryEvents[input.platform].push({
        category: "diagnostic",
        platform: input.platform,
        level: "debug",
        message: `Authoritative negative campaign search for ${result.backoff.campaignId}; retry at ${result.backoff.retryAt}`,
      });
    }
    return { key: input.key, snapshotRevision: input.snapshot.revision, generation: input.generation, result };
  }

  async function prepareSelection(input: SelectionInput): Promise<CommittedSelection> {
    const cached = selectionCache[input.platform];
    if (!input.force && cached?.key === input.key && cached.generation === input.generation) {
      discoveryEvents[input.platform].push({
        category: "diagnostic",
        platform: input.platform,
        level: "debug",
        message: `Snapshot selection skipped (trigger=${input.trigger}, revision=${input.snapshot.revision}, age=${Math.max(0, Date.now() - input.snapshot.observedAt)}ms, material=false)`,
      });
      const retryAt = cached.result.backoff ? Date.parse(cached.result.backoff.retryAt) : Number.NaN;
      if (cached.result.backoff && Number.isFinite(retryAt) && retryAt > Date.now()) {
        discoveryEvents[input.platform].push({
          category: "diagnostic",
          platform: input.platform,
          level: "debug",
          message: `Skipped authoritative negative campaign search for ${cached.result.backoff.campaignId} (${retryAt - Date.now()}ms remaining)`,
        });
      }
      const reused = {
        ...cached,
        snapshotRevision: input.snapshot.revision,
        generation: input.generation,
      };
      selectionCache[input.platform] = reused;
      return reused;
    }
    const running = selectionRuns[input.platform];
    if (running) {
      pendingSelections[input.platform] = input;
      return running;
    }
    const run = (async () => {
      let current = input;
      while (true) {
        const evaluated = await evaluateSelection(current);
        const pending = pendingSelections[current.platform];
        delete pendingSelections[current.platform];
        if (!pending) {
          if (current.generation === selectionGeneration[current.platform]) {
            selectionCache[current.platform] = evaluated;
          } else {
            discoveryEvents[current.platform].push({
              category: "diagnostic",
              platform: current.platform,
              level: "debug",
              message: `Snapshot selection discarded stale lifecycle work (trigger=${current.trigger}, revision=${current.snapshot.revision})`,
            });
          }
          return evaluated;
        }
        discoveryEvents[current.platform].push({
          category: "diagnostic",
          platform: current.platform,
          level: "debug",
          message: `Snapshot selection discarded stale work (trigger=${current.trigger}, revision=${current.snapshot.revision})`,
        });
        current = pending;
      }
    })();
    selectionRuns[input.platform] = run;
    try {
      return await run;
    } finally {
      if (selectionRuns[input.platform] === run) delete selectionRuns[input.platform];
    }
  }

  function selectionAlreadyCommitted(
    prepared: CommittedSelection,
    snapshot: DiscoverySnapshot,
    state: SchedulerState,
    platform: Platform,
  ): SnapshotSelectionResult | undefined {
    if (prepared.snapshotRevision !== snapshot.revision) return undefined;
    if (prepared.generation !== selectionGeneration[platform]) return undefined;
    const session = state.sessions[platform];
    const decision = prepared.result.decision;
    const action = session.status === "watching"
      ? session.campaignId ? "watch" : "fallback"
      : "idle";
    if (action !== decision.action
      || session.campaignId !== decision.campaign?.id
      || session.rewardId !== decision.reward?.id
      || session.channel?.url !== decision.channel?.url) return undefined;
    return {
      ...prepared.result,
      decision: {
        ...decision,
        reason: "Keeping already committed snapshot selection",
        reasonCode: "keeping_current_watch",
      },
      retention: {
        keep: true,
        offlineChecks: session.offlineChecks,
        playbackChecks: session.playbackChecks ?? 0,
        noProgressChecks: session.noProgressChecks,
        lastWatchedMinutes: session.lastWatchedMinutes,
        channel: session.channel,
        reason: "Keeping already committed snapshot selection",
        reasonCode: "keeping_current_watch",
      },
      campaignsChecked: 0,
      candidatesChecked: 0,
      fastPath: true,
    };
  }

  async function tickPlatform(
    platform: Platform,
    trigger: TickTrigger,
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<readonly [Platform, string[]]> {
    const abort = new AbortController();
    activeTicks.add(abort);
    activePlatformTicks[platform] += 1;
    const tickContext: TickDiagnosticContext = {
      globalTickId: ++globalTickSequence,
      platformTickId: ++platformTickSequence[platform],
    };
    const tickStartedAt = Date.now();
    diagnosticEvent(
      "debug",
      `Tick #${tickContext.platformTickId} started (trigger=${trigger}, platforms=${platform})`,
      platform,
      tickContext,
    );
    try {
      const claimed = await runTick(tickContext, [platform], abort.signal, trigger, onPersisted);
      return [platform, claimed[platform] ?? []];
    } catch (error) {
      if (abort.signal.aborted) return [platform, []];
      throw error;
    } finally {
      activeTicks.delete(abort);
      activePlatformTicks[platform] -= 1;
      if (activePlatformTicks[platform] === 0) startPendingDiscoverySignalRefresh(platform);
      diagnosticEvent(
        "debug",
        `Tick #${tickContext.platformTickId} finished after ${Date.now() - tickStartedAt}ms (trigger=${trigger}, platforms=${platform})`,
        platform,
        tickContext,
      );
    }
  }

  async function runTick(
    tickContext: TickDiagnosticContext,
    platforms: Platform[] | undefined,
    signal: AbortSignal,
    trigger: TickTrigger,
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<ClaimedRewards> {
    const claimedRewards: ClaimedRewards = {};
    const settings = await deps.loadSettings();
    const requestedPlatforms = platforms ?? PLATFORMS;
    const tickAdapters = Object.fromEntries(requestedPlatforms.map((platform) =>
      [platform, createTickAdapterHandle(platform)])) as Partial<Record<Platform, TickAdapterHandle>>;
    const excludedPlatforms = new Set<Platform>();
    if (isFarmingActive(settings)) {
      if (requestedPlatforms.includes("twitch")) {
        const twitchReady = await prepareTwitchIntegrity(settings, signal, tickContext);
        if (!twitchReady) excludedPlatforms.add("twitch");
      }
      const authPlatforms = requestedPlatforms.filter((platform) => !excludedPlatforms.has(platform));
      if (authPlatforms.length > 0) {
        const authStartedAt = Date.now();
        try {
          await refreshAuthHealth(
            authPlatforms,
            settings,
            false,
            signal,
            tickContext,
            tickAdapters,
          );
          for (const platform of authPlatforms) {
            diagnosticEvent(
              "debug",
              `Tick #${tickContext.platformTickId} refreshed auth health in ${Date.now() - authStartedAt}ms`,
              platform,
              tickContext,
            );
          }
        } catch (error) {
          const failures = flattenedRefreshFailures(error);
          const setupFailures = failures.filter((failure): failure is AuthProbeSetupError =>
            failure instanceof AuthProbeSetupError);
          if (setupFailures.length === 0) throw error;
          for (const failure of setupFailures) excludedPlatforms.add(failure.platform);
          let reportingFailure: unknown;
          try {
            await reportAuthSetupFailures(setupFailures, tickContext);
          } catch (failure) {
            reportingFailure = failure;
          }
          const nonSetupFailures = failures.filter((failure) => !(failure instanceof AuthProbeSetupError));
          if (nonSetupFailures.length > 0) {
            if (reportingFailure !== undefined) {
              throw new AggregateError(
                [...failures, reportingFailure],
                "Authentication refresh and interruption persistence failed",
              );
            }
            throw error;
          }
          if (reportingFailure !== undefined) throw reportingFailure;
        }
      }
    }
    const schedulerPlatforms = requestedPlatforms.filter((platform) =>
      !excludedPlatforms.has(platform));
    if (schedulerPlatforms.length === 0) return claimedRewards;
    const currentState = await withStateCommit(() => deps.loadState());
    const discoveryPlatforms = schedulerPlatforms.filter((platform) =>
      currentState.authHealth[platform].status === "healthy");
    await refreshDiscovery(discoveryPlatforms, selectionBypassesBackoff(trigger), tickAdapters);
    signal.throwIfAborted();
    const preparedSelections: Partial<Record<Platform, CommittedSelection>> = {};
    const pageContextObservations: Partial<Record<Platform, import("../platforms/adapter").KickPageContextCycleObservation>> = {};
    const pageContextObservationRevisions: Partial<Record<Platform, number>> = {};
    await Promise.all(discoveryPlatforms.map(async (selectionPlatform) => {
      const snapshot = discoveryLanes[selectionPlatform].current().snapshot;
      if (!snapshot) return;
      const input: SelectionInput = {
        platform: selectionPlatform,
        trigger,
        snapshot,
        settings,
        state: currentState,
        key: selectionKey(selectionPlatform, snapshot, settings, currentState),
        force: selectionIsForced(trigger) || selectionBackoffDue(selectionPlatform, currentState),
        signal,
        generation: selectionGeneration[selectionPlatform],
      };
      preparedSelections[selectionPlatform] = await prepareSelection(input);
    }));
    signal.throwIfAborted();
    const platform = schedulerPlatforms[0];
    await withStateLock(() => withEventCollector(async (emit, events) => {
      signal.throwIfAborted();
      const settings = await deps.loadSettings();
      const state = await deps.loadState();
      const nextWaitingClaimRewardIds: Record<Platform, Set<string>> = {
        twitch: new Set(waitingClaimRewardIds.twitch),
        kick: new Set(waitingClaimRewardIds.kick),
      };
      let nextState: SchedulerState;
      let publicationLeases: Array<readonly [Platform, HeartbeatPublicationLease]> = [];
      try {
        const adapters = Object.fromEntries(schedulerPlatforms.map((schedulerPlatform) => [
          schedulerPlatform,
          tickAdapters[schedulerPlatform]!.adapter(settings, emit, true),
        ])) as Record<Platform, PlatformAdapter>;
        for (const discoveryPlatform of schedulerPlatforms) {
          adapters[discoveryPlatform] = adapterFromDiscoverySnapshot(
            adapters[discoveryPlatform],
            discoveryLanes[discoveryPlatform].current().snapshot,
            state.sessions[discoveryPlatform],
          );
        }
        const selections: Partial<Record<Platform, SnapshotSelectionResult>> = {};
        for (const selectionPlatform of schedulerPlatforms) {
          const snapshot = discoveryLanes[selectionPlatform].current().snapshot;
          if (!snapshot) continue;
          const key = selectionKey(selectionPlatform, snapshot, settings, state);
          let prepared = preparedSelections[selectionPlatform];
          if (!prepared || prepared.key !== key || prepared.snapshotRevision !== snapshot.revision) {
            const committed = prepared
              ? selectionAlreadyCommitted(prepared, snapshot, state, selectionPlatform)
              : undefined;
            if (committed) {
              selections[selectionPlatform] = committed;
              continue;
            }
            if (prepared) {
              discoveryEvents[selectionPlatform].push({
                category: "diagnostic",
                platform: selectionPlatform,
                level: "debug",
                message: `Snapshot selection discarded before commit (trigger=${trigger}, revision=${prepared.snapshotRevision})`,
              });
            }
            prepared = await prepareSelection({
              platform: selectionPlatform,
              trigger,
              snapshot,
              settings,
              state,
              key,
              force: selectionBackoffDue(selectionPlatform, state),
              signal,
              generation: selectionGeneration[selectionPlatform],
            });
          }
          preparedSelections[selectionPlatform] = prepared;
          if (prepared.generation !== selectionGeneration[selectionPlatform]) {
            discoveryEvents[selectionPlatform].push({
              category: "diagnostic",
              platform: selectionPlatform,
              level: "debug",
              message: `Snapshot selection discarded before commit after lifecycle change (trigger=${trigger}, revision=${prepared.snapshotRevision})`,
            });
            continue;
          }
          selections[selectionPlatform] = prepared.result;
        }
        const selectionsAreCurrent = (): boolean => schedulerPlatforms.every((selectionPlatform) => {
          const prepared = preparedSelections[selectionPlatform];
          const snapshot = discoveryLanes[selectionPlatform].current().snapshot;
          return !prepared || (prepared.generation === selectionGeneration[selectionPlatform]
            && prepared.snapshotRevision === snapshot?.revision);
        });
        const staleSelection = new Error("Snapshot selection lifecycle changed before publication");
        const assertSelectionsCurrent = (): void => {
          if (!selectionsAreCurrent()) throw staleSelection;
        };
        // Observed here rather than returned by the scheduler: the controller
        // already sees every emitted event, and the post-claim handoff only
        // needs to know which platforms claimed.
        const claimObservingEmit: EventEmitter = (event) => {
          if (event.category === "activity" && event.code === "reward_claimed" && event.platform) {
            (claimedRewards[event.platform] ??= []).push(event.data.rewardId);
          }
          emit(event);
        };
        const eventsBeforeTick = events.length;
        for (const discoveryPlatform of schedulerPlatforms) {
          for (const event of discoveryEvents[discoveryPlatform].splice(0)) claimObservingEmit(event);
        }
        const result = await runSchedulerTick(state, settings, adapters, {
          platforms: schedulerPlatforms,
          stopPageContextTabs: deps.stopPageContextTabs,
          waitingClaimRewardIds: nextWaitingClaimRewardIds,
          emit: claimObservingEmit,
          signal,
          campaignEvaluationFingerprints,
          selections,
          selectionIsCurrent: Object.fromEntries(schedulerPlatforms.map((selectionPlatform) => {
            const prepared = preparedSelections[selectionPlatform];
            return [selectionPlatform, () => prepared?.generation === selectionGeneration[selectionPlatform]];
          })),
          discovery: Object.fromEntries(schedulerPlatforms.map((discoveryPlatform) => {
            const discoveryState = discoveryLanes[discoveryPlatform].current();
            return [discoveryPlatform, {
              campaigns: discoveryState.snapshot?.campaigns.map(({ campaign }) => campaign)
                ?? state.campaigns[discoveryPlatform],
              complete: discoveryState.snapshot !== undefined,
            }];
          })),
        });
        signal.throwIfAborted();
        assertSelectionsCurrent();
        const lifecycleEvents = farmingLifecycleEvents(state, result.state);
        for (const event of lifecycleEvents) emit(event);
        await emitNotifications(settings, state, result.state, result.events);
        signal.throwIfAborted();
        assertSelectionsCurrent();
        await applyAdFocusForState(result.state, emit, schedulerPlatforms);
        signal.throwIfAborted();
        assertSelectionsCurrent();
        publicationLeases = await reconcileTablessWatchers(
          result.state,
          settings,
          adapters,
          emit,
          schedulerPlatforms,
        );
        signal.throwIfAborted();
        assertSelectionsCurrent();
        await reconcileDiscoverySignalControllers(result.state, settings, adapters, emit, schedulerPlatforms);
        for (const schedulerPlatform of schedulerPlatforms) tickAdapters[schedulerPlatform]?.drain(claimObservingEmit);
        signal.throwIfAborted();
        assertSelectionsCurrent();
        for (const schedulerPlatform of schedulerPlatforms) {
          const observation = adapters[schedulerPlatform].consumePageContextCycleObservation?.();
          const prepared = preparedSelections[schedulerPlatform];
          if (observation && prepared) {
            pageContextObservations[schedulerPlatform] = observation;
            pageContextObservationRevisions[schedulerPlatform] = prepared.snapshotRevision;
          }
        }
        nextState = result.state;
        if (settings.criticalFailurePromptEnabled) {
          // Page-context tabs are created deep inside tabs.ts, which has no access
          // to scheduler state, and their events come from the adapters' own
          // emitter rather than the tick's. Reading them back off this tick's
          // collected events catches every emitter, not just the wrapped one.
          for (const event of events.slice(eventsBeforeTick)) {
            if (event.category !== "activity" || event.code !== "page_context_opened") continue;
            const transition = recordManagedTabOpen(nextState, event.platform, Date.now(), {
              source: "page_context",
              reason: event.data.reason,
            });
            nextState = transition.state;
            if (transition.event) emit(transition.event);
          }
          // Keep the registry that gates page-context creation in step with the
          // state we are about to persist, so the very next fetch is suppressed.
          syncManagedTabBreakers(nextState, schedulerPlatforms);
        }
      } catch (error) {
        // The tick was rolled back, so any partial claim set is not actionable.
        for (const key of Object.keys(claimedRewards) as Platform[]) delete claimedRewards[key];
        clearOperationalEvents(events);
        try {
          if (signal.aborted) return;
          if (error instanceof Error && error.message === "Snapshot selection lifecycle changed before publication") {
            await applyAdFocusForState(state, emit, schedulerPlatforms);
            publicationLeases.push(...await reconcileTablessWatchers(
              state,
              settings,
              Object.fromEntries(schedulerPlatforms.map((schedulerPlatform) => [
                schedulerPlatform,
                tickAdapters[schedulerPlatform]!.adapter(settings, emit, true),
              ])) as Record<Platform, PlatformAdapter>,
              emit,
              schedulerPlatforms,
            ));
            emit({ category: "diagnostic", level: "debug", platform, message: error.message });
            await reportBestEffort(correlateTickDiagnostics(events, tickContext));
            return;
          }
          const detail = error instanceof Error ? error.message : "Scheduler tick failed";
          emit({ category: "activity", code: "interruption", level: "error", platform, data: { reason: "platform_error", detail } });
          emit({ category: "diagnostic", level: "error", platform, message: detail });
          await persistPlatformAndReport(platform, state, correlateTickDiagnostics(events, tickContext));
        } finally {
          await Promise.all(publicationLeases.map(([leasePlatform, lease]) =>
            releaseHeartbeatPublicationLease(leasePlatform, lease)));
        }
        return;
      }
      try {
        const persisted = await persistPlatformAndReport(
          platform,
          nextState,
          correlateTickDiagnostics(events, tickContext),
          () => schedulerPlatforms.every((selectionPlatform) => {
            const prepared = preparedSelections[selectionPlatform];
            const snapshot = discoveryLanes[selectionPlatform].current().snapshot;
            return !prepared || (prepared.generation === selectionGeneration[selectionPlatform]
              && prepared.snapshotRevision === snapshot?.revision);
          }),
          onPersisted,
        );
        if (!persisted) return;
        for (const schedulerPlatform of schedulerPlatforms) {
          const observation = pageContextObservations[schedulerPlatform];
          const snapshotRevision = pageContextObservationRevisions[schedulerPlatform];
          if (snapshotRevision === undefined || !observation || !deps.reconcilePageContextRecovery
            || reconciledPageContextSnapshotRevision[schedulerPlatform] === snapshotRevision) continue;
          await withEventCollector(async (recoveryEmit, recoveryEvents) => {
            try {
              await deps.reconcilePageContextRecovery!(schedulerPlatform, observation, settings, recoveryEmit);
              reconciledPageContextSnapshotRevision[schedulerPlatform] = snapshotRevision;
              await persistPlatformState(schedulerPlatform, nextState);
            } catch (error) {
              recoveryEmit({
                category: "diagnostic",
                level: "debug",
                platform: schedulerPlatform,
                message: `Page-context recovery reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
            await reportBestEffort(correlateTickDiagnostics(recoveryEvents, tickContext));
          });
        }
        waitingClaimRewardIds[platform].clear();
        for (const rewardId of nextWaitingClaimRewardIds[platform]) {
          waitingClaimRewardIds[platform].add(rewardId);
        }
      } finally {
        await Promise.all(publicationLeases.map(([leasePlatform, lease]) =>
          releaseHeartbeatPublicationLease(leasePlatform, lease)));
      }
    }), schedulerPlatforms);
    return claimedRewards;
  }

  async function checkAuthHealth(platform: Platform): Promise<void> {
    const releaseDiscoverySignalAuthRefresh = reserveDiscoverySignalAuthRefresh(platform);
    try {
      await refreshAuthHealth([platform]);
    } finally {
      releaseDiscoverySignalAuthRefresh();
    }
  }

  async function invalidateAuthHealth(platform: Platform): Promise<void> {
    discoveryLanes[platform].invalidate();
    invalidateSelection(platform);
    const releaseDiscoverySignalAuthRefresh = reserveDiscoverySignalAuthRefresh(platform);
    try {
      const generations = await beginAuthRefresh([platform]);
      const generation = generations[platform];
      const settings = await deps.loadSettings();
      if (!settings.platform[platform].enabled) return;
      await withStateLock(() => withEventCollector(async (emit, events) => {
        if (generation === undefined || authRefreshGeneration[platform] !== generation) return;
        const state = await deps.loadState();
        const transition = applyPlatformAuthHealth(state, platform, { status: "checking" });
        if (transition.event) emit(transition.event);
        await saveOperationalState(transition.state);
        await stopDiscoverySignalController(platform, emit);
        await reportBestEffort(events);
      }));
    } finally {
      releaseDiscoverySignalAuthRefresh();
    }
  }

  async function handleTabRemoved(tabId: number): Promise<void> {
    // Serialize the load-modify-persist under the state lock so it cannot race a
    // concurrent tick()/heartbeat (both fire on a ~1-minute cadence while the
    // user can close a tab at any moment). A removal never runs the scheduler
    // directly (#193): it only records state, and the next ordinary alarm reads
    // it. Closing a tab LurkLoot owns now records a per-platform pause, so the
    // alarm keeps the platform paused instead of reopening the tab a minute
    // later. The user's enabled/running settings are deliberately untouched;
    // the popup shows the pause with a one-click resume.
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const state = await deps.loadState();
      const manualPlatforms = (["twitch", "kick"] as Platform[]).filter((platform) => state.manualWatch?.[platform]?.tabId === tabId);
      let nextState = state;
      if (manualPlatforms.length > 0) {
        const manualWatch = { ...state.manualWatch };
        for (const platform of manualPlatforms) delete manualWatch[platform];
        nextState = {
          ...state,
          manualWatch,
        };
      }

      const closedManagedPlatforms: Platform[] = [];
      for (const platform of PLATFORMS) {
        const session = state.sessions[platform];
        if (
          session.status === "watching"
          && session.tabManagedByExtension
          && session.tabId === tabId
        ) {
          closedManagedPlatforms.push(platform);
          emit({ category: "diagnostic", platform, level: "info", message: "Managed watch tab was closed manually; pausing farming for this platform until the user resumes" });
        }
      }

      if (closedManagedPlatforms.length > 0) {
        const closedAt = new Date().toISOString();
        const sessions = { ...nextState.sessions };
        const managedWatchTabs = { ...nextState.managedWatchTabs };
        const manualClosePause = { ...nextState.manualClosePause };
        for (const platform of closedManagedPlatforms) {
          sessions[platform] = {
            platform,
            status: "paused",
            offlineChecks: 0,
            message: "Farming tab closed",
            reasonCode: "manual_tab_close",
          };
          delete managedWatchTabs[platform];
          const channelUrl = state.managedWatchTabs?.[platform]?.channelUrl ?? state.sessions[platform].channel?.url;
          manualClosePause[platform] = {
            platform,
            closedAt,
            ...(channelUrl ? { channelUrl } : {}),
          };
        }
        nextState = { ...nextState, sessions, managedWatchTabs, manualClosePause };
        await stopDiscoverySignalControllers(closedManagedPlatforms, emit);
      }

      if (nextState !== state || events.length > 0) await persistAndReport(nextState, events);
    }));
  }

  // Explicit user action: clears the manual-close pause so the next tick may
  // farm this platform again. Only the user can undo the gesture they made.
  async function resumeAfterManualClose(platform: Platform): Promise<void> {
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const state = await deps.loadState();
      if (!state.manualClosePause?.[platform]) {
        await reportBestEffort(events);
        return;
      }
      const manualClosePause = { ...state.manualClosePause };
      delete manualClosePause[platform];
      emit({ category: "diagnostic", platform, level: "info", message: "Resuming farming after a manual watch tab close" });
      await persistAndReport({ ...state, manualClosePause }, events);
    }));
  }

  function tablessWatchContext(): WatchContext {
    // The Twitch watcher resolves the viewer id itself; nothing extra needed yet.
    return {};
  }

  // Aligns the live tabless watchers with the scheduler's session state: starts
  // or switches a watcher for each platform farming tablessly, and stops the
  // rest (idle, paused, fell back to a tab, or watching with a real tab).
  async function reconcileTablessWatchers(
    state: SchedulerState,
    settings: EngineSettings,
    adapters: Record<Platform, PlatformAdapter>,
    emit: EventEmitter,
    platforms?: Platform[],
  ): Promise<Array<readonly [Platform, HeartbeatPublicationLease]>> {
    const targets = platforms ?? PLATFORMS;
    const publicationLeases: Array<readonly [Platform, HeartbeatPublicationLease]> = [];
    for (const platform of targets) {
      const session = state.sessions[platform];
      const adapter = adapters[platform];
      const wantsTabless = settings.platform[platform].enabled
        && state.authHealth[platform].status === "healthy"
        && session.status === "watching"
        && session.watchMode === "tabless"
        && Boolean(session.channel);
      const contextKey = heartbeatContextKey(session);
      const ownership = await withHeartbeatLane(platform, async (lane) => {
        const committed = lane.committed;
        const watcher = committed?.watcher ?? tablessWatchers.get(platform);
        const keepsCommittedContext = wantsTabless
          && adapter.createTablessWatcher !== undefined
          && contextKey !== undefined
          && committed?.contextKey === contextKey;
        const needsPublicationLease = keepsCommittedContext
          ? false
          : (wantsTabless && adapter.createTablessWatcher !== undefined) || watcher !== undefined;
        let publicationLease: HeartbeatPublicationLease | undefined;
        if (needsPublicationLease) {
          publicationLease = lane.publicationLease;
          if (!publicationLease) {
            publicationLease = newHeartbeatPublicationLease();
            lane.publicationLease = publicationLease;
            // Invalidate recovery that captured storage before this handoff
            // started. The lease remains held until scheduler persistence.
            lane.revision += 1;
          }
        }
        return {
          revision: lane.revision,
          committed,
          watcher,
          publicationLease,
        };
      });
      if (ownership.publicationLease) {
        publicationLeases.push([platform, ownership.publicationLease]);
      }
      const existing = ownership.watcher;

      try {
        if (wantsTabless && session.channel && adapter.createTablessWatcher) {
          const changingContext = ownership.committed != null
            && ownership.committed.contextKey !== contextKey;
          const watcher = !existing || changingContext
            ? adapter.createTablessWatcher()
            : existing;
          const created = watcher !== existing;
          drainWatcherEvents(watcher, emit);
          if (watcher.channelUrl !== session.channel.url) {
            let startFailed = false;
            let startError: unknown;
            try {
              await watcher.start(session.channel, tablessWatchContext());
            } catch (error) {
              startFailed = true;
              startError = error;
            } finally {
              drainWatcherEvents(watcher, emit);
            }
            if (startFailed) {
              emit({
                category: "diagnostic",
                platform,
                level: "warn",
                message: startError instanceof Error ? startError.message : "Could not start the tabless watcher",
              });
            }
          }
          const publication = await commitHeartbeatContext(
            platform,
            session,
            watcher,
            ownership.revision,
            ownership.publicationLease,
          );
          const winningContext = publication.committed;
          session.tablessHeartbeat = publication.accepted || !winningContext
            || winningContext.contextKey !== contextKey
            ? publication.cadence
            : winningContext.session.tablessHeartbeat;
          const discarded = publication.accepted
            ? publication.replaced
            : created ? watcher : undefined;
          if (discarded) await stopTablessWatcher(discarded, platform, emit);
        } else if (existing) {
          const removal = await takeHeartbeatWatcher(platform, ownership.revision);
          session.tablessHeartbeat = undefined;
          if (!removal.accepted || !removal.watcher) continue;
          await stopTablessWatcher(removal.watcher, platform, emit);
        } else {
          await takeHeartbeatWatcher(platform, ownership.revision);
          session.tablessHeartbeat = undefined;
        }
      } catch (error) {
        if (ownership.publicationLease) {
          await releaseHeartbeatPublicationLease(platform, ownership.publicationLease);
          const index = publicationLeases.findIndex(([leasePlatform, lease]) =>
            leasePlatform === platform && lease === ownership.publicationLease);
          if (index >= 0) publicationLeases.splice(index, 1);
        }
        throw error;
      }
    }
    return publicationLeases;
  }

  function drainWatcherEvents(watcher: TablessWatchController, emit: EventEmitter): void {
    for (const event of watcher.drainEvents()) emit(event);
  }

  async function stopTablessWatcher(
    watcher: TablessWatchController,
    platform: Platform,
    emit: EventEmitter,
  ): Promise<void> {
    drainWatcherEvents(watcher, emit);
    try {
      await watcher.stop();
    } catch (error) {
      emitHostCallbackError(emit, platform, error, "Could not stop the tabless watcher");
    } finally {
      drainWatcherEvents(watcher, emit);
    }
  }

  async function clearHeartbeatOwnership(platforms: readonly Platform[]): Promise<void> {
    await withEventCollector(async (emit, events) => {
      for (const platform of platforms) {
        const removal = await takeHeartbeatWatcher(platform);
        if (removal.watcher) await stopTablessWatcher(removal.watcher, platform, emit);
      }
      await reportBestEffort(events);
    });
  }

  function clearHeartbeatOwnershipInBackground(platforms: readonly Platform[]): void {
    const run = clearHeartbeatOwnership(platforms).catch((error) => {
      const platform = platforms.length === 1 ? platforms[0] : undefined;
      diagnosticEvent(
        "warn",
        `Tabless watcher cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        platform,
      );
    });
    backgroundWork = backgroundWork.then(() => run, () => run);
  }

  function drainDiscoverySignalEvents(
    controller: DiscoverySignalController,
    emit: EventEmitter,
  ): void {
    for (const event of controller.drainEvents()) emit(event);
  }

  async function stopDiscoverySignalController(
    platform: Platform,
    emit: EventEmitter,
  ): Promise<void> {
    invalidateDiscoverySignalAdmission(platform);
    const controller = discoverySignalControllers.get(platform);
    if (!controller) return;
    // Delete before awaiting host cleanup so a callback captured by an obsolete
    // controller cannot enqueue work while its socket/timer teardown finishes.
    discoverySignalControllers.delete(platform);
    drainDiscoverySignalEvents(controller, emit);
    try {
      await controller.stop();
    } catch (error) {
      emitHostCallbackError(emit, platform, error, "Could not stop the discovery signal observer");
    } finally {
      drainDiscoverySignalEvents(controller, emit);
    }
  }

  async function stopDiscoverySignalControllers(
    platforms: readonly Platform[],
    emit: EventEmitter,
  ): Promise<void> {
    await Promise.all(platforms.map((platform) =>
      stopDiscoverySignalController(platform, emit)));
  }

  async function stopDiscoverySignalControllersAndReport(
    platforms: readonly Platform[],
  ): Promise<void> {
    await withEventCollector(async (emit, events) => {
      await stopDiscoverySignalControllers(platforms, emit);
      await reportBestEffort(events);
    });
  }

  function stopDiscoverySignalControllersInBackground(
    platforms: readonly Platform[],
  ): void {
    for (const platform of platforms) invalidateDiscoverySignalAdmission(platform);
    const run = stopDiscoverySignalControllersAndReport(platforms).catch((error) => {
      const platform = platforms.length === 1 ? platforms[0] : undefined;
      diagnosticEvent(
        "warn",
        `Discovery signal observer cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        platform,
      );
    });
    backgroundWork = backgroundWork.then(() => run, () => run);
  }

  async function reconcileDiscoverySignalControllers(
    state: SchedulerState,
    settings: EngineSettings,
    adapters: Record<Platform, PlatformAdapter>,
    emit: EventEmitter,
    platforms?: Platform[],
  ): Promise<void> {
    const targets = platforms ?? PLATFORMS;
    for (const platform of targets) {
      const session = state.sessions[platform];
      const adapter = adapters[platform];
      const factory = adapter.createDiscoverySignalController;
      const wanted = discoverySignalLifecycleOpen
        && !discoverySignalPlatformBlocked[platform]
        && settings.platform[platform].enabled
        && state.authHealth[platform].status === "healthy"
        && session.status === "watching"
        && Boolean(session.channel)
        && Boolean(factory);
      const existing = discoverySignalControllers.get(platform);

      if (!wanted || !session.channel || !factory) {
        if (existing) await stopDiscoverySignalController(platform, emit);
        continue;
      }

      let controller = existing;
      if (!controller) {
        try {
          controller = factory();
          invalidateDiscoverySignalAdmission(platform);
          discoverySignalControllers.set(platform, controller);
        } catch (error) {
          emitHostCallbackError(emit, platform, error, "Could not create the discovery signal observer");
          continue;
        }
      }

      drainDiscoverySignalEvents(controller, emit);
      try {
        await controller.start(
          { platform, channel: session.channel },
          () => {
            if (discoverySignalControllers.get(platform) !== controller) return;
            queueDiscoverySignalRefresh(platform, controller);
          },
        );
      } catch (error) {
        emitHostCallbackError(emit, platform, error, "Could not start the discovery signal observer");
      } finally {
        drainDiscoverySignalEvents(controller, emit);
      }

      // Reset/shutdown/disable cleanup can race a host controller whose start()
      // awaits transport setup. Teardown wins, and the just-finished obsolete
      // start must not retain its callback or transport.
      if (
        discoverySignalControllers.get(platform) !== controller
        || !discoverySignalLifecycleOpen
        || controllerShutdown
      ) {
        if (discoverySignalControllers.get(platform) === controller) {
          invalidateDiscoverySignalAdmission(platform);
          discoverySignalControllers.delete(platform);
        }
        try {
          await controller.stop();
        } catch (error) {
          emitHostCallbackError(emit, platform, error, "Could not stop the discovery signal observer");
        } finally {
          drainDiscoverySignalEvents(controller, emit);
        }
      }
    }
  }

  // Fired by the 1-minute watch alarm. Runs one heartbeat per active tabless
  // watcher and records its health on the session, falling back to a real tab
  // (by re-running the scheduler) when a heartbeat keeps failing.
  async function runWatchHeartbeat(): Promise<void> {
    const settings = await deps.loadSettings();
    if (!isFarmingActive(settings)) return;

    const heartbeatResults = await Promise.allSettled(PLATFORMS.map((platform) =>
      runPlatformWatchHeartbeat(platform, settings)));
    const fallbacks = heartbeatResults.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : []);
    const fallbackResults = await Promise.allSettled(fallbacks.map(runHeartbeatFallback));
    const failures = [...heartbeatResults, ...fallbackResults].flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Platform watch heartbeats failed");
    }
  }

  async function runPlatformWatchHeartbeat(
    platform: Platform,
    settings: S,
  ): Promise<HeartbeatFallback | undefined> {
    if (controllerShutdown) return undefined;
    await withEventCollector(async (emit, events) => {
      while (!controllerShutdown) {
        // Capture the lane revision before loading storage. If another recovery
        // publishes while this read is pending, the loaded snapshot must not
        // remove or replace that newer owner.
        const expectedRevision = heartbeatLanes[platform].revision;
        const expectedPageContextRevision = currentManagedPageContextTabsRevision();
        const nextState = await deps.loadState();
        hydrateManagedPageContextTabs(
          nextState.managedPageContextTabs ?? {},
          [platform],
          expectedPageContextRevision,
        );
        const adapters = createSelectedAdapters(settings, emit, [platform]);
        const prepared = await preparePlatformHeartbeatContext(
          platform,
          settings,
          nextState,
          adapters,
          emit,
          expectedRevision,
        );
        if (prepared) break;
      }
      await reportBestEffort(events);
    });
    if (controllerShutdown) return undefined;
    return requestPlatformHeartbeat(platform, settings, "scheduled");
  }

  async function preparePlatformHeartbeatContext(
    platform: Platform,
    settings: S,
    state: SchedulerState,
    adapters: Record<Platform, PlatformAdapter>,
    emit: EventEmitter,
    expectedRevision: number,
  ): Promise<boolean> {
    const session = state.sessions[platform];
    const contextKey = heartbeatContextKey(session);
    const wantsTabless = settings.platform[platform].enabled
      && state.authHealth[platform].status === "healthy"
      && session.status === "watching"
      && session.watchMode === "tabless"
      && Boolean(session.channel)
      && Boolean(contextKey)
      && Boolean(adapters[platform].createTablessWatcher);

    let recoveryCommit: HeartbeatRecoveryCommit | undefined;
    const decision = await withHeartbeatLane(platform, async (lane) => {
      if (lane.publicationLease) {
        if (
          lane.committed
          && lane.publicationLease.published === lane.committed
        ) {
          return { ready: true };
        }
        return { waitFor: lane.publicationLease.admissionReady };
      }
      if (lane.recoveryCommit) return { waitFor: lane.recoveryCommit.settled };
      if (lane.revision !== expectedRevision) {
        // A same-context winner makes this invocation redundant. A different
        // normalized target asks the caller to reload storage and retry. An
        // invalid stale snapshot never tears down the winner that appeared
        // after its read began.
        if (contextKey && lane.committed?.contextKey !== contextKey) return { retry: true };
        return { ready: true };
      }

      const persistedMetadata = session.tablessHeartbeat;
      const retainedCadence = validTablessHeartbeatCadence(session);
      if (lane.committed) {
        const sameAuthority = wantsTabless
          && lane.committed.contextKey === contextKey
          && retainedCadence?.generation === lane.committed.generation;
        const stalePersistedAuthority = wantsTabless
          && retainedCadence !== undefined
          && retainedCadence.generation < lane.committed.generation;
        if (sameAuthority || stalePersistedAuthority) return { ready: true };
        if (lane.resultCommit) return { waitFor: lane.resultCommit.settled };
        const discarded = lane.committed.watcher;
        lane.committed = undefined;
        tablessWatchers.delete(platform);
        lane.revision += 1;
        return { discarded, retry: wantsTabless };
      }
      if (!wantsTabless || !session.channel || !contextKey) return { ready: true };
      if (lane.resultCommit) return { waitFor: lane.resultCommit.settled };

      // A fresh service worker has no watcher instance to reserve. Construct
      // and start exactly one under the narrow lane synchronization, then make
      // the immutable context visible before any provider heartbeat transport.
      const watcher = adapters[platform].createTablessWatcher!();
      drainWatcherEvents(watcher, emit);
      try {
        await watcher.start(session.channel, tablessWatchContext());
      } catch (error) {
        emit({
          category: "diagnostic",
          platform,
          level: "warn",
          message: error instanceof Error ? error.message : "Could not start the tabless watcher",
        });
      } finally {
        drainWatcherEvents(watcher, emit);
      }
      if (controllerShutdown) return { discarded: watcher, ready: true };

      const persistedGeneration = validHeartbeatGeneration(persistedMetadata?.generation)
        ? persistedMetadata.generation
        : 0;
      const mayRestorePersisted = retainedCadence
        && (lane.generationHighWater === undefined
          || retainedCadence.generation > lane.generationHighWater);
      const generation = mayRestorePersisted
        ? retainedCadence.generation
        : nextHeartbeatGeneration(lane.generationHighWater, persistedGeneration);
      const cadence: TablessHeartbeatCadence = Object.freeze(mayRestorePersisted
        ? { ...retainedCadence }
        : {
            generation,
            contextKey,
            nextDueAt: retainedCadence?.nextDueAt ?? new Date(Date.now()).toISOString(),
          });
      if (!mayRestorePersisted) {
        let settle!: () => void;
        const settled = new Promise<void>((resolve) => {
          settle = resolve;
        });
        recoveryCommit = {
          generation,
          contextKey,
          expectedPersistedCadence: retainedCadence
            ? Object.freeze({ ...retainedCadence })
            : undefined,
          settled,
          settle,
        };
        lane.recoveryCommit = recoveryCommit;
      }
      lane.committed = Object.freeze({
        generation,
        contextKey,
        session: frozenHeartbeatSession(session, cadence),
        watcher,
      });
      lane.generationHighWater = Math.max(lane.generationHighWater ?? 0, generation);
      tablessWatchers.set(platform, watcher);
      lane.revision += 1;
      return { cadence, ready: true };
    });

    if ("waitFor" in decision) {
      await decision.waitFor;
      return false;
    }
    if ("discarded" in decision && decision.discarded) {
      await stopTablessWatcher(decision.discarded, platform, emit);
      return !("retry" in decision && decision.retry);
    }
    if ("retry" in decision) return false;
    const candidateRecovery = recoveryCommit;
    const candidateCadence = "cadence" in decision ? decision.cadence : undefined;
    if (!candidateRecovery || !candidateCadence) return true;

    let accepted = false;
    try {
      accepted = await persistRecoveredHeartbeatCadence(
        platform,
        settings,
        candidateRecovery,
        candidateCadence,
      );
    } finally {
      let discarded: TablessWatchController | undefined;
      await withHeartbeatLane(platform, async (lane) => {
        if (lane.recoveryCommit === candidateRecovery) {
          lane.recoveryCommit = undefined;
          if (
            !accepted
            && lane.committed?.generation === candidateRecovery.generation
            && lane.committed.contextKey === candidateRecovery.contextKey
          ) {
            discarded = lane.committed.watcher;
            lane.committed = undefined;
            tablessWatchers.delete(platform);
            lane.revision += 1;
          }
          candidateRecovery.settle();
        }
      });
      if (discarded) await stopTablessWatcher(discarded, platform, emit);
    }
    return accepted;
  }

  async function persistRecoveredHeartbeatCadence(
    platform: Platform,
    settings: S,
    recovery: HeartbeatRecoveryCommit,
    cadence: TablessHeartbeatCadence,
  ): Promise<boolean> {
    return withStateCommit(async () => {
      if (controllerShutdown || !settings.platform[platform].enabled) return false;
      const latest = await deps.loadState();
      const current = latest.sessions[platform];
      if (
        latest.authHealth[platform].status !== "healthy"
        || current.status !== "watching"
        || current.watchMode !== "tabless"
        || heartbeatContextKey(current) !== recovery.contextKey
      ) {
        return false;
      }
      const persisted = validTablessHeartbeatCadence(current);
      if (persisted) {
        if (
          persisted.generation === recovery.generation
          && persisted.nextDueAt === cadence.nextDueAt
        ) {
          return true;
        }
        if (
          !recovery.expectedPersistedCadence
          || persisted.generation !== recovery.expectedPersistedCadence.generation
          || persisted.nextDueAt !== recovery.expectedPersistedCadence.nextDueAt
        ) {
          return false;
        }
      }
      await saveOperationalStateDirect({
        ...latest,
        sessions: {
          ...latest.sessions,
          [platform]: {
            ...current,
            tablessHeartbeat: cadence,
          },
        },
      });
      return true;
    });
  }

  async function requestPlatformHeartbeat(
    platform: Platform,
    settings: S,
    kind: HeartbeatAttemptKind,
    session?: WatchSession,
  ): Promise<HeartbeatFallback | undefined> {
    return withEventCollector(async (emit, events) => {
      if (controllerShutdown) return undefined;
      const requestedAt = Date.now();
      let resolveAttempt!: (fallback: HeartbeatFallback | undefined) => void;
      let rejectAttempt!: (error: unknown) => void;
      const attemptPromise = new Promise<HeartbeatFallback | undefined>((resolve, reject) => {
        resolveAttempt = resolve;
        rejectAttempt = reject;
      });
      let reservation: {
        start: boolean;
        standaloneCoalescedCalls: number;
        attempt?: HeartbeatAttempt;
        committed?: CommittedHeartbeatContext;
      };
      while (true) {
        const decision = await withHeartbeatLane(platform, async (lane) => {
          if (controllerShutdown) {
            return { start: false, standaloneCoalescedCalls: 0 };
          }
          if (
            lane.publicationLease
            && lane.publicationLease.published !== lane.committed
          ) {
            return { waitFor: lane.publicationLease.admissionReady };
          }
          const committed = lane.committed;
          const requestedContextKey = session ? heartbeatContextKey(session) : committed?.contextKey;
          const requestedGeneration = session
            ? validTablessHeartbeatCadence(session)?.generation
            : undefined;
          if (
            !committed
            || requestedContextKey !== committed.contextKey
            || (kind === "immediate" && requestedGeneration !== committed.generation)
          ) {
            const standaloneCoalescedCalls = lane.coalescedWithoutAttempt;
            lane.coalescedWithoutAttempt = 0;
            return { start: false, standaloneCoalescedCalls };
          }

          if (
            lane.inFlight
            && lane.inFlight.generation === committed.generation
            && lane.inFlight.contextKey === committed.contextKey
          ) {
            lane.inFlight.coalescedCalls += 1;
            return { attempt: lane.inFlight, start: false, standaloneCoalescedCalls: 0 };
          }

          const attemptAt = Date.now();
          let dueAt = attemptAt;
          if (kind === "scheduled") {
            dueAt = Date.parse(committed.session.tablessHeartbeat?.nextDueAt ?? "");
            if (!Number.isFinite(dueAt) || attemptAt < dueAt) {
              return { start: false, standaloneCoalescedCalls: 0 };
            }
          } else if (
            lane.lastCompletedGeneration === committed.generation
            && lane.lastCompletedContextKey === committed.contextKey
          ) {
            const lastHeartbeatAt = Date.parse(committed.session.lastHeartbeatAt ?? "");
            if (Number.isFinite(lastHeartbeatAt) && attemptAt - lastHeartbeatAt < RECENT_HEARTBEAT_MS) {
              return { start: false, standaloneCoalescedCalls: 0 };
            }
          }

          const attempt: HeartbeatAttempt = {
            generation: committed.generation,
            contextKey: committed.contextKey,
            dueAt,
            attemptAt,
            synchronizationDelayMs: Math.max(0, attemptAt - requestedAt),
            coalescedCalls: lane.coalescedWithoutAttempt,
            promise: attemptPromise,
          };
          lane.coalescedWithoutAttempt = 0;
          lane.inFlight = attempt;
          return { attempt, committed, start: true, standaloneCoalescedCalls: 0 };
        });
        if ("waitFor" in decision) {
          await decision.waitFor;
          continue;
        }
        reservation = decision;
        break;
      }

      if (!reservation.attempt) {
        if (reservation.standaloneCoalescedCalls > 0) {
          emit({
            category: "diagnostic",
            platform,
            level: "debug",
            message: `Tabless heartbeat coalescing ended without an attempt coalescedCalls=${reservation.standaloneCoalescedCalls}`,
          });
        }
        await reportBestEffort(events);
        return undefined;
      }

      if (!reservation.start || !reservation.committed) {
        await reportBestEffort(events);
        return reservation.attempt.promise;
      }

      const { attempt, committed } = reservation;
      if (controllerShutdown) {
        await withHeartbeatLane(platform, async (lane) => {
          if (lane.inFlight === attempt) lane.inFlight = undefined;
        });
        resolveAttempt(undefined);
        await reportBestEffort(events);
        return attempt.promise;
      }
      void (async () => {
        try {
          const fallback = await performReservedHeartbeatAttempt(
            platform,
            settings,
            committed,
            attempt,
            emit,
            events,
          );
          resolveAttempt(fallback);
        } catch (error) {
          rejectAttempt(error);
        }
      })();
      return attempt.promise;
    });
  }

  async function performReservedHeartbeatAttempt(
    platform: Platform,
    settings: S,
    committed: CommittedHeartbeatContext,
    attempt: HeartbeatAttempt,
    emit: EventEmitter,
    events: EngineEvent[],
  ): Promise<HeartbeatFallback | undefined> {
    const { watcher } = committed;
    let ok = false;
    let message: string | undefined;
    drainWatcherEvents(watcher, emit);
    try {
      const result = await watcher.tick(tablessWatchContext());
      ok = result.ok;
      message = result.message;
    } catch (error) {
      message = error instanceof Error ? error.message : "Tabless heartbeat failed";
    } finally {
      drainWatcherEvents(watcher, emit);
    }

    let commit = { stale: false, fallback: false };
    let commitError: unknown;
    try {
      commit = await commitHeartbeatResult(platform, settings, attempt, ok, message, emit);
      await reportBestEffort(events);
    } catch (error) {
      commitError = error;
    }

    const coalescedCalls = await withHeartbeatLane(platform, async (lane) => {
      if (lane.inFlight === attempt) lane.inFlight = undefined;
      return attempt.coalescedCalls;
    });
    await reportBestEffort([{
      category: "diagnostic",
      platform,
      level: ok ? "debug" : "warn",
      message: [
        "Tabless heartbeat timing",
        `scheduledDueAt=${new Date(attempt.dueAt).toISOString()}`,
        `actualAttemptAt=${new Date(attempt.attemptAt).toISOString()}`,
        `latenessMs=${Math.max(0, attempt.attemptAt - attempt.dueAt)}`,
        `synchronizationDelayMs=${attempt.synchronizationDelayMs}`,
        `coalescedCalls=${coalescedCalls}`,
        `outcome=${ok ? "ok" : "failed"}`,
        `staleResult=${commit.stale}`,
      ].join(" "),
    }]);

    if (commitError) throw commitError;
    return commit.fallback
      ? { platform, generation: attempt.generation, contextKey: attempt.contextKey }
      : undefined;
  }

  async function commitHeartbeatResult(
    platform: Platform,
    settings: S,
    attempt: HeartbeatAttempt,
    ok: boolean,
    message: string | undefined,
    emit: EventEmitter,
  ): Promise<{ stale: boolean; fallback: boolean }> {
    const reservation = await reserveHeartbeatResultCommit(platform, attempt);
    if (!reservation) return { stale: true, fallback: false };

    let committedSession: WatchSession | undefined;
    try {
      return await withStateCommit(async () => {
        const latest = await deps.loadState();
        const current = latest.sessions[platform];
        if (!heartbeatAuthorityMatches(current, attempt.generation, attempt.contextKey)) {
          return { stale: true, fallback: false };
        }

        const previousChecks = current.heartbeatChecks ?? 0;
        const heartbeatChecks = ok ? 0 : previousChecks + 1;
        const nextSession: WatchSession = {
          ...current,
          lastHeartbeatAt: new Date().toISOString(),
          lastHeartbeatOk: ok,
          heartbeatChecks,
          tablessHeartbeat: {
            generation: attempt.generation,
            contextKey: attempt.contextKey,
            nextDueAt: new Date(nextHeartbeatDueAt(attempt.dueAt, attempt.attemptAt)).toISOString(),
          },
        };
        const managedPageContextTabs = { ...latest.managedPageContextTabs };
        const pageContext = currentManagedPageContextTabs()[platform];
        if (pageContext) managedPageContextTabs[platform] = pageContext;
        else delete managedPageContextTabs[platform];

        if (ok && previousChecks > 0) {
          emit({ category: "diagnostic", platform, level: "info", message: "Tabless watch heartbeat recovered" });
        } else if (!ok && previousChecks === 0) {
          emit({ category: "diagnostic", platform, level: "warn", message: message ?? "Tabless watch heartbeat failed" });
        }
        const fallback = !ok && heartbeatChecks >= settings.tablessFallbackFailureLimit;
        if (fallback) {
          emit({ category: "diagnostic", platform, level: "warn", message: "Tabless watch heartbeat keeps failing; falling back to a watch tab" });
        }

        await saveOperationalStateDirect({
          ...latest,
          sessions: {
            ...latest.sessions,
            [platform]: nextSession,
          },
          managedPageContextTabs,
        });
        if (current.lastHeartbeatOk !== ok || previousChecks !== heartbeatChecks) {
          invalidateSelection(platform);
        }
        committedSession = nextSession;
        return { stale: false, fallback };
      });
    } finally {
      await finishHeartbeatResultCommit(platform, reservation, committedSession);
    }
  }

  async function reserveHeartbeatResultCommit(
    platform: Platform,
    attempt: HeartbeatAttempt,
  ): Promise<HeartbeatResultCommit | undefined> {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const reservation: HeartbeatResultCommit = { attempt, settled, settle };
    while (true) {
      const decision = await withHeartbeatLane(platform, async (lane) => {
        if (lane.publicationLease && !lane.publicationLease.published) {
          return { waitFor: lane.publicationLease.admissionReady };
        }
        if (
          lane.committed?.generation !== attempt.generation
          || lane.committed.contextKey !== attempt.contextKey
        ) {
          return { accepted: false };
        }
        if (lane.publicationLease?.published === lane.committed) {
          return { waitFor: lane.publicationLease.settled };
        }
        if (lane.resultCommit) return { accepted: false };
        lane.resultCommit = reservation;
        return { accepted: true };
      });
      if ("waitFor" in decision) {
        await decision.waitFor;
        continue;
      }
      return decision.accepted ? reservation : undefined;
    }
  }

  async function finishHeartbeatResultCommit(
    platform: Platform,
    reservation: HeartbeatResultCommit,
    committedSession: WatchSession | undefined,
  ): Promise<void> {
    await withHeartbeatLane(platform, async (lane) => {
      try {
        if (
          committedSession
          && lane.committed?.generation === reservation.attempt.generation
          && lane.committed.contextKey === reservation.attempt.contextKey
        ) {
          lane.lastCompletedGeneration = reservation.attempt.generation;
          lane.lastCompletedContextKey = reservation.attempt.contextKey;
          lane.committed = Object.freeze({
            ...lane.committed,
            session: frozenHeartbeatSession(
              committedSession,
              committedSession.tablessHeartbeat!,
            ),
          });
        }
      } finally {
        if (lane.resultCommit === reservation) lane.resultCommit = undefined;
        reservation.settle();
      }
    });
  }

  function heartbeatAuthorityMatches(
    session: WatchSession,
    generation: number,
    contextKey: string,
  ): boolean {
    const cadence = validTablessHeartbeatCadence(session);
    return cadence?.generation === generation && cadence.contextKey === contextKey;
  }

  async function runHeartbeatFallback(fallback: HeartbeatFallback): Promise<void> {
    const ownsLane = await withHeartbeatLane(fallback.platform, async (lane) =>
      lane.committed?.generation === fallback.generation
      && lane.committed.contextKey === fallback.contextKey);
    if (!ownsLane) return;

    const ownsPersistedContext = await withStateCommit(async () => {
      const latest = await deps.loadState();
      return heartbeatAuthorityMatches(
        latest.sessions[fallback.platform],
        fallback.generation,
        fallback.contextKey,
      );
    });
    if (!ownsPersistedContext) return;

    const stillOwnsLane = await withHeartbeatLane(fallback.platform, async (lane) =>
      lane.committed?.generation === fallback.generation
      && lane.committed.contextKey === fallback.contextKey);
    if (!stillOwnsLane) return;
    await tick([fallback.platform], "tabless_fallback");
  }

  // Aborts every in-flight handoff. Called when farming stops, when a settings
  // session begins, and on runtime restart.
  // Scoped when a single platform is switched off: with per-platform toggles,
  // cancelling every handoff would abort work the other platform still needs.
  function abortClaimHandoffs(platform?: Platform): void {
    for (const [handoffPlatform, controller] of claimHandoffs) {
      if (platform && handoffPlatform !== platform) continue;
      controller.abort();
      claimHandoffs.delete(handoffPlatform);
    }
  }

  function abortActiveTicks(reason: string): void {
    for (const controller of activeTicks) {
      controller.abort(new Error(reason));
    }
  }

  function closeTwitchIntegrityLifecycle(reason: string): void {
    const error = new Error(reason);
    if (integrityLifecycleOpen) {
      integrityLifecycleOpen = false;
      integrityLifecycleGeneration += 1;
    }
    integrityRefreshAbort?.abort(error);
    deps.cancelTwitchIntegrityAcquisition?.(error);
  }

  function reopenTwitchIntegrityLifecycle(): void {
    if (controllerShutdown || integrityLifecycleOpen) return;
    integrityLifecycleOpen = true;
    integrityLifecycleGeneration += 1;
  }

  function reconcileTwitchIntegrityLifecycle(enabled: boolean | undefined): void {
    if (enabled === true) reopenTwitchIntegrityLifecycle();
    else if (enabled === false) closeTwitchIntegrityLifecycle("Twitch disabled");
  }

  function shutdown(): void {
    controllerShutdown = true;
    for (const platform of PLATFORMS) {
      discoveryLanes[platform].stop();
      invalidateSelection(platform);
    }
    discoverySignalLifecycleOpen = false;
    for (const platform of PLATFORMS) invalidateDiscoverySignalAdmission(platform);
    twitchSettingsTransitionGeneration += 1;
    abortActiveTicks("Controller shutdown");
    closeTwitchIntegrityLifecycle("Controller shutdown");
    void clearTwitchIntegrityAlarmBestEffort();
    abortClaimHandoffs();
    void cancelHeartbeatPublicationLeases(PLATFORMS);
    clearHeartbeatOwnershipInBackground(PLATFORMS);
    stopDiscoverySignalControllersInBackground(PLATFORMS);
  }

  async function prepareForHostReset(resetHostStorage?: () => Promise<void>): Promise<void> {
    discoverySignalLifecycleOpen = false;
    for (const platform of PLATFORMS) invalidateDiscoverySignalAdmission(platform);
    twitchSettingsTransitionGeneration += 1;
    for (const platform of PLATFORMS) {
      discoveryLanes[platform].invalidate();
      invalidateSelection(platform);
    }
    abortActiveTicks("Host reset");
    closeTwitchIntegrityLifecycle("Host reset");
    await stopDiscoverySignalControllersAndReport(PLATFORMS);
    await clearTwitchIntegrityAlarmBestEffort();
    abortClaimHandoffs();
    await clearHeartbeatOwnership(PLATFORMS);
    await withSettingsLock(() => withStateLock(() => withEventCollector(async (emit, events) => {
      const [settings, state] = await Promise.all([deps.loadSettings(), deps.loadState()]);
      const adapters = createAdapters(settings, emit);
      const managedTabs = Object.values(state.managedWatchTabs ?? {}).filter((tab): tab is ManagedWatchTab => tab?.ownedByExtension === true);
      if (deps.closeManagedTabs && managedTabs.length > 0) await deps.closeManagedTabs(managedTabs);
      for (const platform of PLATFORMS) {
        await deps.applyAdFocus?.(platform, state.sessions[platform].tabId, false, emit);
        await adapters[platform].stopWatchTab?.(state.sessions[platform], { closeManagedTabs: true });
      }
      if (deps.stopPageContextTabs) {
        await deps.stopPageContextTabs(state.managedPageContextTabs ?? {}, {
          platforms: PLATFORMS,
          reason: "automation_disabled",
          emit,
        });
      }
      registerManagedPageContextTabs({});
      installedTwitchIntegrity = undefined;
      persistedIntegrityToken = undefined;
      twitchIntegrityRefreshDue = undefined;
      setTwitchIntegrity(undefined);
      await resetHostStorage?.();
      lastPersistedTwitchEnabled = undefined;
      await reportBestEffort(events);
    })));
    if (!controllerShutdown) discoverySignalLifecycleOpen = true;
  }

  // Bounded post-claim handoff (see docs/superpowers/specs/2026-07-19-twitch-claim-handoff-design.md).
  // Re-runs a scoped tick on the configured cadence until the platform lands on
  // a reward other than the ones just claimed, then hands off to the immediate
  // heartbeat. Runs OUTSIDE the state lock: each inner tick() acquires the lock
  // on its own, so a long handoff never blocks telemetry or user actions.
  async function runClaimHandoff(
    platform: Platform,
    justClaimedRewardIds: readonly string[] = [],
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<void> {
    if (claimHandoffs.has(platform)) return;
    // Reserved synchronously, before the first await. Registering after the
    // async setup would let two triggers past the guard into concurrent loops,
    // and would let an abortClaimHandoffs() landing mid-setup miss this handoff
    // entirely.
    const abort = new AbortController();
    claimHandoffs.set(platform, abort);

    try {
      const settings = await deps.loadSettings();
      if (abort.signal.aborted) return;
      if (!settings.postClaimHandoff) return;
      if (!settings.platform[platform].enabled) return;

      // Deliberately bypasses the createAdapters() wrapper: that records every
      // compatibility diagnostic it emits into the dedup caches, so probing
      // through it with a no-op emit would mark a diagnostic as "already
      // reported" without it ever reaching a sink, permanently suppressing it on
      // the next genuine tick. This is a capability lookup, not a reporting
      // context; the handoff's own tick() reports normally.
      const { adapters } = deps.createAdapters(() => undefined, settings);
      if (!adapters[platform].supportsPostClaimHandoff) return;

      const claimed = new Set(justClaimedRewardIds);
      // A session is a successful handoff target when it is watching a reward
      // other than the ones just claimed.
      const isSuccessor = (session: WatchSession): boolean =>
        session.status === "watching" && session.rewardId != null && !claimed.has(session.rewardId);

      // The triggering tick may already have found the successor, in which case
      // there is nothing to poll for — only a heartbeat to bring forward.
      const before = await deps.loadState();
      if (abort.signal.aborted) return;
      if (isSuccessor(before.sessions[platform])) {
        await requestPlatformHeartbeat(platform, settings, "immediate", before.sessions[platform]);
        return;
      }

      // The deadline is computed once. A claim occurring inside the loop never
      // extends it, so the worst case stays fixed at maxSeconds.
      const deadline = Date.now() + settings.postClaimHandoffMaxSeconds * 1000;
      const intervalMs = settings.postClaimHandoffIntervalSeconds * 1000;

      while (!abort.signal.aborted && Date.now() < deadline) {
        // Capped at the remaining budget, so an interval longer than what is
        // left cannot push a refresh past the deadline.
        await wait(Math.min(intervalMs, deadline - Date.now()), abort.signal);
        if (abort.signal.aborted || Date.now() >= deadline) break;

        await tick([platform], "claim_handoff", onPersisted);
        if (abort.signal.aborted) break;

        const session = (await deps.loadState()).sessions[platform];
        // Re-checked after the load: a cancellation during it must not still
        // transmit.
        if (abort.signal.aborted) break;
        if (isSuccessor(session)) {
          await requestPlatformHeartbeat(platform, settings, "immediate", session);
          return;
        }
        // Nothing eligible left on this platform: the chain is finished, so stop
        // rather than burning the rest of the budget on identical refreshes.
        if (session.status !== "watching" && isNothingLeftToFarm(session.reasonCode)) return;
      }
    } finally {
      if (claimHandoffs.get(platform) === abort) claimHandoffs.delete(platform);
    }
  }

  function invalidateDiscoverySignalAdmission(platform: Platform): void {
    discoverySignalRefreshPending[platform] = undefined;
    discoverySignalAdmissionGeneration[platform] += 1;
  }

  function discoverySignalRefreshAllowed(
    platform: Platform,
    request: DiscoverySignalRefreshRequest,
  ): boolean {
    return !controllerShutdown
      && discoverySignalLifecycleOpen
      && !discoverySignalPlatformBlocked[platform]
      && discoverySignalAuthRefreshes[platform] === 0
      && discoverySignalAdmissionGeneration[platform] === request.generation
      && discoverySignalControllers.get(platform) === request.controller;
  }

  function reserveDiscoverySignalAuthRefresh(platform: Platform): () => void {
    // Credential observation calls invalidate/check without awaiting the pair.
    // Close signal admission synchronously so no callback or paused refresh loop
    // can launch obsolete platform work before the first state-lock await lands.
    invalidateDiscoverySignalAdmission(platform);
    discoverySignalAuthRefreshes[platform] += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      discoverySignalAuthRefreshes[platform] -= 1;
    };
  }

  function queueDiscoverySignalRefresh(
    platform: Platform,
    controller: DiscoverySignalController,
  ): void {
    const request: DiscoverySignalRefreshRequest = {
      controller,
      generation: discoverySignalAdmissionGeneration[platform],
    };
    if (!discoverySignalRefreshAllowed(platform, request)) return;
    discoverySignalRefreshPending[platform] = request;
    startPendingDiscoverySignalRefresh(platform);
  }

  function startPendingDiscoverySignalRefresh(platform: Platform): void {
    if (discoverySignalRefreshRunning[platform] || activePlatformTicks[platform] > 0) return;
    const queued = discoverySignalRefreshPending[platform];
    if (!queued) return;
    if (!discoverySignalRefreshAllowed(platform, queued)) {
      discoverySignalRefreshPending[platform] = undefined;
      return;
    }
    // Reserve synchronously. A burst in the async setup window must see the
    // running loop and collapse into its one pending request.
    discoverySignalRefreshRunning[platform] = true;

    const run = (async () => {
      try {
        while (discoverySignalRefreshPending[platform]) {
          const current = discoverySignalRefreshPending[platform];
          if (!current) break;
          if (!discoverySignalRefreshAllowed(platform, current)) {
            if (discoverySignalRefreshPending[platform] === current) {
              discoverySignalRefreshPending[platform] = undefined;
            }
            continue;
          }
          discoverySignalRefreshPending[platform] = undefined;
          const settings = await deps.loadSettings();
          if (!discoverySignalRefreshAllowed(platform, current)) continue;
          if (!settings.platform[platform].enabled) {
            discoverySignalRefreshPending[platform] = undefined;
            break;
          }
          await tickAndHandOff([platform], "discovery_signal");
        }
      } finally {
        discoverySignalRefreshRunning[platform] = false;
        // Covers a signal arriving after the loop's last condition check but
        // before the running reservation is released.
        startPendingDiscoverySignalRefresh(platform);
      }
    })().catch((error) => {
      diagnosticEvent(
        "warn",
        `Discovery signal refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        platform,
      );
    });

    backgroundWork = backgroundWork.then(() => run, () => run);
  }

  // Runs a tick without holding the caller open for it. A user action gets its
  // snapshot back immediately; the popup re-polls getSnapshot on its own cadence
  // and picks the result up when the tick lands.
  function tickInBackground(
    platforms: Platform[] | undefined,
    trigger: TickTrigger,
    onCompleted?: () => void,
  ): void {
    if (controllerShutdown) return;
    const run = tickAndHandOff(platforms, trigger)
      .then(() => onCompleted?.())
      .catch((error) => {
        const platform = platforms?.length === 1 ? platforms[0] : undefined;
        diagnosticEvent("warn", `Background tick (trigger=${trigger}) failed: ${error instanceof Error ? error.message : String(error)}`, platform);
      });
    backgroundWork = backgroundWork.then(() => run, () => run);
  }

  // Detached ticks have no caller to await them, which leaves observers (tests,
  // and the CLI's one-shot mode) with no way to know when the work they just
  // triggered has actually landed. Settling drains the chain until it stops
  // growing, so a tick that queues a post-claim handoff is covered too.
  async function settleBackgroundWork(): Promise<void> {
    await initialTwitchIntegrityLoad;
    let pending = backgroundWork;
    for (;;) {
      await pending;
      if (backgroundWork === pending) return;
      pending = backgroundWork;
    }
  }

  // The persisted session still describes the platform as it was *before* the
  // toggle, and nothing rewrites it until the tick finishes. Detaching the tick
  // alone would not fix that: the popup polls stored state, so a slow tick can
  // leave it rendering a lifecycle that contradicts the switch the user just
  // flipped. Persist the typed transition up front instead.
  async function markPlatformsStarting(
    platforms: readonly Platform[],
    transitionIsCurrent: () => boolean = () => true,
  ): Promise<void> {
    await withStateLock(async () => {
      const state = await deps.loadState();
      if (!transitionIsCurrent()) return;
      let changed = false;
      const sessions = { ...state.sessions };
      for (const platform of platforms) {
        const session = state.sessions[platform];
        // An already-watching platform is not "starting" — leave its live status
        // (and its channel) alone so a toggle elsewhere never blanks it.
        if (session.status === "watching") continue;
        sessions[platform] = {
          ...session,
          status: "starting",
          message: "Starting automation",
          reasonCode: "no_existing_session",
        };
        changed = true;
      }
      if (!changed) return;
      if (!transitionIsCurrent()) return;
      await saveOperationalState({ ...state, sessions });
      if (!transitionIsCurrent()) {
        await saveOperationalState(state);
      }
    });
  }

  // The normal entry point for alarm- and message-driven ticks: run the tick,
  // then hand off for every platform that claimed. Kept separate from tick() so
  // the handoff's own inner ticks cannot recurse into another handoff.
  async function tickAndHandOff(
    platforms?: Platform[],
    trigger: TickTrigger = "unknown",
  ): Promise<SchedulerState | undefined> {
    let committedState: SchedulerState | undefined;
    const captureCommittedState = (state: SchedulerState): void => {
      committedState = state;
    };
    const claimed = await tick(platforms, trigger, captureCommittedState);
    const handoffPlatforms = Object.keys(claimed) as Platform[];
    const results = await Promise.allSettled(handoffPlatforms.map((platform) =>
      runClaimHandoff(platform, claimed[platform] ?? [], captureCommittedState)));
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status !== "rejected") continue;
      diagnosticEvent(
        "warn",
        `Post-claim handoff failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        handoffPlatforms[index],
      );
    }
    return committedState;
  }

  async function recordPlaybackTelemetry(
    message: Extract<CoreRuntimeMessage, { type: "playbackTelemetry" }>,
    senderTabId?: number,
  ): Promise<void> {
    let manualWatchStarted = false;
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const [settings, state] = await Promise.all([deps.loadSettings(), deps.loadState()]);
      const session = state.sessions[message.platform];
      const isManagedWatchTab = senderTabId != null
        && session.status === "watching"
        && session.watchMode !== "tabless"
        && session.tabId === senderTabId;

      if (!isManagedWatchTab) {
        if (senderTabId != null) {
          const manualWatch = recordManualWatchTelemetry(state, settings, message, senderTabId);
          manualWatchStarted = manualWatch.started;
          await persistPlatformAndReport(
            message.platform,
            manualWatch.state,
            events,
          );
        }
        return;
      }

      const previous = session.playback;
      const telemetry = message.telemetry;
      let nextState: SchedulerState = {
        ...state,
        sessions: {
          ...state.sessions,
          [message.platform]: {
            ...session,
            playback: {
              ...telemetry,
              platform: message.platform,
              checkedAt: new Date().toISOString(),
            },
            // Telemetry arrives between scheduler ticks. Clearing the counter the
            // moment playback is confirmed means a tab that dipped unhealthy and
            // recovered is never condemned by a stale count (#250).
            playbackChecks: isPlaybackTelemetryHealthy(telemetry) ? 0 : session.playbackChecks,
          },
        },
      };

      // Only log transitions — telemetry arrives every few seconds, so logging the
      // raw stream would bury everything else.
      const playbackDiagnostics = session.status === "watching"
        ? playbackEvents(message.platform, previous, telemetry)
        : [];
      for (const event of playbackDiagnostics) emit(event);

      await persistPlatformState(message.platform, nextState);
      if ((previous ? isPlaybackTelemetryHealthy(previous) : undefined)
        !== isPlaybackTelemetryHealthy(telemetry)) {
        invalidateSelection(message.platform);
      }
      try {
        if (deps.applyAdFocus && session.status === "watching" && session.tabId === senderTabId) {
          await deps.applyAdFocus(message.platform, session.tabId, Boolean(message.telemetry.adActive), emit);
        }
      } catch (error) {
        emitHostCallbackError(emit, message.platform, error, "Could not apply ad focus");
      } finally {
        await reportBestEffort(events);
      }
    }), [message.platform]);
    if (manualWatchStarted) tickInBackground([message.platform], "manual_watch");
  }

  function recordManualWatchTelemetry(
    state: SchedulerState,
    settings: EngineSettings,
    message: Extract<CoreRuntimeMessage, { type: "playbackTelemetry" }>,
    senderTabId: number,
  ): { state: SchedulerState; started: boolean } {
    const manualWatch = { ...state.manualWatch };
    if (!settings.pauseOnManualWatch) {
      delete manualWatch[message.platform];
      return { state: { ...state, manualWatch }, started: false };
    }

    const active = message.telemetry.playingVideoCount > 0 && !message.telemetry.documentHidden;
    const previous = manualWatch[message.platform];
    const recentPrevious = previous?.active && !isTimestampStale(previous.checkedAt, MANUAL_WATCH_TTL_MS, Date.now());
    if (!active && previous?.tabId !== senderTabId && recentPrevious) {
      return { state, started: false };
    }

    manualWatch[message.platform] = {
      platform: message.platform,
      tabId: senderTabId,
      checkedAt: new Date().toISOString(),
      active,
    };
    return {
      state: { ...state, manualWatch },
      started: active && !recentPrevious,
    };
  }

  async function applyAdFocusForState(
    state: SchedulerState,
    emit: EventEmitter,
    platforms: readonly Platform[] = PLATFORMS,
  ): Promise<void> {
    if (!deps.applyAdFocus) return;
    for (const platform of platforms) {
      const session = state.sessions[platform];
      const watching = session.status === "watching" && session.tabId != null;
      try {
        await deps.applyAdFocus(platform, session.tabId, watching && Boolean(session.playback?.adActive), emit);
      } catch (error) {
        emitHostCallbackError(emit, platform, error, "Could not apply ad focus");
      }
    }
  }

  async function getPlaybackControl(
    message: Extract<CoreRuntimeMessage, { type: "getPlaybackControl" }>,
    senderTabId?: number,
  ): Promise<PlaybackControl> {
    const [policy, state] = await Promise.all([deps.loadTabPlaybackPolicy?.(), deps.loadState()]);
    const session = state.sessions[message.platform];
    return {
      managed: senderTabId != null
        && session.status === "watching"
        && session.tabId === senderTabId,
      keepVideosUnmuted: policy?.keepVideosUnmuted ?? true,
    };
  }

  async function claimRewardNow(
    message: Extract<CoreRuntimeMessage, { type: "claimReward" }>,
  ): Promise<RuntimeSnapshot<S>> {
    // Hold the owning platform lock across the whole load→persist so a concurrent
    // same-platform tick or telemetry write can't clobber the claimed-reward
    // update. The short commit merges this slice with any sibling-platform write.
    let claimedManually = false;
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const [settings, state] = await Promise.all([deps.loadSettings(), deps.loadState()]);
      const campaigns = state.campaigns[message.platform];
      const campaign = campaigns.find((item) => item.id === message.campaignId);
      const reward = campaign?.rewards.find((item) => item.id === message.rewardId);

      if (!campaign || !reward) {
        emit({
          category: "diagnostic",
          platform: message.platform,
          level: "warn",
          message: "Reward claim skipped because the campaign or reward is no longer available",
        });
        await persistPlatformAndReport(message.platform, state, events);
        return;
      }

      if (!canClaimReward(reward)) {
        emit({
          category: "diagnostic",
          platform: message.platform,
          level: "warn",
          message: `${reward.name} is not ready to claim`,
        });
        await persistPlatformAndReport(message.platform, state, events);
        return;
      }

      let stateWithCampaigns: SchedulerState;
      try {
        const claimed = await createAdapters(settings, emit)[message.platform].claimReward(campaign, reward);
        claimedManually = claimed;
        const nextCampaigns = campaigns.map((item) => {
          if (item.id !== campaign.id) return item;
          const rewards = item.rewards.map((candidate) => candidate.id === reward.id && claimed
            ? { ...candidate, status: "claimed" as const, watchedMinutes: candidate.requiredMinutes }
            : candidate);
          return reconcileCampaignAfterClaims(item, rewards);
        });
        stateWithCampaigns = {
          ...state,
          campaigns: {
            ...state.campaigns,
            [message.platform]: nextCampaigns,
          },
        };
        const claimEvent: EngineEvent = claimed
          ? {
            category: "activity",
            platform: message.platform,
            level: "info",
            code: "reward_claimed",
            data: {
              campaignId: campaign.id,
              campaignName: campaign.name,
              rewardId: reward.id,
              rewardName: reward.name,
              ...(reward.imageUrl ? { rewardImageUrl: reward.imageUrl } : {}),
              ...(campaign.url ? { campaignUrl: campaign.url } : {}),
              method: "manual",
            },
          }
          : {
            category: "diagnostic",
            platform: message.platform,
            level: "warn",
            message: `Could not claim ${reward.name} from ${campaign.name}`,
          };
        emit(claimEvent);
        if (claimed && settings.notifyRewardEarned) {
          await safeNotify(
            await tr("notificationRewardClaimed"),
            await tr("notificationRewardFromCampaign", [reward.name, campaign.name]),
          );
        }
      } catch (error) {
        clearOperationalEvents(events);
        emit({
          category: "diagnostic",
          platform: message.platform,
          level: "error",
          message: error instanceof Error ? error.message : `Claim failed for ${reward.name}`,
        });
        await persistPlatformAndReport(message.platform, state, events);
        return;
      }
      await persistPlatformAndReport(message.platform, stateWithCampaigns, events);
    }), [message.platform]);
    // Outside the lock: runClaimHandoff ticks, which takes the lock itself.
    if (claimedManually) await runClaimHandoff(message.platform, [message.rewardId]);
    return snapshot();
  }

  async function handleMessage(
    message: CoreRuntimeMessage,
    sender?: { tab?: { id?: number } },
  ): Promise<RuntimeSnapshot<S> | PlaybackControl | CategorySearchResult | void> {
    if (message.type === "getPlaybackControl") {
      return getPlaybackControl(message, sender?.tab?.id);
    }

    if (message.type === "playbackTelemetry") {
      await recordPlaybackTelemetry(message, sender?.tab?.id);
      return undefined;
    }

    if (message.type === "getSnapshot") {
      return snapshot();
    }

    // setPlatformEnabled and setAutomation are the same operation now that there
    // is no master switch to flip alongside the platform flag. Both are kept:
    // they are separate wire messages with existing callers.
    if (message.type === "setPlatformEnabled" || message.type === "setAutomation") {
      const platformLabel = message.platform === "twitch" ? "Twitch" : "Kick";
      const action = message.enabled ? "enable" : "disable";
      diagnosticEvent("info", `User requested ${platformLabel} automation ${action}`, message.platform);
      if (activePlatformTicks[message.platform] > 0) {
        diagnosticEvent(
          "info",
          `${platformLabel} automation ${action} queued behind an active tick`,
          message.platform,
        );
      }
      // Stopping must cancel any loop still refreshing in the background.
      if (!message.enabled) abortClaimHandoffs(message.platform);
      const twitchTransitionGeneration = message.platform === "twitch"
        ? ++twitchSettingsTransitionGeneration
        : undefined;
      const twitchTransitionIsCurrent = (): boolean =>
        !controllerShutdown
        && twitchTransitionGeneration === twitchSettingsTransitionGeneration;
      const twitchLifecycleOpenBeforeTransition = message.platform === "twitch"
        ? integrityLifecycleOpen
        : undefined;
      let twitchSettingsLoaded = false;
      const stoppingTwitch = message.platform === "twitch" && !message.enabled;
      if (stoppingTwitch) closeTwitchIntegrityLifecycle("Twitch disabled");
      try {
        await updateStoredSettings({
          platform: {
            [message.platform]: {
              enabled: message.enabled,
            },
          },
        }, message.platform === "twitch"
          ? (settings) => {
              lastPersistedTwitchEnabled = settings.platform.twitch.enabled;
              if (twitchTransitionIsCurrent()) {
                reconcileTwitchIntegrityLifecycle(settings.platform.twitch.enabled);
              }
            }
          : undefined,
        message.platform === "twitch"
          ? (settings) => {
              twitchSettingsLoaded = true;
              lastPersistedTwitchEnabled = settings.platform.twitch.enabled;
            }
          : undefined);
      } catch (error) {
        if (message.platform === "twitch" && twitchTransitionIsCurrent()) {
          const rollbackEnabled = twitchSettingsLoaded
            ? lastPersistedTwitchEnabled
            : twitchLifecycleOpenBeforeTransition;
          reconcileTwitchIntegrityLifecycle(rollbackEnabled);
          if (stoppingTwitch && rollbackEnabled === true) {
            await restoreTwitchIntegritySchedule(twitchTransitionIsCurrent);
          }
        }
        throw error;
      }
      discoverySignalPlatformBlocked[message.platform] = !message.enabled;
      if (!message.enabled) {
        await stopDiscoverySignalControllersAndReport([message.platform]);
      }
      if (message.platform === "twitch") {
        if (!twitchTransitionIsCurrent()) return snapshot();
        if (message.enabled) {
          await restoreTwitchIntegritySchedule(twitchTransitionIsCurrent);
        } else {
          await clearTwitchIntegrityAlarmBestEffort();
        }
        if (!twitchTransitionIsCurrent()) return snapshot();
      }
      if (message.enabled) {
        await markPlatformsStarting(
          [message.platform],
          message.platform === "twitch"
            ? twitchTransitionIsCurrent
            : undefined,
        );
        if (message.platform === "twitch" && !twitchTransitionIsCurrent()) {
          return snapshot();
        }
      }
      // Always scoped to the toggled platform. Nothing about this change can
      // affect the other one any more, so it is never dragged through this
      // platform's discovery.
      tickInBackground(
        [message.platform],
        message.type === "setAutomation" ? "automation_toggle" : "platform_toggle",
        () => diagnosticEvent("info", `${platformLabel} automation ${action} completed`, message.platform),
      );
      return snapshot();
    }

    if (message.type === "saveSettings") {
      const settings = await updateStoredSettings(message.settingsPatch);
      if (message.tickAfterSave && isFarmingActive(settings)) {
        tickInBackground(message.tickAfterSavePlatforms, "settings_saved");
      }
      return snapshot();
    }

    if (message.type === "resumeAfterManualClose") {
      await resumeAfterManualClose(message.platform);
      const settings = await deps.loadSettings();
      if (settings.platform[message.platform].enabled) {
        await markPlatformsStarting([message.platform]);
        tickInBackground([message.platform], "manual_resume");
      }
      return snapshot();
    }

    if (message.type === "claimReward") {
      return claimRewardNow(message);
    }

    if (message.type === "searchCategories") {
      return withEventCollector(async (emit, events) => {
        const settings = await deps.loadSettings();
        let categories: CategorySearchResult["categories"] = [];
        try {
          categories = await createAdapters(settings, emit)[message.platform].searchCategories?.(message.query) ?? [];
        } catch (error) {
          emit({
            category: "diagnostic",
            level: "warn",
            message: `Category search failed: ${error instanceof Error ? error.message : String(error)}`,
            platform: message.platform,
          });
        }
        await reportBestEffort(events);
        return { categories };
      });
    }

    if (message.type === "tickNow") {
      await tickAndHandOff(undefined, "manual_tick");
      return snapshot();
    }
    if (message.type === "dismissCriticalFailure") {
      // Serialized like every other load→mutate→persist handler here: a dismiss
      // racing an alarm-driven tick would otherwise interleave loads and drop
      // one side's write to the persisted state.
      await withStateLock(() => withEventCollector(async (emit, events) => {
        const state = await deps.loadState();
        const transition = dismissCriticalFailure(state, message.platform, Date.now());
        if (transition.event) emit(transition.event);
        // Closing the breaker here is what lets farming resume immediately
        // instead of waiting for the next tick to sync the registry.
        syncManagedTabBreakers(transition.state, [message.platform]);
        await persistAndReport(transition.state, events);
      }));
      await tickAndHandOff(undefined, "critical_failure_dismissed");
      return snapshot();
    }
  }

  async function safeNotify(title: string, message: string): Promise<void> {
    if (!deps.createNotification) return;
    try {
      await deps.createNotification({ title, message });
    } catch {
      // Notification delivery is best-effort and must not fail scheduler ticks.
    }
  }

  async function tr(key: string, substitutions?: string | string[]): Promise<string> {
    const translated = await deps.translate?.(key, substitutions);
    if (translated) return translated;
    const template = EN_RUNTIME_MESSAGES[key] ?? key;
    const values = Array.isArray(substitutions)
      ? substitutions
      : substitutions == null
        ? []
        : [substitutions];
    return values.reduce((text, value, index) => text.replaceAll(`$${index + 1}`, value), template);
  }

  async function emitNotifications(
    settings: EngineSettings,
    previous: SchedulerState,
    next: SchedulerState,
    tickEvents: readonly EngineEvent[] = [],
  ): Promise<void> {
    if (settings.notifyRewardEarned) {
      for (const reward of newlyEarnedRewards(previous, next)) {
        await safeNotify(
          await tr("notificationRewardEarned"),
          await tr("notificationRewardFromCampaign", [reward.reward.name, reward.campaign.name]),
        );
      }
      // Challenge claims never enter SchedulerState, so they come from the tick's
      // events instead of a state diff. They ride notifyRewardEarned deliberately:
      // one more toggle for a single event type is not worth the settings surface.
      for (const event of tickEvents) {
        if (event.category !== "activity" || event.code !== "challenge_claimed") continue;
        await safeNotify(
          await tr("notificationChallengeClaimed"),
          await tr("notificationChallengeReward", [event.data.rarity, event.data.recurrence]),
        );
      }
    }

    if (settings.notifyNoDropsLeft) {
      const isDropsExhausted = (state: SchedulerState, platform: Platform): boolean =>
        state.sessions[platform].status === "idle"
        && state.campaigns[platform].length > 0
        && state.campaigns[platform].every((campaign) => !hasEarnableReward(campaign));

      for (const platform of ["twitch", "kick"] as Platform[]) {
        if (
          settings.platform[platform].enabled
          // Only on the transition into the exhausted state, so the
          // notification fires once instead of re-firing every tick (~1/min)
          // for as long as the platform stays out of earnable drops.
          && isDropsExhausted(next, platform)
          && !isDropsExhausted(previous, platform)
        ) {
          await safeNotify(
            await tr("notificationNoDropsLeft"),
            await tr("notificationNoDropsLeftMessage", platformLabel(platform)),
          );
        }
      }
    }
  }

  return {
    ensureAlarm,
    ensureInstalledAt,
    handleStartup,
    handleTabRemoved,
    handleMessage,
    resumeAfterManualClose,
    captureTwitchIntegrity,
    runTwitchIntegrityRefresh,
    checkAuthHealth,
    invalidateAuthHealth,
    tick,
    tickAndHandOff,
    refreshDiscovery,
    discoverySnapshot,
    runWatchHeartbeat,
    runClaimHandoff,
    abortClaimHandoffs,
    shutdown,
    prepareForHostReset,
    settleBackgroundWork,
  };
}

function farmingLifecycleEvents(previous: SchedulerState, next: SchedulerState): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const platform of ["twitch", "kick"] as Platform[]) {
    const before = farmingTarget(previous, platform);
    const after = farmingTarget(next, platform);
    const sameTarget = Boolean(
      before
      && after
      && before.campaign.id === after.campaign.id
      && before.reward.id === after.reward.id,
    );
    if (sameTarget) continue;

    if (before) {
      const updatedReward = next.campaigns[platform]
        .find((campaign) => campaign.id === before.campaign.id)
        ?.rewards.find((reward) => reward.id === before.reward.id);
      const reason = updatedReward?.status === "claimed" || updatedReward?.status === "claimable"
        ? "watch_requirement_completed"
        : farmingStopReason(next.sessions[platform]);
      events.push({
        category: "activity",
        platform,
        level: next.sessions[platform].status === "error" ? "error" : "info",
        code: "farming_stopped",
        data: {
          campaignId: before.campaign.id,
          campaignName: before.campaign.name,
          rewardId: before.reward.id,
          rewardName: before.reward.name,
          ...(before.reward.imageUrl ? { rewardImageUrl: before.reward.imageUrl } : {}),
          ...(before.campaign.url ? { campaignUrl: before.campaign.url } : {}),
          reason,
        },
      });
    }
    if (after) {
      events.push({
        category: "activity",
        platform,
        level: "info",
        code: "farming_started",
        data: {
          campaignId: after.campaign.id,
          campaignName: after.campaign.name,
          rewardId: after.reward.id,
          rewardName: after.reward.name,
          ...(after.reward.imageUrl ? { rewardImageUrl: after.reward.imageUrl } : {}),
          ...(after.campaign.url ? { campaignUrl: after.campaign.url } : {}),
          ...(after.session.channel ? { channel: after.session.channel.displayName ?? after.session.channel.username } : {}),
        },
      });
    } else if (!before) {
      const session = next.sessions[platform];
      const prior = previous.sessions[platform];
      const changed = session.status !== prior.status || session.message !== prior.message;
      const actionable = session.status === "error" || session.reasonCode === "manual_watch";
      if (changed && actionable) {
        const reason = farmingStopReason(session);
        events.push({
          category: "activity",
          platform,
          level: session.status === "error" ? "error" : "warn",
          code: "interruption",
          data: { reason, ...(session.message ? { detail: session.message } : {}) },
        });
      }
    }
  }
  return events;
}

function farmingTarget(state: SchedulerState, platform: Platform): {
  session: WatchSession;
  campaign: DropCampaign;
  reward: DropReward;
} | undefined {
  const session = state.sessions[platform];
  if (session.status !== "watching" || !session.campaignId || !session.rewardId) return undefined;
  const campaign = state.campaigns[platform].find((candidate) => candidate.id === session.campaignId);
  const reward = campaign?.rewards.find((candidate) => candidate.id === session.rewardId);
  return campaign && reward ? { session, campaign, reward } : undefined;
}

function farmingStopReason(session: WatchSession): FarmingStopReason {
  const code = session.reasonCode;
  return code && isFarmingStopReason(code)
    ? code
    : session.status === "error" ? "platform_error" : "target_changed";
}

function isFarmingStopReason(code: WatchReasonCode): code is FarmingStopReason {
  return Object.prototype.hasOwnProperty.call(FARMING_STOP_REASON_CODES, code);
}

function staleStartupCleanup(state: SchedulerState, preservePageContexts = false): {
  hasStaleSession: boolean;
  managedTabs: ManagedWatchTab[];
  state: SchedulerState;
} {
  let hasStaleSession = false;
  const managedTabs = new Map<number, ManagedWatchTab>();
  const sessions = { ...state.sessions };

  for (const platform of ["twitch", "kick"] as Platform[]) {
    const session = state.sessions[platform];
    const managedTab = state.managedWatchTabs?.[platform];
    const managedPageContextTab = state.managedPageContextTabs?.[platform];
    if (managedTab?.ownedByExtension) managedTabs.set(managedTab.tabId, managedTab);

    if (session.status === "watching" || session.tabId != null || managedTab || (!preservePageContexts && managedPageContextTab)) {
      hasStaleSession = true;
      sessions[platform] = pausedStartupSession(session);
    }
  }

  return {
    hasStaleSession,
    managedTabs: [...managedTabs.values()],
    state: {
      ...state,
      sessions,
      managedWatchTabs: {},
      managedPageContextTabs: preservePageContexts ? state.managedPageContextTabs : {},
    },
  };
}

function pausedStartupSession(session: WatchSession): WatchSession {
  return {
    ...session,
    status: "paused",
    channel: undefined,
    campaignId: undefined,
    rewardId: undefined,
    tabId: undefined,
    tabManagedByExtension: undefined,
    playback: undefined,
    playbackChecks: 0,
    errorChecks: 0,
    retryAfter: undefined,
    message: "Browser restarted; farming paused",
    reasonCode: "runtime_restart",
  };
}

function hasEnabledPlatform(settings: EngineSettings): boolean {
  return (["twitch", "kick"] as Platform[]).some((platform) => settings.platform[platform].enabled);
}

function newlyEarnedRewards(
  previous: SchedulerState,
  next: SchedulerState,
): Array<{ campaign: DropCampaign; reward: DropReward }> {
  const previousStatuses = new Map<string, DropReward["status"]>();
  for (const platform of ["twitch", "kick"] as Platform[]) {
    for (const campaign of previous.campaigns[platform]) {
      for (const reward of campaign.rewards) {
        previousStatuses.set(`${platform}:${campaign.id}:${reward.id}`, reward.status);
      }
    }
  }

  const earned: Array<{ campaign: DropCampaign; reward: DropReward }> = [];
  for (const platform of ["twitch", "kick"] as Platform[]) {
    for (const campaign of next.campaigns[platform]) {
      for (const reward of campaign.rewards) {
        const before = previousStatuses.get(`${platform}:${campaign.id}:${reward.id}`);
        if ((reward.status === "claimable" || reward.status === "claimed") && before !== reward.status) {
          earned.push({ campaign, reward });
        }
      }
    }
  }
  return earned;
}

function hasEarnableReward(campaign: DropCampaign): boolean {
  return campaign.status === "active"
    && !hasCampaignEnded(campaign)
    && campaign.accountLinked !== false
    && (!campaign.eligibility || campaign.eligibility === "eligible")
    && campaign.rewards.some((reward) => isWatchReward(reward) && reward.status !== "claimed" && reward.status !== "claimable" && reward.preconditionsMet !== false);
}

function hasCampaignEnded(campaign: DropCampaign): boolean {
  if (!campaign.endsAt) return false;
  const endsAt = Date.parse(campaign.endsAt);
  return !Number.isNaN(endsAt) && endsAt < Date.now();
}

function canClaimReward(reward: DropReward): boolean {
  if (reward.status !== "claimable") return false;
  if (!reward.claimUntil) return true;
  const claimUntil = Date.parse(reward.claimUntil);
  return Number.isNaN(claimUntil) || Date.now() < claimUntil;
}

function platformLabel(platform: Platform): string {
  return platform === "twitch" ? "Twitch" : "Kick";
}
