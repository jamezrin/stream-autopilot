import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "@lurkloot/shared/settings";
import { I18nContext, PopupRuntimeContext } from "../../popup-ui/src/context";
import { SettingsView } from "../../popup-ui/src/settings";
import type { PopupAdapter } from "../../popup-ui/src/types";

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

// Every message key the registry resolves for a DEFAULT_SETTINGS render without
// a compatibility registry supplied. A key missing here falls back to the raw
// key name, which makes the assertions below fail confusingly rather than
// cleanly, so keep this in sync with settingsRegistry.tsx. (Mirrors the map in
// settingsSearchView.test.tsx, which mounts the same tree.)
const labels: Record<string, string> = {
  settingsSearchPlaceholder: "Search settings…",
  settingsSearchNoResults: "No settings match",
  settingsShowAdvancedTitle: "Show advanced settings",
  settingsGroupAppearance: "Appearance & behavior",
  settingsGroupNotifications: "Notifications",
  settingsGroupDrops: "Drops",
  settingsGroupFarmingTabs: "Farming tabs",
  settingsGroupAdvanced: "Advanced",
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
  dropsListFilterLockedHint: "Always shown while you're farming these campaigns.",
  notLinked: "Not linked",
  subscriptionCampaigns: "Subscription campaigns",
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

describe("deadline feasibility setting", () => {
  function mountSettings(settings = DEFAULT_SETTINGS) {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onSettingsChange = vi.fn(async () => undefined);
    const adapter = {} as PopupAdapter;
    const container = document.getElementById("app")!;

    act(() => {
      root = createRoot(container);
      root.render(
        <PopupRuntimeContext.Provider value={{ adapter, preview: true }}>
          <I18nContext.Provider value={{ t: (key) => labels[key] ?? key, dir: "ltr", locale: "en" }}>
            <SettingsView
              suggestions={{ twitch: [], kick: [] }}
              onSearchCategories={async () => []}
              settings={settings}
              onSettingsChange={onSettingsChange}
              exportConfirmationResetKey={0}
            />
          </I18nContext.Provider>
        </PopupRuntimeContext.Provider>,
      );
    });

    // The deadline-feasibility controls live in the "Advanced" group inside
    // the General section, which is hidden until the advanced switch is on.
    const advancedSwitch = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Show advanced settings");
    act(() => advancedSwitch?.click());
    return { container, onSettingsChange };
  }

  function setNumberInput(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    // Linkedom does not route these events through React's ChangeEventPlugin,
    // so mirror the browser's input-and-blur sequence through the stashed host
    // props. The search-view test uses the same focused workaround.
    const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
    const props = propsKey ? (input as unknown as Record<string, { onBlur?(event: unknown): void; onChange?(event: unknown): void }>)[propsKey] : undefined;
    props?.onChange?.({ target: input, currentTarget: input });
    props?.onBlur?.({ currentTarget: input });
  }

  it("defaults the toggle on and saves changes immediately", () => {
    const { container, onSettingsChange } = mountSettings();
    const toggle = container.querySelector('[role="switch"][aria-label="Skip rewards that cannot be completed"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    act(() => toggle.click());
    expect(onSettingsChange).toHaveBeenCalledWith(
      { skipUnfinishableRewards: false },
      { tickAfterSave: true },
    );
  });

  it("disables but preserves the margin input when filtering is off", () => {
    const { container } = mountSettings({ ...DEFAULT_SETTINGS, skipUnfinishableRewards: false, deadlineSafetyMarginMinutes: 17 });
    const input = container.querySelector('input[aria-label="Deadline safety margin"]') as HTMLInputElement;
    expect(input.value).toBe("17");
    expect(input.disabled).toBe(true);
  });

  it("renders and saves the tabless fallback threshold", () => {
    const { container, onSettingsChange } = mountSettings();
    const input = container.querySelector(
      'input[aria-label="Tabless fallback threshold"]',
    ) as HTMLInputElement;
    expect(input.value).toBe("5");
    expect(input.getAttribute("min")).toBe("1");
    expect(input.getAttribute("max")).toBe("10");

    act(() => setNumberInput(input, "7"));
    expect(onSettingsChange).toHaveBeenCalledWith(
      { tablessFallbackFailureLimit: 7 },
      { tickAfterSave: true },
    );
  });

  it("disables the tabless fallback threshold when tabless mode is off", () => {
    const { container } = mountSettings({ ...DEFAULT_SETTINGS, tablessMode: false });
    const input = container.querySelector(
      'input[aria-label="Tabless fallback threshold"]',
    ) as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it("renders and saves the Kick fallback-page recovery threshold", () => {
    const { container, onSettingsChange } = mountSettings();
    const input = container.querySelector(
      'input[aria-label="Kick fallback-page recovery"]',
    ) as HTMLInputElement;
    expect(input.value).toBe("3");
    expect(input.getAttribute("min")).toBe("1");
    expect(input.getAttribute("max")).toBe("10");

    act(() => setNumberInput(input, "6"));
    expect(onSettingsChange).toHaveBeenCalledWith(
      { kickPageContextRecoverySuccesses: 6 },
      { tickAfterSave: true },
    );
  });

  it("disables the Kick fallback-page recovery threshold when Kick is off", () => {
    const settings = mergeSettings({
      platform: { kick: { enabled: false } },
    } as never);
    const { container } = mountSettings(settings);
    const input = container.querySelector(
      'input[aria-label="Kick fallback-page recovery"]',
    ) as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it("re-ticks after toggling a farming-eligibility row", () => {
    const { container, onSettingsChange } = mountSettings();
    // The two farming rows are full SettingRow toggles keyed by their title, so
    // query by the switch's accessible name.
    const toggle = container.querySelector('[role="switch"][aria-label="Farm campaigns without a linked account"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    act(() => toggle.click());

    expect(onSettingsChange).toHaveBeenCalledWith(
      { farmingEligibility: { farmUnlinkedCampaigns: false } },
      { tickAfterSave: true },
    );
  });

  it("renders both farming-eligibility rows as full toggles", () => {
    const { container } = mountSettings();
    const text = container.textContent ?? "";

    expect(text).toContain("Farm campaigns without a linked account");
    expect(text).toContain("Farm campaigns that require a subscription");
    // Both are switches, not chips: a switch role means the row carries its own
    // description, which the compact chip row does not.
    expect(container.querySelector('[role="switch"][aria-label="Farm campaigns without a linked account"]')).not.toBeNull();
    expect(container.querySelector('[role="switch"][aria-label="Farm campaigns that require a subscription"]')).not.toBeNull();
  });

  it("exposes the Drops list view chip row with an accessible name", () => {
    const { container } = mountSettings();
    // Queried by role and accessible name rather than by text, so a refactor
    // that drops the labelling leaves screen-reader users with an anonymous run
    // of buttons and this test fails instead of passing silently.
    const groups = [...container.querySelectorAll('[role="group"]')].map((group) => {
      const labelId = group.getAttribute("aria-labelledby")!;
      return {
        name: container.querySelector(`#${labelId}`)?.textContent,
        pills: [...group.querySelectorAll("button[aria-pressed]")].map((pill) => pill.textContent?.trim()),
      };
    });

    expect(groups).toEqual([
      { name: "Drops list view", pills: ["upcoming", "expired", "excluded", "finished", "Not linked", "Subscription campaigns"] },
    ]);
  });

  it("locks the not-linked chip on and disables it while its campaigns are farmed", () => {
    // farmUnlinkedCampaigns on: the class is always farmed, so the chip is forced
    // visible and disabled — the farmed-implies-visible invariant, surfaced.
    const { container } = mountSettings({
      ...DEFAULT_SETTINGS,
      farmingEligibility: { ...DEFAULT_SETTINGS.farmingEligibility, farmUnlinkedCampaigns: true },
    });
    const chip = [...container.querySelectorAll('button[aria-pressed]')].find((button) => button.textContent?.trim() === "Not linked") as HTMLButtonElement;
    expect(chip).toBeTruthy();
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(chip.disabled).toBe(true);
    expect(chip.getAttribute("aria-disabled")).toBe("true");
  });

  it("frees the not-linked chip as a normal toggle when its campaigns are not farmed", () => {
    const { container } = mountSettings({
      ...DEFAULT_SETTINGS,
      farmingEligibility: { ...DEFAULT_SETTINGS.farmingEligibility, farmUnlinkedCampaigns: false },
      dropsListFilter: { ...DEFAULT_SETTINGS.dropsListFilter, showNotLinked: false },
    });
    const chip = [...container.querySelectorAll('button[aria-pressed]')].find((button) => button.textContent?.trim() === "Not linked") as HTMLButtonElement;
    expect(chip).toBeTruthy();
    // Not farmed and hidden: a plain, enabled, unpressed toggle over showNotLinked.
    expect(chip.disabled).toBe(false);
    expect(chip.getAttribute("aria-disabled")).toBe("false");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
  });

  it("reconciles all platforms after changing Idle Watchlist fallback policy", () => {
    const { container, onSettingsChange } = mountSettings();
    const toggle = container.querySelector('[role="switch"][aria-label="Only when no drops are active"]') as HTMLButtonElement;

    act(() => toggle.click());

    expect(onSettingsChange).toHaveBeenCalledWith(
      { idleWatchlistFallbackOnly: false },
      { tickAfterSave: true },
    );
  });

  // The mode change must ride platformPatch, which carries tickAfterSave for the
  // one platform — the existing selection-invalidation path, not a new one.
  it("targets category mode changes to their platform", () => {
    const { container, onSettingsChange } = mountSettings();
    const select = container.querySelector('select[aria-label="Category filter"]') as HTMLSelectElement;

    act(() => {
      // linkedom's select.value is getter-only, so the selection is staged the
      // same way compatibilitySettingsView.test.tsx does it.
      for (const option of select.querySelectorAll("option")) option.selected = option.getAttribute("value") === "exclude";
      Object.defineProperty(select, "value", { configurable: true, value: "exclude" });
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });

    expect(onSettingsChange).toHaveBeenCalledWith(
      { platform: { twitch: { categoryMode: "exclude" } } },
      { tickAfterSave: true, tickAfterSavePlatforms: ["twitch"] },
    );
  });

  it("saves notification preferences without a scheduler tick", () => {
    const { container, onSettingsChange } = mountSettings();
    const toggle = container.querySelector('[role="switch"][aria-label="Reward earned"]') as HTMLButtonElement;

    act(() => toggle.click());

    expect(onSettingsChange).toHaveBeenCalledWith({ notifyRewardEarned: false });
  });
});
