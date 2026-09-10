import type { AdFocusMode, CategoryMode, CategorySelection, CompatibilitySettings, EngineSettings, ExtensionSettings, GithubStarNudgeStatus, KickPlatformSettings, LanguageOverride, Platform, PriorityMode, RateNudgeStatus, SupportedLocale, TwitchPlatformSettings } from "./models";

const FARMING_PLATFORMS: Platform[] = ["twitch", "kick"];
const AD_FOCUS_MODES: AdFocusMode[] = ["none", "tab", "window"];
const PRIORITY_MODES: PriorityMode[] = ["ending_soonest", "lowest_availability", "priority_list_only"];
const RATE_NUDGE_STATUSES: RateNudgeStatus[] = ["pending", "rated", "dismissed"];
const GITHUB_STAR_NUDGE_STATUSES: GithubStarNudgeStatus[] = ["pending", "starred", "dismissed"];
export const CATEGORY_MODES: CategoryMode[] = ["all", "include", "exclude"];
export const SUPPORTED_LOCALES: SupportedLocale[] = ["en", "es", "fr", "it", "ru", "de", "zh_CN", "hi", "pt_BR", "ar", "tr"];
const LANGUAGE_OVERRIDES: LanguageOverride[] = ["browser", ...SUPPORTED_LOCALES];

export type SettingsPatch = Partial<Omit<ExtensionSettings, "platform" | "compatibility" | "farmingEligibility" | "dropsListFilter">> & {
  platform?: {
    twitch?: Partial<TwitchPlatformSettings>;
    kick?: Partial<KickPlatformSettings>;
  };
  compatibility?: {
    twitch?: Partial<CompatibilitySettings["twitch"]>;
    kick?: Partial<CompatibilitySettings["kick"]>;
  };
  farmingEligibility?: Partial<ExtensionSettings["farmingEligibility"]>;
  dropsListFilter?: Partial<ExtensionSettings["dropsListFilter"]>;
};

// The engine-contract defaults: the universal subset every host shares.
export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  autoClaim: true,
  tablessMode: true,
  pauseOnManualWatch: true,
  notifyRewardEarned: true,
  notifyNoDropsLeft: true,
  autoStartDropFarming: true,
  idleWatchlistFallbackOnly: true,
  preferKnownChannels: true,
  priorityMode: "ending_soonest",
  platform: {
    twitch: {
      enabled: false,
      idleWatchlistChannels: [],
      excludedChannels: [],
      categoryMode: "all",
      categories: [],
      autoClaimChannelPoints: true,
      strictCampaignAvailability: false,
    },
    kick: {
      enabled: false,
      idleWatchlistChannels: [],
      excludedChannels: [],
      categoryMode: "all",
      categories: [],
      autoClaimChallenges: true,
    },
  },
  compatibility: {
    twitch: {
      profile: "auto",
      heartbeatTransport: "auto",
      inventoryQueryVersion: "auto",
    },
    kick: {
      profile: "auto",
      claimLinkHandling: "auto",
    },
  },
  campaignPriorities: {},
  excludedCampaignIds: [],
  // Both classes are eligible by default: turning either off only ever farms
  // less, so no existing user's farming changes on upgrade.
  farmingEligibility: {
    farmUnlinkedCampaigns: true,
    farmSubscriptionCampaigns: true,
  },
  offlineRetryLimit: 3,
  tablessFallbackFailureLimit: 5,
  pollIntervalMinutes: 1,
  postClaimHandoff: true,
  // Nine refreshes at most, always finishing before the next one-minute watch
  // alarm so the handoff and the alarm never contend for the same heartbeat.
  postClaimHandoffIntervalSeconds: 5,
  postClaimHandoffMaxSeconds: 45,
  skipUnfinishableRewards: true,
  deadlineSafetyMarginMinutes: 5,
  criticalFailurePromptEnabled: true,
};

// The extension's full defaults: the engine contract plus the host-only knobs.
export const DEFAULT_SETTINGS: ExtensionSettings = {
  ...DEFAULT_ENGINE_SETTINGS,
  muteFarmingTabs: true,
  keepFarmingVideosUnmuted: true,
  autoCloseFinishedDrops: true,
  // Preserve the previously hard-coded visible set exactly: show upcoming and
  // finished, hide expired and excluded unless opted back in.
  dropsListFilter: {
    showUpcoming: true,
    showExpired: false,
    showFinished: true,
    showExcluded: false,
    // Not-linked and subscription campaigns show by default. These only hide a
    // class the user has also chosen NOT to farm; a farmed class stays visible
    // regardless (enforced in isCampaignVisible), so the default is show-all.
    showNotLinked: true,
    showSubscription: true,
  },
  adFocusMode: "window",
  languageOverride: "browser",
  rateNudgeStatus: "pending",
  githubStarNudgeStatus: "pending",
  showTips: true,
  // On by default: diagnostics only capture after they are enabled, so leaving
  // this off meant the first occurrence of any bug — the one being reported —
  // was always already lost. Recording is bounded (IndexedDB, capped records,
  // 7-day diagnostic retention, daily prune) and stays user-controllable, and
  // recording is independent of the activity view's display toggle. Existing
  // installs are unaffected: they have persisted an explicit value already, and
  // no migration overrides it.
  diagnosticLogging: true,
  showInPagePanel: true,
};

// Normalizes the universal engine contract. The engine (packages/core) and any
// non-extension host (CLI) merge through this; host-only fields are not touched.
// Legacy property names are not read here. Hosts run migrateSettings() from
// @lurkloot/shared/settingsSchema on the raw payload first; by the time a value
// reaches normalization it only carries current names.
export function mergeEngineSettings(value: Partial<EngineSettings> | undefined): EngineSettings {
  const platform = value?.platform;
  const compatibility = value?.compatibility;
  return {
    autoClaim: booleanOr(value?.autoClaim, DEFAULT_ENGINE_SETTINGS.autoClaim),
    tablessMode: booleanOr(value?.tablessMode, DEFAULT_ENGINE_SETTINGS.tablessMode),
    pauseOnManualWatch: booleanOr(value?.pauseOnManualWatch, DEFAULT_ENGINE_SETTINGS.pauseOnManualWatch),
    notifyRewardEarned: booleanOr(value?.notifyRewardEarned, DEFAULT_ENGINE_SETTINGS.notifyRewardEarned),
    notifyNoDropsLeft: booleanOr(value?.notifyNoDropsLeft, DEFAULT_ENGINE_SETTINGS.notifyNoDropsLeft),
    autoStartDropFarming: booleanOr(value?.autoStartDropFarming, DEFAULT_ENGINE_SETTINGS.autoStartDropFarming),
    idleWatchlistFallbackOnly: booleanOr(value?.idleWatchlistFallbackOnly, DEFAULT_ENGINE_SETTINGS.idleWatchlistFallbackOnly),
    preferKnownChannels: booleanOr(value?.preferKnownChannels, DEFAULT_ENGINE_SETTINGS.preferKnownChannels),
    priorityMode: PRIORITY_MODES.includes(value?.priorityMode as PriorityMode)
      ? (value!.priorityMode as PriorityMode)
      : DEFAULT_ENGINE_SETTINGS.priorityMode,
    platform: {
      twitch: {
        enabled: booleanOr(platform?.twitch?.enabled, DEFAULT_ENGINE_SETTINGS.platform.twitch.enabled),
        idleWatchlistChannels: normalizeChannelList(platform?.twitch?.idleWatchlistChannels),
        excludedChannels: normalizeChannelList(platform?.twitch?.excludedChannels),
        categoryMode: normalizeCategoryMode(platform?.twitch?.categoryMode),
        categories: normalizeCategorySelections(platform?.twitch?.categories),
        autoClaimChannelPoints: booleanOr(platform?.twitch?.autoClaimChannelPoints, DEFAULT_ENGINE_SETTINGS.platform.twitch.autoClaimChannelPoints),
        strictCampaignAvailability: booleanOr(platform?.twitch?.strictCampaignAvailability, DEFAULT_ENGINE_SETTINGS.platform.twitch.strictCampaignAvailability),
      },
      kick: {
        enabled: booleanOr(platform?.kick?.enabled, DEFAULT_ENGINE_SETTINGS.platform.kick.enabled),
        idleWatchlistChannels: normalizeChannelList(platform?.kick?.idleWatchlistChannels),
        excludedChannels: normalizeChannelList(platform?.kick?.excludedChannels),
        categoryMode: normalizeCategoryMode(platform?.kick?.categoryMode),
        categories: normalizeCategorySelections(platform?.kick?.categories),
        autoClaimChallenges: booleanOr(platform?.kick?.autoClaimChallenges, DEFAULT_ENGINE_SETTINGS.platform.kick.autoClaimChallenges),
      },
    },
    compatibility: {
      twitch: {
        profile: compatibilitySelectionOrAuto(compatibility?.twitch?.profile),
        heartbeatTransport: compatibilitySelectionOrAuto(compatibility?.twitch?.heartbeatTransport),
        inventoryQueryVersion: compatibilitySelectionOrAuto(compatibility?.twitch?.inventoryQueryVersion),
      },
      kick: {
        profile: compatibilitySelectionOrAuto(compatibility?.kick?.profile),
        claimLinkHandling: compatibilitySelectionOrAuto(compatibility?.kick?.claimLinkHandling),
      },
    },
    campaignPriorities: normalizePriorities(value?.campaignPriorities),
    excludedCampaignIds: normalizeIdList(value?.excludedCampaignIds),
    farmingEligibility: normalizeFarmingEligibility(value?.farmingEligibility),
    offlineRetryLimit: clampInteger(value?.offlineRetryLimit, 1, 10, DEFAULT_ENGINE_SETTINGS.offlineRetryLimit),
    tablessFallbackFailureLimit: clampInteger(
      value?.tablessFallbackFailureLimit,
      1,
      10,
      DEFAULT_ENGINE_SETTINGS.tablessFallbackFailureLimit,
    ),
    // chrome.alarms floors periodInMinutes at 1, so sub-minute values are inert.
    pollIntervalMinutes: clampNumber(value?.pollIntervalMinutes, 1, 60, DEFAULT_ENGINE_SETTINGS.pollIntervalMinutes),
    postClaimHandoff: booleanOr(value?.postClaimHandoff, DEFAULT_ENGINE_SETTINGS.postClaimHandoff),
    postClaimHandoffIntervalSeconds: clampInteger(value?.postClaimHandoffIntervalSeconds, 1, 30, DEFAULT_ENGINE_SETTINGS.postClaimHandoffIntervalSeconds),
    postClaimHandoffMaxSeconds: clampInteger(value?.postClaimHandoffMaxSeconds, 5, 120, DEFAULT_ENGINE_SETTINGS.postClaimHandoffMaxSeconds),
    skipUnfinishableRewards: booleanOr(value?.skipUnfinishableRewards, DEFAULT_ENGINE_SETTINGS.skipUnfinishableRewards),
    deadlineSafetyMarginMinutes: clampInteger(
      value?.deadlineSafetyMarginMinutes,
      0,
      60,
      DEFAULT_ENGINE_SETTINGS.deadlineSafetyMarginMinutes,
    ),
    criticalFailurePromptEnabled: booleanOr(value?.criticalFailurePromptEnabled, DEFAULT_ENGINE_SETTINGS.criticalFailurePromptEnabled),
  };
}

// Normalizes the extension's full settings: the engine contract plus the
// host-only fields the engine never reads.
export function mergeSettings(value: Partial<ExtensionSettings> | undefined): ExtensionSettings {
  return {
    ...mergeEngineSettings(value),
    muteFarmingTabs: booleanOr(value?.muteFarmingTabs, DEFAULT_SETTINGS.muteFarmingTabs),
    keepFarmingVideosUnmuted: booleanOr(value?.keepFarmingVideosUnmuted, DEFAULT_SETTINGS.keepFarmingVideosUnmuted),
    autoCloseFinishedDrops: booleanOr(value?.autoCloseFinishedDrops, DEFAULT_SETTINGS.autoCloseFinishedDrops),
    dropsListFilter: normalizeDropsListFilter(value?.dropsListFilter),
    adFocusMode: AD_FOCUS_MODES.includes(value?.adFocusMode as AdFocusMode)
      ? (value!.adFocusMode as AdFocusMode)
      : DEFAULT_SETTINGS.adFocusMode,
    languageOverride: normalizeLanguageOverride(value?.languageOverride),
    rateNudgeStatus: RATE_NUDGE_STATUSES.includes(value?.rateNudgeStatus as RateNudgeStatus)
      ? (value!.rateNudgeStatus as RateNudgeStatus)
      : DEFAULT_SETTINGS.rateNudgeStatus,
    githubStarNudgeStatus: GITHUB_STAR_NUDGE_STATUSES.includes(value?.githubStarNudgeStatus as GithubStarNudgeStatus)
      ? (value!.githubStarNudgeStatus as GithubStarNudgeStatus)
      : DEFAULT_SETTINGS.githubStarNudgeStatus,
    showTips: booleanOr(value?.showTips, DEFAULT_SETTINGS.showTips),
    diagnosticLogging: booleanOr(value?.diagnosticLogging, DEFAULT_SETTINGS.diagnosticLogging),
    showInPagePanel: booleanOr(value?.showInPagePanel, DEFAULT_SETTINGS.showInPagePanel),
  };
}

function normalizeLanguageOverride(value: LanguageOverride | undefined): LanguageOverride {
  return LANGUAGE_OVERRIDES.includes(value as LanguageOverride) ? (value as LanguageOverride) : DEFAULT_SETTINGS.languageOverride;
}

export function applySettingsPatch(current: ExtensionSettings, patch: SettingsPatch): ExtensionSettings {
  return mergeSettings({
    ...current,
    ...patch,
    platform: {
      ...current.platform,
      twitch: {
        ...current.platform.twitch,
        ...patch.platform?.twitch,
      },
      kick: {
        ...current.platform.kick,
        ...patch.platform?.kick,
      },
    },
    compatibility: {
      twitch: {
        ...current.compatibility.twitch,
        ...patch.compatibility?.twitch,
      },
      kick: {
        ...current.compatibility.kick,
        ...patch.compatibility?.kick,
      },
    },
    farmingEligibility: {
      ...current.farmingEligibility,
      ...patch.farmingEligibility,
    },
    dropsListFilter: {
      ...current.dropsListFilter,
      ...patch.dropsListFilter,
    },
  });
}

function compatibilitySelectionOrAuto(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "auto";
}

export function booleanOr(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

// Ordered list, deduped by lowercased id; entries need both a non-empty id and a
// non-empty name. The legacy `gamePriority: string[]` is intentionally NOT
// migrated: it stored ids without display names (and was an ordering hint, not an
// allowlist), so carrying it over would surface bare numeric ids like "13".
// Category images render unconditionally as <img src> as soon as the settings
// view is open — no click required — so an https-only allowlist matters here
// the same way it does for openHttpsLink's click-through guidance: settings
// can come from an imported file (see @lurkloot/shared/settingsExport), and a
// crafted category with a non-https imageUrl would otherwise beacon or probe
// the local network the instant the popup renders it.
function httpsUrlOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed).protocol === "https:" ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

// Exported so the CLI validates the mode exactly as the engine does rather than
// duplicating the allowed values. An absent or invalid mode defaults to "all",
// which is also what the pre-mode `farmAllCategories: true` default meant.
export function normalizeCategoryMode(value: unknown): CategoryMode {
  return CATEGORY_MODES.includes(value as CategoryMode) ? (value as CategoryMode) : "all";
}

export function normalizeCategorySelections(value: CategorySelection[] | undefined): CategorySelection[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: CategorySelection[] = [];
  for (const entry of value) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!id || !name) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const imageUrl = httpsUrlOrUndefined(entry?.imageUrl);
    result.push(imageUrl ? { id, name, imageUrl } : { id, name });
  }
  return result;
}

// Campaign ids are case-sensitive and matched verbatim against campaign.id in
// the scheduler, so unlike channel/game lists they must not be lowercased.
export function normalizeIdList(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
}

// Exported for non-extension hosts (the CLI) that honour farmingEligibility on
// their own settings surface but must default identically to the engine.
export function normalizeFarmingEligibility(
  value: Partial<EngineSettings["farmingEligibility"]> | undefined,
): EngineSettings["farmingEligibility"] {
  return {
    farmUnlinkedCampaigns: booleanOr(value?.farmUnlinkedCampaigns, DEFAULT_ENGINE_SETTINGS.farmingEligibility.farmUnlinkedCampaigns),
    farmSubscriptionCampaigns: booleanOr(value?.farmSubscriptionCampaigns, DEFAULT_ENGINE_SETTINGS.farmingEligibility.farmSubscriptionCampaigns),
  };
}

// dropsListFilter is extension-only (host view preference), so it normalizes in
// mergeSettings rather than the engine merge.
function normalizeDropsListFilter(
  value: Partial<ExtensionSettings["dropsListFilter"]> | undefined,
): ExtensionSettings["dropsListFilter"] {
  return {
    showUpcoming: booleanOr(value?.showUpcoming, DEFAULT_SETTINGS.dropsListFilter.showUpcoming),
    showExpired: booleanOr(value?.showExpired, DEFAULT_SETTINGS.dropsListFilter.showExpired),
    showFinished: booleanOr(value?.showFinished, DEFAULT_SETTINGS.dropsListFilter.showFinished),
    showExcluded: booleanOr(value?.showExcluded, DEFAULT_SETTINGS.dropsListFilter.showExcluded),
    showNotLinked: booleanOr(value?.showNotLinked, DEFAULT_SETTINGS.dropsListFilter.showNotLinked),
    showSubscription: booleanOr(value?.showSubscription, DEFAULT_SETTINGS.dropsListFilter.showSubscription),
  };
}

export function normalizeChannelList(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/^@+/, "").toLowerCase())
    .filter(Boolean))];
}

export function normalizePriorities(value: Record<string, number> | undefined): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([campaignId, priority]) => campaignId.trim() && Number.isFinite(priority))
      .map(([campaignId, priority]) => [campaignId.trim(), Math.round(priority)]),
  );
}

// The claim toggles are per-platform, so a scheduler loop holding `platform` as a
// variable cannot read them off the union. These answer "is the toggle on for
// this platform"; whether the platform can actually claim is decided separately
// by the adapter's optional capability method.
export function autoClaimChannelPointsFor(settings: EngineSettings, platform: Platform): boolean {
  return platform === "twitch" ? settings.platform.twitch.autoClaimChannelPoints : false;
}

export function autoClaimChallengesFor(settings: EngineSettings, platform: Platform): boolean {
  return platform === "kick" ? settings.platform.kick.autoClaimChallenges : false;
}

// Farming is active when at least one platform is enabled. This replaces the
// former stored `running` master switch: a single source of truth cannot drift
// out of step with the per-platform flags the way two of them could.
export function isFarmingActive(settings: EngineSettings): boolean {
  return FARMING_PLATFORMS.some((platform) => settings.platform[platform].enabled);
}
