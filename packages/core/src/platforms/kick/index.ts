import type { CategorySelection, ChannelCandidate, ChannelCheck, DropCampaign, DropReward, PlatformAuthHealth, WatchSession } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import type { TablessWatchController } from "../../core/tablessWatch";
import type { DiscoverySignalController } from "../../core/discoverySignals";
import { KickWafBlockedError } from "../../core/tabs";
import { authHealthFromError } from "../../core/fetchError";
import { StaleWhileRevalidateCache } from "../../core/staleCache";
import type { WebSocketFactory } from "../../core/webSocket";
import { diagnostic, ignoreEvent, type AdapterOperationOptions, type ChannelCheckBatch, type ChannelCheckRequest, type ClaimedChallenge, type PageFetcher, type PlatformAdapter, type WatchTabOptions, type WatchTabPort } from "../adapter";
import { kickCandidatesFromCampaign, mergeKickProgress, parseKickCampaigns } from "./parser";
import { KICK_CLIENT_TOKEN, KickWatcher } from "./watch";
import { KickDiscoverySignalController } from "./discoverySignals";
import type { ResolvedCompatibility } from "../../compatibility/types";
import { createKickClaimCapability } from "./claim/factory";
import type { KickClaimCapability } from "./claim/types";
import { safeHttpsUrl } from "./claim/types";
import { KickClaimState } from "./claim/v2";
import { isSafeFetchError } from "../../core/fetchError";

export { createKickClaimCapability } from "./claim/factory";
export type { KickClaimCapability, KickClaimOutcome } from "./claim/types";
export { KickClaimState } from "./claim/v2";

// The follow list only breaks ties between eligible channels, so a stale minute
// costs nothing while a fresh read on every tick would be a wasted request.
const FOLLOWED_CHANNELS_CACHE_TTL_MS = 5 * 60_000;

// Cross-tick cache for listFollowedChannels. A field on KickAdapter itself would
// not do: every host reconstructs KickAdapter fresh each scheduler tick (see
// TwitchDiscoveryState for the same constraint on the Twitch side), so only
// state injected from outside the adapter survives to the next tick. Only one
// field today, but this is the deliberate injection point for any future
// cross-tick Kick state (mirroring TwitchDiscoveryState) — resist collapsing it
// back into a bare StaleWhileRevalidateCache passed around directly.
export class KickDiscoveryState {
  readonly followedChannels = new StaleWhileRevalidateCache<string[]>(FOLLOWED_CHANNELS_CACHE_TTL_MS);
}

export interface KickAdapterOptions {
  // Resolved metadata is injected by the host and fixed for this adapter's
  // lifetime. Settings changes construct a fresh adapter rather than switching
  // claim behavior after a request failure. Required: resolveCompatibility()
  // is the only thing that may decide which capability an adapter gets — no
  // construction site restates a default.
  compatibility: ResolvedCompatibility["kick"];
  claimState?: KickClaimState;
  discoveryState?: KickDiscoveryState;
}

interface KickLivestreamsResponse {
  data?: Array<KickLivestream> | { livestreams?: KickLivestream[] };
}

interface KickLivestream {
    slug?: string;
    channel?: { slug?: string; username?: string };
    category?: { id?: string | number; name?: string };
    viewer_count?: number;
    // The livestreams endpoint names the stream title `title`; channel-v2 uses
    // `session_title`. Accept both so candidate titles populate either way.
    title?: string;
    session_title?: string;
}

interface KickChannelResponse {
  id?: string | number;
  livestream?: {
    id?: string | number;
    is_live?: boolean;
    category?: { id?: string | number; name?: string };
    categories?: Array<{ id?: string | number; name?: string }>;
    viewer_count?: number;
    session_title?: string;
  } | null;
}

interface KickClaimResponse {
  success?: boolean;
  message?: string;
  data?: { id?: string | number } | null;
}

interface KickChallengesResponse {
  data?: KickChallenge[];
}

// A single item from GET kick.com/api/v1/user/livestreams — the account's live
// followed channels only, not the full follow list. Shape confirmed against the
// Kick mobile app's own client (references/kcik-tv-app ChannelApiService.
// getFollowingLiveStreamsV1 / LiveStreamItem); anonymous requests get a clean
// 401 rather than Kick's ambiguous `200 {}`, so a schema mismatch here surfaces
// as a parse producing no candidates rather than a silent wrong answer.
interface KickFollowedLiveStream {
  channel?: { slug?: string; username?: string };
}

// Kick's v1 endpoints are inconsistent about wrapping (see KickLivestreamsResponse
// above): accept a bare array or one wrapped in `data`, so an envelope change here
// degrades to "no preference" rather than being silently indistinguishable from
// "this account follows nobody live".
type KickFollowedLiveStreamsResponse = KickFollowedLiveStream[] | { data?: KickFollowedLiveStream[] };

interface KickIdentityResponse {
  id?: string | number;
  username?: string;
  slug?: string;
  user?: {
    id?: string | number;
    username?: string;
    slug?: string;
  };
}

function hasKickIdentity(response: KickIdentityResponse): boolean {
  const identity = response.user ?? response;
  const id = identity.id;
  return (typeof id === "string" && id.trim().length > 0)
    || (typeof id === "number" && Number.isFinite(id))
    || (typeof identity.username === "string" && identity.username.trim().length > 0)
    || (typeof identity.slug === "string" && identity.slug.trim().length > 0);
}

interface KickChallenge {
  id?: string;
  recurrence?: string;
  // Kick sets this when the box has already been opened. `status` is deliberately
  // not consulted: only "claimed" is documented, so any check against the other
  // values would be a guess.
  claimed_at?: string | null;
  condition?: { progress?: number; threshold?: number; type?: string };
}

interface KickChallengeClaimResponse {
  data?: { challenge_id?: string; winner?: { id?: string; rarity?: string } } | null;
}

// Default Kick fetcher. Spike: try the service worker first (fully tabless) and
// fall back to a retained kick.com page-context tab if Kick's WAF rejects the
// extension origin. The outcome is logged once per host (then debug) so a
// real-Chrome run shows exactly which calls are tabless-capable. The fallback
// makes this risk-free: farming behaves as before regardless of the result.
export function createKickFetcher(deps: {
  background: (url: string, init?: RequestInit) => Promise<unknown>;
  pageFetch: (url: string, init?: RequestInit) => Promise<unknown>;
  onBackgroundSuccess?: (host: string, emit: EventEmitter) => Promise<void> | void;
  onPageFallback?: (host: string, emit: EventEmitter) => Promise<void> | void;
}): PageFetcher {
  const { background, pageFetch, onBackgroundSuccess, onPageFallback } = deps;
  const announced = new Map<string, "background" | "fallback">();
  const report = (emit: EventEmitter, host: string, outcome: "background" | "fallback", detail: string): void => {
    const repeat = announced.get(host) === outcome;
    announced.set(host, outcome);
    diagnostic(emit, repeat ? "debug" : "info", `Kick fetch ${host} ${detail}`, "kick");
  };
  const notifyLifecycle = async (
    callback: ((host: string, emit: EventEmitter) => Promise<void> | void) | undefined,
    host: string,
    emit: EventEmitter,
  ): Promise<void> => {
    try {
      await callback?.(host, emit);
    } catch {
      diagnostic(emit, "debug", `Kick page-context lifecycle update failed for ${host}`, "kick");
    }
  };
  return {
    fetchJson: async <T,>(url: string, init?: RequestInit, emit: EventEmitter = ignoreEvent): Promise<T> => {
      init?.signal?.throwIfAborted();
      const host = safeHost(url);
      let result: unknown;
      try {
        result = await background(url, init);
      } catch (error) {
        init?.signal?.throwIfAborted();
        // Rate limiting applies to the request, not its execution context.
        if (isSafeFetchError(error) && error.failure.status === 429) throw error;
        report(emit, host, "fallback", error instanceof KickWafBlockedError
          ? "→ WAF-blocked from service worker, using page tab"
          : "→ service worker error, using page tab");
        await notifyLifecycle(onPageFallback, host, emit);
        init?.signal?.throwIfAborted();
        result = await pageFetch(url, init);
        return result as T;
      }
      report(emit, host, "background", "→ service worker OK (tabless-capable)");
      await notifyLifecycle(onBackgroundSuccess, host, emit);
      return result as T;
    },
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown-host";
  }
}

// Parses the `categories[]` array from Kick's `/api/search` response. Each entry
// is a game/subcategory `{id, name, slug, banner:{src,srcset}}`; its `id` matches
// the campaign categoryId used by the scheduler. Deduped by id; entries without
// an id or name are skipped.
function parseKickCategories(data: unknown): CategorySelection[] {
  const root = (data ?? {}) as Record<string, unknown>;
  const raw = (Array.isArray(root.categories) ? root.categories : []) as Array<Record<string, unknown>>;
  const seen = new Set<string>();
  const result: CategorySelection[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const id = String(entry.id ?? "").trim();
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const key = id.toLowerCase();
    if (!id || !name || seen.has(key)) continue;
    seen.add(key);
    const imageUrl = kickCategoryImage(entry.banner) ?? (typeof entry.image_url === "string" ? entry.image_url : undefined);
    result.push(imageUrl ? { id, name, imageUrl } : { id, name });
  }
  return result;
}

function kickCategoryImage(banner: unknown): string | undefined {
  const src = (banner as { src?: unknown } | undefined)?.src;
  return typeof src === "string" && src ? src : undefined;
}

export class KickAdapter implements PlatformAdapter {
  platform = "kick" as const;
  readonly compatibility?: ResolvedCompatibility["kick"];
  private readonly claimCapability: KickClaimCapability;
  private readonly discoveryState: KickDiscoveryState;
  readonly createDiscoverySignalController?: () => DiscoverySignalController;

  async checkAuthHealth(signal?: AbortSignal): Promise<PlatformAuthHealth> {
    const checkedAt = new Date().toISOString();
    try {
      // Kick serves this endpoint anonymously as `200 {}` instead of rejecting it, so the
      // identity check below is what separates a real session from a credential-free one.
      // It only works because kick.com is in KICK_AUTH_HOSTS (core/tabs.ts) and therefore
      // gets session_token replayed as a Bearer; without that header Kick returns the
      // empty object and a signed-in account looks signed out.
      const response = await this.fetcher.fetchJson<KickIdentityResponse>(
        "https://kick.com/api/v1/user",
        signal ? { signal } : undefined,
        this.emit,
      );
      if (hasKickIdentity(response)) return { status: "healthy", checkedAt };
      // An empty/unrecognized body means the request went out without credentials, which
      // is a transport fault rather than proof of a signed-out session. Only an explicit
      // rejection below may suspend farming.
      return {
        status: "unavailable",
        checkedAt,
        reasonCode: "platform_unavailable",
        message: { key: "authPlatformUnavailable" },
      };
    } catch (error) {
      if (isSafeFetchError(error)) {
        if (error.failure.kind === "authentication_rejected") {
          return {
            status: "invalid_credentials",
            checkedAt,
            reasonCode: "credentials_rejected",
            message: { key: "authInvalidCredentials" },
          };
        }
        if (error.failure.kind === "security_policy_blocked") {
          const reference = error.failure.reference;
          return {
            status: "blocked",
            checkedAt,
            reasonCode: "security_policy_blocked",
            message: {
              key: "authSecurityPolicyBlocked",
              ...(reference === undefined ? {} : { values: { reference } }),
            },
          };
        }
        if (error.failure.kind === "network_error") {
          return {
            status: "unavailable",
            checkedAt,
            reasonCode: "network_unavailable",
            message: { key: "authNetworkUnavailable" },
          };
        }
      }
      return {
        status: "unavailable",
        checkedAt,
        reasonCode: "platform_unavailable",
        message: { key: "authPlatformUnavailable" },
      };
    }
  }

  constructor(
    private readonly fetcher: PageFetcher,
    // Tab-based watch is browser-bound, so it is injected (see WatchTabPort). No
    // default: a required options.compatibility below would follow an optional
    // parameter, which TypeScript rejects (a required parameter cannot follow an
    // optional one), so this and webSocketFactory lost their defaults too. emit
    // moved after options (instead of before) so it could keep its default.
    private readonly watchTabPort: WatchTabPort,
    // Factory for the tabless viewer WebSocket. The extension passes undefined
    // (the watcher uses the platform WebSocket from the service worker); a
    // headless runtime injects one that rides its impersonated session so the
    // handshake clears Kick's WAF.
    private readonly webSocketFactory: WebSocketFactory | undefined,
    // No default: options.compatibility is required, so every construction
    // site must resolve it via resolveCompatibility() rather than get one implied.
    options: KickAdapterOptions,
    private readonly emit: EventEmitter = ignoreEvent,
  ) {
    this.compatibility = options.compatibility;
    this.discoveryState = options.discoveryState ?? new KickDiscoveryState();
    if (this.webSocketFactory) {
      const createWebSocket = this.webSocketFactory;
      this.createDiscoverySignalController = () => new KickDiscoverySignalController({ createWebSocket });
    }
    this.claimCapability = createKickClaimCapability(
      options.compatibility.claim,
      options.claimState,
    );
  }

  async refreshCampaigns(
    _session?: WatchSession,
    { signal, requireComplete }: AdapterOperationOptions = {},
  ): Promise<DropCampaign[]> {
    const [campaignResult, progressResult] = await Promise.allSettled([
      this.fetchCampaignData(signal),
      this.fetchProgressData(signal),
    ]);
    signal?.throwIfAborted();
    if (campaignResult.status === "rejected") throw campaignResult.reason;
    const campaignData = campaignResult.value;
    if (requireComplete && !hasCompleteKickCampaignInventory(campaignData)) {
      throw new Error("Kick discovery campaign inventory was incomplete");
    }
    const campaigns = parseKickCampaigns(
      campaignData as Parameters<typeof parseKickCampaigns>[0],
    );
    if (progressResult.status === "fulfilled") {
      if (requireComplete && !hasCompleteKickProgressInventory(progressResult.value)) {
        throw new Error("Kick discovery progress was incomplete");
      }
      return this.mergeProgress(campaigns, progressResult.value);
    }
    signal?.throwIfAborted();
    if (authHealthFromError(progressResult.reason)) throw progressResult.reason;
    if (requireComplete) throw new Error("Kick discovery progress was incomplete");
    this.reportProgressFallback(progressResult.reason);
    return campaigns;
  }

  private fetchCampaignData(signal?: AbortSignal): Promise<unknown> {
    return this.fetcher.fetchJson<unknown>(
      "https://web.kick.com/api/v1/drops/campaigns",
      { signal },
      this.emit,
    );
  }

  private fetchProgressData(signal?: AbortSignal): Promise<unknown> {
    // Kick's WAF rejects authed drops endpoints that omit X-Client-Token with
    // "Request blocked by security policy." — the reference sends it on
    // /drops/progress and /drops/claim (references/kickautodrops/core/kick.py:
    // 131, 67). pageFetchJson adds the Bearer from session_token on top.
    return this.fetcher.fetchJson<unknown>(
      "https://web.kick.com/api/v1/drops/progress",
      {
        headers: { "X-Client-Token": KICK_CLIENT_TOKEN },
        signal,
      },
      this.emit,
    );
  }

  private mergeProgress(campaigns: DropCampaign[], data: unknown): DropCampaign[] {
    const progress = mergeKickProgress(
      campaigns,
      data as Parameters<typeof mergeKickProgress>[1],
    );
    return this.claimCapability.reconcileProgress?.(
      progress,
      affirmativelyLinkedCampaignIds(data),
    ) ?? progress;
  }

  private reportProgressFallback(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    diagnostic(this.emit, "warn", `Could not read Kick drop progress; using last-known progress: ${message}`, "kick");
  }

  async searchCategories(query: string): Promise<CategorySelection[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    // Confirmed live (scripts/kick-inspect.mjs --categories): this is the endpoint
    // Kick's own search box uses, and its `categories[]` ids match campaign
    // categoryIds (e.g. Rust = 13). search.kick.com is the newer variant but needs
    // a Typesense key; this one is plain and works from the SW/page fetcher.
    const url = new URL("https://kick.com/api/search");
    url.searchParams.set("searched_word", trimmed);
    const data = await this.fetcher.fetchJson<unknown>(url.toString(), undefined, this.emit);
    return parseKickCategories(data);
  }

  // Live channels the signed-in account follows, so the scheduler can send a
  // campaign's watch time to someone the user actually watches. A single
  // request that Kick itself already filters to live channels, rather than
  // paginating the full follow list and filtering client-side. A signed-out
  // session or a failing lookup answers with an empty list: the preference is a
  // nicety, never a reason to lose a farming tick.
  //
  // Caching lives on discoveryState, not on `this`: every host reconstructs
  // KickAdapter fresh each scheduler tick, so a per-instance cache would never
  // survive to the next tick and this would hit the network every time —
  // exactly the tick latency this cache exists to avoid. A cached value (even a
  // stale one) is served immediately to standalone callers. Refresh ownership
  // is independent from a particular caller's abort signal because overlapping
  // callers share the promise. Strict snapshot discovery still awaits it before
  // observing its own cancellation, so route evidence cannot arrive late.
  async listFollowedChannels({ signal, requireComplete }: AdapterOperationOptions = {}): Promise<string[]> {
    const cache = this.discoveryState.followedChannels;
    const cached = cache.get();
    if (cached) {
      if (cache.isStale()) {
        const refresh = cache.refreshOnce(() => this.fetchFollowedChannels());
        if (requireComplete) {
          await refresh;
          signal?.throwIfAborted();
        }
      }
      return cached;
    }
    await cache.refreshOnce(() => this.fetchFollowedChannels());
    signal?.throwIfAborted();
    return cache.get() ?? [];
  }

  // Never rejects: it is shared via StaleWhileRevalidateCache.refreshOnce, so a
  // rejection would propagate to any unrelated overlapping caller, including
  // one whose own abort signal was never involved. On failure this resolves to
  // an empty list instead — the tick that owns `signal` still notices its own
  // cancellation through the scheduler's other throwIfAborted() checks moments
  // later.
  private async fetchFollowedChannels(signal?: AbortSignal): Promise<string[]> {
    try {
      const response = await this.fetcher.fetchJson<KickFollowedLiveStreamsResponse>(
        "https://kick.com/api/v1/user/livestreams",
        { signal },
        this.emit,
      );
      const streams = Array.isArray(response) ? response : response?.data ?? [];
      return streams
        .map((stream) => (stream.channel?.slug ?? stream.channel?.username)?.toLowerCase())
        .filter((username): username is string => Boolean(username));
    } catch (error) {
      diagnostic(
        this.emit,
        "debug",
        `Kick followed-channel lookup failed (${error instanceof Error ? error.message : String(error)}); channel preference falls back to viewer count`,
        "kick",
      );
      return [];
    }
  }

  async listCandidateChannels(
    campaign: DropCampaign,
    { signal, requireComplete }: AdapterOperationOptions = {},
  ): Promise<ChannelCandidate[]> {
    const aclCandidates = kickCandidatesFromCampaign(campaign);
    if (aclCandidates.length > 0) return aclCandidates;

    const url = new URL("https://web.kick.com/api/v1/livestreams");
    url.searchParams.set("limit", "25");
    url.searchParams.set("sort", "viewer_count_desc");
    if (campaign.categoryId) url.searchParams.set("category_id", campaign.categoryId);

    const response = await this.fetcher.fetchJson<KickLivestreamsResponse>(url.toString(), { signal }, this.emit);
    const directory = Array.isArray(response?.data) ? response.data : response?.data?.livestreams;
    if (requireComplete && (!Array.isArray(directory) || directory.some((stream) => {
      const username = stream?.channel?.slug ?? stream?.channel?.username ?? stream?.slug;
      return typeof username !== "string" || !username.trim();
    }))) throw new Error("Kick discovery channel directory was incomplete");
    const streams = directory ?? [];
    return streams.map((stream): ChannelCandidate => {
      const username = stream.channel?.slug ?? stream.channel?.username ?? stream.slug ?? "";
      return {
        platform: "kick",
        username,
        displayName: username,
        url: `https://kick.com/${username}`,
        campaignId: campaign.id,
        categoryId: stream.category?.id == null ? campaign.categoryId : String(stream.category.id),
        categoryName: stream.category?.name,
        isAclMatch: false,
        viewerCount: stream.viewer_count,
        title: stream.title ?? stream.session_title,
        live: true,
      };
    }).filter((candidate) => Boolean(candidate.username));
  }

  async checkChannel(
    channel: ChannelCandidate,
    options: AdapterOperationOptions & { campaign?: DropCampaign } = {},
  ): Promise<ChannelCheck> {
    return this.checkChannelWithFetcher(channel, options, this.fetcher);
  }

  async checkChannels(requests: ChannelCheckRequest[], { signal }: AdapterOperationOptions = {}): Promise<ChannelCheckBatch> {
    // The cache belongs to this revision, never the adapter lifetime. Cache raw
    // responses so category expectations and ACL/campaign metadata stay local.
    const evidence = new Map<string, Promise<unknown>>();
    const fetcher: PageFetcher = {
      fetchJson: <T,>(url: string, init?: RequestInit, emit?: EventEmitter): Promise<T> => {
        let pending = evidence.get(url);
        if (!pending) {
          pending = this.fetcher.fetchJson(url, init, emit);
          evidence.set(url, pending);
        }
        return pending as Promise<T>;
      },
    };
    const checks: Array<ChannelCheck | undefined> = new Array(requests.length).fill(undefined);
    // One sequential candidate chain per campaign avoids speculative requests
    // after an early match. Independent campaigns (and idle checks) share the
    // worker limit and evidence cache.
    const groups: number[][] = [];
    const campaignGroups = new Map<string, number[]>();
    requests.forEach((request, index) => {
      let group = request.campaign ? campaignGroups.get(request.campaign.id) : undefined;
      if (!group) {
        group = [];
        groups.push(group);
        if (request.campaign) campaignGroups.set(request.campaign.id, group);
      }
      group.push(index);
    });
    const checkedChannels = new Set<string>();
    let next = 0;
    let failed = false;
    let failure: unknown;
    const worker = async (): Promise<void> => {
      while (!failed && next < groups.length) {
        const group = groups[next++]!;
        try {
          for (const index of group) {
            if (failed) break;
            signal?.throwIfAborted();
            const request = requests[index]!;
            checkedChannels.add(request.channel.username.toLowerCase());
            const check = await this.checkChannelWithFetcher(request.channel,
              { campaign: request.campaign, signal, requireComplete: true }, fetcher);
            checks[index] = check;
            if (request.campaign && check.live && check.categoryMatches && check.campaignMatches !== false) break;
          }
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    };
    // Await every active worker before the controller can consume this cycle's
    // fetch observations. A failure stops admission, not drainage.
    await Promise.all(Array.from({ length: Math.min(3, groups.length) }, worker));
    signal?.throwIfAborted();
    if (failed) throw failure;
    return { checks, uniqueChannelChecks: checkedChannels.size };
  }

  private async checkChannelWithFetcher(
    channel: ChannelCandidate,
    { campaign, signal, requireComplete }: AdapterOperationOptions & { campaign?: DropCampaign },
    fetcher: PageFetcher,
  ): Promise<ChannelCheck> {
    try {
      const data = await fetcher.fetchJson<KickChannelResponse>(
        `https://kick.com/api/v2/channels/${encodeURIComponent(channel.username.toLowerCase())}`,
        { signal },
        this.emit,
      );
      if (requireComplete && (!data || !("livestream" in data))) {
        throw new Error("Kick discovery channel response was incomplete");
      }
      const livestream = data.livestream;
      if (requireComplete && livestream !== null && (
        !livestream
        || typeof livestream !== "object"
        || Array.isArray(livestream)
        || (typeof livestream.is_live !== "boolean" && livestream.id == null)
      )) {
        throw new Error("Kick discovery channel response was incomplete");
      }
      // Kick now returns a `categories` array; keep `category` as a fallback.
      const category = livestream?.categories?.[0] ?? livestream?.category;
      const actualCategoryId = category?.id == null ? undefined : String(category.id);
      const expectedCategoryId = campaign ? campaign.categoryId : channel.categoryId;
      const live = livestream !== null && Boolean(livestream?.is_live ?? true);
      if (requireComplete && live && expectedCategoryId && actualCategoryId == null) {
        throw new Error("Kick discovery channel category evidence was incomplete");
      }
      return {
        live,
        categoryMatches: !expectedCategoryId || actualCategoryId === expectedCategoryId,
        reason: livestream ? undefined : "Kick channel is offline",
        candidate: {
          ...channel,
          categoryId: actualCategoryId ?? channel.categoryId,
          categoryName: category?.name ?? channel.categoryName,
          viewerCount: livestream?.viewer_count ?? channel.viewerCount,
          title: livestream?.session_title ?? channel.title,
          channelId: data.id == null ? channel.channelId : String(data.id),
          broadcastId: livestream?.id == null ? channel.broadcastId : String(livestream.id),
        },
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (authHealthFromError(error)) throw error;
      if (requireComplete && isSafeFetchError(error) && error.failure.status === 429) throw error;
      return this.checkChannelFromPage(channel, campaign, error, signal, fetcher, requireComplete);
    }
  }

  async claimReward(
    campaign: DropCampaign,
    reward: DropReward,
    { signal }: AdapterOperationOptions = {},
  ): Promise<boolean> {
    if (!reward.claimId && reward.status !== "claimable") return false;
    if (this.claimCapability.isSuppressed?.(campaign, reward)) return false;
    // JSON.stringify drops `undefined`, so when no claim id was carried by
    // /drops/progress this matches the reference's `{ campaign_id, reward_id }`
    // payload exactly (references/kickautodrops/core/kick.py:48-52); `claim_id`
    // is only sent when Kick itself returned one. The live claim cannot be
    // exercised until campaigns launch — the raw response is logged below so we
    // can confirm the shape on day one.
    try {
      const response = await this.fetcher.fetchJson<KickClaimResponse>(
        "https://web.kick.com/api/v1/drops/claim",
        {
          method: "POST",
          // Verified working end-to-end: once the Kick account is linked, this
          // claims the reward. The session Bearer (added by pageFetchJson)
          // authorizes it; the captured "Pedir" request confirmed the payload is
          // just {campaign_id, reward_id} and that an unlinked account fails with
          // a 400 INVALID_CLAIM (not an auth error). X-Client-Token is harmless.
          headers: { "content-type": "application/json", "X-Client-Token": KICK_CLIENT_TOKEN },
          body: JSON.stringify({
            campaign_id: campaign.id,
            reward_id: reward.id,
            claim_id: reward.claimId,
          }),
          signal,
        },
        this.emit,
      );
      const outcome = this.claimCapability.classify(response, campaign);
      if (outcome.kind === "claimed") return true;
      if (outcome.kind === "link_required") {
        this.claimCapability.suppress?.(campaign, reward, outcome.url);
        this.warnAccountNotLinked(campaign, reward, outcome.url);
      }
      return false;
    } catch (error) {
      signal?.throwIfAborted();
      if (authHealthFromError(error)) throw error;
      // Kick accrues watch progress before the account is linked, but rejects
      // the claim until you connect the org account. Turn that into actionable
      // guidance instead of a raw error, and swallow it so the scheduler does
      // not back the whole platform off over an unlinked campaign.
      if (campaign.accountLinked === false) {
        const outcome = this.claimCapability.classify(undefined, campaign);
        if (outcome.kind === "link_required") {
          this.claimCapability.suppress?.(campaign, reward, outcome.url);
          this.warnAccountNotLinked(campaign, reward, outcome.url);
        } else {
          throw error;
        }
        return false;
      }
      throw error;
    }
  }

  async claimChallenges({ signal }: AdapterOperationOptions = {}): Promise<ClaimedChallenge[]> {
    const response = await this.fetcher.fetchJson<KickChallengesResponse>(
      "https://web.kick.com/api/v1/gamification/challenges",
      { signal },
      this.emit,
    );
    const claimed: ClaimedChallenge[] = [];
    for (const challenge of response?.data ?? []) {
      const id = typeof challenge?.id === "string" ? challenge.id.trim() : "";
      if (!id || challenge.claimed_at != null) continue;
      const progress = Number(challenge.condition?.progress ?? 0);
      const threshold = Number(challenge.condition?.threshold ?? 0);
      if (!Number.isFinite(progress) || !Number.isFinite(threshold) || threshold <= 0 || progress < threshold) continue;
      // One failing box must not block the others, so each claim is isolated.
      try {
        const result = await this.fetcher.fetchJson<KickChallengeClaimResponse>(
          `https://web.kick.com/api/v1/gamification/challenges/${encodeURIComponent(id)}/claim`,
          { method: "POST", signal },
          this.emit,
        );
        const rarity = result?.data?.winner?.rarity;
        claimed.push({
          id,
          rarity: typeof rarity === "string" && rarity.trim() ? rarity.trim() : "unknown",
          recurrence: typeof challenge.recurrence === "string" && challenge.recurrence.trim() ? challenge.recurrence.trim() : "unknown",
        });
      } catch (error) {
        signal?.throwIfAborted();
        if (authHealthFromError(error)) throw error;
        diagnostic(this.emit, "warn", `Kick challenge ${id} claim failed: ${error instanceof Error ? error.message : String(error)}`, "kick");
      }
    }
    return claimed;
  }

  private warnAccountNotLinked(campaign: DropCampaign, reward: DropReward, responseUrl?: string): void {
    const url = responseUrl ?? safeHttpsUrl(campaign.accountLinkUrl);
    const where = url ? " using the account-link action" : campaign.name ? ` for ${campaign.name}` : "";
    diagnostic(this.emit, "warn", `Cannot claim "${reward.name}" yet — link your Kick account${where} to claim this campaign's drops.`, "kick");
  }

  prepareWatchTab(channel: ChannelCandidate, session?: WatchSession, options?: Partial<WatchTabOptions>) {
    return this.watchTabPort.openPinnedMutedTab(channel, session, options);
  }

  stopWatchTab(session: WatchSession, options?: Partial<WatchTabOptions>): Promise<void> {
    return this.watchTabPort.stopWatchTab(session, options);
  }

  // Tabless farming via Kick's viewer WebSocket (see KickWatcher). Reuses this
  // adapter's in-page fetcher for the token exchange and channel lookups.
  supportsTabless = true;

  createTablessWatcher(): TablessWatchController {
    return new KickWatcher({
      fetcher: this.fetcher,
      createWebSocket: this.webSocketFactory,
    });
  }

  private async checkChannelFromPage(
    channel: ChannelCandidate,
    campaign: DropCampaign | undefined,
    originalError: unknown,
    signal?: AbortSignal,
    fetcher: PageFetcher = this.fetcher,
    requireComplete = false,
  ): Promise<ChannelCheck> {
    const originalMessage = requireComplete && isSafeFetchError(originalError)
      ? `${originalError.failure.kind}${originalError.failure.status == null ? "" : ` status=${originalError.failure.status}`}`
      : requireComplete ? "provider evidence unavailable"
      : originalError instanceof Error ? originalError.message : String(originalError);
    diagnostic(this.emit, "debug", `Kick API channel check failed for ${channel.username}, falling back to the channel page: ${originalMessage}`, "kick");
    try {
      const page = await fetcher.fetchJson<{ html?: string }>(channel.url, { signal }, this.emit);
      const html = page.html ?? "";
      const explicitLive = parseBooleanField(html, ["is_live", "isLive", "live"]);
      if (requireComplete && explicitLive === undefined) throw new Error("Kick discovery page evidence was incomplete");
      const live = explicitLive ?? html.includes("livestream");
      const actualCategoryId = parseCategoryId(html);
      const expectedCategoryId = campaign ? campaign.categoryId : channel.categoryId;
      if (requireComplete && live && expectedCategoryId && actualCategoryId == null) {
        throw new Error("Kick discovery page category evidence was incomplete");
      }
      return {
        live,
        categoryMatches: !expectedCategoryId || actualCategoryId == null || actualCategoryId === expectedCategoryId,
        reason: "Kick API check failed; used channel page fallback",
        candidate: {
          ...channel,
          categoryId: actualCategoryId ?? channel.categoryId,
        },
      };
    } catch {
      signal?.throwIfAborted();
      if (requireComplete) throw new Error("Kick discovery channel evidence was incomplete");
      return {
        live: false,
        categoryMatches: false,
        reason: originalError instanceof Error ? originalError.message : "Kick channel check failed",
        candidate: channel,
      };
    }
  }
}

function kickInventoryRecords(input: unknown, keys: string[]): unknown[] | undefined {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== "object") return undefined;
  const root = input as Record<string, unknown>;
  if (Array.isArray(root.data)) return root.data;
  const data = root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : {};
  const buckets = keys.flatMap((key) => [root[key], data[key]]).filter(Array.isArray);
  return buckets.length > 0 ? buckets.flat() : undefined;
}

function hasCompleteKickCampaignInventory(input: unknown): boolean {
  const records = kickInventoryRecords(input, ["campaigns", "active", "current", "upcoming"]);
  return records !== undefined && records.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const campaign = entry as Record<string, unknown>;
    if (campaign.id == null) return false;
    const rewards = campaign.rewards ?? campaign.drops;
    return rewards === undefined || (Array.isArray(rewards) && rewards.every((reward) =>
      Boolean(reward) && typeof reward === "object" && !Array.isArray(reward)
      && (reward as Record<string, unknown>).id != null));
  });
}

function hasCompleteKickProgressInventory(input: unknown): boolean {
  const records = kickInventoryRecords(input, ["progress", "campaigns", "active", "current", "completed"]);
  return records !== undefined && records.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const progress = entry as Record<string, unknown>;
    const rewards = progress.rewards;
    const identifiesProgress = progress.id != null
      || progress.campaign_id != null
      || progress.drop_campaign_id != null
      || progress.reward_id != null
      || progress.drop_id != null;
    return identifiesProgress && (rewards === undefined || (Array.isArray(rewards) && rewards.every((reward) =>
      Boolean(reward) && typeof reward === "object" && !Array.isArray(reward)
      && ((reward as Record<string, unknown>).id != null
        || (reward as Record<string, unknown>).reward_id != null
        || (reward as Record<string, unknown>).drop_id != null))));
  });
}

function affirmativelyLinkedCampaignIds(input: unknown): Set<string> {
  const root = input != null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const buckets = [Array.isArray(input) ? input : undefined, root.data, root.progress, root.campaigns, root.active, root.current, root.completed];
  if (root.data != null && typeof root.data === "object" && !Array.isArray(root.data)) {
    const data = root.data as Record<string, unknown>;
    buckets.push(data.progress, data.campaigns, data.active, data.current, data.completed);
  }
  const ids = new Set<string>();
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const progress = entry as Record<string, unknown>;
      if (progress.user_app_connected !== true) continue;
      const id = progress.campaign_id ?? progress.drop_campaign_id ?? progress.id;
      if (id != null) ids.add(String(id));
    }
  }
  return ids;
}

function parseBooleanField(html: string, names: string[]): boolean | undefined {
  for (const name of names) {
    const match = html.match(new RegExp(`["']${name}["']\\s*:\\s*(true|false)`, "i"));
    if (match?.[1]) return match[1].toLowerCase() === "true";
  }
  return undefined;
}

function parseCategoryId(html: string): string | undefined {
  const categoryObject = html.match(/["']category["']\s*:\s*\{[^{}]*["']id["']\s*:\s*["']?([^"',}]+)["']?/i);
  if (categoryObject?.[1]) return categoryObject[1];
  const categoryId = html.match(/["']category_id["']\s*:\s*["']?([^"',}]+)["']?/i);
  return categoryId?.[1];
}
