import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  Clock3,
  Package,
  RotateCcw,
  Settings as SettingsIcon,
} from "lucide-react";
import type { ActivityPage, CategorySearchResult, CliCredentialBlob, DiagnosticsExport, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { ActivityHistoryRecord } from "@lurkloot/shared/events";
import type { CategorySelection, ExtensionSettings, Platform } from "@lurkloot/shared/models";
import { applySettingsPatch, DEFAULT_SETTINGS, mergeSettings, type SettingsPatch } from "@lurkloot/shared/settings";
import { buildSettingsExportPayload, parseSettingsImportPayload } from "@lurkloot/shared/settingsExport";
import { effectiveLocale, isRtlLocale, translateFromCatalogs, type MessageCatalog } from "@lurkloot/shared/i18n";
import { loadCatalog } from "@lurkloot/locales";
import { buildFailureReport } from "@lurkloot/shared/failureReport";
import { I18nContext, PopupRuntimeContext } from "./context";
import {
  GITHUB_STAR_NUDGE_MIN_DAYS,
  PLATFORM_INVENTORY_URLS,
  PLATFORMS,
  RATE_NUDGE_MIN_DAYS,
  SCREENSHOT_VARIANTS,
  SCREENSHOT_WATCHLIST_LIVE,
  SELECTED_PLATFORM_KEY,
} from "./constants";
import type {
  GameItem,
  PopupAdapter,
  PopupInitialState,
  ScreenshotVariant,
  TFunction,
} from "./types";
import { variantShowsPopup } from "./types";
import {
  campaignViewFromCampaign,
  channelViewFromSession,
  fallbackGame,
  gameItemsFromCampaigns,
  isCampaignVisible,
  prioritiesFromOrder,
  sortCampaignsForPopup,
  streamerItemFromFallback,
} from "./viewModels";
import { IconButton, cn } from "./primitives";
import { ActivityLog } from "./activity";
import {
  advanceActivityRequestScope,
  applyActivityMutationForRequest,
  beginActivityMutation,
  beginDiagnosticsExport,
  buildActivityExport,
  buildDiagnosticsExportFilename,
  createActivityMutationSequence,
  createActivityRequestScope,
  createActivityStream,
  createDiagnosticsExportRequest,
  isActivityRequestCurrent,
  isDiagnosticsExportCurrent,
  type ActivityRequestScope,
  type ActivityStream,
} from "./activity.logic";
import { AttributionFooter } from "./footer";
import { RateNudge, shouldShowGithubStarNudge, shouldShowRateNudge } from "./rateNudge";
import { GithubStarNudge } from "./githubStarNudge";
import { popupNoticeSlot } from "./popupNoticeSlot";
import { UpdateNotice } from "./updateNotice";
import { DropsPanel } from "./drops";
import { CriticalFailurePanel } from "./criticalFailure";
import { openHttpsLink } from "./links";
import { IdleWatchlistPanel } from "./idleWatchlist";
import { AutomationStatusLine, PlatformBar } from "./automation";
import { automationPresentation, type AutomationPresentation } from "./automationStatus";
import { SettingsView } from "./settings";
import { TipsBanner } from "./tips";
export function screenshotVariant(id: string | null | undefined): ScreenshotVariant {
  return SCREENSHOT_VARIANTS[id ?? "drops"] ?? SCREENSHOT_VARIANTS.drops;
}

function isPlatform(value: unknown): value is Platform {
  return value === "twitch" || value === "kick";
}

export function Popup({ adapter, initialState }: { adapter: PopupAdapter; initialState?: PopupInitialState }): React.ReactElement {
  const preview = initialState?.preview ?? false;
  const initialVariant = initialState?.variant ?? screenshotVariant("drops");
  const watchlistShot = preview && variantShowsPopup(initialVariant) && initialVariant.view === "watchlist";
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [overrideCatalog, setOverrideCatalog] = useState<MessageCatalog | undefined>();
  const [fallbackCatalog, setFallbackCatalog] = useState<MessageCatalog | undefined>();
  const [platform, setPlatform] = useState<Platform>(
    preview && variantShowsPopup(initialVariant) ? initialVariant.platform : "twitch",
  );
  // Drops and the Idle Watchlist share one view; the watchlist folds away under
  // the campaigns until asked for (or until a screenshot variant wants it).
  const [watchlistExpanded, setWatchlistExpanded] = useState(watchlistShot);
  const [watchlistAdding, setWatchlistAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(
    preview && variantShowsPopup(initialVariant) && initialVariant.view === "settings",
  );
  const [settingsOpenGeneration, setSettingsOpenGeneration] = useState(0);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityStream, setActivityStream] = useState<ActivityStream>(createActivityStream);
  const [diagnosticStream, setDiagnosticStream] = useState<ActivityStream>(createActivityStream);
  const [reportEvents, setReportEvents] = useState<ActivityHistoryRecord[]>([]);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagnosticSearchQuery, setDiagnosticSearchQuery] = useState("");
  const [loadingMoreActivity, setLoadingMoreActivity] = useState(false);
  const [clearActivityArmed, setClearActivityArmed] = useState(false);
  const [clearingActivity, setClearingActivity] = useState(false);
  const [clearActivityFailed, setClearActivityFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingChangelogVersion, setPendingChangelogVersion] = useState<string>();
  const [pendingAutomation, setPendingAutomation] = useState<Partial<Record<Platform, boolean>>>({});
  // Request to jump to a campaign in the drops list (expand + scroll). The seq
  // counter lets repeated clicks on the same campaign re-trigger the effect.
  const [campaignFocus, setCampaignFocus] = useState<{ id: string; seq: number } | null>(null);
  const settingsRef = useRef<ExtensionSettings | null>(null);
  const settingsSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const snapshotRequestGenerationRef = useRef(0);
  const activityRequestScopeRef = useRef(createActivityRequestScope(platform));
  const diagnosticsExportRequestRef = useRef(createDiagnosticsExportRequest(platform));
  const activityMutationSequenceRef = useRef(createActivityMutationSequence());
  const diagnosticMutationSequenceRef = useRef(createActivityMutationSequence());
  const activityClearInFlightRef = useRef(false);
  const [activityRequestGeneration, setActivityRequestGeneration] = useState(0);
  const trimmedDiagnosticSearchQuery = diagnosticSearchQuery.trim();
  const languageOverride = initialState?.locale ?? snapshot?.settings.languageOverride ?? DEFAULT_SETTINGS.languageOverride;
  const locale = effectiveLocale(languageOverride, adapter.getUiLanguage());
  const dir = isRtlLocale(locale) ? "rtl" : "ltr";
  const t: TFunction = (key, substitutions) => {
    if (languageOverride === "browser") {
      const message = adapter.getMessage(key, substitutions);
      if (message) return message;
    }
    const message = translateFromCatalogs(key, substitutions, overrideCatalog, fallbackCatalog ?? overrideCatalog ?? {});
    return message === key ? adapter.getMessage(key, substitutions) || message : message;
  };

  function invalidateActivityRequests(
    nextPlatform: Platform = activityRequestScopeRef.current.platform,
    nextQuery: string = activityRequestScopeRef.current.query,
  ): ActivityRequestScope {
    const nextScope = advanceActivityRequestScope(activityRequestScopeRef.current, nextPlatform, nextQuery);
    activityRequestScopeRef.current = nextScope;
    setActivityRequestGeneration(nextScope.generation);
    setLoadingMoreActivity(false);
    return nextScope;
  }

  useEffect(() => {
    let cancelled = false;
    void loadCatalog("en").then((catalog) => {
      if (!cancelled) setFallbackCatalog(catalog);
    });
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  useEffect(() => {
    let cancelled = false;
    if (languageOverride === "browser") {
      setOverrideCatalog(undefined);
      return () => {
        cancelled = true;
      };
    }
    void loadCatalog(languageOverride).then((catalog) => {
      if (!cancelled) setOverrideCatalog(catalog);
    });
    return () => {
      cancelled = true;
    };
  }, [adapter, languageOverride]);

  function snapshotWithMergedSettings(nextSnapshot: RuntimeSnapshot): RuntimeSnapshot {
    const settings = mergeSettings(nextSnapshot.settings);
    settingsRef.current = settings;
    return { ...nextSnapshot, settings };
  }

  function snapshotPreservingLocalSettings(nextSnapshot: RuntimeSnapshot): RuntimeSnapshot {
    const settings = settingsRef.current ?? mergeSettings(nextSnapshot.settings);
    settingsRef.current = settings;
    return { ...nextSnapshot, settings };
  }

  const previewPlatform = variantShowsPopup(initialVariant) ? initialVariant.platform : "twitch";

  useEffect(() => {
    void Promise.all([
      adapter.send<RuntimeSnapshot>({ type: "getSnapshot" }),
      preview
        ? Promise.resolve({ [SELECTED_PLATFORM_KEY]: previewPlatform })
        : adapter.getStorage(SELECTED_PLATFORM_KEY),
    ]).then(([nextSnapshot, stored]) => {
      const savedPlatform = stored[SELECTED_PLATFORM_KEY];
      if (isPlatform(savedPlatform)) setPlatform(savedPlatform);
      setSnapshot(snapshotWithMergedSettings(nextSnapshot));
    });
  }, [adapter, previewPlatform, preview]);

  useEffect(() => {
    if (!watchlistShot || !snapshot) return;
    document.getElementById("idle-watchlist")?.scrollIntoView?.({ block: "start" });
  }, [snapshot, watchlistShot]);

  useEffect(() => {
    if (preview || !adapter.getPendingChangelogVersion) return;
    void adapter.getPendingChangelogVersion().then(setPendingChangelogVersion);
  }, [adapter, preview]);

  useEffect(() => {
    if (!activityOpen || preview || clearingActivity) return;
    let cancelled = false;
    const requestScope = activityRequestScopeRef.current;
    const refresh = () => {
      if (activityClearInFlightRef.current || !isActivityRequestCurrent(requestScope, activityRequestScopeRef.current)) return;
      const refreshRequest = beginActivityMutation(activityMutationSequenceRef.current);
      void adapter.send<ActivityPage>({ type: "getActivity", platform: requestScope.platform, category: "activity", limit: 80 }).then((page) => {
        if (!cancelled) {
          setActivityStream((current) => applyActivityMutationForRequest(
            current,
            page,
            "refresh",
            requestScope,
            activityRequestScopeRef.current,
            activityMutationSequenceRef.current,
            refreshRequest,
          ));
        }
      }).catch(() => undefined);
    };
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activityOpen, activityRequestGeneration, adapter, clearingActivity, preview]);

  useEffect(() => {
    if (activityRequestScopeRef.current.platform !== platform || activityRequestScopeRef.current.query) {
      invalidateActivityRequests(platform, "");
    }
    setActivityStream(createActivityStream());
    setDiagnosticStream(createActivityStream());
    setDiagnosticSearchQuery("");
    setShowDiagnostics(false);
    setClearActivityArmed(false);
    setClearActivityFailed(false);
  }, [platform]);

  useEffect(() => {
    if (activityRequestScopeRef.current.query === trimmedDiagnosticSearchQuery) return;
    invalidateActivityRequests(platform, trimmedDiagnosticSearchQuery);
    setDiagnosticStream(createActivityStream());
  }, [platform, trimmedDiagnosticSearchQuery]);

  useEffect(() => {
    if (!snapshot?.settings.diagnosticLogging) handleShowDiagnosticsChange(false);
  }, [snapshot?.settings.diagnosticLogging]);

  // The failure report needs recent activity, but the Activity view's stream is
  // only populated once the user opens that tab — and the panel lives on the
  // drops tab, so the report would otherwise be emptiest for exactly the user who
  // is about to file an issue. Fetch a page of our own while the panel is up.
  const criticalFailureFlagged = snapshot?.state.criticalHealth?.[platform]?.status === "flagged";
  useEffect(() => {
    if (!criticalFailureFlagged || preview) return undefined;
    let cancelled = false;
    void adapter.send<ActivityPage>({ type: "getActivity", platform, category: "activity", limit: 40 })
      .then((page) => {
        if (!cancelled) setReportEvents(page.events);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [adapter, platform, preview, criticalFailureFlagged]);

  useEffect(() => {
    if (!activityOpen || preview || clearingActivity || !showDiagnostics || !snapshot?.settings.diagnosticLogging) return;
    let cancelled = false;
    const requestScope = activityRequestScopeRef.current;
    const refresh = () => {
      if (activityClearInFlightRef.current || !isActivityRequestCurrent(requestScope, activityRequestScopeRef.current)) return;
      const refreshRequest = beginActivityMutation(diagnosticMutationSequenceRef.current);
      void adapter.send<ActivityPage>({ type: "getActivity", platform: requestScope.platform, category: "diagnostic", query: requestScope.query || undefined, limit: 80 }).then((page) => {
        if (!cancelled) {
          setDiagnosticStream((current) => applyActivityMutationForRequest(
            current,
            page,
            "refresh",
            requestScope,
            activityRequestScopeRef.current,
            diagnosticMutationSequenceRef.current,
            refreshRequest,
          ));
        }
      }).catch(() => undefined);
    };
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activityOpen, activityRequestGeneration, adapter, clearingActivity, preview, showDiagnostics, snapshot?.settings.diagnosticLogging]);

  function loadMoreActivity(): void {
    if (activityClearInFlightRef.current || clearingActivity || loadingMoreActivity) return;
    const requestScope = activityRequestScopeRef.current;
    const requests: Promise<void>[] = [];
    // Only the visible view pages: the toggle switches between the streams
    // instead of merging them, so paging the hidden one just burns requests.
    if (!showDiagnostics && activityStream.nextCursor) {
      const cursor = activityStream.nextCursor;
      const pageRequest = beginActivityMutation(activityMutationSequenceRef.current);
      requests.push(adapter.send<ActivityPage>({ type: "getActivity", platform: requestScope.platform, category: "activity", cursor, limit: 80 })
        .then((page) => {
          setActivityStream((current) => applyActivityMutationForRequest(
            current,
            page,
            "page",
            requestScope,
            activityRequestScopeRef.current,
            activityMutationSequenceRef.current,
            pageRequest,
          ));
        }));
    }
    if (showDiagnostics && snapshot?.settings.diagnosticLogging && diagnosticStream.nextCursor) {
      const cursor = diagnosticStream.nextCursor;
      const pageRequest = beginActivityMutation(diagnosticMutationSequenceRef.current);
      requests.push(adapter.send<ActivityPage>({ type: "getActivity", platform: requestScope.platform, category: "diagnostic", query: requestScope.query || undefined, cursor, limit: 80 })
        .then((page) => {
          setDiagnosticStream((current) => applyActivityMutationForRequest(
            current,
            page,
            "page",
            requestScope,
            activityRequestScopeRef.current,
            diagnosticMutationSequenceRef.current,
            pageRequest,
          ));
        }));
    }
    if (requests.length === 0) return;
    setLoadingMoreActivity(true);
    void Promise.allSettled(requests).finally(() => {
      if (isActivityRequestCurrent(requestScope, activityRequestScopeRef.current)) setLoadingMoreActivity(false);
    });
  }

  function clearActivityHistory(): void {
    if (activityClearInFlightRef.current) return;
    if (!clearActivityArmed) {
      setClearActivityArmed(true);
      setClearActivityFailed(false);
      return;
    }
    activityClearInFlightRef.current = true;
    invalidateActivityRequests();
    setClearingActivity(true);
    setClearActivityFailed(false);
    void adapter.send<void>({ type: "clearActivity" }).then(() => {
      activityClearInFlightRef.current = false;
      invalidateActivityRequests();
      setActivityStream(createActivityStream());
      setDiagnosticStream(createActivityStream());
      setDiagnosticSearchQuery("");
      invalidateActivityRequests(platform, "");
      setClearActivityArmed(false);
      setClearingActivity(false);
    }).catch(() => {
      activityClearInFlightRef.current = false;
      setClearActivityArmed(false);
      setClearActivityFailed(true);
      setClearingActivity(false);
    });
  }

  function dismissUpdateNotice(): void {
    setPendingChangelogVersion(undefined);
    void adapter.dismissPendingChangelogVersion?.();
  }

  // Keep the snapshot (and its Activity log) live while the popup is open, so
  // background scheduler ticks are reflected without needing a manual refresh.
  useEffect(() => {
    if (preview) return;
    const interval = setInterval(() => {
      const generation = snapshotRequestGenerationRef.current;
      void adapter.send<RuntimeSnapshot>({ type: "getSnapshot" }).then((nextSnapshot) => {
        if (generation !== snapshotRequestGenerationRef.current) return;
        // Keep the locally-held settings rather than the refreshed ones so an
        // in-flight edit is never clobbered mid-typing. The tradeoff: a setting
        // changed by the background (e.g. startup auto-pausing `running`) is not
        // reflected until the popup is reopened.
        setSnapshot((current) => {
          if (current) {
            settingsRef.current = current.settings;
            return { ...nextSnapshot, settings: current.settings };
          }
          return snapshotPreservingLocalSettings(nextSnapshot);
        });
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [adapter, preview]);

  function selectPlatform(nextPlatform: Platform): void {
    if (nextPlatform !== activityRequestScopeRef.current.platform) {
      invalidateActivityRequests(nextPlatform, "");
      diagnosticsExportRequestRef.current = beginDiagnosticsExport(
        diagnosticsExportRequestRef.current,
        nextPlatform,
      );
    }
    setDiagnosticSearchQuery("");
    setPlatform(nextPlatform);
    // The watchlist add form belongs to the platform it was opened on: leaving
    // it open would submit a name typed for one platform into the other's list.
    setWatchlistAdding(false);
    if (!preview) void adapter.setStorage({ [SELECTED_PLATFORM_KEY]: nextPlatform });
  }

  function closeActivityView(): void {
    if (activityOpen) {
      invalidateActivityRequests(platform, "");
      diagnosticsExportRequestRef.current = beginDiagnosticsExport(
        diagnosticsExportRequestRef.current,
        platform,
      );
    }
    setClearActivityArmed(false);
    setClearActivityFailed(false);
    setDiagnosticSearchQuery("");
    setDiagnosticStream(createActivityStream());
    setActivityOpen(false);
  }

  function handleShowDiagnosticsChange(nextShowDiagnostics: boolean): void {
    if (showDiagnostics && !nextShowDiagnostics) {
      invalidateActivityRequests(platform, "");
      diagnosticsExportRequestRef.current = beginDiagnosticsExport(
        diagnosticsExportRequestRef.current,
        platform,
      );
      setDiagnosticSearchQuery("");
      setDiagnosticStream(createActivityStream());
    }
    setShowDiagnostics(nextShowDiagnostics);
  }

  async function exportDiagnosticsLog(): Promise<number | undefined> {
    const downloadFile = adapter.downloadFile;
    if (!downloadFile) return undefined;
    const request = beginDiagnosticsExport(diagnosticsExportRequestRef.current, platform);
    diagnosticsExportRequestRef.current = request;
    const exportedAt = new Date();
    const result = await adapter.send<DiagnosticsExport>({ type: "exportDiagnostics", platform: request.platform });
    if (!isDiagnosticsExportCurrent(request, diagnosticsExportRequestRef.current)) return undefined;
    downloadFile(
      buildDiagnosticsExportFilename(request.platform, exportedAt),
      buildActivityExport({
        events: result.events,
        platform: request.platform,
        diagnostics: true,
        coverage: "full",
        version: adapter.version,
        userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
        locale,
        at: exportedAt.toISOString(),
      }, t),
      "text/plain",
    );
    return result.events.length;
  }

  async function updateSettings(patch: SettingsPatch, options?: { tickAfterSave?: boolean; tickAfterSavePlatforms?: Platform[] }): Promise<void> {
    if (!snapshot) return;
    const settingsPatch = patch;
    const nextSettings = applySettingsPatch(settingsRef.current ?? snapshot.settings, settingsPatch);
    settingsRef.current = nextSettings;
    setSnapshot((current) => current ? { ...current, settings: nextSettings } : current);
    const save = settingsSaveQueue.current.catch(() => undefined).then(async () => {
      const nextSnapshot = await adapter.send<RuntimeSnapshot>({
        type: "saveSettings",
        settingsPatch,
        tickAfterSave: options?.tickAfterSave,
        tickAfterSavePlatforms: options?.tickAfterSavePlatforms,
      });
      setSnapshot({ ...nextSnapshot, settings: settingsRef.current ?? mergeSettings(nextSnapshot.settings) });
    });
    settingsSaveQueue.current = save;
    await save;
  }

  // Addressed by platform rather than "the selected one": each platform tab now
  // carries its own switch, so either can be toggled without selecting it first.
  async function setAutomation(pendingPlatform: Platform, enabled: boolean): Promise<void> {
    if (!snapshot || pendingAutomation[pendingPlatform] != null) return;
    setPendingAutomation((current) => ({ ...current, [pendingPlatform]: enabled }));
    try {
      setSnapshot(snapshotWithMergedSettings(await adapter.send<RuntimeSnapshot>({ type: "setAutomation", platform: pendingPlatform, enabled })));
    } catch (error) {
      console.error("Failed to update automation", error);
    } finally {
      setPendingAutomation((current) => {
        const { [pendingPlatform]: _completed, ...rest } = current;
        return rest;
      });
    }
  }

  // Undoes the pause caused by manually closing the managed watch tab. Keeps
  // the user's enabled/running settings untouched — only the pause is cleared.
  async function resumeAfterManualClose(): Promise<void> {
    if (!snapshot) return;
    const resumingPlatform = platform;
    try {
      setSnapshot(snapshotWithMergedSettings(await adapter.send<RuntimeSnapshot>({ type: "resumeAfterManualClose", platform: resumingPlatform })));
    } catch (error) {
      console.error("Failed to resume farming", error);
    }
  }

  async function refreshNow(): Promise<void> {
    if (!snapshot || refreshing) return;
    setRefreshing(true);
    try {
      setSnapshot(snapshotWithMergedSettings(await adapter.send<RuntimeSnapshot>({ type: "tickNow" })));
    } finally {
      setRefreshing(false);
    }
  }

  async function searchCategories(searchPlatform: Platform, query: string): Promise<CategorySelection[]> {
    const result = await adapter.send<CategorySearchResult>({ type: "searchCategories", platform: searchPlatform, query });
    return result.categories;
  }

  // Exports the session tokens the headless CLI's `login --import` consumes.
  // Gated behind inline confirmation in the settings view; available only when
  // the host adapter supports credential export (the live extension, not demo).
  const exportCredentials = adapter.exportCredentials
    ? async () => {
        const blob = await adapter.send<CliCredentialBlob>({ type: "exportCliCredentials" });
        adapter.exportCredentials?.(blob);
      }
    : undefined;

  const resetExtension = adapter.resetExtension
    ? async () => {
        await settingsSaveQueue.current.catch(() => undefined);
        snapshotRequestGenerationRef.current += 1;
        const nextSnapshot = await adapter.resetExtension!();
        settingsRef.current = mergeSettings(nextSnapshot.settings);
        invalidateActivityRequests("twitch");
        setActivityStream(createActivityStream());
        setDiagnosticStream(createActivityStream());
        setShowDiagnostics(false);
        setPlatform("twitch");
        setWatchlistExpanded(false);
        setWatchlistAdding(false);
        setPendingChangelogVersion(undefined);
        setSnapshot(snapshotWithMergedSettings(nextSnapshot));
        setSettingsOpen(false);
      }
    : undefined;

  if (!snapshot) {
    return (
      <PopupRuntimeContext.Provider value={{ adapter, preview }}>
      <I18nContext.Provider value={{ t, dir, locale }}>
        <main dir={dir} className="grid h-[600px] w-[400px] place-items-center border border-zinc-200 bg-zinc-50 text-sm font-semibold text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400" data-platform="twitch">
          {t("loading")}
        </main>
      </I18nContext.Provider>
      </PopupRuntimeContext.Provider>
    );
  }

  const settings = mergeSettings(snapshot.settings);

  // Downloads the current settings as a portable JSON file. Available only
  // when the host adapter supports it (the live extension, not the demo).
  const exportSettings = adapter.exportSettings
    ? () => adapter.exportSettings?.(buildSettingsExportPayload(settingsRef.current ?? settings))
    : undefined;

  // Prompts for a settings file, validates/migrates it (never trusting file
  // contents), and applies the result as a full patch — the same save path
  // every other settings mutation uses, so it goes through the same queue and
  // storage lock. Returns false when the user cancels the file picker.
  const importSettings = adapter.importSettings
    ? async () => {
        const raw = await adapter.importSettings!();
        if (raw == null) return false;
        const { settings: imported } = parseSettingsImportPayload(raw);
        await updateSettings(imported as SettingsPatch, { tickAfterSave: true });
        return true;
      }
    : undefined;

  const compatibilityResolution = adapter.resolveCompatibility?.(settings.compatibility);
  const excludedIds = new Set(settings.excludedCampaignIds);
  const rawCampaigns = sortCampaignsForPopup(snapshot.state.campaigns[platform].filter((campaign) => isCampaignVisible(campaign, settings, excludedIds)), settings);
  const session = snapshot.state.sessions[platform];
  const sessionChannel = channelViewFromSession(session);
  const criticalFailure = snapshot.state.criticalHealth?.[platform];
  // Only the flagged platform loses its drops list; the other one keeps working.
  const criticalFailureReason = settings.criticalFailurePromptEnabled && criticalFailure?.status === "flagged"
    ? criticalFailure.reason
    : undefined;
  const campaigns = rawCampaigns.map((campaign, index) => campaignViewFromCampaign(
    campaign,
    index,
    session,
    excludedIds.has(campaign.id),
    {
      skipUnfinishableRewards: settings.skipUnfinishableRewards,
      deadlineSafetyMarginMinutes: settings.deadlineSafetyMarginMinutes,
      settings,
    },
  ));
  const games = gameItemsFromCampaigns(snapshot.state.campaigns[platform], t);
  // Categories that currently have active drop campaigns, surfaced as one-tap
  // "Has active drops" suggestions in the category filter editor (zero network).
  const dropCategorySuggestions: Record<Platform, GameItem[]> = {
    twitch: gameItemsFromCampaigns(snapshot.state.campaigns.twitch, t),
    kick: gameItemsFromCampaigns(snapshot.state.campaigns.kick, t),
  };
  const gameMap = Object.fromEntries(games.map((game) => [game.id, game]));
  const idleWatchlistChannels = settings.platform[platform].idleWatchlistChannels;
  const idleWatchlist = idleWatchlistChannels.map((username) => streamerItemFromFallback(username, session, t));
  const screenshotWatchlist = watchlistShot
    ? idleWatchlist.map((item) => {
        const live = SCREENSHOT_WATCHLIST_LIVE[item.id];
        if (!live) return item;
        return { ...item, name: live.displayName, live: true, viewers: live.viewers, subtitle: live.subtitle };
      })
    : idleWatchlist;
  const automation = {
    twitch: pendingAutomation.twitch ?? settings.platform.twitch.enabled,
    kick: pendingAutomation.kick ?? settings.platform.kick.enabled,
  };
  const automationPending: Record<Platform, boolean> = {
    twitch: pendingAutomation.twitch != null,
    kick: pendingAutomation.kick != null,
  };
  const automationPresentationByPlatform = Object.fromEntries(
    (Object.keys(PLATFORMS) as Platform[]).map((id) => [id, automationPresentation({
      platform: id,
      enabled: automation[id],
      pending: pendingAutomation[id] != null,
      authHealth: snapshot.state.authHealth[id],
      session: snapshot.state.sessions[id],
      manualClosePaused: Boolean(snapshot.state.manualClosePause?.[id]),
    })]),
  ) as Record<Platform, AutomationPresentation>;
  const presentation = automationPresentationByPlatform[platform];
  const activeCampaign = campaigns.find((campaign) => campaign.farmingChannel);
  const farmingChannel = activeCampaign?.farmingChannel ?? sessionChannel;
  const onFarmingTitleClick = activeCampaign
    ? () => setCampaignFocus((prev) => ({ id: activeCampaign.id, seq: (prev?.seq ?? 0) + 1 }))
    : undefined;
  const mainViewOpen = !settingsOpen && !activityOpen;
  const viewTitle = settingsOpen ? t("settingsTitle") : activityOpen ? t("activityTitle") : "Lurkloot";
  const updateNotice = pendingChangelogVersion && adapter.changelogUrl
    ? { version: pendingChangelogVersion, href: adapter.changelogUrl(pendingChangelogVersion) }
    : undefined;
  const now = new Date();
  const noticeSlot = popupNoticeSlot({
    preview,
    hasUpdateNotice: Boolean(updateNotice),
    showRateNudge: shouldShowRateNudge(snapshot.state.installedAt, settings.rateNudgeStatus, now, RATE_NUDGE_MIN_DAYS),
    showGithubStarNudge: shouldShowGithubStarNudge(snapshot.state.installedAt, settings.githubStarNudgeStatus, now, GITHUB_STAR_NUDGE_MIN_DAYS),
  });

  return (
      <PopupRuntimeContext.Provider value={{ adapter, preview }}>
      <I18nContext.Provider value={{ t, dir, locale }}>
    <main
      dir={dir}
      data-platform={platform}
      className="flex h-[600px] w-[400px] flex-col overflow-hidden border border-zinc-200/80 bg-zinc-50 shadow-2xl shadow-black/30 dark:border-zinc-800 dark:bg-zinc-950"
    >
      {/* Every piece of chrome lives here, in one fixed block: brand + actions,
          the platform picker with its automation switch, the status line, and the
          list toolbar. Merging them is what freed the vertical space the campaign
          list now uses. */}
      <div className="relative shrink-0 border-b border-zinc-200/70 bg-white/85 px-3 pb-1.5 pt-2.5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-linear-to-r from-transparent via-[var(--accent)] to-transparent" />
        <header className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <img src="/logo-ring.svg" alt="Lurkloot" width={28} height={28} className="h-7 w-7 shrink-0 rounded-lg shadow-sm" style={{ boxShadow: "0 4px 14px -4px var(--accent-glow)" }} />
            <div className="font-display truncate text-[14px] font-bold tracking-normal text-zinc-900 dark:text-zinc-50">{viewTitle}</div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {settingsOpen ? (
              <>
                <IconButton
                  label={t("back")}
                  onClick={() => { setSettingsOpen(false); closeActivityView(); }}
                >
                  <ArrowLeft size={16} />
                </IconButton>
              </>
            ) : activityOpen ? (
              <IconButton
                label={t("back")}
                onClick={() => { setSettingsOpen(false); closeActivityView(); }}
              >
                <ArrowLeft size={16} />
              </IconButton>
            ) : (
              <>
                <IconButton label={t("refreshSchedule")} onClick={() => void refreshNow()} disabled={refreshing}>
                  <RotateCcw size={16} className={cn(refreshing && "animate-spin")} />
                </IconButton>
                <IconButton
                  label={t("openInventory")}
                  onClick={() => openHttpsLink(PLATFORM_INVENTORY_URLS[platform], adapter.openLink)}
                >
                  <Package size={16} />
                </IconButton>
                <IconButton label={t("openActivity")} onClick={() => { setActivityOpen(true); setSettingsOpen(false); }}>
                  <Clock3 size={16} />
                </IconButton>
                <IconButton label={t("openSettings")} onClick={() => { setSettingsOpenGeneration((current) => current + 1); setSettingsOpen(true); closeActivityView(); }}>
                  <SettingsIcon size={16} />
                </IconButton>
              </>
            )}
          </div>
        </header>
        {mainViewOpen ? (
          <>
            <PlatformBar
              active={platform}
              presentation={automationPresentationByPlatform}
              enabled={automation}
              pending={automationPending}
              onChange={selectPlatform}
              onToggle={setAutomation}
            />
            <AutomationStatusLine
              platform={platform}
              presentation={presentation}
              farmingTitle={activeCampaign?.title}
              farmingChannel={farmingChannel}
              watchingIdleWatchlist={!activeCampaign && Boolean(farmingChannel)}
              onFarmingTitleClick={onFarmingTitleClick}
              onResume={resumeAfterManualClose}
            />
          </>
        ) : null}
      </div>

      <div id="popup-platform-panel" className="nice-scroll min-h-0 flex-1 overflow-y-auto text-zinc-700 dark:text-zinc-300">
        <div className="space-y-2 p-3 pt-2">
          <AnimatePresence mode="wait" initial={false}>
            {settingsOpen ? (
              <motion.div key="settings" initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 14 }} transition={{ duration: 0.18 }} className="space-y-2.5">
                <SettingsView suggestions={dropCategorySuggestions} onSearchCategories={searchCategories} settings={settings} onSettingsChange={updateSettings} onExportCredentials={exportCredentials} onExportSettings={exportSettings} onImportSettings={importSettings} onReset={resetExtension} exportConfirmationResetKey={settingsOpenGeneration} compatibilityRegistry={adapter.compatibilityRegistry} compatibilityResolution={compatibilityResolution} focusGroupId={preview && variantShowsPopup(initialVariant) && initialVariant.view === "settings" ? "general.drops" : undefined} />
              </motion.div>
            ) : activityOpen ? (
              <motion.div key="activity" initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 14 }} transition={{ duration: 0.18 }}>
                <ActivityLog
                  activityEvents={activityStream.events}
                  diagnosticEvents={diagnosticStream.events}
                  platform={platform}
                  lastTickAt={snapshot.state.lastTickAt}
                  diagnosticLogging={settings.diagnosticLogging}
                  showDiagnostics={showDiagnostics}
                  hasMore={Boolean(showDiagnostics ? diagnosticStream.nextCursor : activityStream.nextCursor)}
                  clearArmed={clearActivityArmed}
                  clearFailed={clearActivityFailed}
                  loadingMore={loadingMoreActivity}
                  clearing={clearingActivity}
                  version={adapter.version}
                  locale={locale}
                  searchQuery={diagnosticSearchQuery}
                  onSearchQueryChange={setDiagnosticSearchQuery}
                  searchingDiagnostics={Boolean(trimmedDiagnosticSearchQuery)}
                  onShowDiagnosticsChange={handleShowDiagnosticsChange}
                  onLoadMore={loadMoreActivity}
                  onClear={clearActivityHistory}
                  writeClipboard={adapter.writeClipboard}
                  onExportAll={adapter.downloadFile ? exportDiagnosticsLog : undefined}
                />
              </motion.div>
            ) : (
              <motion.div key="main" initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -14 }} transition={{ duration: 0.18 }} className="space-y-3">
                <AnimatePresence initial={false}>
                  {noticeSlot === "update" && updateNotice ? (
                    <UpdateNotice
                      key="update-notice"
                      version={updateNotice.version}
                      href={updateNotice.href}
                      onDismiss={dismissUpdateNotice}
                    />
                  ) : null}
                  {noticeSlot === "rate" ? (
                    <RateNudge
                      key="rate-nudge"
                      onRate={() => void updateSettings({ rateNudgeStatus: "rated" })}
                      onDismiss={() => void updateSettings({ rateNudgeStatus: "dismissed" })}
                    />
                  ) : null}
                  {noticeSlot === "github-star" ? (
                    <GithubStarNudge
                      key="github-star-nudge"
                      onStar={() => void updateSettings({ githubStarNudgeStatus: "starred" })}
                      onDismiss={() => void updateSettings({ githubStarNudgeStatus: "dismissed" })}
                    />
                  ) : null}
                </AnimatePresence>
                {settings.showTips ? <TipsBanner initialIndex={preview ? 0 : undefined} preview={preview} /> : null}
                {criticalFailureReason ? (
                  <CriticalFailurePanel
                    platform={platform}
                    reason={criticalFailureReason}
                    buildReport={() => buildFailureReport({
                      platform,
                      version: adapter.version,
                      userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
                      locale,
                      at: new Date().toISOString(),
                      settings,
                      state: snapshot.state,
                      events: reportEvents.length > 0 ? reportEvents : activityStream.events,
                    })}
                    onDismiss={() => {
                      void adapter.send({ type: "dismissCriticalFailure", platform })
                        .then(() => refreshNow())
                        .catch(() => undefined);
                    }}
                    openLink={adapter.openLink}
                    writeClipboard={adapter.writeClipboard ?? (async () => false)}
                  />
                ) : (
                  <DropsPanel
                    campaigns={campaigns}
                    gameMap={gameMap}
                    focus={campaignFocus}
                    refreshing={refreshing}
                    onRefreshCampaign={() => refreshNow()}
                    onReorder={(ordered) => updateSettings({ campaignPriorities: prioritiesFromOrder(ordered) }, { tickAfterSave: true })}
                    onToggleExclude={(id) => {
                      const next = new Set(settings.excludedCampaignIds);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return updateSettings({ excludedCampaignIds: [...next] }, { tickAfterSave: true });
                    }}
                  />
                )}
                {/* Keyed by platform so the add field's own text cannot survive
                    a platform switch either. */}
                <IdleWatchlistPanel
                  key={platform}
                  platform={platform}
                  streamers={screenshotWatchlist}
                  expanded={watchlistExpanded}
                  adding={watchlistAdding}
                  onExpandedChange={(next) => { setWatchlistExpanded(next); if (!next) setWatchlistAdding(false); }}
                  onAddingChange={setWatchlistAdding}
                  onChange={(ordered) => updateSettings(
                    {
                      platform: {
                        [platform]: {
                          idleWatchlistChannels: ordered.map((streamer) => streamer.id),
                        },
                      },
                    },
                    { tickAfterSave: true, tickAfterSavePlatforms: [platform] },
                  )}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      {settingsOpen ? <AttributionFooter version={adapter.version} /> : null}
    </main>
    </I18nContext.Provider>
    </PopupRuntimeContext.Provider>
  );
}
