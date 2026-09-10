import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { I18nContext, PopupRuntimeContext } from "../../popup-ui/src/context";
import { SettingsView } from "../../popup-ui/src/settings";
import type { PopupAdapter } from "../../popup-ui/src/types";

// Every message key the registry resolves for a DEFAULT_SETTINGS render without
// a compatibility registry supplied. A key missing here falls back to the raw
// key name, which makes the assertions below fail confusingly rather than
// cleanly, so keep this in sync with settingsRegistry.tsx.
const labels: Record<string, string> = {
  search: "Search",
  closeSearch: "Close search",
  settingsSearchPlaceholder: "Search settings…",
  settingsSearchNoResults: "No settings match",
  settingsPlatformSettings: "$1",
  settingsShowAdvancedTitle: "Show advanced settings",
  settingsSectionAdvancedActions: "Advanced actions",
  settingsSectionAdvancedActionsDescription: "Import, export, or reset Lurkloot settings.",
  settingsExportTitle: "Import and export",
  settingsExportHint: "Save or restore your settings.",
  settingsExportButton: "Export settings",
  settingsImportButton: "Import settings",
  settingsGroupAppearance: "Appearance & behavior",
  settingsGeneralDescription: "Language, startup, and popup behavior.",
  settingsGroupNotifications: "Notifications",
  notificationsDescription: "Alerts when rewards are ready or campaigns finish.",
  settingsGroupDrops: "Drops",
  dropsSettingsDescription: "Claiming, eligibility, priorities, and campaign visibility.",
  settingsGroupFarmingTabs: "Farming tabs",
  farmingTabsDescription: "Controls for video-tab farming.",
  settingsGroupAdvanced: "Advanced",
  advancedDescription: "Low-level scheduler and logging behavior.",
  settingsGroupPlatformAdvanced: "Advanced & compatibility",
  strictCampaignAvailabilityTitle: "Strict campaign availability",
  strictCampaignAvailabilityDescription: "Only farm a campaign on channels Twitch lists it for.",
  twitchSectionDescription: "Channel points, category filter, excluded channels, and Twitch compatibility.",
  kickSectionDescription: "Daily challenges, category filter, excluded channels, and Kick compatibility.",
  twitchAdvancedDescription: "Campaign availability and the transports Lurkloot uses.",
  kickAdvancedDescription: "How Lurkloot opens Kick claim links.",
  settingsGroupCategories: "Categories",
  settingsGroupExcludedChannels: "Excluded channels",
  settingsLanguageTitle: "Language",
  settingsLanguageDescription: "Choose the language used by the popup and extension notifications.",
  autoStartTitle: "Auto-start on launch",
  autoStartDescription: "Begin farming as soon as the extension loads.",
  pauseManualTitle: "Pause when watching manually",
  pauseManualDescription: "Stop farming while you have a stream open and are watching yourself.",
  hideTipsTitle: "Hide tips",
  hideTipsDescription: "Remove helpful tips from the main popup.",
  rewardEarnedTitle: "Reward earned",
  rewardEarnedDescription: "Notify when a drop reward is claimable.",
  noDropsLeftTitle: "No drops left",
  noDropsLeftDescription: "Notify when all active campaigns are exhausted.",
  autoClaimTitle: "Auto-claim drops",
  autoClaimDescription: "Claim earned drop rewards automatically when they become available.",
  campaignPriorityTitle: "Campaign priority",
  campaignPriorityDescription: "How campaigns are chosen to farm.",
  preferKnownChannelsTitle: "Prefer followed and Idle Watchlist channels",
  preferKnownChannelsDescription: "Picks a channel you know over an unfamiliar one.",
  idleWatchlistFallbackOnlyTitle: "Only when no drops are active",
  idleWatchlistFallbackOnlyDescription: "Preserves drop priority automatically.",
  farmUnlinkedTitle: "Farm campaigns without a linked account",
  farmUnlinkedDescription: "When off, campaigns that need you to link your account are skipped.",
  farmSubscriptionTitle: "Farm campaigns that require a subscription",
  farmSubscriptionDescription: "When off, campaigns whose rewards need a channel subscription are skipped.",
  dropsListFilterTitle: "Drops list view",
  dropsListFilterDescription: "Choose which campaigns are shown in the Drops list.",
  forgetExcludedTitle: "Forget excluded campaigns",
  forgetExcludedDescription: "Clear every campaign you excluded from farming.",
  tablessTitle: "Tabless low-resource mode",
  tablessDescription: "Farm via lightweight watch signals instead of a video tab.",
  autoCloseTabsTitle: "Auto-close farming tabs",
  autoCloseTabsDescription: "Automatically close when the extension is idle.",
  muteTabsTitle: "Mute farming tabs",
  muteTabsDescription: "Keep drop and Watch Queue tabs muted while farming.",
  keepVideosUnmutedTitle: "Keep farming videos unmuted",
  keepVideosUnmutedDescription: "Keeps page video players unmuted while the browser tab is muted.",
  adFocusTitle: "Focus tab during ads",
  adFocusDescription: "Ad countdowns freeze in background tabs.",
  schedulerIntervalTitle: "Scheduler interval",
  schedulerIntervalDescription: "How often campaign and streamer status refreshes.",
  tablessFallbackFailureLimitTitle: "Tabless fallback threshold",
  tablessFallbackFailureLimitDescription: "Open a video tab after this many consecutive failed tabless watch signals.",
  tablessFallbackFailureLimitDisabledReason: "Enable tabless low-resource mode to change this setting.",
  failuresSuffix: "failures",
  kickPageContextRecoverySuccessesTitle: "Kick fallback-page recovery",
  kickPageContextRecoverySuccessesDescription: "Close an extension-opened Kick fallback page after this many successful refresh cycles.",
  kickPageContextRecoverySuccessesDisabledReason: "Enable Kick to change this setting.",
  cyclesSuffix: "cycles",
  postClaimHandoffTitle: "Fast reward handoff",
  postClaimHandoffDescription: "After claiming a drop, briefly check for the next reward.",
  postClaimHandoffIntervalTitle: "Handoff check interval",
  postClaimHandoffIntervalDescription: "How long to wait between checks for the next reward.",
  postClaimHandoffMaxTitle: "Handoff time limit",
  postClaimHandoffMaxDescription: "Give up and return to the regular schedule after this long.",
  skipUnfinishableRewardsTitle: "Skip rewards that cannot be completed",
  skipUnfinishableRewardsDescription: "Do not farm impossible rewards.",
  deadlineSafetyMarginTitle: "Deadline safety margin",
  deadlineSafetyMarginDescription: "Extra minutes required before farming a reward.",
  deadlineSafetyMarginDisabledReason: "Enable deadline filtering to change the safety margin.",
  diagnosticLoggingTitle: "Include diagnostic logs",
  diagnosticLoggingDescription: "Record additional technical details.",
  tablessDisabledReason: "Disabled while tabless low-resource mode is enabled.",
  secondsSuffix: "sec",
  minutesSuffix: "min",
  off: "Off",
  tabOnly: "Tab only",
  tabAndWindow: "Tab + window",
  priorityListOnly: "Priority list only",
  endingSoonest: "Ending soonest",
  lowAvailabilityFirst: "Low availability first",
  autoClaimChannelPointsTitle: "Auto-claim channel points",
  autoClaimChannelPointsDescription: "Claim channel-point bonuses while farming this platform.",
  autoClaimChallengesTitle: "Auto-claim daily challenges",
  autoClaimChallengesDescription: "Claim Kick's daily challenge reward once its watch-time goal is met.",
  categoryModeTitle: "Category filter",
  categoryModeDescription: "Farm every $1 category, include only the categories you select, or exclude them.",
  categoryModeAll: "All categories",
  categoryModeInclude: "Only selected",
  categoryModeExclude: "All except selected",
  excludedChannelsTitle: "Excluded drop channels",
  excludedChannelsDescription: "Campaign farming will skip these streamers.",
  excludedChannelsEmpty: "No excluded drop channels.",
};

// KNOWN LIMITATION — depends on a React internal, verified necessary:
//
// The textbook fix for a controlled-input test not firing onChange is to call
// the native value setter (bypassing React's per-instance tracker) and then
// reset React's `_valueTracker` to the empty string before dispatching an
// "input" event, so React's ChangeEventPlugin sees the DOM value as changed.
// That was tried here first, from `window.HTMLInputElement.prototype` (not
// `input.constructor.prototype`, in case linkedom aliased them) with an
// explicit `tracker.setValue("")` reset before the dispatch. It did not work:
// confirmed with an isolated repro that React's container-level "input"
// listener *does* run (wrapping the listener function shows 2 invocations —
// capture and bubble), but the handler still never calls the app's onChange,
// even with the tracker reset. Something in linkedom's Event/target plumbing
// that ChangeEventPlugin depends on (composedPath, target resolution, or
// similar) does not line up the way it does in jsdom/real browsers, and that
// is below what's worth chasing here.
//
// So instead this reaches into the fiber's stashed props object (the
// `__reactProps$<id>` key React attaches to every host DOM node) and calls
// the current onChange prop directly with a minimal synthetic-event shape.
// This exercises the same application code the real event would have, just
// skipping React's own dispatch machinery. `__reactProps$` is an
// implementation-detail key with no stability guarantee across React
// versions. If this test starts failing after a React upgrade with an error
// like "props is undefined" or the key prefix changing, do not just chase the
// new key name — first re-verify whether the native dispatchEvent path above
// works under the new React/linkedom combination, since that would be the
// correct fix.
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")?.set;
  setter?.call(input, value);
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey ? (input as unknown as Record<string, { onChange?(event: unknown): void }>)[propsKey] : undefined;
  props?.onChange?.({ target: input, currentTarget: input });
}

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function mountSettings(settings = DEFAULT_SETTINGS, actions: Partial<Pick<React.ComponentProps<typeof SettingsView>, "onExportSettings" | "onImportSettings" | "onReset" | "onExportCredentials">> = {}) {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onSettingsChange = vi.fn(async () => undefined);
  const adapter = {
    getStorage: async () => ({}),
    setStorage: async () => undefined,
  } as unknown as PopupAdapter;
  const container = document.getElementById("app")!;

  act(() => {
    root = createRoot(container);
    root.render(
      <PopupRuntimeContext.Provider value={{ adapter, preview: true }}>
        <I18nContext.Provider value={{ t: (key: string, substitutions?: string | string[]) => (labels[key] ?? key).replace("$1", Array.isArray(substitutions) ? substitutions[0] ?? "" : substitutions ?? ""), dir: "ltr", locale: "en" }}>
          <SettingsView
            suggestions={{ twitch: [], kick: [] }}
            onSearchCategories={async () => []}
            settings={settings}
            onSettingsChange={onSettingsChange}
            exportConfirmationResetKey={0}
            {...actions}
          />
        </I18nContext.Provider>
      </PopupRuntimeContext.Provider>,
    );
  });

  return { container, onSettingsChange };
}

function openSearch(container: HTMLElement): HTMLInputElement {
  return container.querySelector("input[type=search]") as HTMLInputElement;
}

describe("settings search view", () => {
  it("shows advanced settings without an advanced-settings switch", () => {
    const { container } = mountSettings();
    expect(container.textContent).toContain("Scheduler interval");
    expect(container.querySelector('[aria-label="Show advanced settings"]')).toBeNull();
  });

  it("organizes the normal view into ordered collapsible settings sections", () => {
    const { container } = mountSettings();
    // Target the title span by its class rather than by ordinal, so adding a
    // badge or an icon to one section cannot silently shift what this reads.
    const sectionTitles = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
      .map((button) => button.querySelector<HTMLSpanElement>("span.uppercase")?.textContent?.trim());

    expect(sectionTitles).toEqual([
      "Appearance & behavior",
      "Notifications",
      "Drops",
      "Farming tabs",
      "Twitch",
      "Kick",
      "Advanced",
    ]);
    expect(container.textContent).toContain("Language, startup, and popup behavior.");
    expect(container.textContent).toContain("Alerts when rewards are ready or campaigns finish.");
    expect(container.textContent).toContain("Claiming, eligibility, priorities, and campaign visibility.");
  });

  it("keeps reward-completion policy with the other drop controls", () => {
    const { container } = mountSettings();
    const drops = container.querySelector("#settings-section-general\\.drops");
    const advanced = container.querySelector("#settings-section-general\\.advanced");

    expect(drops?.textContent).toContain("Skip rewards that cannot be completed");
    expect(advanced?.textContent).not.toContain("Skip rewards that cannot be completed");
  });

  it("keeps the compact settings search field visible without a separate action", () => {
    const { container } = mountSettings();
    expect(container.querySelector("input[type=search]")).not.toBeNull();
    expect(container.querySelector('[aria-label="Search"]')).toBeNull();
  });

  it("gives each platform its own top-level section instead of a tab switch", () => {
    const { container } = mountSettings();

    expect(container.querySelector('[role="tab"]')).toBeNull();
    expect(container.querySelector("#settings-section-twitch")).not.toBeNull();
    expect(container.querySelector("#settings-section-kick")).not.toBeNull();
    // Both platforms are on screen at once, so neither needs to be selected.
    expect(container.textContent).toContain("Auto-claim channel points");
    expect(container.textContent).toContain("Auto-claim daily challenges");
  });

  it("gives every section a subtitle naming its own contents", () => {
    const { container } = mountSettings();
    const twitch = container.querySelector("#settings-section-twitch");
    const kick = container.querySelector("#settings-section-kick");

    // Three sections sharing one subtitle is what made the old layout read as
    // the same section repeated, so no two of them may say the same thing.
    expect(twitch?.textContent).toContain("Channel points, category filter");
    expect(kick?.textContent).toContain("Daily challenges, category filter");
    expect(twitch?.textContent).not.toContain("Daily challenges, category filter");
  });

  it("keeps each advanced group with the settings it tunes", () => {
    const { container } = mountSettings();
    const twitch = container.querySelector("#settings-section-twitch");
    const general = container.querySelector("#settings-section-general\\.advanced");

    // The platform advanced group is titled apart from the General one so the
    // two are not read as the same section repeated.
    expect(twitch?.textContent).toContain("Advanced & compatibility");
    expect(twitch?.textContent).toContain("Strict campaign availability");
    expect(general?.textContent).toContain("Scheduler interval");
    expect(general?.textContent).not.toContain("Strict campaign availability");
  });

  it("filters settings by title as the user types", () => {
    const { container } = mountSettings();
    const search = openSearch(container);
    act(() => {
      setInputValue(search, "mute");
    });
    expect(container.textContent).toContain("Mute farming tabs");
    expect(container.textContent).not.toContain("Auto-claim drops");
  });

  it("shows matching setting groups instead of a broad General search section", () => {
    const { container } = mountSettings();
    const search = openSearch(container);

    act(() => setInputValue(search, "campaign"));

    const drops = container.querySelector<HTMLButtonElement>("#settings-section-general\\.drops button[aria-expanded]");
    expect(container.querySelector("#settings-section-general")).toBeNull();
    expect(drops?.textContent).toContain("Drops");

    act(() => drops?.click());
    expect(drops?.getAttribute("aria-expanded")).toBe("false");
  });

  it("finds import and export actions", () => {
    const { container } = mountSettings(DEFAULT_SETTINGS, {
      onExportSettings: async () => undefined,
      onImportSettings: async () => false,
    });
    const search = openSearch(container);

    act(() => setInputValue(search, "export"));

    expect(container.textContent).toContain("Export settings");
    expect(container.textContent).toContain("Import settings");
    expect(container.textContent).not.toContain("No settings match");
  });

  // The mode names live in the option labels, which the search haystack (title
  // + description) never sees, so the description has to carry them or the one
  // control that excludes categories is unfindable by the word "exclude".
  it("finds the category filter by the mode the user is looking for", () => {
    for (const query of ["exclude", "include", "categor"]) {
      const { container } = mountSettings();
      const search = openSearch(container);

      act(() => setInputValue(search, query));

      expect(container.textContent, query).toContain("Category filter");
      expect(container.textContent, query).not.toContain("No settings match");
    }
  });

  it("restores the full tree when the query is cleared", () => {
    const { container } = mountSettings();
    const search = openSearch(container);
    act(() => setInputValue(search, "mute"));
    act(() => setInputValue(search, ""));
    expect(container.textContent).toContain("Auto-claim drops");
  });

  it("shows an empty state when nothing matches", () => {
    const { container } = mountSettings();
    const search = openSearch(container);
    act(() => setInputValue(search, "zzzznotasetting"));
    expect(container.textContent).toContain("No settings match");
  });
});
