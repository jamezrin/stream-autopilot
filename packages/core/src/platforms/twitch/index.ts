import type { CategorySelection, ChannelCandidate, ChannelCheck, DropCampaign, DropReward, PlatformAuthHealth, WatchSession } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import type { LogLevel } from "@lurkloot/shared/logging";
import { authHealthFromError, SafeFetchError } from "../../core/fetchError";
import type { TwitchIntegrityRequest } from "../../core/tabs";
import type { TwitchIntegrity } from "../../core/twitchIntegrity";
import { PendingWatcherDiagnostics, type HeartbeatResult, type TablessWatchController, type WatchContext } from "../../core/tablessWatch";
import { StaleWhileRevalidateCache } from "../../core/staleCache";
import { diagnostic, ignoreEvent, type AdapterOperationOptions, type CandidateChannelSelection, type PageFetcher, type PlatformAdapter, type WatchTabOptions, type WatchTabPort } from "../adapter";
import { campaignHasClaimableReward, mergeTwitchCampaignProgress, parseTwitchCampaigns, twitchCandidatesFromCampaign, withCampaignStatus } from "./parser";
import type { ResolvedCompatibility, TwitchIdentity } from "../../compatibility/types";
import { createTwitchHeartbeat } from "./heartbeat/factory";
import type { TwitchHeartbeatFetchText, TwitchHeartbeatPost, TwitchHeartbeatStrategy } from "./heartbeat/types";
import { createTwitchInventory } from "./inventory/factory";
import type { TwitchInventoryCapability } from "./inventory/types";

export { createTwitchInventory } from "./inventory/factory";
export type { TwitchInventoryCapability } from "./inventory/types";

// Inline query: the viewer's own user id, needed for the minute-watched event.
const CURRENT_USER_QUERY = "query CurrentUser { currentUser { id } }";

// Twitch's web Client-ID — the default identity. It is the one Twitch gates
// behind Client-Integrity (Kasada); non-web client ids (Android/TV) are not.
const TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
// Deliberately wider than the default 1-minute poll cadence (plus the time
// discovery consumes before selection even starts) so two selections roughly
// 60s apart reuse the same entry instead of always missing at the boundary.
// A cadence configured longer than this still misses every time — same as
// before — but the default (and every shorter cadence) now actually hits.
const POSITIVE_CHANNEL_CAMPAIGN_CACHE_TTL_MS = 2 * 60_000;
const NEGATIVE_CHANNEL_CAMPAIGN_CACHE_TTL_MS = 30_000;
const PROGRESS_CONFIRMED_AVAILABILITY_TTL_MS = 5 * 60_000;
// FIFO bound, not LRU: a cache hit returns immediately without touching this
// map, so a hot channel's insertion order never refreshes and it can still be
// evicted before a colder one. Accepted trade-off: FIFO is one Map without a
// second recency structure, and re-fetching an evicted-but-still-hot channel
// costs one extra request, not a correctness problem.
const CHANNEL_CAMPAIGN_CACHE_MAX_ENTRIES = 128;
// The follow list only breaks ties between eligible channels, so a stale minute
// costs nothing while a fresh read on every tick would be a wasted request.
const FOLLOWED_CHANNELS_CACHE_TTL_MS = 5 * 60_000;
// Followed channels that are live right now. Bounded generously: the preference
// only matters for channels that also show up in a campaign's directory page.
const FOLLOWED_CHANNELS_LIMIT = 100;
const DISCOVERY_DETAIL_PRUNE_LIMIT = 32;
const GQL_BATCH_OPERATION_LIMIT = 20;
const GQL_BATCH_CONCURRENCY = 2;
// How long a discovery result stays usable when Twitch stops answering. Long
// enough to ride out an outage of many ticks, short enough that a campaign
// Twitch quietly stopped serving does not linger for a whole session.
const DISCOVERY_RETENTION_TTL_MS = 30 * 60_000;
// How long a *successful* detail read may be reused instead of refetched. Far
// shorter than the retention TTL above, which is an outage fallback: this is the
// window in which a campaign the user is not watching cannot have changed in any
// way this adapter would notice. Minutes watched and claim state for started
// campaigns arrive from the Inventory payload every tick and are merged over
// these details (mergeTwitchCampaignProgress), so what the cache holds back is
// only the immutable half — name, images, reward tiers, allowed channels.
const CAMPAIGN_DETAILS_FRESH_TTL_MS = 3 * 60_000;
// Added on top of the base freshness, spread deterministically per campaign id.
// Without it a cold start stamps every campaign with the same deadline and the
// whole set re-expires on one tick, reproducing the full-batch refetch this is
// meant to remove — just once every few minutes instead of every tick.
const CAMPAIGN_DETAILS_FRESH_SPREAD_MS = 2 * 60_000;

export interface TwitchAdapterOptions {
  // GQL Client-ID. Defaults to the web client. A headless runtime passes a
  // non-web id (e.g. the Android app) so Twitch never enforces integrity.
  clientId?: string;
  // User-Agent to send with GQL requests, matching the client id. Only set in
  // non-browser runtimes — browsers forbid overriding User-Agent on fetch.
  userAgent?: string;
  // Resolved metadata selects the registered heartbeat and inventory versions.
  // Required: resolveCompatibility() is the only thing that may decide which
  // capability an adapter gets — no construction site restates a default.
  compatibility: ResolvedCompatibility["twitch"];
  heartbeatStrategy?: TwitchHeartbeatStrategy;
  heartbeatIdentity?: TwitchIdentity;
  heartbeatFetchText?: TwitchHeartbeatFetchText;
  heartbeatPost?: TwitchHeartbeatPost;
  discoveryState?: TwitchDiscoveryState;
  // Opt-in exact validation of a campaign against DropsHighlightService_
  // AvailableDrops before a channel may be watched. Off by default: Twitch's
  // own GameDirectory DROPS_ENABLED filter and the campaign ACL are the
  // authoritative discovery sources, and AvailableDrops routinely omits a
  // campaign that is in fact farmable on the channel — which rejected every
  // candidate and left drops unfarmed (#400). When off, live/category
  // validation alone decides, matching TwitchDropsMiner's default.
  strictCampaignAvailability?: boolean;
  // Supplies the integrity bundle each request should carry. The transport
  // attaches it itself rather than letting the fetcher pick one up from a global,
  // so the token a rejection reports is provably the token that was sent: the
  // fetcher selects its own only after awaiting cookie reads, during which a
  // concurrent capture can swap it. Absent in runtimes that never carry integrity
  // at all (non-web client ids).
  currentIntegrity?: () => TwitchIntegrity | undefined;
}

const TWITCH_QUERIES = {
  dashboard: {
    operationName: "ViewerDropsDashboard",
    sha256Hash: "5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619",
    variables: { fetchRewardCampaigns: false },
  },
  campaignDetailsHash: "039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1",
  gameDirectoryHash: "cb5dc816e139dcb8a118f14b4b677d59abc224a4b016c4bc2bb00a47fe0ddec4",
  streamInfoHash: "198492e0857f6aedead9665c81c5a06d67b25b58034649687124083ff288597d",
  currentDropHash: "4d06b702d25d652afb9ef835d2a550031f1cf762b193523a92166f40ea3d142b",
  availableDropsHash: "782dad0f032942260171d2d80a654f88bdd0c5a9dddc392e9bc92218a0f42d20",
  channelPointsHash: "374314de591e69925fce3ddc2bcf085796f56ebb8cad67a0daa3165c03adc345",
  claimCommunityPointsHash: "46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0",
  claimHash: "a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930",
};

// Persisted query hashes for stream info rotate and eventually return
// PersistedQueryNotFound. The viewer-count check sends this inline query instead
// so it keeps working without depending on a server-side registered hash.
const STREAM_INFO_QUERY = `query StreamInfo($channel: String!) {
  user(login: $channel) {
    id
    displayName
    stream { id type viewersCount game { id name } }
  }
}`;

// Inline query for the signed-in account's live followed channels. Sent inline
// because the web client resolves the follow directory from its sidebar cache,
// so there is no persisted hash of ours to piggyback on; field/arg names were
// validated against the live schema, so a "Cannot query field" here means the
// schema drifted rather than a typo.
const FOLLOWED_LIVE_QUERY = `query FollowedLiveChannels($limit: Int!) {
  currentUser {
    id
    followedLiveUsers(first: $limit) {
      edges { node { id login } }
    }
  }
}`;

// Inline query for the category picker's live search. Sent inline (no persisted
// hash) so it keeps working without a server-registered hash. Field/arg names
// match the directory's category search; verify in twitch.tv DevTools if it drifts.
const SEARCH_CATEGORIES_QUERY = `query SearchCategories($query: String!) {
  searchCategories(query: $query, first: 15) {
    edges { node { id displayName boxArtURL } }
  }
}`;

const TWITCH_CAMPAIGN_FIELDS = `{
  id
  name
  imageURL
  startAt
  endAt
  status
  accountLinkURL
  detailsURL
  self { isAccountConnected }
  game { id name displayName slug boxArtURL }
  allow { channels { name login } }
  timeBasedDrops {
    id
    name
    startAt
    endAt
    requiredMinutesWatched
    requiredSubs
    preconditionDrops { id }
    benefitEdges { benefit { id name imageAssetURL distributionType } }
    self { currentMinutesWatched isClaimed dropInstanceID }
  }
}`;

const TWITCH_INLINE_QUERIES: Partial<Record<string, string>> = {
  ViewerDropsDashboard: `query ViewerDropsDashboard($fetchRewardCampaigns: Boolean!) {
    currentUser {
      id
      login
      inventory {
        dropCampaigns @include(if: $fetchRewardCampaigns) { id status self { isAccountConnected } }
      }
      dropCampaigns { id status self { isAccountConnected } }
    }
  }`,
  DropCampaignDetails: `query DropCampaignDetails($channelLogin: String!, $dropID: ID!) {
    currentUser { id login }
    user(login: $channelLogin) {
      dropCampaign(id: $dropID) ${TWITCH_CAMPAIGN_FIELDS}
    }
  }`,
  DirectoryPage_Game: `query DirectoryPage_Game($slug: String!, $options: StreamSearchOptions, $sortTypeIsRecency: Boolean, $limit: Int) {
    game(name: $slug) {
      streams(options: $options, first: $limit, sortTypeIsRecency: $sortTypeIsRecency) {
        edges {
          node {
            id
            title
            viewersCount
            broadcaster { id login displayName profileImageURL }
          }
        }
      }
    }
  }`,
  DropCurrentSessionContext: `query DropCurrentSessionContext($channelID: ID!, $channelLogin: String!) {
    currentUser {
      dropCurrentSession(channelID: $channelID, channelLogin: $channelLogin) {
        dropID
        currentMinutesWatched
      }
    }
  }`,
  DropsHighlightService_AvailableDrops: `query DropsHighlightService_AvailableDrops($channelID: ID!) {
    channel(id: $channelID) {
      id
      viewerDropCampaigns { id }
    }
  }`,
  ChannelPointsContext: `query ChannelPointsContext($channelLogin: String!) {
    community {
      channel(login: $channelLogin) {
        id
        self { communityPoints { availableClaim { id } } }
      }
    }
  }`,
  ClaimCommunityPoints: `mutation ClaimCommunityPoints($input: ClaimCommunityPointsInput!) {
    claimCommunityPoints(input: $input) { status }
  }`,
};

interface TwitchGqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
  // Twitch reports auth/integrity failures as a top-level `{ error, message }`
  // pair rather than the standard `errors[]` envelope (see TwitchDropsMiner
  // twitch.py:1352). Surface it instead of treating the response as usable.
  error?: string;
  message?: string;
}

// The single definition of "Twitch rejected this for Client-Integrity, and a
// fresh token could fix it" — shared by the adapter's safe reads, both claim
// mutations, and the tabless watcher, so the rule cannot drift between them.
// Authentication rejection is excluded first: an invalid session fails the same
// request, but no integrity token can repair it. Anonymous requests are excluded
// because they carry no token and must never open a page context.
function isIntegrityRejection(error: unknown, credentials?: RequestCredentials): boolean {
  if (credentials === "omit") return false;
  if (authHealthFromError(error)) return false;
  return error instanceof Error && /integrity/i.test(error.message);
}

type TwitchGqlFailureKind = "network" | "credentials" | "platform";

class TwitchGqlFailure extends Error {
  // The integrity token this request actually carried, when it carried one.
  // A forced refresh compares against it so it can tell "the token I sent is
  // still the current one, mint a replacement" from "someone already replaced
  // it, just retry".
  sentIntegrityToken?: string;

  constructor(readonly kind: TwitchGqlFailureKind, message: string) {
    super(message);
    this.name = "TwitchGqlFailure";
  }
}

// The token a failed request carried, when the failure knows. Undefined means
// unknown, which makes a forced refresh mint unconditionally.
function sentIntegrityToken(error: unknown): string | undefined {
  return error instanceof TwitchGqlFailure ? error.sentIntegrityToken : undefined;
}

async function refreshIntegrityForRetry(
  ensureIntegrity: (request?: TwitchIntegrityRequest) => Promise<boolean>,
  rejectedToken: string | undefined,
  signal?: AbortSignal,
): Promise<{ refreshed: boolean; integrity: TwitchIntegrity | undefined }> {
  let integrity: TwitchIntegrity | undefined;
  const refreshed = await ensureIntegrity({
    forceRefresh: true,
    reason: "rejection_recovery",
    rejectedToken,
    onIntegrityCaptured: (value) => { integrity = value; },
    signal,
  });
  return { refreshed, integrity };
}

function isCredentialRejection(message: string | undefined): boolean {
  return message != null && /unauthenticated|unauthorized|(?:the )?oauth token (?:(?:is|was) )?invalid|invalid oauth token|token (?:has )?expired/i.test(message);
}

interface TwitchDashboardData {
  currentUser?: {
    id?: string;
    login?: string;
    inventory?: {
      dropCampaigns?: Array<{ id?: string; status?: string; self?: { isAccountConnected?: boolean } }>;
    };
    dropCampaigns?: Array<{ id?: string; status?: string; self?: { isAccountConnected?: boolean } }>;
  };
}

interface TwitchCampaignDetailsData {
  currentUser?: { id?: string; login?: string };
  user?: { dropCampaign?: unknown };
  dropCampaign?: unknown;
}

interface TwitchSearchCategoriesData {
  searchCategories?: {
    edges?: Array<{ node?: { id?: string; displayName?: string; boxArtURL?: string } }>;
  };
}

// Box art URLs come back with `{width}x{height}` placeholders; size them for the
// small picker avatar.
function twitchBoxArtUrl(boxArtURL: string | undefined): string | undefined {
  if (!boxArtURL) return undefined;
  return boxArtURL.replace("{width}", "144").replace("{height}", "192");
}

interface TwitchDirectoryData {
  game?: {
    streams?: {
      edges?: Array<{
        node?: {
          id?: string;
          title?: string;
          viewersCount?: number;
          broadcaster?: {
            id?: string;
            login?: string;
            displayName?: string;
            profileImageURL?: string;
          };
        };
      }>;
    };
  };
}

interface TwitchStreamInfoData {
  user?: {
    id?: string;
    displayName?: string;
    stream?: {
      id?: string;
      type?: string;
      viewersCount?: number;
      game?: { id?: string; name?: string };
    } | null;
  };
}

interface TwitchChannelPointsData {
  community?: {
    channel?: {
      id?: string;
      self?: {
        communityPoints?: {
          availableClaim?: { id?: string };
        };
      };
    };
  };
}

interface TwitchCurrentDropData {
  currentUser?: {
    dropCurrentSession?: {
      dropID?: string;
      currentMinutesWatched?: number;
    } | null;
  };
}

interface TwitchAvailableDropsData {
  channel?: {
    id?: string;
    viewerDropCampaigns?: Array<{ id?: string }> | null;
  } | null;
}

interface CachedAvailableCampaigns {
  broadcastId: string;
  campaignIds: Set<string>;
  fetchedAt: number;
}

interface ProgressConfirmedAvailability {
  channelId: string;
  campaignId: string;
  expiresAt: number;
}

type TwitchAvailabilityCandidate = {
  channelId: string;
  channelLogin: string;
  broadcastId: string;
};

interface TwitchFollowedLiveData {
  currentUser?: {
    id?: string;
    followedLiveUsers?: {
      edges?: Array<{ node?: { id?: string; login?: string } }>;
    } | null;
  } | null;
}

interface CachedCampaignDetails {
  campaign: unknown;
  // The dashboard's status for this campaign when the details were read. The
  // dashboard is refetched every tick and is authoritative for status, so a
  // campaign that has flipped (UPCOMING -> ACTIVE, #400) is refetched at once
  // rather than waiting out its reuse window with a stale status. Undefined
  // when no dashboard answered — see freshCampaignDetails.
  dashboardStatus?: string;
  // When this entry stops being reusable in place of a request. Lapsing only
  // costs the campaign a refetch — it must never drop the entry, or #274's
  // outage retention (expiresAt, far later) would be silently reduced to it.
  freshUntil: number;
  expiresAt: number;
}

interface CachedDashboardCampaigns {
  campaignIds: string[];
  expiresAt: number;
}

function reconcileInventoryCampaignStatuses(
  campaigns: DropCampaign[],
  activeDashboardIds: ReadonlySet<string>,
  dashboardResponded: boolean,
): DropCampaign[] {
  return campaigns.map((campaign) =>
    dashboardResponded
    && !activeDashboardIds.has(campaign.id)
    && !campaignHasClaimableReward(campaign)
      ? withCampaignStatus(campaign, "expired")
      : campaign,
  );
}

export type ChannelAvailabilityLookup =
  | { status: "hit"; campaignIds: ReadonlySet<string> }
  | { status: "broadcast_changed" }
  | { status: "expired" }
  | { status: "miss" };

// An opaque snapshot of "which identity was current when this availability
// request started." Captured before the request begins and replayed at write
// time, so a request that outlives an identity switch can be told apart from
// one that started under the identity still current when it finishes. userId
// alone cannot do this: switching A -> B -> A leaves userId matching again
// even though every cache entry from the A -> B window must stay discarded,
// which is what generation is for.
export interface TwitchAvailabilityRequestIdentity {
  userId: string | undefined;
  generation: number;
}

// Deterministic per-campaign offset in [0, CAMPAIGN_DETAILS_FRESH_SPREAD_MS).
// Deterministic rather than random so a campaign keeps its slot across ticks
// and the same id always lands in the same place, which is what makes the
// spread testable.
function campaignDetailsFreshnessSpread(dropID: string): number {
  // FNV-1a. A plain rolling sum reduced modulo a decimal constant collapses
  // here: campaign ids share long prefixes and differ only in their last
  // characters, which such a hash barely moves, so nearly every campaign lands
  // in the same slot and the spread does nothing.
  let hash = 0x811c9dc5;
  for (let index = 0; index < dropID.length; index += 1) {
    hash ^= dropID.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % CAMPAIGN_DETAILS_FRESH_SPREAD_MS);
}

export class TwitchDiscoveryState {
  private readonly campaignDetailsByDropId = new Map<string, CachedCampaignDetails>();
  private readonly availableCampaignsByChannel = new Map<string, CachedAvailableCampaigns>();
  private readonly progressConfirmedAvailabilityByPair = new Map<string, ProgressConfirmedAvailability>();
  private authenticatedUserId?: string;
  // Starts at 0 so a request captured before any identity is known (userId
  // undefined) still matches the initial state — see availabilityRequestIdentity.
  private availabilityGeneration = 0;
  private retainedDashboard?: CachedDashboardCampaigns;
  // The extension reconstructs TwitchAdapter fresh every tick, so this lives
  // here (state injected from outside the adapter) rather than on the adapter
  // itself. Exposed as a bare field rather than behind pass-through methods,
  // unlike the other caches on this class: it is already a small, fully
  // self-contained value object. Not readonly only so setAuthenticatedUser can
  // swap it wholesale — see there for why replacing beats clearing in place.
  followedChannels = new StaleWhileRevalidateCache<string[]>(FOLLOWED_CHANNELS_CACHE_TTL_MS);

  // Returns whether this call cleared caches for an identity switch, so the
  // caller can log it. A boolean rather than an invalidated-entry count: a
  // count of 0 would be ambiguous between "nothing to invalidate" and "no
  // switch happened at all", where a boolean only ever means the latter.
  setAuthenticatedUser(userId: string): boolean {
    const previousUserId = this.authenticatedUserId;
    const identityChanged = Boolean(previousUserId && previousUserId !== userId);
    if (identityChanged) {
      this.retainedDashboard = undefined;
      this.campaignDetailsByDropId.clear();
      // Follows are per-account, so the previous user's list must not survive
      // the switch. Replaced rather than cleared in place because a refresh may
      // already be in flight for the old account: clearing would let that
      // pending fetch write the old user's logins back into the live cache
      // moments later. The orphaned instance still settles, but into an object
      // nothing reads any more.
      this.followedChannels = new StaleWhileRevalidateCache<string[]>(FOLLOWED_CHANNELS_CACHE_TTL_MS);
    }
    // Bumped on any identity value change, including the initial transition
    // from no known identity to a known user — unlike identityChanged above,
    // which only reports a true switch (for the diagnostic below). An
    // in-flight availability request captured the prior generation and must
    // never write into the cache once this moves past it, so a stale request
    // that would otherwise never have "changed" the identity (going from
    // unknown to known) still gets invalidated.
    if (previousUserId !== userId) {
      this.availabilityGeneration += 1;
      this.availableCampaignsByChannel.clear();
      this.progressConfirmedAvailabilityByPair.clear();
    }
    this.authenticatedUserId = userId;
    return identityChanged;
  }

  // Snapshot to capture before starting an asynchronous availability request
  // and replay at write time via rememberChannelAvailability, so a request
  // that outlives an identity switch cannot repopulate the shared cache.
  availabilityRequestIdentity(): TwitchAvailabilityRequestIdentity {
    return { userId: this.authenticatedUserId, generation: this.availabilityGeneration };
  }

  rememberDashboardCampaignIds(campaignIds: string[]): void {
    this.retainedDashboard = {
      campaignIds,
      expiresAt: Date.now() + DISCOVERY_RETENTION_TTL_MS,
    };
  }

  retainedDashboardCampaignIds(): string[] {
    if (!this.retainedDashboard) return [];
    if (this.retainedDashboard.expiresAt <= Date.now()) {
      this.retainedDashboard = undefined;
      return [];
    }
    return this.retainedDashboard.campaignIds;
  }

  rememberCampaignDetails(
    dropID: string,
    campaign: unknown,
    dashboardStatus: string | undefined,
    requestIdentity: TwitchAvailabilityRequestIdentity,
  ): boolean {
    if (
      requestIdentity.userId !== this.authenticatedUserId
      || requestIdentity.generation !== this.availabilityGeneration
    ) {
      return false;
    }
    const now = Date.now();
    // A tick with no dashboard answer knows nothing about status; it must not
    // erase what the last answering tick recorded, or the flip check below
    // would go blind for a whole reuse window afterwards.
    const status = dashboardStatus ?? this.campaignDetailsByDropId.get(dropID)?.dashboardStatus;
    let inspected = 0;
    for (const [cachedDropID, cached] of this.campaignDetailsByDropId) {
      if (inspected >= DISCOVERY_DETAIL_PRUNE_LIMIT) break;
      inspected += 1;
      if (cached.expiresAt <= now) this.campaignDetailsByDropId.delete(cachedDropID);
    }
    this.campaignDetailsByDropId.set(dropID, {
      campaign,
      dashboardStatus: status,
      freshUntil: now + CAMPAIGN_DETAILS_FRESH_TTL_MS + campaignDetailsFreshnessSpread(dropID),
      expiresAt: now + DISCOVERY_RETENTION_TTL_MS,
    });
    return true;
  }

  forgetCampaignDetails(
    dropID: string,
    requestIdentity: TwitchAvailabilityRequestIdentity,
  ): boolean {
    if (
      requestIdentity.userId !== this.authenticatedUserId
      || requestIdentity.generation !== this.availabilityGeneration
    ) {
      return false;
    }
    return this.campaignDetailsByDropId.delete(dropID);
  }

  // Drops the entry's reuse window without dropping the entry: the next
  // discovery refetches this campaign, while the payload stays available as
  // outage retention until its normal expiry. Used when something outside
  // discovery changed what a detail read would return — a claim, today.
  expireCampaignDetailsFreshness(dropID: string): void {
    const cached = this.campaignDetailsByDropId.get(dropID);
    if (cached) cached.freshUntil = 0;
  }

  // The reuse path: details good enough to serve *instead of* a request, as
  // opposed to retainedCampaignDetails below, which serves them only once a
  // request has already failed. Deliberately does not delete on a lapsed
  // freshness — only true expiry evicts.
  // dashboardStatus is this tick's authoritative status for the campaign, or
  // undefined when no dashboard answered — in which case there is nothing to
  // compare against and reuse rides on the deadlines alone.
  freshCampaignDetails(dropID: string, dashboardStatus?: string): unknown {
    const cached = this.campaignDetailsByDropId.get(dropID);
    if (!cached) return undefined;
    const now = Date.now();
    if (cached.expiresAt <= now) {
      this.campaignDetailsByDropId.delete(dropID);
      return undefined;
    }
    if (cached.freshUntil <= now) return undefined;
    if (
      dashboardStatus !== undefined
      && cached.dashboardStatus !== undefined
      && cached.dashboardStatus !== dashboardStatus
    ) {
      return undefined;
    }
    return cached.campaign;
  }

  retainedCampaignDetails(dropID: string): unknown {
    const cached = this.campaignDetailsByDropId.get(dropID);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
      this.campaignDetailsByDropId.delete(dropID);
      return undefined;
    }
    return cached.campaign;
  }

  // Lives here rather than on TwitchAdapter so it survives the per-tick
  // adapter reconstruction (see the class comment on followedChannels above)
  // — without that, the cache is structurally incapable of ever hitting.
  cachedChannelAvailability(
    channelId: string,
    broadcastId: string,
    campaignId: string,
  ): ChannelAvailabilityLookup {
    const cached = this.availableCampaignsByChannel.get(channelId);
    if (!cached) return { status: "miss" };
    if (cached.broadcastId !== broadcastId) {
      this.availableCampaignsByChannel.delete(channelId);
      return { status: "broadcast_changed" };
    }
    const now = Date.now();
    const isPositive = cached.campaignIds.has(campaignId);
    const ttl = isPositive
      ? POSITIVE_CHANNEL_CAMPAIGN_CACHE_TTL_MS
      : NEGATIVE_CHANNEL_CAMPAIGN_CACHE_TTL_MS;
    if (cached.fetchedAt + ttl <= now) {
      if (cached.fetchedAt + POSITIVE_CHANNEL_CAMPAIGN_CACHE_TTL_MS <= now) {
        this.availableCampaignsByChannel.delete(channelId);
      }
      return { status: "expired" };
    }
    return { status: "hit", campaignIds: cached.campaignIds };
  }

  // Returns whether the write actually happened, so the guard's verdict is
  // observable instead of silently dropping the entry. A request whose
  // captured identity no longer matches the current one (the authenticated
  // user changed, or the same user re-authenticated after an intervening
  // switch — see the generation comment on setAuthenticatedUser) must not
  // repopulate shared cache state, even though it still finishes and answers
  // its own caller.
  rememberChannelAvailability(
    channelId: string,
    broadcastId: string,
    campaignIds: ReadonlySet<string>,
    requestIdentity: TwitchAvailabilityRequestIdentity,
  ): boolean {
    if (
      requestIdentity.userId !== this.authenticatedUserId
      || requestIdentity.generation !== this.availabilityGeneration
    ) {
      return false;
    }
    if (
      !this.availableCampaignsByChannel.has(channelId)
      && this.availableCampaignsByChannel.size >= CHANNEL_CAMPAIGN_CACHE_MAX_ENTRIES
    ) {
      const oldest = this.availableCampaignsByChannel.keys().next().value;
      if (oldest !== undefined) this.availableCampaignsByChannel.delete(oldest);
    }
    this.availableCampaignsByChannel.set(channelId, {
      broadcastId,
      campaignIds: new Set(campaignIds),
      fetchedAt: Date.now(),
    });
    return true;
  }

  hasProgressConfirmedAvailability(channelId: string, campaignId: string): boolean {
    const key = `${channelId}:${campaignId}`;
    const confirmed = this.progressConfirmedAvailabilityByPair.get(key);
    if (!confirmed) return false;
    if (confirmed.expiresAt <= Date.now()) {
      this.progressConfirmedAvailabilityByPair.delete(key);
      return false;
    }
    return true;
  }

  rememberProgressConfirmedAvailability(
    channelId: string,
    campaignId: string,
    requestIdentity: TwitchAvailabilityRequestIdentity,
  ): boolean {
    if (
      requestIdentity.userId !== this.authenticatedUserId
      || requestIdentity.generation !== this.availabilityGeneration
    ) {
      return false;
    }
    const key = `${channelId}:${campaignId}`;
    if (
      !this.progressConfirmedAvailabilityByPair.has(key)
      && this.progressConfirmedAvailabilityByPair.size >= CHANNEL_CAMPAIGN_CACHE_MAX_ENTRIES
    ) {
      const oldest = this.progressConfirmedAvailabilityByPair.keys().next().value;
      if (oldest !== undefined) this.progressConfirmedAvailabilityByPair.delete(oldest);
    }
    this.progressConfirmedAvailabilityByPair.set(key, {
      channelId,
      campaignId,
      expiresAt: Date.now() + PROGRESS_CONFIRMED_AVAILABILITY_TTL_MS,
    });
    const cachedAvailability = this.availableCampaignsByChannel.get(channelId);
    if (cachedAvailability && !cachedAvailability.campaignIds.has(campaignId)) {
      cachedAvailability.campaignIds.add(campaignId);
      cachedAvailability.fetchedAt = Date.now();
    }
    return true;
  }
}

export type TwitchGqlTransport = <T>(
  operationName: string,
  sha256Hash: string,
  variables: Record<string, unknown>,
  query?: string,
  credentials?: RequestCredentials,
  emit?: EventEmitter,
  signal?: AbortSignal,
  // Optional one-attempt bundle pin used by integrity recovery. When absent,
  // the transport reads the current global capture as before.
  integrityOverride?: TwitchIntegrity,
) => Promise<TwitchGqlResponse<T>>;

// Reporter-neutral transport: it captures only the request transport and
// immutable client identity. Callers select the event destination per request,
// so a persistent watcher never retains an operation-scoped adapter/emitter.
export function createTwitchGqlTransport(
  fetcher: PageFetcher,
  options: TwitchAdapterOptions,
): TwitchGqlTransport {
  const clientId = options.clientId ?? TWITCH_CLIENT_ID;
  const userAgent = options.userAgent;
  return async <T>(
    operationName: string,
    sha256Hash: string,
    variables: Record<string, unknown>,
    query?: string,
    credentials?: RequestCredentials,
    emit: EventEmitter = ignoreEvent,
    signal?: AbortSignal,
    integrityOverride?: TwitchIntegrity,
  ): Promise<TwitchGqlResponse<T>> => {
    // Read once per attempt and reused for both the headers and the failure
    // stamp, so the two can never disagree.
    let sentIntegrity: TwitchIntegrity | undefined;
    const stamp = (failure: TwitchGqlFailure): TwitchGqlFailure => {
      failure.sentIntegrityToken = sentIntegrity?.integrity;
      return failure;
    };
    const buildRequest = (queryText?: string) => ({
      method: "POST",
      headers: {
        "Accept": "*/*",
        "Accept-Language": "en-US",
        "Content-Type": "text/plain; charset=UTF-8",
        "Client-ID": clientId,
        ...(userAgent ? { "User-Agent": userAgent } : {}),
        // The trio is bound together at mint time and must be replayed together.
        // Set here rather than left to the fetcher so the sent token is known.
        ...(sentIntegrity
          ? {
              "Client-Integrity": sentIntegrity.integrity,
              ...(sentIntegrity.deviceId ? { "X-Device-Id": sentIntegrity.deviceId } : {}),
              ...(sentIntegrity.clientSessionId ? { "Client-Session-Id": sentIntegrity.clientSessionId } : {}),
            }
          : {}),
      },
      ...(credentials ? { credentials } : {}),
      ...(signal ? { signal } : {}),
      body: JSON.stringify(
        queryText
          ? { operationName, variables, query: queryText }
          : {
              operationName,
              variables,
              extensions: {
                persistedQuery: {
                  version: 1,
                  sha256Hash,
                },
              },
            },
      ),
    } satisfies RequestInit);
    const fetchOnce = async (queryText?: string): Promise<TwitchGqlResponse<T> | null> => {
      // Anonymous queries deliberately carry no identity at all.
      sentIntegrity = credentials === "omit" ? undefined : integrityOverride ?? options.currentIntegrity?.();
      const request = buildRequest(queryText);
      let raw: unknown;
      try {
        raw = await fetcher.fetchJson<unknown>("https://gql.twitch.tv/gql", request, emit);
      } catch (error) {
        signal?.throwIfAborted();
        if (authHealthFromError(error)) throw error;
        const message = error instanceof Error ? error.message : `${operationName} request failed`;
        throw stamp(new TwitchGqlFailure("network", message));
      }
      const pageError = twitchPageFetchError(raw);
      if (pageError?.kind === "credentials") {
        throw new SafeFetchError({ kind: "authentication_rejected", status: 401, reason: "Authenticated session rejected" });
      }
      if (pageError) throw stamp(new TwitchGqlFailure(pageError.kind, `${operationName}: ${pageError.message}`));
      return normalizeTwitchGqlResponse<T>(raw);
    };
    let activeQuery = query;
    let response = await fetchOnce(activeQuery);
    if (!isTwitchGqlResponse<T>(response)) {
      throw stamp(new TwitchGqlFailure("platform", `${operationName} ${query ? "inline query" : "persisted query"} returned an empty Twitch GQL response`));
    }
    const fallbackQuery = !query ? TWITCH_INLINE_QUERIES[operationName] : undefined;
    if (fallbackQuery && hasPersistedQueryNotFound(response)) {
      diagnostic(emit, "debug", `GQL ${operationName} persisted query not found; retrying with the inline query`, "twitch");
      activeQuery = fallbackQuery;
      response = await fetchOnce(activeQuery);
      if (!isTwitchGqlResponse<T>(response)) {
        throw stamp(new TwitchGqlFailure("platform", `${operationName} inline query fallback returned an empty Twitch GQL response`));
      }
    }
    if (response.errors?.some((error) => isTransientGqlError(error.message))) {
      diagnostic(emit, "debug", `GQL ${operationName} returned a transient error; retrying once`, "twitch");
      response = await fetchOnce(activeQuery);
      if (!isTwitchGqlResponse<T>(response)) {
        throw stamp(new TwitchGqlFailure("platform", `${operationName} ${activeQuery ? "inline query" : "persisted query"} returned an empty Twitch GQL response`));
      }
    }
    if (response.error || (response.message && response.data === undefined)) {
      const message = [response.error, response.message].filter(Boolean).join(": ") || `${operationName} failed`;
      if (isCredentialRejection(message)) {
        throw new SafeFetchError({ kind: "authentication_rejected", status: 401, reason: "Authenticated session rejected" });
      }
      throw stamp(new TwitchGqlFailure("platform", message));
    }
    if (response.errors?.length) {
      const message = response.errors.map((error) => error.message).filter(Boolean).join("; ") || `${operationName} failed`;
      if (isCredentialRejection(message)) {
        throw new SafeFetchError({ kind: "authentication_rejected", status: 401, reason: "Authenticated session rejected" });
      }
      throw stamp(new TwitchGqlFailure("platform", message));
    }
    return response;
  };
}

export class TwitchAdapter implements PlatformAdapter {
  platform = "twitch" as const;
  readonly compatibility?: ResolvedCompatibility["twitch"];

  async checkAuthHealth(signal?: AbortSignal): Promise<PlatformAuthHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const response = await this.gqlWithIntegrityRetry<{ currentUser?: { id?: string } | null }>(
        "CurrentUser",
        "",
        {},
        CURRENT_USER_QUERY,
        undefined,
        this.emit,
        signal,
      );
      if (response.data?.currentUser) {
        return { status: "healthy", checkedAt, message: { key: "authHealthy" } };
      }
      return {
        status: "invalid_credentials",
        checkedAt,
        reasonCode: "credentials_rejected",
        message: { key: "authInvalidCredentials" },
      };
    } catch (error) {
      if (authHealthFromError(error)?.status === "invalid_credentials") {
        return {
          status: "invalid_credentials",
          checkedAt,
          reasonCode: "credentials_rejected",
          message: { key: "authInvalidCredentials" },
        };
      }
      const network = error instanceof TwitchGqlFailure && error.kind === "network";
      return {
        status: "unavailable",
        checkedAt,
        reasonCode: network ? "network_unavailable" : "platform_unavailable",
        message: { key: network ? "authNetworkUnavailable" : "authPlatformUnavailable" },
      };
    }
  }

  private readonly gqlTransport: TwitchGqlTransport;
  private readonly inventoryCapability: TwitchInventoryCapability;
  private readonly discoveryState: TwitchDiscoveryState;

  constructor(
    // Twitch GQL is unreachable from the twitch.tv page context (CORS / anti-
    // tampering blocks it). The injected fetcher reaches gql.twitch.tv with the
    // OAuth token: the extension backs it with its host-permissioned background
    // fetch (like the web client); a headless runtime with its own transport.
    private readonly fetcher: PageFetcher,
    // Twitch only enforces Client-Integrity (Kasada) for the WEB client id, so
    // this is only meaningful under that id (the extension, which captures the
    // page-minted token). A runtime using a non-web client id never needs it —
    // pass `async () => false` for "no integrity available". No default: a
    // required options.compatibility below would follow an optional parameter,
    // which TypeScript rejects (a required parameter cannot follow an optional
    // one), so this and watchTabPort lost their defaults too.
    private readonly ensureIntegrity: (request?: TwitchIntegrityRequest) => Promise<boolean>,
    // Tab-based watch is browser-bound, so it is injected (see WatchTabPort).
    private readonly watchTabPort: WatchTabPort,
    // Identity the GQL requests present. Defaults to the WEB client (what the
    // extension uses). A headless runtime can pass a non-web client id + matching
    // user agent (e.g. the Android app) so Twitch never gates it behind integrity
    // — the persisted-query hashes are client-agnostic, so claims work unchanged.
    // No default: options.compatibility is required, so every construction site
    // must resolve it via resolveCompatibility() rather than get one implied.
    private readonly options: TwitchAdapterOptions,
    private readonly emit: EventEmitter = ignoreEvent,
  ) {
    this.compatibility = options.compatibility;
    this.discoveryState = options.discoveryState ?? new TwitchDiscoveryState();
    this.gqlTransport = createTwitchGqlTransport(fetcher, options);
    this.inventoryCapability = createTwitchInventory(options.compatibility.inventory);
  }

  private async discoverCampaignSnapshot(
    { signal }: AdapterOperationOptions = {},
    // The campaign being farmed right now, if any. Its details always come from
    // a fresh request: it is the one campaign whose `self` block moves between
    // ticks, and the one whose reward progress a stale read would visibly delay.
    farmedCampaignId?: string,
  ): Promise<DropCampaign[]> {
    let [inventory, dashboardResult] = await Promise.all([
      this.fetchInventory({ signal }),
      this.fetchDashboard(TWITCH_QUERIES.dashboard.variables, signal),
    ]);
    let inventoryCampaigns = this.inventoryCapability.parse(inventory);
    let dashboardCampaigns = twitchDashboardCampaigns(dashboardResult.response);

    if (inventoryCampaigns.length === 0 && dashboardCampaigns.length === 0) {
      try {
        const [fallbackInventory, fallbackDashboardResult] = await Promise.all([
          this.fetchInventory({
            variables: { fetchRewardCampaigns: true },
            signal,
          }),
          this.fetchDashboard({ fetchRewardCampaigns: true }, signal),
        ]);
        inventory = fallbackInventory;
        inventoryCampaigns = this.inventoryCapability.parse(inventory);
        if (fallbackDashboardResult.ok || !dashboardResult.ok) {
          dashboardResult = fallbackDashboardResult;
          dashboardCampaigns = twitchDashboardCampaigns(dashboardResult.response);
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (authHealthFromError(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        diagnostic(
          this.emit,
          "warn",
          `Twitch reward-campaign inventory request failed; preserving the initial dashboard result: ${message}`,
          "twitch",
        );
      }
    }
    const dashboard = dashboardResult.response;

    if (!twitchHasCurrentUser(inventory) && !dashboard.data?.currentUser) {
      throw new SafeFetchError({
        kind: "authentication_rejected",
        reason: "Twitch did not return a logged-in current user; open twitch.tv and confirm you are signed in",
      });
    }

    const authenticatedUserId = twitchCurrentUserId(inventory) ?? dashboard.data?.currentUser?.id;
    if (authenticatedUserId && this.discoveryState.setAuthenticatedUser(authenticatedUserId)) {
      diagnostic(this.emit, "debug", "Twitch authenticated identity changed; discovery caches cleared", "twitch");
    }
    const userLogin = authenticatedUserId ?? dashboard.data?.currentUser?.login ?? "";
    // Captured after installing this response's identity and replayed when the
    // asynchronous detail requests settle. A request from an older identity
    // may still finish after a later tick clears the cache; it must answer its
    // own caller without repopulating shared state for the new identity.
    const detailsRequestIdentity = this.discoveryState.availabilityRequestIdentity();
    const freshCampaignIds = dashboardCampaigns
      .filter((campaign) =>
        campaign.id
        && (campaign.status === "ACTIVE" || campaign.status === "UPCOMING")
      )
      .map((campaign) => campaign.id as string);
    // Only from a dashboard that actually answered: a retained id list carries
    // no status, and treating "unknown" as a status would refetch everything.
    const dashboardStatusById = new Map<string, string>();
    if (dashboardResult.ok) {
      for (const campaign of dashboardCampaigns) {
        if (campaign.id && campaign.status) dashboardStatusById.set(campaign.id, campaign.status);
      }
    }

    // A failed dashboard parses to the same empty list as a dashboard with no
    // active drops, and the Inventory payload only carries campaigns the user
    // already started — so falling back to it hides every campaign they have
    // not. Reuse the last dashboard we did get instead. `dashboardResponded`
    // stays false so the expiry stamping below never fires off a stale list.
    if (dashboardResult.ok && authenticatedUserId) {
      this.discoveryState.rememberDashboardCampaignIds(freshCampaignIds);
    }
    const discoverableCampaignIds = dashboardResult.ok
      ? freshCampaignIds
      : authenticatedUserId
        ? this.discoveryState.retainedDashboardCampaignIds()
        : [];
    const dashboardResponded = dashboardResult.ok && dashboardCampaigns.length > 0;

    if (discoverableCampaignIds.length === 0) {
      return reconcileInventoryCampaignStatuses(
        inventoryCampaigns,
        new Set(discoverableCampaignIds),
        dashboardResponded,
      );
    }

    // Campaigns whose details we already hold and that nothing can have changed
    // since (see CAMPAIGN_DETAILS_FRESH_TTL_MS) cost no request this tick. The
    // farmed campaign is never served from cache, and an unauthenticated pass
    // has no identity to key reuse on, so it always refetches.
    const cachedDetailsByDropId = new Map<string, unknown>();
    const dropIdsToFetch: string[] = [];
    for (const dropID of discoverableCampaignIds) {
      const cached = authenticatedUserId && dropID !== farmedCampaignId
        ? this.discoveryState.freshCampaignDetails(dropID, dashboardStatusById.get(dropID))
        : undefined;
      if (cached === undefined) dropIdsToFetch.push(dropID);
      else cachedDetailsByDropId.set(dropID, cached);
    }

    const detailsStartedAt = Date.now();
    const detailFetch = dropIdsToFetch.length > 0
      ? await this.fetchCampaignDetails(dropIdsToFetch, userLogin, signal)
      : { results: [], batchRequests: 0, singleFallbacks: 0 };
    // Kept on an all-cache-hit tick too: a missing line would read as a dead
    // code path exactly in the steady state this cache exists to produce.
    diagnostic(
      this.emit,
      "debug",
      `Twitch campaign details finished in ${Date.now() - detailsStartedAt}ms (${discoverableCampaignIds.length} campaigns: ${dropIdsToFetch.length} fetched in ${detailFetch.batchRequests} batch requests, ${detailFetch.singleFallbacks} single fallbacks, ${cachedDetailsByDropId.size} served from cache)`,
      "twitch",
    );
    signal?.throwIfAborted();
    for (const result of detailFetch.results) {
      if (result.status === "rejected" && authHealthFromError(result.reason)) throw result.reason;
    }
    // Keyed by drop id rather than read positionally: only a subset of the
    // dashboard's campaigns is fetched, so results[i] no longer lines up with
    // discoverableCampaignIds[i], and getting that wrong would file one
    // campaign's payload under another's id with nothing to catch it.
    const fetchedByDropId = new Map<string, PromiseSettledResult<TwitchGqlResponse<TwitchCampaignDetailsData>>>();
    detailFetch.results.forEach((result, index) => {
      const dropID = dropIdsToFetch[index];
      if (dropID !== undefined) fetchedByDropId.set(dropID, result);
    });
    // A campaign the user has not started is only ever described by its detail
    // request, so dropping a rejection loses the campaign entirely. Serve the
    // last details we saw for it instead, and never lose the failure silently.
    // Iterated in dashboard order so reuse cannot reorder the snapshot.
    const detailedCampaigns: unknown[] = [];
    discoverableCampaignIds.forEach((dropID) => {
      const cached = cachedDetailsByDropId.get(dropID);
      if (cached !== undefined) {
        detailedCampaigns.push(cached);
        return;
      }
      const result = fetchedByDropId.get(dropID);
      if (!result) return;
      if (result.status === "fulfilled") {
        const data = result.value.data;
        const campaign = data?.dropCampaign ?? data?.user?.dropCampaign;
        if (!campaign) {
          const campaignWasAuthoritativelyMissing = Boolean(
            data
            && (
              Object.prototype.hasOwnProperty.call(data, "dropCampaign")
              || (
                data.user
                && Object.prototype.hasOwnProperty.call(data.user, "dropCampaign")
              )
            ),
          );
          if (authenticatedUserId && campaignWasAuthoritativelyMissing) {
            this.discoveryState.forgetCampaignDetails(dropID, detailsRequestIdentity);
          }
          return;
        }
        if (authenticatedUserId) {
          this.discoveryState.rememberCampaignDetails(
            dropID,
            campaign,
            dashboardStatusById.get(dropID),
            detailsRequestIdentity,
          );
        }
        detailedCampaigns.push(campaign);
        return;
      }
      const retained = authenticatedUserId
        ? this.discoveryState.retainedCampaignDetails(dropID)
        : undefined;
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      diagnostic(
        this.emit,
        "warn",
        `Twitch campaign details for ${dropID} failed; ${retained ? "reusing the last known details" : "leaving the campaign out of this refresh"}: ${message}`,
        "twitch",
      );
      if (retained) detailedCampaigns.push(retained);
    });
    if (detailedCampaigns.length === 0) {
      return inventoryCampaigns;
    }
    const parsedDetails = parseTwitchCampaigns(detailedCampaigns as Parameters<typeof parseTwitchCampaigns>[0]);
    const mergedDetails = mergeTwitchCampaignProgress(parsedDetails, inventory as Parameters<typeof mergeTwitchCampaignProgress>[1]);
    const detailedIds = new Set(mergedDetails.map((campaign) => campaign?.id));
    // The Inventory payload omits campaign/reward end dates, so an ended
    // campaign that still has in-progress drops parses as "active". The
    // dashboard is the authoritative signal for what is still running: if it
    // responded and no longer lists this campaign as ACTIVE/UPCOMING, treat the
    // inventory-only campaign as expired (unless it still has a claimable reward
    // we should keep surfacing so the user can claim it).
    const activeDashboardIds = new Set(discoverableCampaignIds);
    const inventoryOnly = reconcileInventoryCampaignStatuses(
      inventoryCampaigns.filter((campaign) => !detailedIds.has(campaign.id)),
      activeDashboardIds,
      dashboardResponded,
    );
    return [...mergedDetails, ...inventoryOnly];
  }

  async refreshCampaigns(
    session?: WatchSession,
    options: AdapterOperationOptions = {},
  ): Promise<DropCampaign[]> {
    const campaigns = await this.discoverCampaignSnapshot(options, session?.campaignId);
    if (!session?.channel || session.status !== "watching") return campaigns;
    return this.mergeCurrentSessionProgress(campaigns, session.channel, options.signal);
  }

  private async fetchCampaignDetails(
    dropIds: readonly string[],
    channelLogin: string,
    signal?: AbortSignal,
  ): Promise<{
    results: PromiseSettledResult<TwitchGqlResponse<TwitchCampaignDetailsData>>[];
    batchRequests: number;
    singleFallbacks: number;
  }> {
    const chunks = Array.from(
      { length: Math.ceil(dropIds.length / GQL_BATCH_OPERATION_LIMIT) },
      (_, index) => dropIds.slice(
        index * GQL_BATCH_OPERATION_LIMIT,
        (index + 1) * GQL_BATCH_OPERATION_LIMIT,
      ),
    );
    const results = new Array<{
      results: PromiseSettledResult<TwitchGqlResponse<TwitchCampaignDetailsData>>[];
      singleFallbacks: number;
    }>(chunks.length);
    let nextChunk = 0;
    const workers = Array.from(
      { length: Math.min(GQL_BATCH_CONCURRENCY, chunks.length) },
      async () => {
        for (;;) {
          const chunkIndex = nextChunk;
          nextChunk += 1;
          const chunk = chunks[chunkIndex];
          if (!chunk) return;
          signal?.throwIfAborted();
          results[chunkIndex] = await this.fetchCampaignDetailsChunk(chunk, channelLogin, signal);
        }
      },
    );
    await Promise.all(workers);
    return {
      results: results.flatMap((result) => result.results),
      batchRequests: chunks.length,
      singleFallbacks: results.reduce((total, result) => total + result.singleFallbacks, 0),
    };
  }

  private async fetchCampaignDetailsChunk(
    dropIds: readonly string[],
    channelLogin: string,
    signal?: AbortSignal,
  ): Promise<{
    results: PromiseSettledResult<TwitchGqlResponse<TwitchCampaignDetailsData>>[];
    singleFallbacks: number;
  }> {
    const fallback = async () => {
      const results: PromiseSettledResult<TwitchGqlResponse<TwitchCampaignDetailsData>>[] = [];
      for (const dropID of dropIds) {
        try {
          const value = await this.gqlWithIntegrityRetry<TwitchCampaignDetailsData>(
            "DropCampaignDetails",
            TWITCH_QUERIES.campaignDetailsHash,
            { channelLogin, dropID },
            undefined,
            undefined,
            this.emit,
            signal,
          );
          results.push({ status: "fulfilled", value });
        } catch (reason) {
          results.push({ status: "rejected", reason });
        }
      }
      return { results, singleFallbacks: dropIds.length };
    };
    const integrity = this.options.currentIntegrity?.();
    let raw: unknown;
    try {
      raw = await this.fetcher.fetchJson<unknown>(
        "https://gql.twitch.tv/gql",
        {
          method: "POST",
          headers: {
            "Accept": "*/*",
            "Accept-Language": "en-US",
            "Content-Type": "text/plain; charset=UTF-8",
            "Client-ID": this.options.clientId ?? TWITCH_CLIENT_ID,
            ...(this.options.userAgent ? { "User-Agent": this.options.userAgent } : {}),
            ...(integrity
              ? {
                  "Client-Integrity": integrity.integrity,
                  ...(integrity.deviceId ? { "X-Device-Id": integrity.deviceId } : {}),
                  ...(integrity.clientSessionId ? { "Client-Session-Id": integrity.clientSessionId } : {}),
                }
              : {}),
          },
          ...(signal ? { signal } : {}),
          body: JSON.stringify(dropIds.map((dropID) => ({
            operationName: "DropCampaignDetails",
            variables: { channelLogin, dropID },
            extensions: {
              persistedQuery: {
                version: 1,
                sha256Hash: TWITCH_QUERIES.campaignDetailsHash,
              },
            },
          }))),
        },
        this.emit,
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (authHealthFromError(error)) throw error;
      return fallback();
    }
    if (twitchPageFetchError(raw)) return fallback();
    const responses = Array.isArray(raw) ? raw : dropIds.length === 1 ? [raw] : [];
    if (responses.length !== dropIds.length) return fallback();

    let singleFallbacks = 0;
    const results: PromiseSettledResult<TwitchGqlResponse<TwitchCampaignDetailsData>>[] = [];
    for (let index = 0; index < responses.length; index += 1) {
      const value = responses[index];
      const response = normalizeTwitchGqlResponse<TwitchCampaignDetailsData>(value);
      if (
        response
        && Object.prototype.hasOwnProperty.call(response, "data")
        && !response.error
        && !(response.message && response.data === undefined)
        && !response.errors?.length
      ) {
        results.push({ status: "fulfilled", value: response });
        continue;
      }
      singleFallbacks += 1;
      try {
        const fallbackResponse = await this.gqlWithIntegrityRetry<TwitchCampaignDetailsData>(
          "DropCampaignDetails",
          TWITCH_QUERIES.campaignDetailsHash,
          { channelLogin, dropID: dropIds[index] },
          undefined,
          undefined,
          this.emit,
          signal,
        );
        results.push({ status: "fulfilled", value: fallbackResponse });
      } catch (reason) {
        results.push({ status: "rejected", reason });
      }
    }
    return { results, singleFallbacks };
  }

  async listCandidateChannels(
    campaign: DropCampaign,
    { signal }: AdapterOperationOptions = {},
  ): Promise<ChannelCandidate[]> {
    const aclCandidates = twitchCandidatesFromCampaign(campaign);
    if (aclCandidates.length > 0) return aclCandidates;
    if (!campaign.slug && !campaign.categoryId) return [];

    const response = await this.gqlWithIntegrityRetry<TwitchDirectoryData>("DirectoryPage_Game", TWITCH_QUERIES.gameDirectoryHash, {
      slug: campaign.slug ?? campaign.gameName,
      imageWidth: 50,
      includeCostreaming: false,
      options: {
        sort: "VIEWER_COUNT",
        broadcasterLanguages: [],
        includeRestricted: ["SUB_ONLY_LIVE"],
        recommendationsContext: { platform: "web" },
        requestID: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`,
        freeformTags: null,
        systemFilters: ["DROPS_ENABLED"],
        tags: [],
      },
      sortTypeIsRecency: false,
      limit: 25,
    }, undefined, undefined, this.emit, signal);

    return (response.data?.game?.streams?.edges ?? [])
      .map((edge): ChannelCandidate | undefined => {
        const broadcaster = edge.node?.broadcaster;
        if (!broadcaster?.login) return undefined;
        return {
          platform: "twitch",
          username: broadcaster.login.toLowerCase(),
          displayName: broadcaster.displayName ?? broadcaster.login,
          profileImageUrl: broadcaster.profileImageURL,
          url: `https://www.twitch.tv/${broadcaster.login}`,
          campaignId: campaign.id,
          categoryId: campaign.categoryId,
          categoryName: campaign.gameName,
          isAclMatch: false,
          viewerCount: edge.node?.viewersCount,
          title: edge.node?.title,
          live: true,
          channelId: broadcaster.id,
          broadcastId: edge.node?.id,
        };
      })
      .filter((candidate): candidate is ChannelCandidate => Boolean(candidate));
  }

  // Live channels the signed-in account follows, so the scheduler can send a
  // campaign's watch time to someone the user actually watches. A signed-out or
  // failing lookup answers with an empty list: the preference is a nicety, never
  // a reason to lose a farming tick.
  //
  // Caching lives on discoveryState, not on `this`: the extension reconstructs
  // TwitchAdapter fresh every scheduler tick, so a per-instance cache would
  // never survive to the next tick and this would hit the network every time —
  // exactly the tick latency this cache exists to avoid. A cached value (even a
  // stale one) is served immediately and refreshed in the background, never
  // blocking the caller; only the very first call ever (nothing cached yet)
  // blocks once, so the first campaign decision after startup can still prefer
  // a followed channel instead of being stuck on a stranger for the rest of the
  // session (shouldKeepWatching never switches mid-session for the same
  // campaign).
  async listFollowedChannels({ signal }: AdapterOperationOptions = {}): Promise<string[]> {
    const cache = this.discoveryState.followedChannels;
    const cached = cache.get();
    if (cached) {
      if (cache.isStale()) void cache.refreshOnce(() => this.fetchFollowedChannels());
      return cached;
    }
    await cache.refreshOnce(() => this.fetchFollowedChannels(signal));
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
      // A single plain attempt, not gqlWithIntegrityRetry: an integrity
      // rejection there forces a token refresh (and potentially a page context)
      // with a ~30s tail, which is a steep price for a tie-break nicety. Also
      // never passed the calling tick's signal when refreshing a stale cache in
      // the background (see listFollowedChannels): that fetch must outlive the
      // tick that triggered it, not be cancelled when the tick ends.
      const response = await this.gql<TwitchFollowedLiveData>(
        "FollowedLiveChannels",
        "",
        { limit: FOLLOWED_CHANNELS_LIMIT },
        FOLLOWED_LIVE_QUERY,
        undefined,
        this.emit,
        signal,
      );
      // A GQL errors body (the shape schema drift arrives in) is raised by the
      // transport, so it lands in the catch below rather than passing for a
      // signed-out account with no live follows.
      return (response.data?.currentUser?.followedLiveUsers?.edges ?? [])
        .map((edge) => edge.node?.login?.toLowerCase())
        .filter((login): login is string => Boolean(login));
    } catch (error) {
      diagnostic(
        this.emit,
        "debug",
        `Twitch followed-channel lookup failed (${error instanceof Error ? error.message : String(error)}); channel preference falls back to viewer count`,
        "twitch",
      );
      return [];
    }
  }

  async selectCandidateChannel(
    candidates: ChannelCandidate[],
    campaign?: DropCampaign,
    { signal }: AdapterOperationOptions = {},
  ): Promise<CandidateChannelSelection> {
    if (candidates.length === 0) return { checked: 0 };
    const startedAt = Date.now();
    const selectionLabel = campaign
      ? `for "${campaign.name}" (campaign ${campaign.id})`
      : "idle";
    const selectionDescription = campaign
      ? `channel selection ${selectionLabel}`
      : `${selectionLabel} channel selection`;
    const checks = new Array<ChannelCheck | undefined>(candidates.length);
    const streamCandidates: Array<{ candidate: ChannelCandidate; index: number }> = [];
    let trustedDirectoryCandidates = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate.live === true && candidate.isAclMatch === false && candidate.broadcastId) {
        trustedDirectoryCandidates += 1;
        checks[index] = {
          live: true,
          categoryMatches: !campaign?.categoryId || candidate.categoryId === campaign.categoryId,
          candidate,
        };
      } else {
        streamCandidates.push({ candidate, index });
      }
    }
    const streamCheckResult = await this.batchStreamInfoChecks(
      streamCandidates.map(({ candidate }) => candidate),
      campaign,
      signal,
    );
    streamCheckResult.checks.forEach((check, index) => {
      const target = streamCandidates[index];
      if (target) checks[target.index] = check;
    });
    // Without strict validation the matches map stays empty, so every candidate
    // reads `undefined` below and passes on live/category evidence alone.
    const availabilityResult = campaign && this.options.strictCampaignAvailability
      ? await this.batchCampaignAvailability(
          checks.flatMap((check) =>
            check?.live && check.categoryMatches && check.candidate.channelId && check.candidate.broadcastId
              ? [{
                  channelId: check.candidate.channelId,
                  channelLogin: check.candidate.username,
                  broadcastId: check.candidate.broadcastId,
                }]
              : []),
          campaign.id,
          signal,
        )
      : {
          matches: new Map<string, boolean | undefined>(),
          batchRequests: 0,
          singleFallbacks: 0,
          cacheHits: 0,
          cacheMisses: 0,
          cacheExpirations: 0,
          broadcastInvalidations: 0,
          progressOverrides: 0,
        };

    let checked = 0;
    let winnerFallbacks = 0;
    let strictRejections = 0;
    const reportSelectionFinished = () => {
      diagnostic(
        this.emit,
        "debug",
        `Twitch ${selectionDescription} finished in ${Date.now() - startedAt}ms (${this.options.strictCampaignAvailability ? "strict campaign availability" : "trusted discovery sources"}, ${streamCandidates.length} candidates batch-checked, ${checked} candidates evaluated, ${Math.ceil(streamCandidates.length / GQL_BATCH_OPERATION_LIMIT)} StreamInfo batch requests, ${streamCheckResult.singleFallbacks} StreamInfo single fallbacks, ${availabilityResult.batchRequests} AvailableDrops batch requests, ${availabilityResult.singleFallbacks} AvailableDrops single fallbacks, ${availabilityResult.cacheHits} availability cache hits, ${availabilityResult.cacheMisses} availability cache misses, ${availabilityResult.cacheExpirations} availability cache expirations, ${availabilityResult.broadcastInvalidations} availability broadcast invalidations, ${availabilityResult.progressOverrides} progress-confirmed availability overrides, ${trustedDirectoryCandidates} directory candidates trusted, ${winnerFallbacks} winner fallbacks, ${strictRejections} candidates rejected by strict availability)`,
        "twitch",
      );
    };
    const observations = (): ChannelCheck[] => checks.flatMap((check) => {
      if (!check) return [];
      return [{
        ...check,
        campaignMatches: campaign && check.candidate.channelId
          && availabilityResult.matches.has(check.candidate.channelId)
          ? availabilityResult.matches.get(check.candidate.channelId)
          : check.campaignMatches,
      }];
    });
    for (let index = 0; index < checks.length; index += 1) {
      const check = checks[index];
      if (!check) continue;
      checked += 1;
      if (!check.live || !check.categoryMatches) continue;
      let campaignMatches: boolean | undefined;
      let selectedCandidate = check.candidate;
      if (campaign && !check.candidate.channelId) {
        winnerFallbacks += 1;
        const confirmed = await this.checkChannel(check.candidate, { campaign, signal });
        checks[index] = confirmed;
        if (!confirmed.live || !confirmed.categoryMatches || confirmed.campaignMatches === false) continue;
        selectedCandidate = confirmed.candidate;
        campaignMatches = confirmed.campaignMatches;
      } else if (campaign && check.candidate.channelId) {
        campaignMatches = availabilityResult.matches.get(check.candidate.channelId);
      }
      if (campaignMatches === false) {
        strictRejections += 1;
        continue;
      }
      reportSelectionFinished();
      return {
        checked: candidates.length,
        observations: observations(),
        metrics: {
          cacheHits: availabilityResult.cacheHits,
          cacheMisses: availabilityResult.cacheMisses,
          batchRequests: Math.ceil(streamCandidates.length / GQL_BATCH_OPERATION_LIMIT) + availabilityResult.batchRequests,
          singleFallbacks: streamCheckResult.singleFallbacks + availabilityResult.singleFallbacks + winnerFallbacks,
        },
        channel: {
          ...selectedCandidate,
          live: true,
        },
      };
    }
    reportSelectionFinished();
    return {
      checked: candidates.length,
      observations: observations(),
      metrics: {
        cacheHits: availabilityResult.cacheHits,
        cacheMisses: availabilityResult.cacheMisses,
        batchRequests: Math.ceil(streamCandidates.length / GQL_BATCH_OPERATION_LIMIT) + availabilityResult.batchRequests,
        singleFallbacks: streamCheckResult.singleFallbacks + availabilityResult.singleFallbacks + winnerFallbacks,
      },
    };
  }

  private async batchCampaignAvailability(
    candidates: readonly TwitchAvailabilityCandidate[],
    campaignId: string,
    signal?: AbortSignal,
  ): Promise<{
    matches: Map<string, boolean | undefined>;
    batchRequests: number;
    singleFallbacks: number;
    cacheHits: number;
    cacheMisses: number;
    cacheExpirations: number;
    broadcastInvalidations: number;
    progressOverrides: number;
  }> {
    const matches = new Map<string, boolean | undefined>();
    const uncached: TwitchAvailabilityCandidate[] = [];
    let cacheHits = 0;
    let cacheMisses = 0;
    let cacheExpirations = 0;
    let broadcastInvalidations = 0;
    let progressOverrides = 0;
    for (const candidate of candidates) {
      if (matches.has(candidate.channelId)) continue;
      if (this.discoveryState.hasProgressConfirmedAvailability(candidate.channelId, campaignId)) {
        progressOverrides += 1;
        matches.set(candidate.channelId, true);
        continue;
      }
      const lookup = this.discoveryState.cachedChannelAvailability(candidate.channelId, candidate.broadcastId, campaignId);
      if (lookup.status === "hit") {
        cacheHits += 1;
        matches.set(candidate.channelId, lookup.campaignIds.has(campaignId));
        continue;
      }
      if (lookup.status === "expired") cacheExpirations += 1;
      else if (lookup.status === "broadcast_changed") broadcastInvalidations += 1;
      else cacheMisses += 1;
      uncached.push(candidate);
    }
    if (uncached.length === 1) {
      const candidate = uncached[0];
      // checkCampaignAvailability does not get to classify this lookup itself:
      // the loop above already read this entry, so a second read here would
      // either repeat an expired negative lookup while retained or see a plain
      // miss after the whole snapshot expires — the classification above is
      // the only correct one available.
      const metrics = { checks: 0, cacheHits: 0 };
      matches.set(
        candidate.channelId,
        await this.checkCampaignAvailability(
          candidate.channelId,
          candidate.broadcastId,
          campaignId,
          candidate.channelLogin,
          signal,
          metrics,
        ),
      );
      return {
        matches,
        batchRequests: 0,
        singleFallbacks: metrics.checks,
        cacheHits: cacheHits + metrics.cacheHits,
        cacheMisses,
        cacheExpirations,
        broadcastInvalidations,
        progressOverrides,
      };
    }
    const chunks = Array.from(
      { length: Math.ceil(uncached.length / GQL_BATCH_OPERATION_LIMIT) },
      (_, index) => uncached.slice(
        index * GQL_BATCH_OPERATION_LIMIT,
        (index + 1) * GQL_BATCH_OPERATION_LIMIT,
      ),
    );
    const results = new Array<{
      matches: Map<string, boolean | undefined>;
      singleFallbacks: number;
    }>(chunks.length);
    let nextChunk = 0;
    await Promise.all(Array.from(
      { length: Math.min(GQL_BATCH_CONCURRENCY, chunks.length) },
      async () => {
        for (;;) {
          const chunkIndex = nextChunk;
          nextChunk += 1;
          const chunk = chunks[chunkIndex];
          if (!chunk) return;
          signal?.throwIfAborted();
          results[chunkIndex] = await this.batchCampaignAvailabilityChunk(
            chunk,
            campaignId,
            signal,
          );
        }
      },
    ));
    for (const result of results) {
      for (const [channelId, match] of result.matches) matches.set(channelId, match);
    }
    return {
      matches,
      batchRequests: chunks.length,
      singleFallbacks: results.reduce((total, result) => total + result.singleFallbacks, 0),
      cacheHits,
      cacheMisses,
      cacheExpirations,
      broadcastInvalidations,
      progressOverrides,
    };
  }

  private async batchCampaignAvailabilityChunk(
    candidates: readonly TwitchAvailabilityCandidate[],
    campaignId: string,
    signal?: AbortSignal,
  ): Promise<{
    matches: Map<string, boolean | undefined>;
    singleFallbacks: number;
  }> {
    const matches = new Map<string, boolean | undefined>();
    const fallback = async (
      candidate: TwitchAvailabilityCandidate,
    ): Promise<void> => {
      matches.set(
        candidate.channelId,
        await this.checkCampaignAvailability(
          candidate.channelId,
          candidate.broadcastId,
          campaignId,
          candidate.channelLogin,
          signal,
        ),
      );
    };
    // Captured once for the whole chunk, before the request starts — every
    // entry in this batch answers as of the same moment (see
    // TwitchAvailabilityRequestIdentity).
    const requestIdentity = this.discoveryState.availabilityRequestIdentity();
    const integrity = this.options.currentIntegrity?.();
    let raw: unknown;
    try {
      raw = await this.fetcher.fetchJson<unknown>(
        "https://gql.twitch.tv/gql",
        {
          method: "POST",
          headers: {
            "Accept": "*/*",
            "Accept-Language": "en-US",
            "Content-Type": "text/plain; charset=UTF-8",
            "Client-ID": this.options.clientId ?? TWITCH_CLIENT_ID,
            ...(this.options.userAgent ? { "User-Agent": this.options.userAgent } : {}),
            ...(integrity
              ? {
                  "Client-Integrity": integrity.integrity,
                  ...(integrity.deviceId ? { "X-Device-Id": integrity.deviceId } : {}),
                  ...(integrity.clientSessionId ? { "Client-Session-Id": integrity.clientSessionId } : {}),
                }
              : {}),
          },
          ...(signal ? { signal } : {}),
          body: JSON.stringify(candidates.map((candidate) => ({
            operationName: "DropsHighlightService_AvailableDrops",
            variables: { channelID: candidate.channelId },
            extensions: {
              persistedQuery: {
                version: 1,
                sha256Hash: TWITCH_QUERIES.availableDropsHash,
              },
            },
          }))),
        },
        this.emit,
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (authHealthFromError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      for (const [index, candidate] of candidates.entries()) {
        diagnostic(
          this.emit,
          "debug",
          availableDropsEvidence(null, candidate, campaignId, `batch request index ${index} of ${candidates.length}`, `batch request failed: ${message}`),
          "twitch",
        );
        await fallback(candidate);
      }
      return { matches, singleFallbacks: candidates.length };
    }
    if (twitchPageFetchError(raw)) {
      for (const [index, candidate] of candidates.entries()) {
        diagnostic(
          this.emit,
          "debug",
          availableDropsEvidence(null, candidate, campaignId, `batch request index ${index} of ${candidates.length}`, "batch request rejected by the page fetch transport"),
          "twitch",
        );
        await fallback(candidate);
      }
      return { matches, singleFallbacks: candidates.length };
    }
    const responses = Array.isArray(raw) ? raw : candidates.length === 1 ? [raw] : [];
    let singleFallbacks = 0;
    for (const [index, candidate] of candidates.entries()) {
      const response = normalizeTwitchGqlResponse<TwitchAvailableDropsData>(responses[index]);
      diagnostic(
        this.emit,
        "debug",
        availableDropsEvidence(response, candidate, campaignId, `batch response index ${index} of ${candidates.length}`),
        "twitch",
      );
      const campaignIds = parseAvailableDropCampaigns(response, candidate.channelId);
      if (!campaignIds) {
        singleFallbacks += 1;
        await fallback(candidate);
        continue;
      }
      this.discoveryState.rememberChannelAvailability(
        candidate.channelId,
        candidate.broadcastId,
        campaignIds,
        requestIdentity,
      );
      matches.set(candidate.channelId, campaignIds.has(campaignId));
    }
    return { matches, singleFallbacks };
  }

  private async batchStreamInfoChecks(
    candidates: readonly ChannelCandidate[],
    campaign: DropCampaign | undefined,
    signal?: AbortSignal,
  ): Promise<{ checks: ChannelCheck[]; singleFallbacks: number }> {
    if (candidates.length === 0) return { checks: [], singleFallbacks: 0 };
    const chunks = Array.from(
      { length: Math.ceil(candidates.length / GQL_BATCH_OPERATION_LIMIT) },
      (_, index) => candidates.slice(
        index * GQL_BATCH_OPERATION_LIMIT,
        (index + 1) * GQL_BATCH_OPERATION_LIMIT,
      ),
    );
    const results = new Array<{ checks: ChannelCheck[]; singleFallbacks: number }>(chunks.length);
    let nextChunk = 0;
    await Promise.all(Array.from(
      { length: Math.min(GQL_BATCH_CONCURRENCY, chunks.length) },
      async () => {
        for (;;) {
          const chunkIndex = nextChunk;
          nextChunk += 1;
          const chunk = chunks[chunkIndex];
          if (!chunk) return;
          signal?.throwIfAborted();
          results[chunkIndex] = await this.batchStreamInfoChunk(chunk, campaign, signal);
        }
      },
    ));
    return {
      checks: results.flatMap((result) => result.checks),
      singleFallbacks: results.reduce((total, result) => total + result.singleFallbacks, 0),
    };
  }

  private async batchStreamInfoChunk(
    candidates: readonly ChannelCandidate[],
    campaign: DropCampaign | undefined,
    signal?: AbortSignal,
  ): Promise<{ checks: ChannelCheck[]; singleFallbacks: number }> {
    let raw: unknown;
    try {
      raw = await this.fetcher.fetchJson<unknown>(
        "https://gql.twitch.tv/gql",
        {
          method: "POST",
          credentials: "omit",
          headers: {
            "Accept": "*/*",
            "Accept-Language": "en-US",
            "Content-Type": "text/plain; charset=UTF-8",
            "Client-ID": this.options.clientId ?? TWITCH_CLIENT_ID,
            ...(this.options.userAgent ? { "User-Agent": this.options.userAgent } : {}),
          },
          ...(signal ? { signal } : {}),
          body: JSON.stringify(candidates.map((candidate) => ({
            operationName: "StreamInfo",
            variables: { channel: candidate.username },
            query: STREAM_INFO_QUERY,
          }))),
        },
        this.emit,
      );
    } catch (error) {
      signal?.throwIfAborted();
      const checks: ChannelCheck[] = [];
      for (const candidate of candidates) {
        checks.push(await this.checkChannel(candidate, { signal }));
      }
      return { checks, singleFallbacks: candidates.length };
    }
    const responses = Array.isArray(raw) ? raw : candidates.length === 1 ? [raw] : [];
    const checks: ChannelCheck[] = [];
    let singleFallbacks = 0;
    for (const [index, candidate] of candidates.entries()) {
      const response = normalizeTwitchGqlResponse<TwitchStreamInfoData>(responses[index]);
      if (!response?.data?.user || response.errors?.length || response.error) {
        singleFallbacks += 1;
        checks.push(await this.checkChannel(candidate, { signal }));
        continue;
      }
      const stream = response.data.user.stream;
      const categoryId = stream?.game?.id;
      checks.push({
        live: Boolean(stream),
        categoryMatches: !campaign?.categoryId || categoryId === campaign.categoryId,
        candidate: {
          ...candidate,
          displayName: response.data.user.displayName ?? candidate.displayName,
          categoryId: categoryId ?? candidate.categoryId,
          categoryName: stream?.game?.name ?? candidate.categoryName,
          viewerCount: stream?.viewersCount ?? candidate.viewerCount,
          channelId: response.data.user.id ?? candidate.channelId,
          broadcastId: stream?.id ?? candidate.broadcastId,
          live: Boolean(stream),
        },
      });
    }
    return { checks, singleFallbacks };
  }

  async checkChannel(
    channel: ChannelCandidate,
    { campaign, signal }: AdapterOperationOptions & { campaign?: DropCampaign } = {},
  ): Promise<ChannelCheck> {
    try {
      const response = await this.gql<TwitchStreamInfoData>(
        "StreamInfo",
        TWITCH_QUERIES.streamInfoHash,
        { channel: channel.username },
        STREAM_INFO_QUERY,
        // Anonymous: this is public data, and logged-in GQL calls without an
        // integrity token are rejected (which would mask the channel as live).
        "omit",
        this.emit,
        signal,
      );
      const stream = response.data?.user?.stream;
      const channelId = response.data?.user?.id;
      const actualCategoryId = stream?.game?.id;
      const expectedCategoryId = campaign?.categoryId ?? channel.categoryId;
      const categoryMatches = !expectedCategoryId || actualCategoryId === expectedCategoryId;
      const broadcastId = stream?.id;
      // Gated on strict validation for the same reason as selectCandidateChannel:
      // this path also re-verifies the channel already being watched, so an
      // un-gated negative would stop farming mid-session (#400).
      const campaignMatches = stream && categoryMatches && campaign && channelId && broadcastId
        && this.options.strictCampaignAvailability
        ? await this.checkCampaignAvailability(channelId, broadcastId, campaign.id, channel.username, signal)
        : undefined;
      return {
        live: Boolean(stream),
        categoryMatches,
        campaignMatches,
        reason: !stream
          ? "Twitch channel is offline"
          : campaignMatches === false
            ? "Twitch campaign is not available on this channel"
            : undefined,
        candidate: {
          ...channel,
          displayName: response.data?.user?.displayName ?? channel.displayName,
          categoryId: actualCategoryId ?? channel.categoryId,
          categoryName: stream?.game?.name ?? channel.categoryName,
          viewerCount: stream?.viewersCount ?? channel.viewerCount,
          channelId: channelId ?? channel.channelId,
          broadcastId: broadcastId ?? channel.broadcastId,
        },
      };
    } catch (error) {
      signal?.throwIfAborted();
      return this.checkChannelFromPage(channel, campaign, error, signal);
    }
  }

  private async checkCampaignAvailability(
    channelId: string,
    broadcastId: string,
    campaignId: string,
    channelLogin: string,
    signal?: AbortSignal,
    metrics?: { checks: number; cacheHits: number },
  ): Promise<boolean | undefined> {
    if (this.discoveryState.hasProgressConfirmedAvailability(channelId, campaignId)) return true;
    const lookup = this.discoveryState.cachedChannelAvailability(channelId, broadcastId, campaignId);
    if (lookup.status === "hit") {
      if (metrics) metrics.cacheHits += 1;
      return lookup.campaignIds.has(campaignId);
    }

    // Captured before the request starts: a concurrent identity switch that
    // finishes first must make the write below a no-op, not a stale cache
    // entry (see TwitchAvailabilityRequestIdentity).
    const requestIdentity = this.discoveryState.availabilityRequestIdentity();
    try {
      if (metrics) metrics.checks += 1;
      const response = await this.gqlWithIntegrityRetry<TwitchAvailableDropsData>(
        "DropsHighlightService_AvailableDrops",
        TWITCH_QUERIES.availableDropsHash,
        { channelID: channelId },
        undefined,
        undefined,
        this.emit,
        signal,
      );
      diagnostic(
        this.emit,
        "debug",
        availableDropsEvidence(response, { channelId, channelLogin, broadcastId }, campaignId, "single response"),
        "twitch",
      );
      const campaignIds = parseAvailableDropCampaigns(response, channelId);
      if (!campaignIds) {
        diagnostic(this.emit, "debug", `Twitch did not return available campaign data for ${channelLogin}; using live/category validation`, "twitch");
        return undefined;
      }

      this.discoveryState.rememberChannelAvailability(
        channelId,
        broadcastId,
        campaignIds,
        requestIdentity,
      );
      return campaignIds.has(campaignId);
    } catch (error) {
      signal?.throwIfAborted();
      if (authHealthFromError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      diagnostic(
        this.emit,
        "debug",
        availableDropsEvidence(null, { channelId, channelLogin, broadcastId }, campaignId, "single response", `single request failed: ${message}`),
        "twitch",
      );
      diagnostic(this.emit, "debug", `Could not confirm available Twitch campaigns for ${channelLogin}; using live/category validation: ${message}`, "twitch");
      return undefined;
    }
  }

  async searchCategories(query: string): Promise<CategorySelection[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    // Anonymous: public data, and logged-in GQL without an integrity token is
    // rejected. Passing the inline query skips the persisted-hash attempt.
    const response = await this.gql<TwitchSearchCategoriesData>(
      "SearchCategories",
      "",
      { query: trimmed },
      SEARCH_CATEGORIES_QUERY,
      "omit",
    );
    return (response.data?.searchCategories?.edges ?? [])
      .map((edge): CategorySelection => ({
        id: edge.node?.id ?? "",
        name: edge.node?.displayName ?? "",
        imageUrl: twitchBoxArtUrl(edge.node?.boxArtURL),
      }))
      .filter((category) => category.id && category.name);
  }

  private async fetchInventory({
    variables = { ...this.inventoryCapability.variables },
    signal,
  }: {
    variables?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {}): Promise<unknown> {
    try {
      return await this.gqlWithIntegrityRetry<unknown>("Inventory", this.inventoryCapability.hash, variables, undefined, undefined, this.emit, signal);
    } catch (error) {
      if (!(error instanceof Error) || !/PersistedQueryNotFound/i.test(error.message)) throw error;
      diagnostic(this.emit, "debug", `GQL Inventory persisted query not found for ${this.inventoryCapability.id}; retrying with its inline query`, "twitch");
      return this.gqlWithIntegrityRetry<unknown>("Inventory", this.inventoryCapability.hash, variables, this.inventoryCapability.inlineQuery, undefined, this.emit, signal);
    }
  }

  // Non-auth failures are tolerated, but reported: discovery has to tell
  // "Twitch says there are no campaigns" from "Twitch did not answer".
  private async fetchDashboard(
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ response: TwitchGqlResponse<TwitchDashboardData>; ok: boolean }> {
    try {
      const response = await this.gqlWithIntegrityRetry<TwitchDashboardData>(
        TWITCH_QUERIES.dashboard.operationName,
        TWITCH_QUERIES.dashboard.sha256Hash,
        variables,
        undefined,
        undefined,
        this.emit,
        signal,
      );
      return { response, ok: true };
    } catch (error) {
      signal?.throwIfAborted();
      if (authHealthFromError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      diagnostic(this.emit, "warn", `Twitch drops dashboard request failed; reusing the last campaign list it returned: ${message}`, "twitch");
      return { response: {}, ok: false };
    }
  }

  // A "claimable" reward can only be claimed once Twitch has released its real
  // drop-instance id (see parseTwitchReward). Until then, defer.
  isClaimReady(reward: DropReward): boolean {
    return Boolean(reward.claimId);
  }

  async claimReward(
    campaign: DropCampaign,
    reward: DropReward,
    { signal }: AdapterOperationOptions = {},
  ): Promise<boolean> {
    if (!reward.claimId) return false;

    diagnostic(this.emit, "debug", `Claiming ${reward.name} from ${campaign.name} (instance ${reward.claimId})`, "twitch");
    // Claiming requires a valid Client-Integrity token, which we replay from the
    // live twitch.tv page (see src/core/twitchIntegrity.ts). Proactively ensure one
    // exists first so a tabless / no-tab session can still claim. This is a no-op
    // fast path when a token is already captured.
    await this.ensureIntegrity({ signal });

    // A successful claim changes what a detail read returns for this campaign
    // (`self { isClaimed dropInstanceID }`), so its reuse window ends here even
    // though nothing about discovery has run yet. Freshness only: the payload
    // stays available as outage retention until its normal expiry.
    const invalidateOnClaim = (claimed: boolean): boolean => {
      if (claimed && campaign.id) this.discoveryState.expireCampaignDetailsFreshness(campaign.id);
      return claimed;
    };

    try {
      return invalidateOnClaim(await this.runClaim(reward, signal));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only integrity rejections are worth a refresh + retry; everything else
      // (e.g. an unexpected status or a stale id) propagates unchanged.
      if (!isIntegrityRejection(error)) throw error;
      diagnostic(this.emit, "warn", `Claim for ${reward.name} was rejected for integrity; refreshing the token and retrying once`, "twitch");
      // Twitch rejected the token it was sent, so the local expiry says nothing:
      // only a forced refresh replaces it. Retry exactly once; a second failure
      // propagates.
      const rejectedToken = sentIntegrityToken(error);
      const retry = await refreshIntegrityForRetry(this.ensureIntegrity, rejectedToken, signal);
      if (retry.refreshed) return invalidateOnClaim(await this.runClaim(reward, signal, retry.integrity));
      throw new Error(`Twitch rejected the claim for ${reward.name} (${message}). Keep a logged-in twitch.tv tab open so the extension can capture a valid integrity token, then retry.`);
    }
  }

  private async runClaim(reward: DropReward, signal?: AbortSignal, integrityOverride?: TwitchIntegrity): Promise<boolean> {
    const result = await this.gql<{ claimDropRewards?: { status?: string } }>(
      "DropsPage_ClaimDropRewards",
      TWITCH_QUERIES.claimHash,
      { input: { dropInstanceID: reward.claimId } },
      undefined,
      undefined,
      this.emit,
      signal,
      integrityOverride,
    );
    const status = result.data?.claimDropRewards?.status;
    if (status === "ELIGIBLE_FOR_ALL" || status === "DROP_INSTANCE_ALREADY_CLAIMED") return true;
    // Surface the rejection instead of a silent false so the cause is visible in
    // the event log (e.g. an unexpected status, integrity, or a stale id).
    throw new Error(`Twitch refused claim for ${reward.name}: status=${status ?? "unknown"}`);
  }

  async claimChannelPoints(
    channel: ChannelCandidate,
    { signal }: AdapterOperationOptions = {},
  ): Promise<boolean> {
    const context = await this.gqlWithIntegrityRetry<TwitchChannelPointsData>(
      "ChannelPointsContext",
      TWITCH_QUERIES.channelPointsHash,
      { channelLogin: channel.username },
      undefined,
      undefined,
      this.emit,
      signal,
    );
    const channelId = context.data?.community?.channel?.id;
    const claimId = context.data?.community?.channel?.self?.communityPoints?.availableClaim?.id;
    if (!channelId || !claimId) return false;

    // Like a drop claim, this mutation is gated on Client-Integrity. Ensure one
    // exists first (a no-op fast path when a token is already captured), then
    // recover explicitly rather than through a generic transport retry — the
    // same claim id must never be replayed more than once.
    await this.ensureIntegrity({ signal });
    try {
      return await this.runChannelPointsClaim(claimId, channelId, signal);
    } catch (error) {
      if (!isIntegrityRejection(error)) throw error;
      diagnostic(this.emit, "warn", `Channel-points claim for ${channel.username} was rejected for integrity; refreshing the token and retrying once`, "twitch");
      const rejectedToken = sentIntegrityToken(error);
      const retry = await refreshIntegrityForRetry(this.ensureIntegrity, rejectedToken, signal);
      if (!retry.refreshed) throw error;
      return await this.runChannelPointsClaim(claimId, channelId, signal, retry.integrity);
    }
  }

  private async runChannelPointsClaim(
    claimId: string,
    channelId: string,
    signal?: AbortSignal,
    integrityOverride?: TwitchIntegrity,
  ): Promise<boolean> {
    const result = await this.gql<{ claimCommunityPoints?: { status?: string } }>(
      "ClaimCommunityPoints",
      TWITCH_QUERIES.claimCommunityPointsHash,
      { input: { claimID: claimId, channelID: channelId } },
      undefined,
      undefined,
      this.emit,
      signal,
      integrityOverride,
    );
    return result.data?.claimCommunityPoints?.status !== "CLAIM_NOT_AVAILABLE";
  }

  prepareWatchTab(channel: ChannelCandidate, session?: WatchSession, options?: Partial<WatchTabOptions>) {
    return this.watchTabPort.openPinnedMutedTab(channel, session, options);
  }

  stopWatchTab(session: WatchSession, options?: Partial<WatchTabOptions>): Promise<void> {
    return this.watchTabPort.stopWatchTab(session, options);
  }

  // Tabless farming: send Twitch's minute-watched telemetry instead of opening a
  // video tab. The watcher reuses this adapter's authenticated GQL transport, so
  // it keeps working even though the controller recreates adapters each tick.
  supportsTabless = true;

  // Twitch reveals the next reward in a campaign chain only on a later
  // inventory read, so a bounded post-claim refresh recovers watch time that
  // would otherwise be lost waiting for the fixed one-minute watch alarm.
  supportsPostClaimHandoff = true;

  createTablessWatcher(): TablessWatchController {
    return new TwitchWatcher(this.gqlTransport, this.options, this.ensureIntegrity);
  }

  private async mergeCurrentSessionProgress(
    campaigns: DropCampaign[],
    channel: ChannelCandidate,
    signal?: AbortSignal,
  ): Promise<DropCampaign[]> {
    try {
      const streamInfo = await this.gqlWithIntegrityRetry<TwitchStreamInfoData>(
        "VideoPlayerStreamInfoOverlayChannel",
        TWITCH_QUERIES.streamInfoHash,
        { channel: channel.username },
        undefined,
        undefined,
        this.emit,
        signal,
      );
      const channelId = streamInfo.data?.user?.id;
      if (!channelId) return campaigns;

      // Captured immediately before this request so progress from a session
      // that outlives an account switch cannot become availability evidence.
      const requestIdentity = this.discoveryState.availabilityRequestIdentity();
      const current = await this.gqlWithIntegrityRetry<TwitchCurrentDropData>(
        "DropCurrentSessionContext",
        TWITCH_QUERIES.currentDropHash,
        { channelID: channelId, channelLogin: "" },
        undefined,
        undefined,
        this.emit,
        signal,
      );
      const drop = current.data?.currentUser?.dropCurrentSession;
      if (!drop?.dropID || drop.currentMinutesWatched == null) return campaigns;
      const currentMinutesWatched = drop.currentMinutesWatched;
      const matchingCampaigns = campaigns.filter((campaign) =>
        campaign.rewards.some((reward) => reward.id === drop.dropID)
      );
      const matchingCampaign = matchingCampaigns.length === 1 ? matchingCampaigns[0] : undefined;
      const previousReward = matchingCampaign?.rewards.find((reward) => reward.id === drop.dropID);
      if (
        matchingCampaign
        && previousReward
        && currentMinutesWatched > previousReward.watchedMinutes
      ) {
        const wasProgressConfirmed = this.discoveryState.hasProgressConfirmedAvailability(
          channelId,
          matchingCampaign.id,
        );
        const broadcastId = streamInfo.data?.user?.stream?.id;
        const availability = broadcastId
          ? this.discoveryState.cachedChannelAvailability(channelId, broadcastId, matchingCampaign.id)
          : { status: "miss" as const };
        const overridesNegativeAvailability = availability.status === "hit"
          && !availability.campaignIds.has(matchingCampaign.id);
        const wrote = this.discoveryState.rememberProgressConfirmedAvailability(
          channelId,
          matchingCampaign.id,
          requestIdentity,
        );
        if (
          wrote
          && !wasProgressConfirmed
          && overridesNegativeAvailability
        ) {
          diagnostic(
            this.emit,
            "debug",
            `Twitch current-session progress confirmed campaign ${matchingCampaign.id} for ${channel.username} despite a negative availability snapshot`,
            "twitch",
          );
        }
      }

      return campaigns.map((campaign) => ({
        ...campaign,
        rewards: campaign.rewards.map((reward) => reward.id === drop.dropID
          ? {
              ...reward,
              watchedMinutes: Math.max(reward.watchedMinutes, currentMinutesWatched),
              status: currentMinutesWatched >= reward.requiredMinutes
                ? "claimable"
                : currentMinutesWatched > 0
                  ? "in_progress"
                  : reward.status,
              isCurrentReward: true,
            }
          : { ...reward, isCurrentReward: false }),
      }));
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      diagnostic(this.emit, "warn", `Could not merge current session progress for ${channel.username}: ${message}`, "twitch");
      return campaigns;
    }
  }

  private async gql<T>(
    operationName: string,
    sha256Hash: string,
    variables: Record<string, unknown>,
    query?: string,
    credentials?: RequestCredentials,
    emit: EventEmitter = this.emit,
    signal?: AbortSignal,
    integrityOverride?: TwitchIntegrity,
  ): Promise<TwitchGqlResponse<T>> {
    return integrityOverride
      ? this.gqlTransport(operationName, sha256Hash, variables, query, credentials, emit, signal, integrityOverride)
      : this.gqlTransport(operationName, sha256Hash, variables, query, credentials, emit, signal);
  }

  // Twitch can reject an authenticated request for Client-Integrity while the
  // session itself is fine and the captured token has not locally expired, so
  // the only recovery is a genuinely fresh token. Bounded to one forced refresh
  // and one identical replay; the caller's own fallback handles the rest.
  //
  // This deliberately lives above the transport rather than inside it: the same
  // transport carries mutations (which must never be replayed implicitly) and
  // anonymous requests (which must never open a page context).
  private async gqlWithIntegrityRetry<T>(
    operationName: string,
    sha256Hash: string,
    variables: Record<string, unknown>,
    query?: string,
    credentials?: RequestCredentials,
    emit: EventEmitter = this.emit,
    signal?: AbortSignal,
  ): Promise<TwitchGqlResponse<T>> {
    try {
      return await this.gql<T>(operationName, sha256Hash, variables, query, credentials, emit, signal);
    } catch (error) {
      if (!isIntegrityRejection(error, credentials)) throw error;
      diagnostic(emit, "debug", `GQL ${operationName} was rejected for integrity; refreshing the token and retrying once`, "twitch");
      // Taken from the failure, which carries the token the request actually
      // sent. Re-reading it here would race a concurrent capture and could
      // report a token this request never used.
      const rejectedToken = sentIntegrityToken(error);
      const retry = await refreshIntegrityForRetry(this.ensureIntegrity, rejectedToken, signal);
      if (!retry.refreshed) throw error;
      return this.gql<T>(operationName, sha256Hash, variables, query, credentials, emit, signal, retry.integrity);
    }
  }

  private async checkChannelFromPage(
    channel: ChannelCandidate,
    campaign: DropCampaign | undefined,
    originalError: unknown,
    signal?: AbortSignal,
  ): Promise<ChannelCheck> {
    const originalMessage = originalError instanceof Error ? originalError.message : String(originalError);
    diagnostic(this.emit, "debug", `Channel GQL check failed for ${channel.username}, falling back to the channel page: ${originalMessage}`, "twitch");
    try {
      const page = await this.fetcher.fetchJson<{ html?: string }>(channel.url, { signal }, this.emit);
      const html = page.html ?? "";
      const live = parseLiveState(html);
      if (!live) {
        diagnostic(this.emit, "debug", `Channel page for ${channel.username} showed no live signal; treating as offline`, "twitch");
      }
      const actualCategoryId = parseGameId(html);
      const expectedCategoryId = campaign?.categoryId ?? channel.categoryId;
      return {
        live,
        categoryMatches: !expectedCategoryId || actualCategoryId == null || actualCategoryId === expectedCategoryId,
        reason: "Twitch GQL check failed; used channel page fallback",
        candidate: {
          ...channel,
          categoryId: actualCategoryId ?? channel.categoryId,
        },
      };
    } catch {
      signal?.throwIfAborted();
      return {
        live: false,
        categoryMatches: false,
        reason: originalError instanceof Error ? originalError.message : "Twitch channel check failed",
        candidate: channel,
      };
    }
  }
}

// Sends one minute-watched spade event per tick (~once a minute), the tabless
// equivalent of keeping a muted video tab playing. Stateless across ticks except
// for the cached viewer id, so the controller can keep a single instance alive.
class TwitchWatcher implements TablessWatchController {
  readonly platform = "twitch" as const;
  private channel?: ChannelCandidate;
  private viewerUserId?: string;
  private readonly diagnostics = new PendingWatcherDiagnostics();

  private readonly heartbeatStrategy: TwitchHeartbeatStrategy;

  constructor(
    private readonly gql: TwitchGqlTransport,
    private readonly options: TwitchAdapterOptions,
    // Only the authenticated CurrentUser fallback below uses this. The anonymous
    // stream lookup and the heartbeat telemetry are deliberately excluded.
    private readonly ensureIntegrity: (request?: TwitchIntegrityRequest) => Promise<boolean> = async () => false,
  ) {
    this.heartbeatStrategy = options.heartbeatStrategy ?? createTwitchHeartbeat(
      options.compatibility.heartbeat,
      {
        gql,
        emit: this.diagnostics.emit,
        log: (level, message) => this.log(level, message),
        identity: options.heartbeatIdentity ?? "web",
        fetchText: options.heartbeatFetchText,
        post: options.heartbeatPost,
      },
    );
  }

  get channelUrl(): string | undefined {
    return this.channel?.url;
  }

  drainEvents() {
    return this.diagnostics.drain();
  }

  private log(level: LogLevel, message: string): void {
    this.diagnostics.push({ category: "diagnostic", platform: "twitch", level, message });
  }

  async start(channel: ChannelCandidate, context: WatchContext): Promise<void> {
    this.channel = channel;
    if (context.userId) this.viewerUserId = context.userId;
  }

  async stop(): Promise<void> {
    this.channel = undefined;
  }

  async tick(context: WatchContext): Promise<HeartbeatResult> {
    const channel = this.channel;
    if (!channel) return { ok: false, message: "Twitch tabless watcher has no channel" };
    if (context.userId) this.viewerUserId = context.userId;

    // Public stream info (anonymous, like checkChannel) for a fresh broadcast id
    // and liveness; logged-in GQL without an integrity token would be rejected.
    const info = await this.gql<TwitchStreamInfoData>(
      "StreamInfo",
      TWITCH_QUERIES.streamInfoHash,
      { channel: channel.username },
      STREAM_INFO_QUERY,
      "omit",
      this.diagnostics.emit,
    );
    const stream = info.data?.user?.stream;
    const channelId = info.data?.user?.id ?? channel.channelId;
    const broadcastId = stream?.id ?? channel.broadcastId;
    if (!stream || !channelId || !broadcastId) {
      this.log("debug", `Heartbeat skipped for ${channel.username}: channel offline or missing a broadcast id`);
      return { ok: false, live: false, message: "Twitch channel is offline or missing a broadcast id" };
    }

    const userId = await this.resolveUserId();
    if (!userId) return { ok: false, live: true, message: "Twitch did not return a logged-in user id" };
    this.log("debug", `Heartbeat for ${channel.username} (broadcast ${broadcastId}, channel ${channelId})`);

    return await this.heartbeatStrategy.tick({
      channel,
      broadcastId,
      channelId,
      userId,
      gameId: stream.game?.id,
      gameName: stream.game?.name,
    });
  }

  private async resolveUserId(): Promise<string | undefined> {
    if (this.viewerUserId) return this.viewerUserId;
    const currentUser = (integrityOverride?: TwitchIntegrity) => this.gql<{ currentUser?: { id?: string } }>(
      "CurrentUser",
      "",
      {},
      CURRENT_USER_QUERY,
      undefined,
      this.diagnostics.emit,
      undefined,
      integrityOverride,
    );
    try {
      let response;
      try {
        response = await currentUser();
      } catch (error) {
        // Bounded to one forced refresh and one identical replay, like the
        // adapter's safe authenticated reads.
        if (!isIntegrityRejection(error)) throw error;
        this.log("debug", "Twitch viewer id lookup was rejected for integrity; refreshing the token and retrying once");
        const retry = await refreshIntegrityForRetry(this.ensureIntegrity, sentIntegrityToken(error));
        if (!retry.refreshed) throw error;
        response = await currentUser(retry.integrity);
      }
      this.viewerUserId = response.data?.currentUser?.id;
    } catch (error) {
      // Leave unresolved; tick() reports the missing-user case to the scheduler.
      const message = error instanceof Error ? error.message : String(error);
      this.log("warn", `Could not resolve the Twitch viewer id for tabless watching: ${message}`);
    }
    return this.viewerUserId;
  }
}

function twitchDashboardCampaigns(dashboard: TwitchGqlResponse<TwitchDashboardData>) {
  return dashboard.data?.currentUser?.dropCampaigns
    ?? dashboard.data?.currentUser?.inventory?.dropCampaigns
    ?? [];
}

function twitchCurrentUserId(value: unknown): string | undefined {
  return (value as { data?: { currentUser?: { id?: string } } }).data?.currentUser?.id;
}

function twitchHasCurrentUser(value: unknown): boolean {
  return Boolean((value as { data?: { currentUser?: unknown } }).data?.currentUser);
}

function isTwitchGqlResponse<T>(value: TwitchGqlResponse<T> | null): value is TwitchGqlResponse<T> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// Twitch's GQL endpoint answers with a JSON array (one entry per batched
// operation) even though we POST a single operation. Unwrap the lone entry so
// the caller sees the same `{ data, errors }` shape it would for an unbatched
// response; both PersistedQueryNotFound and integrity rejections arrive this way.
// The in-page fetcher resolves `{ __twitchGqlError }` instead of rejecting,
// because executeScript discards rejection messages. Pull the diagnostic out.
function twitchPageFetchError(value: unknown): { message: string; kind: TwitchGqlFailureKind } | undefined {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    const envelope = value as { __twitchGqlError?: unknown; __twitchGqlFailureKind?: unknown };
    if (typeof envelope.__twitchGqlError === "string") {
      const kind = envelope.__twitchGqlFailureKind;
      return {
        message: envelope.__twitchGqlError,
        kind: kind === "credentials" || kind === "platform" ? kind : "network",
      };
    }
  }
  return undefined;
}

function normalizeTwitchGqlResponse<T>(value: unknown): TwitchGqlResponse<T> | null {
  if (Array.isArray(value)) {
    return value.length === 1 ? (value[0] as TwitchGqlResponse<T> | null) : null;
  }
  return value as TwitchGqlResponse<T> | null;
}

// The one place that decides whether an AvailableDrops response is trustworthy
// enough to cache, shared by both the batch and single-channel paths so the
// rule cannot drift between them. Twitch's response says nothing about which
// channel it answers for beyond `channel.id`, so a response is only usable
// when that id is present and matches the channel this specific request asked
// about — otherwise a mismatched or reordered batch entry could silently
// cache one channel's availability under another channel's id. Returns
// undefined (never an empty set) for anything ambiguous, so the caller falls
// back to live/category validation instead of caching a false negative.
function parseAvailableDropCampaigns(
  response: TwitchGqlResponse<TwitchAvailableDropsData> | null,
  expectedChannelId: string,
): Set<string> | undefined {
  if (!response) return undefined;
  if (response.error || (response.message && response.data === undefined) || response.errors?.length) {
    return undefined;
  }
  const channel = response.data?.channel;
  if (!channel?.id || channel.id !== expectedChannelId) return undefined;
  if (!Array.isArray(channel.viewerDropCampaigns)) return undefined;
  return new Set(
    channel.viewerDropCampaigns
      .map((campaign) => campaign?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
}

// Credential-free evidence for comparing a batched AvailableDrops response with
// its single-channel equivalent (#400 acceptance criterion 10). Everything here
// is a public identifier or a GQL error string — never headers, cookies, the
// integrity token, or session/device ids. Emitted only on the strict path,
// which is the only caller of these queries, and at debug level so it stays
// behind the diagnostic-logging setting.
function availableDropsEvidence(
  response: TwitchGqlResponse<TwitchAvailableDropsData> | null,
  requested: { channelId: string; channelLogin: string; broadcastId: string },
  campaignId: string,
  source: string,
  // Set when the request never produced a response at all (transport throw or a
  // page-fetch rejection). Without it those candidates would leave no comparable
  // record, which is the gap that makes a batch failure indistinguishable from a
  // campaign Twitch genuinely does not list.
  failure?: string,
): string {
  const channel = response?.data?.channel;
  const returnedIds = Array.isArray(channel?.viewerDropCampaigns)
    ? channel.viewerDropCampaigns
      .map((campaign) => campaign?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
    : undefined;
  const errors = [
    failure,
    response?.error,
    response?.message,
    ...(response?.errors ?? []).map((error) => error.message),
  ].filter((message): message is string => Boolean(message));
  return [
    `Twitch AvailableDrops evidence (${source})`,
    `requested channel ${requested.channelLogin} id=${requested.channelId} broadcast=${requested.broadcastId}`,
    `matching campaign ${campaignId}`,
    `returned channel.id=${channel?.id ?? "none"}`,
    `returned viewerDropCampaigns=${returnedIds ? (returnedIds.length > 0 ? returnedIds.join(",") : "empty") : "absent"}`,
    `errors=${errors.length > 0 ? errors.join("; ") : "none"}`,
  ].join("; ");
}

function isTransientGqlError(message: string | undefined): boolean {
  return message === "service error"
    || message === "service timeout"
    || message === "service unavailable"
    || message === "context deadline exceeded";
}

function hasPersistedQueryNotFound<T>(response: TwitchGqlResponse<T>): boolean {
  return response.errors?.some((error) => error.message === "PersistedQueryNotFound") ?? false;
}

function parseLiveState(html: string): boolean {
  if (/["']isLiveBroadcast["']\s*:\s*true/i.test(html)) return true;
  if (/["']stream["']\s*:\s*null/i.test(html)) return false;
  if (/isLiveBroadcast/i.test(html) || /DropsEnabled/i.test(html)) return true;
  // No detectable live signal in the page. Treat as offline rather than
  // assuming live: if Twitch's page markup drifts so no marker matches, a
  // default of `true` would silently stall the scheduler on an offline channel
  // (offlineChecks never increments). Reporting offline instead self-heals —
  // the scheduler re-selects and re-checks via GQL, which usually recovers.
  return false;
}

function parseGameId(html: string): string | undefined {
  const gameObject = html.match(/["']game["']\s*:\s*\{[^{}]*["']id["']\s*:\s*["']([^"']+)["']/i);
  if (gameObject?.[1]) return gameObject[1];
  const gameId = html.match(/["']gameID["']\s*:\s*["']([^"']+)["']/i);
  return gameId?.[1];
}
