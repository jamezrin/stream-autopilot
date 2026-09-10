import React from "react";
import type { CategorySelection, ExtensionSettings, LanguageOverride, Platform } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { LOCALE_OPTIONS } from "@lurkloot/shared/i18n";
import { PLATFORMS } from "./constants";
import { Pill } from "./primitives";
import {
  DropsListFilterRow,
  ForgetExcludedCampaignsRow,
  NumberSettingRow,
  SelectSettingRow,
  SettingRow,
} from "./settingsControls";
import { PlatformCategorySettings, PlatformExcludedChannels } from "./settingsPlatform";
import { PlatformCompatibilitySettings } from "./compatibilitySettings";
import type { SettingsEntryNode, SettingsGroupNode, SettingsSectionNode, TranslateFn } from "./settingsSearch";
import type { GameItem, PopupCompatibilityRegistry, PopupCompatibilityResolution } from "./types";

export interface SettingsChangeOptions {
  tickAfterSave?: boolean;
  tickAfterSavePlatforms?: Platform[];
}

// This context builds the full inventory of *settings*. The CLI credential
// export is deliberately not a registry entry: it is an action (not a
// setting), it owns its own arm/confirm state, and it renders as a
// standalone button at the foot of the settings view. See settings.tsx.
export interface SettingsRegistryContext {
  t: TranslateFn;
  settings: ExtensionSettings;
  onSettingsChange(patch: SettingsPatch, options?: SettingsChangeOptions): Promise<void>;
  suggestions: Record<Platform, GameItem[]>;
  onSearchCategories(platform: Platform, query: string): Promise<CategorySelection[]>;
  compatibilityRegistry?: PopupCompatibilityRegistry;
  compatibilityResolution?: PopupCompatibilityResolution;
}

export interface SettingsEntryDef extends SettingsEntryNode {
  render(): React.ReactNode;
}

export interface SettingsGroupDef extends SettingsGroupNode<SettingsEntryDef> {
  // Set only by groups whose whole body is a single editor. The group header
  // then carries the editor's subtitle and count, so the editor renders bare
  // rather than repeating the heading inside a nested card.
  description?: string;
  badge?: React.ReactNode;
}

export interface SettingsSectionDef extends SettingsSectionNode<SettingsEntryDef> {
  // Narrowed from the node shape so the walker can read description/badge off a
  // group without a cast. SettingsGroupDef is assignable to the node type, so
  // filterSettingsTree still accepts these sections.
  groups: SettingsGroupDef[];
  // Subtitle under the section heading. Only the platform sections set it: the
  // General groups each render as their own section and carry their own.
  description?: string;
}

// The shape of a settings patch's `platform` block, keyed by platform. Typing
// platformPatch's second argument against `PlatformPatch[P]` (rather than
// `Record<string, unknown>`) means a typo'd key or a wrong-shaped value fails
// `pnpm typecheck` instead of silently writing a dead key that mergeSettings
// drops at the next save.
type PlatformPatch = NonNullable<SettingsPatch["platform"]>;

export function buildSettingsRegistry(ctx: SettingsRegistryContext): SettingsSectionDef[] {
  const { t, settings, onSettingsChange } = ctx;
  const setFlag = (key: keyof ExtensionSettings) => (value: boolean) => void onSettingsChange({ [key]: value } as SettingsPatch);
  const tabPlaybackDisabled = settings.tablessMode;
  const tabPlaybackDisabledReason = t("tablessDisabledReason");

  const platformPatch = <P extends Platform>(platform: P, patch: NonNullable<PlatformPatch[P]>) =>
    onSettingsChange({ platform: { [platform]: patch } } as SettingsPatch, { tickAfterSave: true, tickAfterSavePlatforms: [platform] });

  const general: SettingsSectionDef = {
    id: "general",
    rows: [],
    groups: [
      {
        id: "general.appearance",
        titleKey: "settingsGroupAppearance",
        description: t("settingsGeneralDescription"),
        entries: [
          {
            id: "general.appearance.language",
            titleKey: "settingsLanguageTitle",
            descriptionKey: "settingsLanguageDescription",
            render: () => (
              <SelectSettingRow<LanguageOverride>
                title={t("settingsLanguageTitle")}
                description={t("settingsLanguageDescription")}
                value={settings.languageOverride}
                options={LOCALE_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.value === "browser" ? t(option.labelKey) : `${option.nativeName} (${t(option.labelKey)})`,
                }))}
                onChange={(value) => void onSettingsChange({ languageOverride: value })}
              />
            ),
          },
          {
            id: "general.appearance.autoStart",
            titleKey: "autoStartTitle",
            descriptionKey: "autoStartDescription",
            render: () => <SettingRow title={t("autoStartTitle")} description={t("autoStartDescription")} checked={settings.autoStartDropFarming} onChange={setFlag("autoStartDropFarming")} />,
          },
          {
            id: "general.appearance.pauseOnManualWatch",
            titleKey: "pauseManualTitle",
            descriptionKey: "pauseManualDescription",
            render: () => <SettingRow title={t("pauseManualTitle")} description={t("pauseManualDescription")} checked={settings.pauseOnManualWatch} onChange={setFlag("pauseOnManualWatch")} />,
          },
          {
            id: "general.appearance.hideTips",
            titleKey: "hideTipsTitle",
            descriptionKey: "hideTipsDescription",
            render: () => <SettingRow title={t("hideTipsTitle")} description={t("hideTipsDescription")} checked={!settings.showTips} onChange={(hideTips) => void onSettingsChange({ showTips: !hideTips })} />,
          },
          {
            id: "general.appearance.inPagePanel",
            titleKey: "inPagePanelTitle",
            descriptionKey: "inPagePanelDescription",
            render: () => <SettingRow title={t("inPagePanelTitle")} description={t("inPagePanelDescription")} checked={settings.showInPagePanel} onChange={setFlag("showInPagePanel")} />,
          },
        ],
      },
      {
        id: "general.notifications",
        titleKey: "settingsGroupNotifications",
        description: t("notificationsDescription"),
        entries: [
          {
            id: "general.notifications.rewardEarned",
            titleKey: "rewardEarnedTitle",
            descriptionKey: "rewardEarnedDescription",
            render: () => <SettingRow title={t("rewardEarnedTitle")} description={t("rewardEarnedDescription")} checked={settings.notifyRewardEarned} onChange={setFlag("notifyRewardEarned")} />,
          },
          {
            id: "general.notifications.noDropsLeft",
            titleKey: "noDropsLeftTitle",
            descriptionKey: "noDropsLeftDescription",
            render: () => <SettingRow title={t("noDropsLeftTitle")} description={t("noDropsLeftDescription")} checked={settings.notifyNoDropsLeft} onChange={setFlag("notifyNoDropsLeft")} />,
          },
        ],
      },
      {
        id: "general.drops",
        titleKey: "settingsGroupDrops",
        description: t("dropsSettingsDescription"),
        entries: [
          {
            id: "general.drops.autoClaim",
            titleKey: "autoClaimTitle",
            descriptionKey: "autoClaimDescription",
            render: () => <SettingRow title={t("autoClaimTitle")} description={t("autoClaimDescription")} checked={settings.autoClaim} onChange={setFlag("autoClaim")} />,
          },
          // Farming-eligibility toggles: they change what gets farmed, so they
          // sit with the other behaviour rows and re-tick on save. Distinct from
          // the display-only chip row below, which changes nothing the engine does.
          {
            id: "general.drops.farmUnlinked",
            titleKey: "farmUnlinkedTitle",
            descriptionKey: "farmUnlinkedDescription",
            render: () => <SettingRow title={t("farmUnlinkedTitle")} description={t("farmUnlinkedDescription")} checked={settings.farmingEligibility.farmUnlinkedCampaigns} onChange={(value) => void onSettingsChange({ farmingEligibility: { farmUnlinkedCampaigns: value } }, { tickAfterSave: true })} />,
          },
          {
            id: "general.drops.farmSubscription",
            titleKey: "farmSubscriptionTitle",
            descriptionKey: "farmSubscriptionDescription",
            render: () => <SettingRow title={t("farmSubscriptionTitle")} description={t("farmSubscriptionDescription")} checked={settings.farmingEligibility.farmSubscriptionCampaigns} onChange={(value) => void onSettingsChange({ farmingEligibility: { farmSubscriptionCampaigns: value } }, { tickAfterSave: true })} />,
          },
          {
            id: "general.drops.priorityMode",
            titleKey: "campaignPriorityTitle",
            descriptionKey: "campaignPriorityDescription",
            render: () => (
              <SelectSettingRow
                title={t("campaignPriorityTitle")}
                description={t("campaignPriorityDescription")}
                value={settings.priorityMode}
                options={[
                  { value: "priority_list_only", label: t("priorityListOnly") },
                  { value: "ending_soonest", label: t("endingSoonest") },
                  { value: "lowest_availability", label: t("lowAvailabilityFirst") },
                ]}
                onChange={(value) => void onSettingsChange({ priorityMode: value }, { tickAfterSave: true })}
              />
            ),
          },
          {
            id: "general.drops.skipUnfinishable",
            titleKey: "skipUnfinishableRewardsTitle",
            descriptionKey: "skipUnfinishableRewardsDescription",
            render: () => <SettingRow title={t("skipUnfinishableRewardsTitle")} description={t("skipUnfinishableRewardsDescription")} checked={settings.skipUnfinishableRewards} onChange={(value) => void onSettingsChange({ skipUnfinishableRewards: value }, { tickAfterSave: true })} />,
          },
          {
            id: "general.drops.preferKnownChannels",
            titleKey: "preferKnownChannelsTitle",
            descriptionKey: "preferKnownChannelsDescription",
            render: () => <SettingRow title={t("preferKnownChannelsTitle")} description={t("preferKnownChannelsDescription")} checked={settings.preferKnownChannels} onChange={(value) => void onSettingsChange({ preferKnownChannels: value }, { tickAfterSave: true })} />,
          },
          {
            id: "general.drops.idleWatchlistFallbackOnly",
            titleKey: "idleWatchlistFallbackOnlyTitle",
            descriptionKey: "idleWatchlistFallbackOnlyDescription",
            render: () => <SettingRow title={t("idleWatchlistFallbackOnlyTitle")} description={t("idleWatchlistFallbackOnlyDescription")} checked={settings.idleWatchlistFallbackOnly} onChange={(value) => void onSettingsChange({ idleWatchlistFallbackOnly: value }, { tickAfterSave: true })} />,
          },
          {
            id: "general.drops.dropsListFilter",
            titleKey: "dropsListFilterTitle",
            descriptionKey: "dropsListFilterDescription",
            // Display-only: saving does not re-tick, matching other pure-view
            // settings (e.g. the language/appearance rows), because it changes
            // nothing the engine does.
            render: () => <DropsListFilterRow value={settings.dropsListFilter} farmingEligibility={settings.farmingEligibility} onChange={(dropsListFilter) => void onSettingsChange({ dropsListFilter })} />,
          },
          {
            id: "general.drops.forgetExcluded",
            titleKey: "forgetExcludedTitle",
            descriptionKey: "forgetExcludedDescription",
            render: () => <ForgetExcludedCampaignsRow count={settings.excludedCampaignIds.length} onForget={() => void onSettingsChange({ excludedCampaignIds: [] }, { tickAfterSave: true })} />,
          },
        ],
      },
      {
        id: "general.farmingTabs",
        titleKey: "settingsGroupFarmingTabs",
        description: t("farmingTabsDescription"),
        entries: [
          {
            id: "general.farmingTabs.tabless",
            titleKey: "tablessTitle",
            descriptionKey: "tablessDescription",
            render: () => <SettingRow title={t("tablessTitle")} description={t("tablessDescription")} checked={settings.tablessMode} onChange={(value) => void onSettingsChange({ tablessMode: value }, { tickAfterSave: true })} />,
          },
          {
            id: "general.farmingTabs.autoClose",
            titleKey: "autoCloseTabsTitle",
            descriptionKey: "autoCloseTabsDescription",
            render: () => <SettingRow title={t("autoCloseTabsTitle")} description={t("autoCloseTabsDescription")} checked={settings.autoCloseFinishedDrops} onChange={setFlag("autoCloseFinishedDrops")} />,
          },
          {
            id: "general.farmingTabs.mute",
            titleKey: "muteTabsTitle",
            descriptionKey: "muteTabsDescription",
            render: () => <SettingRow title={t("muteTabsTitle")} description={t("muteTabsDescription")} checked={settings.muteFarmingTabs} onChange={setFlag("muteFarmingTabs")} disabled={tabPlaybackDisabled} disabledReason={tabPlaybackDisabledReason} />,
          },
          {
            id: "general.farmingTabs.keepUnmuted",
            titleKey: "keepVideosUnmutedTitle",
            descriptionKey: "keepVideosUnmutedDescription",
            render: () => <SettingRow title={t("keepVideosUnmutedTitle")} description={t("keepVideosUnmutedDescription")} checked={settings.keepFarmingVideosUnmuted !== false} onChange={setFlag("keepFarmingVideosUnmuted")} disabled={tabPlaybackDisabled} disabledReason={tabPlaybackDisabledReason} />,
          },
          {
            id: "general.farmingTabs.adFocus",
            titleKey: "adFocusTitle",
            descriptionKey: "adFocusDescription",
            render: () => (
              <SelectSettingRow
                title={t("adFocusTitle")}
                description={t("adFocusDescription")}
                value={settings.adFocusMode ?? "window"}
                options={[
                  { value: "none", label: t("off") },
                  { value: "tab", label: t("tabOnly") },
                  { value: "window", label: t("tabAndWindow") },
                ]}
                onChange={(value) => void onSettingsChange({ adFocusMode: value })}
                disabled={tabPlaybackDisabled}
                disabledReason={tabPlaybackDisabledReason}
              />
            ),
          },
        ],
      },
      {
        // Scheduler tuning and diagnostics are one group, not two: each section
        // gets exactly one advanced group, and a lone "Diagnostics" group would
        // hold a single toggle.
        id: "general.advanced",
        titleKey: "settingsGroupAdvanced",
        description: t("advancedDescription"),
        advanced: true,
        entries: [
          {
            id: "general.advanced.pollInterval",
            titleKey: "schedulerIntervalTitle",
            descriptionKey: "schedulerIntervalDescription",
            render: () => <NumberSettingRow title={t("schedulerIntervalTitle")} description={t("schedulerIntervalDescription")} value={Math.round(settings.pollIntervalMinutes * 60)} min={30} max={3600} suffix={t("secondsSuffix")} onChange={(value) => void onSettingsChange({ pollIntervalMinutes: value / 60 })} />,
          },
          {
            id: "general.advanced.tablessFallbackFailureLimit",
            titleKey: "tablessFallbackFailureLimitTitle",
            descriptionKey: "tablessFallbackFailureLimitDescription",
            render: () => (
              <NumberSettingRow
                title={t("tablessFallbackFailureLimitTitle")}
                description={t("tablessFallbackFailureLimitDescription")}
                value={settings.tablessFallbackFailureLimit}
                min={1}
                max={10}
                suffix={t("failuresSuffix")}
                disabled={!settings.tablessMode}
                disabledReason={t("tablessFallbackFailureLimitDisabledReason")}
                onChange={(value) => void onSettingsChange(
                  { tablessFallbackFailureLimit: value },
                  { tickAfterSave: true },
                )}
              />
            ),
          },
          {
            id: "general.advanced.kickPageContextRecoverySuccesses",
            titleKey: "kickPageContextRecoverySuccessesTitle",
            descriptionKey: "kickPageContextRecoverySuccessesDescription",
            render: () => (
              <NumberSettingRow
                title={t("kickPageContextRecoverySuccessesTitle")}
                description={t("kickPageContextRecoverySuccessesDescription")}
                value={settings.kickPageContextRecoverySuccesses}
                min={1}
                max={10}
                suffix={t("cyclesSuffix")}
                disabled={!settings.platform.kick.enabled}
                disabledReason={t("kickPageContextRecoverySuccessesDisabledReason")}
                onChange={(value) => void onSettingsChange(
                  { kickPageContextRecoverySuccesses: value },
                  { tickAfterSave: true },
                )}
              />
            ),
          },
          {
            id: "general.advanced.postClaimHandoff",
            titleKey: "postClaimHandoffTitle",
            descriptionKey: "postClaimHandoffDescription",
            render: () => <SettingRow title={t("postClaimHandoffTitle")} description={t("postClaimHandoffDescription")} checked={settings.postClaimHandoff} onChange={setFlag("postClaimHandoff")} />,
          },
          {
            id: "general.advanced.postClaimHandoffInterval",
            titleKey: "postClaimHandoffIntervalTitle",
            descriptionKey: "postClaimHandoffIntervalDescription",
            render: () => <NumberSettingRow title={t("postClaimHandoffIntervalTitle")} description={t("postClaimHandoffIntervalDescription")} value={settings.postClaimHandoffIntervalSeconds} min={1} max={30} suffix={t("secondsSuffix")} disabled={!settings.postClaimHandoff} disabledReason={t("postClaimHandoffDescription")} onChange={(value) => void onSettingsChange({ postClaimHandoffIntervalSeconds: value })} />,
          },
          {
            id: "general.advanced.postClaimHandoffMax",
            titleKey: "postClaimHandoffMaxTitle",
            descriptionKey: "postClaimHandoffMaxDescription",
            render: () => <NumberSettingRow title={t("postClaimHandoffMaxTitle")} description={t("postClaimHandoffMaxDescription")} value={settings.postClaimHandoffMaxSeconds} min={5} max={120} suffix={t("secondsSuffix")} disabled={!settings.postClaimHandoff} disabledReason={t("postClaimHandoffDescription")} onChange={(value) => void onSettingsChange({ postClaimHandoffMaxSeconds: value })} />,
          },
          {
            id: "general.advanced.deadlineSafetyMargin",
            titleKey: "deadlineSafetyMarginTitle",
            descriptionKey: "deadlineSafetyMarginDescription",
            render: () => <NumberSettingRow title={t("deadlineSafetyMarginTitle")} description={t("deadlineSafetyMarginDescription")} value={settings.deadlineSafetyMarginMinutes} min={0} max={60} suffix={t("minutesSuffix")} onChange={(value) => void onSettingsChange({ deadlineSafetyMarginMinutes: value }, { tickAfterSave: true })} disabled={!settings.skipUnfinishableRewards} disabledReason={t("deadlineSafetyMarginDisabledReason")} />,
          },
          {
            id: "general.advanced.diagnosticLogging",
            titleKey: "diagnosticLoggingTitle",
            descriptionKey: "diagnosticLoggingDescription",
            render: () => <SettingRow title={t("diagnosticLoggingTitle")} description={t("diagnosticLoggingDescription")} checked={settings.diagnosticLogging} onChange={setFlag("diagnosticLogging")} />,
          },
        ],
      },
    ],
  };

  const platformSection = (platform: Platform): SettingsSectionDef => {
    const details = PLATFORMS[platform];

    const claimEntry: SettingsEntryDef = platform === "twitch"
      ? {
        id: "twitch.autoClaimChannelPoints",
        titleKey: "autoClaimChannelPointsTitle",
        descriptionKey: "autoClaimChannelPointsDescription",
        render: () => <SettingRow title={t("autoClaimChannelPointsTitle")} description={t("autoClaimChannelPointsDescription")} checked={settings.platform.twitch.autoClaimChannelPoints} onChange={(value) => void onSettingsChange({ platform: { twitch: { autoClaimChannelPoints: value } } })} />,
      }
      : {
        id: "kick.autoClaimChallenges",
        titleKey: "autoClaimChallengesTitle",
        descriptionKey: "autoClaimChallengesDescription",
        render: () => <SettingRow title={t("autoClaimChallengesTitle")} description={t("autoClaimChallengesDescription")} checked={settings.platform.kick.autoClaimChallenges} onChange={(value) => void onSettingsChange({ platform: { kick: { autoClaimChallenges: value } } })} />,
      };

    const groups: SettingsGroupDef[] = [
      {
        id: `${platform}.categories`,
        titleKey: "settingsGroupCategories",
        // No description: the mode row directly below carries its own. The count
        // only means anything while the list is actually being consulted, which
        // is both filtered modes but not "all".
        badge: settings.platform[platform].categoryMode === "all"
          ? undefined
          : <Pill tone="outline">{settings.platform[platform].categories.length}</Pill>,
        entries: [
          {
            id: `${platform}.categories.mode`,
            titleKey: "categoryModeTitle",
            descriptionKey: "categoryModeDescription",
            // "Choose which $1 categories…" — without this the search haystack
            // holds the literal "$1" instead of "Twitch"/"Kick", and a query for
            // the platform name never finds this entry.
            descriptionSubstitution: details.label,
            render: () => (
              <PlatformCategorySettings
                platform={platform}
                suggestions={ctx.suggestions[platform]}
                settings={settings}
                // Rides the same platformPatch path as every other per-platform
                // setting, so a mode change invalidates the current target
                // through the existing tickAfterSave lifecycle.
                onCategoryModeChange={(categoryMode) => void platformPatch(platform, { categoryMode })}
                onCategoriesChange={(categories) => void platformPatch(platform, { categories })}
                onSearchCategories={(query) => ctx.onSearchCategories(platform, query)}
              />
            ),
          },
        ],
      },
      {
        id: `${platform}.channels`,
        titleKey: "settingsGroupExcludedChannels",
        description: t("excludedChannelsDescription"),
        badge: <Pill tone="outline">{(settings.platform[platform].excludedChannels ?? []).length}</Pill>,
        entries: [
          {
            id: `${platform}.channels.excluded`,
            titleKey: "excludedChannelsTitle",
            descriptionKey: "excludedChannelsDescription",
            render: () => (
              <PlatformExcludedChannels
                platform={platform}
                settings={settings}
                onExcludedChannelsChange={(excludedChannels) => void platformPatch(platform, { excludedChannels })}
              />
            ),
          },
        ],
      },
    ];

    // Both platforms end in one advanced group with the same title, so the two
    // platform sections read the same way. It is named "Advanced &
    // compatibility" rather than the General section's plain "Advanced" so the
    // two are told apart on sight: General tunes the scheduler, this one tunes
    // one platform. The subtitle is per-platform because the contents differ —
    // Twitch adds a farming toggle and has three compatibility components to
    // Kick's two — and three sections sharing one subtitle read as the same
    // section repeated. Twitch's group exists whether or not a compatibility
    // registry was supplied; Kick's holds the compatibility editor alone.
    const advancedEntries: SettingsEntryDef[] = platform === "twitch"
      ? [{
        id: "twitch.advanced.strictCampaignAvailability",
        titleKey: "strictCampaignAvailabilityTitle",
        descriptionKey: "strictCampaignAvailabilityDescription",
        render: () => (
          <SettingRow
            title={t("strictCampaignAvailabilityTitle")}
            description={t("strictCampaignAvailabilityDescription")}
            checked={settings.platform.twitch.strictCampaignAvailability}
            onChange={(value) => void platformPatch("twitch", { strictCampaignAvailability: value })}
          />
        ),
      }]
      : [];

    if (ctx.compatibilityRegistry && ctx.compatibilityResolution) {
      const compatibilityRegistry = ctx.compatibilityRegistry;
      const compatibilityResolution = ctx.compatibilityResolution;
      advancedEntries.push({
        id: `${platform}.compatibility.rows`,
        titleKey: "compatibilitySectionTitle",
        descriptionKey: "compatibilitySectionDescription",
        render: () => (
          <PlatformCompatibilitySettings
            platform={platform}
            settings={settings.compatibility}
            registry={compatibilityRegistry}
            resolution={compatibilityResolution}
            onChange={(patch) => void onSettingsChange(patch)}
          />
        ),
      });
    }

    if (advancedEntries.length > 0) {
      groups.push({
        id: `${platform}.advanced`,
        titleKey: "settingsGroupPlatformAdvanced",
        description: t(platform === "twitch" ? "twitchAdvancedDescription" : "kickAdvancedDescription"),
        advanced: true,
        entries: advancedEntries,
      });
    }

    return {
      id: platform,
      description: t(platform === "twitch" ? "twitchSectionDescription" : "kickSectionDescription"),
      rows: [claimEntry],
      groups,
    };
  };

  return [
    general,
    platformSection("twitch"),
    platformSection("kick"),
  ];
}
