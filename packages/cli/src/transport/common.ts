import type { EngineSettings, Platform } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import { DEFAULT_ENGINE_SETTINGS } from "@lurkloot/shared/settings";
import type { PageFetcher, PlatformAdapter, WatchTabPort } from "@lurkloot/core/adapter";
import type { WebSocketFactory } from "@lurkloot/core/webSocket";
import { createKickFetcher, KickAdapter, KickClaimState, KickDiscoveryState } from "@lurkloot/core/kick";
import { TwitchAdapter, TwitchDiscoveryState } from "@lurkloot/core/twitch";
import type { TwitchHeartbeatFetchText, TwitchHeartbeatPost } from "@lurkloot/core/twitch/heartbeat";
import { resolveCompatibility, type CompatibilityResolution } from "@lurkloot/core";
import type { PlatformCredentials } from "../authStore";
import { twitchClientIdentity } from "../twitch";

// A built set of platform adapters plus a teardown hook (e.g. to stop the
// cycletls subprocess the impersonate transport owns). Every transport returns
// this shape so the commands can dispose uniformly.
export interface TransportHandle {
  adapters: Record<Platform, PlatformAdapter>;
  createAdapter(platform: Platform, emit: EventEmitter, settings: EngineSettings): {
    adapter: PlatformAdapter;
  } & CompatibilityResolution;
  createAdapters(emit: EventEmitter, settings: EngineSettings): {
    adapters: Record<Platform, PlatformAdapter>;
  } & CompatibilityResolution;
  dispose(): Promise<void>;
}

// Which platforms the run actually farms, so a transport can skip building heavy
// resources for a disabled platform.
export interface EnabledPlatforms {
  twitch: boolean;
  kick: boolean;
}

export function createLazyAdapters(
  createAdapter: (platform: Platform) => PlatformAdapter,
): Record<Platform, PlatformAdapter> {
  let twitch: PlatformAdapter | undefined;
  let kick: PlatformAdapter | undefined;
  return {
    get twitch() {
      return twitch ??= createAdapter("twitch");
    },
    get kick() {
      return kick ??= createAdapter("kick");
    },
  };
}

// What a CLI transport supplies to get the shared TwitchAdapter/KickAdapter
// construction below: how each platform reaches the network. Everything else
// (identity resolution, compatibility resolution, discovery/claim state,
// tabless watch wiring) is identical between the http and impersonate
// transports and lives here once.
export interface CliTransportDeps {
  twitchFetcher(): PageFetcher;
  twitchHeartbeat(identity: ReturnType<typeof twitchClientIdentity>): {
    heartbeatFetchText: TwitchHeartbeatFetchText;
    heartbeatPost: TwitchHeartbeatPost;
  };
  kickFetcher(): PageFetcher;
  // Absent for the http transport: it never opens the viewer WebSocket itself
  // (Kick's WAF blocks it from a pure-Node origin anyway).
  kickWebSocketFactory?(): WebSocketFactory;
}

export function createCliAdapters(
  creds: PlatformCredentials,
  deps: CliTransportDeps,
): Pick<TransportHandle, "adapters" | "createAdapter" | "createAdapters"> {
  const kickClaimState = new KickClaimState();
  const kickDiscoveryState = new KickDiscoveryState();
  const twitchDiscoveryState = new TwitchDiscoveryState();
  const createAdapter = (platform: Platform, emit: EventEmitter | undefined, settings: EngineSettings = DEFAULT_ENGINE_SETTINGS) => {
    const identity = twitchClientIdentity(creds);
    const twitchIdentity = identity.userAgent ? "android" : "web";
    const resolution = resolveCompatibility(settings.compatibility, { host: "cli", twitchIdentity });
    const kickFetcher = platform === "kick" ? deps.kickFetcher() : undefined;
    const adapter = platform === "twitch"
      ? new TwitchAdapter(
        deps.twitchFetcher(),
        async () => false,
        tablessWatchPort,
        {
          ...identity,
          compatibility: resolution.compatibility.twitch,
          discoveryState: twitchDiscoveryState,
          strictCampaignAvailability: settings.platform.twitch.strictCampaignAvailability,
          heartbeatIdentity: twitchIdentity,
          ...deps.twitchHeartbeat(identity),
        },
        emit,
      )
      : new KickAdapter(
        createKickFetcher({
          background: (url, init) => kickFetcher!.fetchJson(url, init, emit),
          routeState: kickDiscoveryState.routeDiagnostics,
        }),
        tablessWatchPort,
        deps.kickWebSocketFactory?.(),
        { compatibility: resolution.compatibility.kick, claimState: kickClaimState, discoveryState: kickDiscoveryState },
        emit,
      );
    return { adapter, ...resolution };
  };
  const createAdapters = (emit: EventEmitter | undefined, settings: EngineSettings = DEFAULT_ENGINE_SETTINGS) => {
    const twitch = createAdapter("twitch", emit, settings);
    const kick = createAdapter("kick", emit, settings);
    return {
      adapters: {
        twitch: twitch.adapter,
        kick: kick.adapter,
      },
      compatibility: twitch.compatibility,
      warnings: twitch.warnings,
    };
  };
  return {
    adapters: createLazyAdapters((platform) => createAdapter(platform, undefined).adapter),
    createAdapter,
    createAdapters,
  };
}

// Shared engine code, so it lives in core alongside the heartbeat strategies it
// bounds — the extension's transport uses the same helper. Re-exported here so
// both CLI transports keep importing their transport helpers from one place.
export {
  HEARTBEAT_REQUEST_TIMEOUT_MS,
  HeartbeatTimeoutError,
  isHeartbeatTimeoutError,
  withHeartbeatTimeout,
} from "@lurkloot/core/twitch/heartbeat";

// Watch port for the headless transports, which never open a tab: opening fails
// clearly (the CLI farms tabless only — keep tablessMode on), while stopping is
// a harmless no-op (nothing to stop without a tab, but the scheduler still calls
// it to clean up idle/disabled platforms).
export const tablessWatchPort: WatchTabPort = {
  openPinnedMutedTab() {
    throw new Error('Tab-based watch is unavailable headlessly; keep "tablessMode" enabled in the config');
  },
  async stopWatchTab() {
    // nothing to stop without a tab
  },
};

// Chrome 124 fingerprint for TLS/JA3 + HTTP/2 impersonation (what Cloudflare
// inspects in front of Kick). Mirrors curl_cffi's impersonate="chrome124" used
// by comparable Kick miners. A fingerprint can itself become flagged over time;
// bump these together — JA3 + HTTP/2 + UA must stay mutually consistent — if
// Kick starts rejecting them.
export const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export const CHROME_JA3 =
  "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-21,29-23-24,0";
export const CHROME_HTTP2 = "1:65536,2:0,4:6291456,6:262144|15663105|0|m,a,s,p";

// Normalizes the various RequestInit.headers shapes into a plain object so the
// cycletls request options can carry them.
export function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { out[key] = value; });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
  } else {
    Object.assign(out, headers);
  }
  return out;
}

export function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}
