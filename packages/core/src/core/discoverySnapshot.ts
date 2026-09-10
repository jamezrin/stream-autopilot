import type { ChannelCandidate, DropCampaign, EngineSettings, Platform, WatchSession } from "@lurkloot/shared/models";
import { evaluateCampaignFarming } from "@lurkloot/shared/campaignFarming";
import type { ChannelCheckRequest, PlatformAdapter } from "../platforms/adapter";

export type ChannelEligibility = true | false | "unknown";

export interface DiscoveryCandidateObservation {
  candidate: ChannelCandidate;
  live: boolean;
  categoryMatches: boolean;
  eligible: ChannelEligibility;
  observedAt: number;
}

export interface DiscoveryCampaignObservation {
  campaign: DropCampaign;
  candidates: DiscoveryCandidateObservation[];
}

export interface DiscoveryRefreshMetrics {
  campaigns: number;
  skippedBeforeChannelWork?: number;
  uniqueChannelChecks?: number;
  candidates: number;
  cacheHits: number;
  cacheMisses: number;
  batchRequests: number;
  singleFallbacks: number;
}

export interface DiscoverySnapshot {
  platform: Platform;
  revision: number;
  observedAt: number;
  campaigns: DiscoveryCampaignObservation[];
  idleCandidates: DiscoveryCandidateObservation[];
  followedChannels: string[];
  complete: true;
  metrics: DiscoveryRefreshMetrics;
}

export interface DiscoveryAttempt {
  startedAt: number;
  finishedAt: number;
  complete: boolean;
  failure?: string;
  discarded?: "stale_generation" | "stopped";
  coalesced: number;
  metrics?: DiscoveryRefreshMetrics;
}

export interface DiscoverySnapshotState {
  snapshot?: DiscoverySnapshot;
  lastAttempt?: DiscoveryAttempt;
}

export interface DiscoveryRefreshResult {
  campaigns: DiscoveryCampaignObservation[];
  idleCandidates: DiscoveryCandidateObservation[];
  followedChannels: string[];
  complete: boolean;
  failure?: string;
  metrics: DiscoveryRefreshMetrics;
}

export interface DiscoveryRefreshContext<TRequest = undefined> {
  generation: number;
  signal: AbortSignal;
  request: TRequest;
}

export type DiscoverySnapshotListener = (state: Readonly<DiscoverySnapshotState>) => void | Promise<void>;

export async function collectDiscoverySnapshot(
  adapter: Pick<PlatformAdapter, "platform" | "refreshCampaigns" | "listCandidateChannels" | "checkChannel" | "checkChannels" | "selectCandidateChannel" | "listFollowedChannels">,
  session: Parameters<PlatformAdapter["refreshCampaigns"]>[0],
  signal: AbortSignal,
  now: () => number = Date.now,
  includeFollowedChannels = true,
  idleCandidates: ChannelCandidate[] = [],
  retainedCampaignCandidates?: (campaign: DropCampaign, campaigns: DropCampaign[]) => DiscoveryCandidateObservation[] | undefined,
  settings?: EngineSettings,
  reconcileCampaigns: (campaigns: DropCampaign[]) => DropCampaign[] = (campaigns) => campaigns,
): Promise<DiscoveryRefreshResult> {
  // Both operations belong to this refresh's fetch-observation lifecycle. Drain
  // the pair even when inventory fails before a followed-channel fallback ends.
  const [campaignResult, followedResult] = await Promise.allSettled([
    adapter.refreshCampaigns(session, { signal, requireComplete: true }),
    includeFollowedChannels
      ? adapter.listFollowedChannels?.({ signal, requireComplete: true }) ?? Promise.resolve([])
      : Promise.resolve([]),
  ]);
  signal.throwIfAborted();
  if (campaignResult.status === "rejected") throw campaignResult.reason;
  if (followedResult.status === "rejected") throw followedResult.reason;
  const campaigns = reconcileCampaigns(campaignResult.value);
  const followedChannels = followedResult.value;
  const observations: DiscoveryCampaignObservation[] = [];
  const batchRequestsToCheck: ChannelCheckRequest[] = [];
  const batchDestinations: DiscoveryCandidateObservation[][] = [];
  let candidatesChecked = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let batchRequests = 0;
  let singleFallbacks = 0;
  let skippedBeforeChannelWork = 0;
  let uniqueChannelChecks = 0;
  const eligibilityTime = now();
  for (const campaign of campaigns) {
    signal.throwIfAborted();
    if (settings && !evaluateCampaignFarming(campaign, settings, { includePriorityMode: true, now: eligibilityTime }).farmable) {
      observations.push({ campaign, candidates: [] });
      skippedBeforeChannelWork += 1;
      continue;
    }
    const retainedCandidates = retainedCampaignCandidates?.(campaign, campaigns);
    if (retainedCandidates) {
      observations.push({ campaign, candidates: retainedCandidates });
      continue;
    }
    const listedCandidates = await adapter.listCandidateChannels(campaign, { signal, requireComplete: true });
    const candidates = session?.campaignId === campaign.id && session.channel
      ? [...new Map(
          [session.channel, ...listedCandidates]
            .map((candidate) => [candidate.username.toLowerCase(), candidate] as const),
        ).values()]
      : listedCandidates;
    const observed: DiscoveryCandidateObservation[] = [];
    if (adapter.checkChannels) {
      for (const candidate of candidates) {
        batchRequestsToCheck.push({ channel: candidate, campaign });
        batchDestinations.push(observed);
      }
    } else if (adapter.selectCandidateChannel) {
      const selection = await adapter.selectCandidateChannel(candidates, campaign, { signal });
      candidatesChecked += selection.checked;
      cacheHits += selection.metrics?.cacheHits ?? 0;
      cacheMisses += selection.metrics?.cacheMisses ?? 0;
      batchRequests += selection.metrics?.batchRequests ?? 0;
      singleFallbacks += selection.metrics?.singleFallbacks ?? 0;
      observed.push(...(selection.observations ?? (selection.channel
        ? [{ live: true, categoryMatches: true, candidate: selection.channel }]
        : [])).map((check) => ({
        candidate: check.candidate,
        live: check.live,
        categoryMatches: check.categoryMatches,
        eligible: check.campaignMatches ?? "unknown" as const,
        observedAt: now(),
      })));
    } else {
      for (const candidate of candidates) {
        signal.throwIfAborted();
        const check = await adapter.checkChannel(candidate, { campaign, signal });
        candidatesChecked += 1;
        observed.push({
          candidate: check.candidate,
          live: check.live,
          categoryMatches: check.categoryMatches,
          eligible: check.campaignMatches ?? "unknown",
          observedAt: now(),
        });
        if (check.live && check.categoryMatches && check.campaignMatches !== false) break;
      }
    }
    observations.push({ campaign, candidates: observed });
  }
  const observedIdleCandidates: DiscoveryCandidateObservation[] = [];
  if (adapter.checkChannels) {
    for (const candidate of idleCandidates) {
      batchRequestsToCheck.push({ channel: candidate });
      batchDestinations.push(observedIdleCandidates);
    }
    const batch = await adapter.checkChannels(batchRequestsToCheck, { signal, requireComplete: true });
    signal.throwIfAborted();
    if (batch.checks.length !== batchRequestsToCheck.length) throw new Error("Channel discovery batch was incomplete");
    uniqueChannelChecks = batch.uniqueChannelChecks;
    const satisfiedCampaigns = new Set<string>();
    for (const [index, request] of batchRequestsToCheck.entries()) {
      const check = batch.checks[index];
      if (!check) {
        if (!request.campaign || !satisfiedCampaigns.has(request.campaign.id)) {
          throw new Error("Channel discovery batch was incomplete");
        }
        continue;
      }
      candidatesChecked += 1;
      if (request.campaign && check.live && check.categoryMatches && check.campaignMatches !== false) {
        satisfiedCampaigns.add(request.campaign.id);
      }
      batchDestinations[index]!.push({
        candidate: check.candidate,
        live: check.live,
        categoryMatches: check.categoryMatches,
        eligible: request.campaign ? check.campaignMatches ?? "unknown" : "unknown",
        observedAt: now(),
      });
    }
  } else if (adapter.selectCandidateChannel) {
    const selection = await adapter.selectCandidateChannel(idleCandidates, undefined, { signal });
    candidatesChecked += selection.checked;
    cacheHits += selection.metrics?.cacheHits ?? 0;
    cacheMisses += selection.metrics?.cacheMisses ?? 0;
    batchRequests += selection.metrics?.batchRequests ?? 0;
    singleFallbacks += selection.metrics?.singleFallbacks ?? 0;
    observedIdleCandidates.push(...(selection.observations ?? (selection.channel
      ? [{ live: true, categoryMatches: true, candidate: selection.channel }]
      : [])).map((check) => ({
      candidate: check.candidate,
      live: check.live,
      categoryMatches: check.categoryMatches,
      eligible: "unknown" as const,
      observedAt: now(),
    })));
  } else {
    for (const candidate of idleCandidates) {
      signal.throwIfAborted();
      const check = await adapter.checkChannel(candidate, { signal });
      candidatesChecked += 1;
      observedIdleCandidates.push({
        candidate: check.candidate,
        live: check.live,
        categoryMatches: check.categoryMatches,
        eligible: "unknown",
        observedAt: now(),
      });
    }
  }
  return {
    campaigns: observations,
    idleCandidates: observedIdleCandidates,
    followedChannels,
    complete: true,
    metrics: {
      campaigns: campaigns.length,
      skippedBeforeChannelWork,
      uniqueChannelChecks: adapter.checkChannels ? uniqueChannelChecks : candidatesChecked,
      candidates: candidatesChecked,
      cacheHits,
      cacheMisses,
      batchRequests,
      singleFallbacks,
    },
  };
}

export function adapterFromDiscoverySnapshot(
  adapter: PlatformAdapter,
  snapshot: DiscoverySnapshot | undefined,
  session?: WatchSession,
): PlatformAdapter {
  const campaigns = new Map((snapshot?.campaigns ?? []).map((observation) => [observation.campaign.id, observation]));
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property === "listCandidateChannels") {
        return async (campaign: DropCampaign): Promise<ChannelCandidate[]> =>
          campaigns.get(campaign.id)?.candidates.map(({ candidate }) => candidate) ?? [];
      }
      if (property === "selectCandidateChannel") return undefined;
      if (property === "listFollowedChannels") {
        return async (): Promise<string[]> => [...(snapshot?.followedChannels ?? [])];
      }
      if (property === "checkChannel") {
        return async (candidate: ChannelCandidate, options?: { campaign?: DropCampaign }) => {
          const observations = options?.campaign
            ? campaigns.get(options.campaign.id)?.candidates ?? []
            : snapshot?.idleCandidates ?? [];
          const observation = observations.find(({ candidate: observed }) =>
            observed.username.toLowerCase() === candidate.username.toLowerCase());
          if (!observation) {
            const currentChannel = session?.channel;
            if (options?.campaign && session?.campaignId === options.campaign.id && currentChannel
              && currentChannel.username.toLowerCase() === candidate.username.toLowerCase()) {
              return { live: true, categoryMatches: true, candidate: currentChannel };
            }
            return { live: false, categoryMatches: false, candidate };
          }
          return {
            live: observation.live,
            categoryMatches: observation.categoryMatches,
            campaignMatches: observation.eligible === "unknown" ? undefined : observation.eligible,
            candidate: observation.candidate,
          };
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function selectionAdapterFromDiscoverySnapshot(
  snapshot: DiscoverySnapshot,
  session?: WatchSession,
): Pick<PlatformAdapter, "listCandidateChannels" | "selectCandidateChannel" | "checkChannel" | "listFollowedChannels"> {
  const campaigns = new Map(snapshot.campaigns.map((observation) => [observation.campaign.id, observation]));
  return {
    listCandidateChannels: async (campaign) =>
      campaigns.get(campaign.id)?.candidates.map(({ candidate }) => candidate) ?? [],
    selectCandidateChannel: undefined,
    listFollowedChannels: async () => [...snapshot.followedChannels],
    checkChannel: async (candidate, options) => {
      const observations = options?.campaign
        ? campaigns.get(options.campaign.id)?.candidates ?? []
        : snapshot.idleCandidates;
      const observation = observations.find(({ candidate: observed }) =>
        observed.username.toLowerCase() === candidate.username.toLowerCase());
      if (!observation) {
        const currentChannel = session?.channel;
        if (options?.campaign && session?.campaignId === options.campaign.id && currentChannel
          && currentChannel.username.toLowerCase() === candidate.username.toLowerCase()) {
          return { live: true, categoryMatches: true, candidate: currentChannel };
        }
        return { live: false, categoryMatches: false, candidate };
      }
      return {
        live: observation.live,
        categoryMatches: observation.categoryMatches,
        campaignMatches: observation.eligible === "unknown" ? undefined : observation.eligible,
        candidate: observation.candidate,
      };
    },
  };
}

export class DiscoverySnapshotLane<TRequest = undefined> {
  private state: DiscoverySnapshotState = {};
  private generation = 0;
  private revision = 0;
  private running = false;
  private pending = false;
  private pendingCount = 0;
  private pendingRequest?: TRequest;
  private stopped = false;
  private abort?: AbortController;
  private settled: Promise<void> = Promise.resolve();

  constructor(
    readonly platform: Platform,
    private readonly refresh: (context: DiscoveryRefreshContext<TRequest>) => Promise<DiscoveryRefreshResult>,
    private readonly onState?: DiscoverySnapshotListener,
    private readonly now: () => number = Date.now,
  ) {}

  current(): Readonly<DiscoverySnapshotState> {
    return this.state;
  }

  request(request?: TRequest): void {
    if (this.stopped) return;
    if (this.running) {
      this.pending = true;
      this.pendingCount += 1;
      this.pendingRequest = request as TRequest;
      return;
    }
    this.running = true;
    const run = this.runLoop(request as TRequest);
    this.settled = run.then(() => undefined, () => undefined);
  }

  async requestAndWait(request?: TRequest): Promise<void> {
    this.request(request);
    await this.settle();
  }

  invalidate(): void {
    this.generation += 1;
    this.pending = false;
    this.pendingCount = 0;
    this.abort?.abort();
    this.state = {};
  }

  stop(): void {
    this.stopped = true;
    this.invalidate();
  }

  async settle(): Promise<void> {
    await this.settled;
  }

  private async runLoop(initialRequest: TRequest): Promise<void> {
    let request = initialRequest;
    try {
      do {
        this.pending = false;
        const coalesced = this.pendingCount;
        this.pendingCount = 0;
        await this.runOnce(coalesced, request);
        if (this.pending) request = this.pendingRequest as TRequest;
      } while (this.pending && !this.stopped);
    } finally {
      this.running = false;
    }
  }

  private async runOnce(coalesced: number, request: TRequest): Promise<void> {
    const generation = this.generation;
    const startedAt = this.now();
    const abort = new AbortController();
    this.abort = abort;
    try {
      const result = await this.refresh({ generation, signal: abort.signal, request });
      const finishedAt = this.now();
      if (this.stopped || generation !== this.generation) {
        this.state = {
          ...this.state,
          lastAttempt: {
            startedAt,
            finishedAt,
            complete: false,
            discarded: this.stopped ? "stopped" : "stale_generation",
            coalesced,
            metrics: result.metrics,
          },
        };
      } else if (!result.complete) {
        this.state = {
          ...this.state,
          lastAttempt: {
            startedAt,
            finishedAt,
            complete: false,
            failure: result.failure ?? "Discovery refresh was incomplete",
            coalesced,
            metrics: result.metrics,
          },
        };
      } else {
        this.state = {
          snapshot: {
            platform: this.platform,
            revision: ++this.revision,
            observedAt: finishedAt,
            campaigns: result.campaigns,
            idleCandidates: result.idleCandidates,
            followedChannels: result.followedChannels,
            complete: true,
            metrics: result.metrics,
          },
          lastAttempt: { startedAt, finishedAt, complete: true, coalesced, metrics: result.metrics },
        };
      }
    } catch (error) {
      const finishedAt = this.now();
      this.state = {
        ...this.state,
        lastAttempt: {
          startedAt,
          finishedAt,
          complete: false,
          failure: error instanceof Error ? error.message : String(error),
          ...(this.stopped || generation !== this.generation
            ? { discarded: this.stopped ? "stopped" as const : "stale_generation" as const }
            : {}),
          coalesced,
        },
      };
    } finally {
      if (this.abort === abort) this.abort = undefined;
      await this.onState?.(this.state);
    }
  }
}
