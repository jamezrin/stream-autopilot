import type { ExtensionSettings, Platform } from "@lurkloot/shared/models";
import type { LogLevel } from "@lurkloot/shared/logging";
import type { ScreenshotVariant } from "./types";

export const PLATFORMS: Record<Platform, { label: string; mark: string; color: string }> = {
  twitch: { label: "Twitch", mark: "T", color: "#9147ff" },
  kick: { label: "Kick", mark: "K", color: "#53fc18" },
};

// Public drop-inventory pages, opened from the popup header so the user does not
// have to navigate there by hand.
export const PLATFORM_INVENTORY_URLS: Record<Platform, string> = {
  twitch: "https://www.twitch.tv/drops/inventory",
  kick: "https://kick.com/drops/inventory",
};

export const SELECTED_PLATFORM_KEY = "popup:selectedPlatform";
export const COLLAPSED_SETTINGS_SECTIONS_KEY = "popup:collapsedSettingsSections";
export const SHOW_ADVANCED_SETTINGS_KEY = "popup:showAdvancedSettings";

// Chrome Web Store listing for the rate/review nudge. Single source of truth for
// the store id so the reviews URL stays correct if the listing slug changes.
export const CHROME_WEB_STORE_ID = "aobaackpofkghaejdnnmpmeaiaoibhdn";
export const CHROME_WEB_STORE_URL = `https://chromewebstore.google.com/detail/${CHROME_WEB_STORE_ID}`;
export const CHROME_WEB_STORE_REVIEW_URL = `${CHROME_WEB_STORE_URL}/reviews`;
// Canonical marketing/landing site for the extension.
export const SITE_URL = "https://lurkloot.jamezrin.com";
export const GITHUB_REPO_URL = "https://github.com/jamezrin/lurkloot";
export const CLI_DOCS_URL = "https://github.com/jamezrin/lurkloot/tree/main/packages/cli#readme";
export const GITHUB_NEW_ISSUE_URL = "https://github.com/jamezrin/lurkloot/issues/new/choose";
export const GITHUB_TRANSLATION_GUIDE_URL = "https://github.com/jamezrin/lurkloot/blob/main/docs/translations.md";
// The chooser URL cannot carry a prefilled title/body, so the critical-failure
// prompt targets the raw new-issue form instead.
export const GITHUB_NEW_ISSUE_URL_BASE = "https://github.com/jamezrin/lurkloot/issues/new";
// How long after install before the one-time "rate it" nudge appears.
export const RATE_NUDGE_MIN_DAYS = 3;
// How long after install before the one-time GitHub star nudge appears.
export const GITHUB_STAR_NUDGE_MIN_DAYS = 7;

export const GAME_ACCENTS = ["#2563eb", "#0891b2", "#ef4444", "#16a34a", "#9333ea", "#f59e0b"];

// Neutral accent for the synthetic "No category" group (drops with no game).
export const NO_CATEGORY_ACCENT = "#71717a";

export const CAMPAIGN_TINTS = [
  "from-orange-400 via-sky-400 to-blue-700",
  "from-cyan-400 via-zinc-700 to-rose-500",
  "from-red-600 via-pink-500 to-cyan-300",
  "from-zinc-700 via-slate-500 to-emerald-500",
  "from-violet-500 via-fuchsia-400 to-emerald-300",
  "from-amber-400 via-red-500 to-zinc-800",
];

export const REWARD_TINTS = [
  "from-lime-200 via-zinc-100 to-sky-200",
  "from-lime-500 via-zinc-800 to-cyan-600",
  "from-fuchsia-400 via-pink-300 to-lime-300",
  "from-cyan-400 via-emerald-500 to-zinc-800",
  "from-orange-400 via-red-500 to-zinc-800",
  "from-yellow-100 via-zinc-100 to-stone-200",
  "from-blue-400 via-blue-600 to-zinc-100",
  "from-zinc-100 via-emerald-200 to-slate-500",
];

export const EVENT_LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "#6366f1",
  info: "#a1a1aa",
  warn: "#f59e0b",
  error: "#ef4444",
};

// The Drops-list view toggles, rendered as a single compact chip row. Pure
// display: a chip only changes what the Drops list shows, never what is farmed —
// that axis is now two separate SettingRow toggles (farmingEligibility). Each
// entry pairs a dropsListFilter key with its per-state chip label message key.
//
// The not-linked/subscription chips carry a `lockedBy` naming the farming flag
// that forces them visible: you cannot hide a class of campaign you are actively
// farming (the farmed-implies-visible invariant lives in isCampaignVisible). When
// that flag is on the chip renders locked-on and disabled; the underlying
// show-flag value is left untouched so it returns when farming is turned off.
export const DROPS_LIST_FILTERS: Array<{
  key: keyof ExtensionSettings["dropsListFilter"];
  label: string;
  lockedBy?: keyof ExtensionSettings["farmingEligibility"];
}> = [
  { key: "showUpcoming", label: "upcoming" },
  { key: "showExpired", label: "expired" },
  { key: "showExcluded", label: "excluded" },
  { key: "showFinished", label: "finished" },
  { key: "showNotLinked", label: "notLinked", lockedBy: "farmUnlinkedCampaigns" },
  { key: "showSubscription", label: "subscriptionCampaigns", lockedBy: "farmSubscriptionCampaigns" },
];

const HERO_GLOW =
  "radial-gradient(ellipse at 12% 115%, rgba(145,71,255,0.40), transparent 44%), radial-gradient(ellipse at 94% 0%, rgba(83,252,24,0.18), transparent 38%)";
const EXTRAS_GLOW =
  "radial-gradient(ellipse at 88% 18%, rgba(83,252,24,0.14), transparent 38%), radial-gradient(ellipse at 8% 90%, rgba(145,71,255,0.28), transparent 44%)";
const EASY_GLOW =
  "radial-gradient(ellipse at 12% 90%, rgba(145,71,255,0.28), transparent 44%), radial-gradient(ellipse at 90% 10%, rgba(83,252,24,0.14), transparent 36%)";
const SETTINGS_GLOW =
  "radial-gradient(ellipse at 24% 90%, rgba(145,71,255,0.28), transparent 42%)";
const UPDATED_GLOW =
  "radial-gradient(ellipse at 18% 110%, rgba(145,71,255,0.36), transparent 46%), radial-gradient(ellipse at 92% 8%, rgba(83,252,24,0.16), transparent 38%)";

const drops: ScreenshotVariant = {
  layout: "hero",
  platform: "twitch",
  view: "drops",
  glow: HERO_GLOW,
  eyebrowKey: "screenshotHeroEyebrow",
  headlineKey: "screenshotHeroHeadline",
  subcopyKey: "screenshotHeroSubcopy",
};
const extras: ScreenshotVariant = {
  layout: "extras",
  platform: "twitch",
  view: "watchlist",
  glow: EXTRAS_GLOW,
  eyebrowKey: "screenshotExtrasEyebrow",
  headlineKey: "screenshotExtrasHeadline",
  subcopyKey: "screenshotExtrasSubcopy",
};
const easy: ScreenshotVariant = {
  layout: "steps",
  platform: "kick",
  view: "drops",
  glow: EASY_GLOW,
  eyebrowKey: "screenshotEasyEyebrow",
  headlineKey: "screenshotEasyHeadline",
  subcopyKey: "screenshotEasyHeadline",
};
const settings: ScreenshotVariant = {
  layout: "settings",
  platform: "twitch",
  view: "settings",
  glow: SETTINGS_GLOW,
  eyebrowKey: "screenshotSettingsEyebrow",
  headlineKey: "screenshotSettingsHeadline",
  subcopyKey: "screenshotSettingsSubcopy",
};
const updated: ScreenshotVariant = {
  layout: "updated",
  glow: UPDATED_GLOW,
  eyebrowKey: "screenshotUpdatedEyebrow",
  headlineKey: "screenshotUpdatedHeadline",
  subcopyKey: "screenshotUpdatedSubcopy",
};

export const SCREENSHOT_VARIANTS: Record<string, ScreenshotVariant> = {
  drops,
  extras,
  easy,
  settings,
  updated,
  "twitch-drops": drops,
  "kick-drops": drops,
  "idle-watchlist": extras,
  activity: updated,
};

export const SCREENSHOT_WATCHLIST_LIVE: Record<string, { displayName: string; viewers: number; subtitle: string }> = {
  rivalspilot: { displayName: "RivalsPilot", viewers: 18420, subtitle: "Marathon Legends" },
  lootforge: { displayName: "LootForge", viewers: 6210, subtitle: "Starfall Arena" },
  nightrunlive: { displayName: "NightRunLive", viewers: 2480, subtitle: "Spellforge" },
};

export const PROMO_GRADIENT =
  "radial-gradient(circle at 16% 18%, rgba(145,71,255,0.40), transparent 38%), radial-gradient(circle at 86% 82%, rgba(83,252,24,0.26), transparent 40%)";
