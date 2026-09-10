import { browser } from "wxt/browser";
import { loadSettings, loadState, loadTwitchIntegrity, resetStorage, saveSettings, saveState, saveTwitchIntegrity } from "../src/core/storage";
import type { CliCredentialBlob, RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import {
  applyAdFocus,
  cancelTwitchIntegrityAcquisition,
  currentValidTwitchIntegrity,
  ensureTwitchIntegrity,
  fetchJsonInPage,
  fetchKickInBackground,
  fetchTwitchInBackground,
  openPinnedMutedTab,
  recordManagedPageContextBackgroundSuccess,
  recordManagedPageContextFallback,
  stopManagedPageContextTabs,
  stopWatchTab,
} from "../src/core/tabs";
import { createBackgroundAlarmListener, createBackgroundController } from "@lurkloot/core/controller";
import { resolveCompatibility } from "@lurkloot/core";
import { applySettingsPatch } from "@lurkloot/shared/settings";
import { effectiveLocale, translateFromCatalogs, type MessageCatalog } from "@lurkloot/shared/i18n";
import { loadCatalog } from "@lurkloot/locales";
import type { ExtensionSettings, Platform, SupportedLocale } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import type { WatchTabPort } from "@lurkloot/core/adapter";
import type { WebSocketFactory, WebSocketLike } from "@lurkloot/core/webSocket";
import { createKickFetcher, KickAdapter, KickClaimState, KickDiscoveryState } from "@lurkloot/core/kick";
import { TwitchAdapter, TwitchDiscoveryState } from "@lurkloot/core/twitch";
import { isMinorOrMajorBump } from "../src/core/version";
import { savePendingChangelogVersion } from "../src/core/updateNotice";
import { appendActivityEvents, clearActivityEvents, exportDiagnosticsEvents, loadActivityEvents } from "../src/core/activityStorage";
import {
  createActivityEventReporter,
  createActivityMessageHandler,
  createRuntimeMessageDispatcher,
} from "../src/core/activityMessages";
import { twitchHeartbeatFetchText, twitchHeartbeatPost } from "../src/core/twitchHeartbeatTransport";
import { createCredentialAvailabilityProvider } from "../src/core/credentialAvailability";
import { createCredentialHealthObserver } from "../src/core/credentialObserver";

const localeCatalogs = new Map<string, MessageCatalog | undefined>();
const getMessage = browser.i18n.getMessage as (key: string, substitutions?: string | string[]) => string;
const handleActivityMessage = createActivityMessageHandler({
  load: loadActivityEvents,
  exportDiagnostics: exportDiagnosticsEvents,
  clear: clearActivityEvents,
});
const reportEvents = createActivityEventReporter({
  loadDiagnosticLogging: async () => (await loadSettings()).diagnosticLogging,
  append: appendActivityEvents,
});
const kickClaimState = new KickClaimState();
const kickDiscoveryState = new KickDiscoveryState();
const twitchDiscoveryState = new TwitchDiscoveryState();
const KICK_PAGE_CONTEXT_URL = "https://kick.com/drops/inventory";
const createBrowserWebSocket: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;
const checkCredentialAvailability = createCredentialAvailabilityProvider({
  get: (details) => browser.cookies.get(details),
});

async function catalog(locale: string): Promise<MessageCatalog | undefined> {
  if (localeCatalogs.has(locale)) return localeCatalogs.get(locale);
  const loaded = await loadCatalog(locale as SupportedLocale);
  localeCatalogs.set(locale, loaded);
  return loaded;
}

// The engine no longer carries the locale; the host resolves it from its own
// settings on demand.
async function translate(key: string, substitutions?: string | string[]): Promise<string> {
  const { languageOverride } = await loadSettings();
  if (languageOverride === "browser") {
    const message = getMessage(key, substitutions);
    if (message) return message;
  }
  const locale = effectiveLocale(languageOverride, browser.i18n.getUILanguage());
  const [active, fallback] = await Promise.all([catalog(locale), catalog("en")]);
  return translateFromCatalogs(key, substitutions, active, fallback ?? {});
}

function createExtensionAdapter(platform: Platform, emit: EventEmitter, settings: ExtensionSettings) {
  const resolution = resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" });
  // The watch-tab port is operation-scoped so every browser diagnostic joins
  // the same controller event batch as the adapter and scheduler events.
  const watchTabPort: WatchTabPort = {
    openPinnedMutedTab: async (channel, session, options) => {
      const settings = await loadSettings();
      return openPinnedMutedTab(channel, session, {
        muted: settings.muteFarmingTabs,
        keepVideosUnmuted: settings.keepFarmingVideosUnmuted,
        closeManagedTabs: settings.autoCloseFinishedDrops,
        ...options,
      }, emit);
    },
    stopWatchTab: async (session, options) => {
      const settings = await loadSettings();
      return stopWatchTab(session, { closeManagedTabs: settings.autoCloseFinishedDrops, ...options }, emit);
    },
  };
  const adapter = platform === "twitch"
    ? new TwitchAdapter(
      { fetchJson: (url, init) => fetchTwitchInBackground(url, init) },
      (request) => ensureTwitchIntegrity(emit, request),
      watchTabPort,
      {
        compatibility: resolution.compatibility.twitch,
        discoveryState: twitchDiscoveryState,
        strictCampaignAvailability: settings.platform.twitch.strictCampaignAvailability,
        currentIntegrity: currentValidTwitchIntegrity,
        heartbeatIdentity: "web",
        heartbeatFetchText: twitchHeartbeatFetchText,
        heartbeatPost: twitchHeartbeatPost,
      },
      emit,
    )
    : new KickAdapter(
      createKickFetcher({
        routeState: kickDiscoveryState.routeDiagnostics,
        background: (url, init) => fetchKickInBackground<unknown>(url, init),
        pageFetch: (url, init) => fetchJsonInPage<unknown>(KICK_PAGE_CONTEXT_URL, url, init, {
          retainPageContext: { platform: "kick" },
          emit,
          openReason: "background_rejected",
        }),
        onBackgroundSuccess: (host, operationEmit) => recordManagedPageContextBackgroundSuccess(host, operationEmit),
        onPageFallback: (host, operationEmit) => recordManagedPageContextFallback(host, operationEmit),
      }),
      watchTabPort,
      createBrowserWebSocket,
      { compatibility: resolution.compatibility.kick, claimState: kickClaimState, discoveryState: kickDiscoveryState },
      emit,
    );
  return { adapter, ...resolution };
}

const controller = createBackgroundController<ExtensionSettings>({
  loadSettings,
  saveSettings,
  loadState,
  saveState,
  reportEvents,
  checkCredentialAvailability,
  createAlarm: (name, options) => browser.alarms.create(name, options),
  getAlarm: async (name) => {
    const alarm = await browser.alarms.get(name);
    return alarm ? { scheduledTime: alarm.scheduledTime } : undefined;
  },
  clearAlarm: (name) => browser.alarms.clear(name),
  ensureTwitchIntegrity: (emit, request) => ensureTwitchIntegrity(emit, request),
  cancelTwitchIntegrityAcquisition,
  closeManagedTabs: async (tabs) => {
    await Promise.all(tabs.map(async ({ tabId, channelUrl }) => {
      try {
        const tab = await browser.tabs.get(tabId);
        if (tab.id === tabId && tab.url === channelUrl) await browser.tabs.remove(tabId);
      } catch {
        // The recorded tab may already be closed or its id may be stale.
      }
    }));
  },
  createNotification: async ({ title, message }) => {
    await browser.notifications.create({
      type: "basic",
      iconUrl: browser.runtime.getURL("/icon/128.png"),
      title,
      message,
    });
  },
  translate,
  applySettingsPatch,
  applyAdFocus: async (platform, tabId, adActive, emit) => {
    const { adFocusMode } = await loadSettings();
    await applyAdFocus(platform, tabId, adActive, adFocusMode, emit);
  },
  loadTabPlaybackPolicy: async () => ({ keepVideosUnmuted: (await loadSettings()).keepFarmingVideosUnmuted !== false }),
  loadTwitchIntegrity,
  saveTwitchIntegrity,
  stopPageContextTabs: (contexts, options) => stopManagedPageContextTabs(contexts, options),
  createAdapter: createExtensionAdapter,
  createAdapters: (emit, settings) => {
    const twitch = createExtensionAdapter("twitch", emit, settings);
    const kick = createExtensionAdapter("kick", emit, settings);
    return {
      adapters: {
        twitch: twitch.adapter,
        kick: kick.adapter,
      },
      compatibility: twitch.compatibility,
      warnings: twitch.warnings,
    };
  },
});

// Builds the CLI credential blob from the user's live session cookies: Twitch
// auth-token / unique_id and Kick session_token — exactly what the headless
// transports replay. Reads only these; nothing else leaves the browser.
async function buildCliCredentialBlob(): Promise<CliCredentialBlob> {
  const cookie = async (url: string, name: string): Promise<string | undefined> =>
    (await browser.cookies.get({ url, name }))?.value;
  return {
    version: 1,
    credentials: {
      twitch: {
        authToken: await cookie("https://www.twitch.tv", "auth-token"),
        deviceId: await cookie("https://www.twitch.tv", "unique_id"),
      },
      kick: {
        sessionToken: await cookie("https://kick.com", "session_token"),
      },
    },
  };
}

let resetMutation: Promise<RuntimeSnapshot<ExtensionSettings>> | undefined;

function resetExtension(): Promise<RuntimeSnapshot<ExtensionSettings>> {
  if (resetMutation) return resetMutation;
  resetMutation = (async () => {
    await controller.prepareForHostReset(async () => {
      kickClaimState.clear();
      await resetStorage();
    });
    return await controller.handleMessage({ type: "getSnapshot" }) as RuntimeSnapshot<ExtensionSettings>;
  })().finally(() => {
    resetMutation = undefined;
  });
  return resetMutation;
}

// Credential export reads the user's live session cookies, which only the
// extension can do. Keep it ahead of activity routing and core delegation.
const dispatchRuntimeMessage = createRuntimeMessageDispatcher({
  exportCliCredentials: buildCliCredentialBlob,
  resetExtension,
  handleActivityMessage,
  handleCoreMessage: (message, sender) => controller.handleMessage(message, sender),
});

export default defineBackground(() => {
  createCredentialHealthObserver(
    {
      addListener: (listener) => browser.cookies.onChanged.addListener(listener),
      removeListener: (listener) => browser.cookies.onChanged.removeListener(listener),
    },
    controller,
  );

  browser.runtime.onInstalled.addListener(async (details) => {
    await controller.ensureAlarm();
    // Stamp the install date once so the popup can time the rate/review nudge.
    // Set-if-missing (rather than gating on reason === "install") also backfills
    // a sane date for users upgrading from a pre-nudge version.
    await controller.ensureInstalledAt();

    // On a meaningful update (major/minor — not a patch bugfix, not a fresh
    // install), queue a popup notice so returning users can choose to see
    // what's new without an unsolicited browser tab interrupting them.
    const currentVersion = browser.runtime.getManifest().version;
    if (details.reason === "update" && isMinorOrMajorBump(details.previousVersion, currentVersion)) {
      await savePendingChangelogVersion(currentVersion);
    }
  });

  browser.runtime.onStartup.addListener(async () => {
    await controller.handleStartup();
  });

  browser.alarms.onAlarm.addListener(createBackgroundAlarmListener(controller));

  browser.tabs.onRemoved.addListener((tabId) => {
    void controller.handleTabRemoved(tabId);
  });

  // Capture the Client-Integrity token the live twitch.tv page sends on its own
  // GQL requests so the background can replay it on authenticated mutations
  // (drop claims). Registered at top level so it re-binds on each SW wake.
  // requestHeaders exposes the custom Client-Integrity header; if a future
  // Chrome build hides it, add "extraHeaders" to this spec.
  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      void controller.captureTwitchIntegrity(details.requestHeaders, details.tabId);
      return undefined;
    },
    { urls: ["https://gql.twitch.tv/*"] },
    ["requestHeaders"],
  );

  browser.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
    void dispatchRuntimeMessage(message, sender).then(sendResponse);
    return true;
  });

});
