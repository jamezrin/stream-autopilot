import { describe, expect, it } from "vitest";
import { applySettingsPatch, DEFAULT_ENGINE_SETTINGS, DEFAULT_SETTINGS, mergeEngineSettings, mergeSettings } from "@lurkloot/shared/settings";
import { migrateSettings } from "@lurkloot/shared/settingsSchema";

describe("engine settings", () => {
  // The tab-policy fields (mute / keep-unmuted / auto-close / ad focus) and the
  // pure-UI fields are host-only: the engine reads none of them, so they must not
  // appear on the EngineSettings contract.
  const HOST_ONLY_FIELDS = [
    "muteFarmingTabs",
    "keepFarmingVideosUnmuted",
    "autoCloseFinishedDrops",
    "adFocusMode",
    "languageOverride",
    "rateNudgeStatus",
    "githubStarNudgeStatus",
    "diagnosticLogging",
    "dropsListFilter",
  ] as const;

  it("normalizes the engine contract without the host-only fields", () => {
    const engine = mergeEngineSettings({ pollIntervalMinutes: 5 });
    expect(engine.pollIntervalMinutes).toBe(5);
    expect(engine.platform.twitch).toBeDefined();
    for (const field of HOST_ONLY_FIELDS) expect(field in engine).toBe(false);
  });

  it("layers host-only fields on top of the engine defaults", () => {
    // The extension defaults are the engine defaults plus the host-only fields.
    expect(DEFAULT_SETTINGS).toMatchObject(DEFAULT_ENGINE_SETTINGS);
    for (const field of HOST_ONLY_FIELDS) expect(field in DEFAULT_SETTINGS).toBe(true);
    expect(DEFAULT_SETTINGS.adFocusMode).toBe("window");
    expect(DEFAULT_SETTINGS.languageOverride).toBe("browser");
    expect(DEFAULT_SETTINGS.rateNudgeStatus).toBe("pending");
    expect(DEFAULT_SETTINGS.githubStarNudgeStatus).toBe("pending");
  });
});

describe("settings", () => {
  it("ignores legacy property names, which the migration registry handles first", () => {
    const merged = mergeSettings({
      watchQueueFallbackOnly: false,
      verboseLogging: true,
      autoClaimChannelPoints: false,
      platform: { ...DEFAULT_SETTINGS.platform, twitch: { ...DEFAULT_SETTINGS.platform.twitch, watchQueueChannels: ["legacy"] } },
    } as never);
    expect(merged.idleWatchlistFallbackOnly).toBe(DEFAULT_SETTINGS.idleWatchlistFallbackOnly);
    // verboseLogging is not read here; the default applies.
    expect(merged.diagnosticLogging).toBe(true);
    expect(merged.platform.twitch.autoClaimChannelPoints).toBe(true);
    expect(merged.platform.twitch.idleWatchlistChannels).toEqual([]);
    expect(merged).not.toHaveProperty("watchQueueFallbackOnly");
  });

  it("defaults compatibility selections to automatic detection", () => {
    expect(mergeSettings(undefined).compatibility).toEqual({
      twitch: { profile: "auto", heartbeatTransport: "auto", inventoryQueryVersion: "auto" },
      kick: { profile: "auto", claimLinkHandling: "auto" },
    });
  });

  it("preserves bundled compatibility identifiers and normalizes invalid selections", () => {
    const settings = mergeSettings({ compatibility: {
      twitch: { profile: "twitch-2026-07", heartbeatTransport: "twitch-heartbeat-gql-v1", inventoryQueryVersion: "auto" },
      kick: { profile: "kick-2026-07", claimLinkHandling: "kick-claim-v1" },
    } } as never);
    expect(settings.compatibility.twitch.profile).toBe("twitch-2026-07");
    expect(settings.compatibility.twitch.heartbeatTransport).toBe("twitch-heartbeat-gql-v1");
    expect(settings.compatibility.kick).toEqual({ profile: "kick-2026-07", claimLinkHandling: "kick-claim-v1" });

    expect(mergeSettings({ compatibility: {
      twitch: { profile: "  ", heartbeatTransport: 42, inventoryQueryVersion: " twitch-inventory-v1 " },
      kick: { profile: null, claimLinkHandling: " kick-claim-v1 " },
    } } as never).compatibility).toEqual({
      twitch: { profile: "auto", heartbeatTransport: "auto", inventoryQueryVersion: "twitch-inventory-v1" },
      kick: { profile: "auto", claimLinkHandling: "kick-claim-v1" },
    });
  });

  it("applies partial compatibility patches without erasing sibling selections", () => {
    const current = mergeSettings({ compatibility: {
      twitch: { profile: "twitch-2026-07", heartbeatTransport: "twitch-heartbeat-gql-v1", inventoryQueryVersion: "twitch-inventory-v1" },
      kick: { profile: "kick-2026-07", claimLinkHandling: "kick-claim-v1" },
    } } as never);

    const settings = applySettingsPatch(current, {
      compatibility: { twitch: { heartbeatTransport: "auto" } },
    });

    expect(settings.compatibility).toEqual({
      twitch: { profile: "twitch-2026-07", heartbeatTransport: "auto", inventoryQueryVersion: "twitch-inventory-v1" },
      kick: { profile: "kick-2026-07", claimLinkHandling: "kick-claim-v1" },
    });
  });

  it("defaults mockup popup settings", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      muteFarmingTabs: true,
      keepFarmingVideosUnmuted: true,
      pauseOnManualWatch: true,
      autoCloseFinishedDrops: true,
      notifyRewardEarned: true,
      notifyNoDropsLeft: true,
      autoStartDropFarming: true,
      showTips: true,
      languageOverride: "browser",
      idleWatchlistFallbackOnly: true,
      pollIntervalMinutes: 1,
      diagnosticLogging: true,
      platform: {
        twitch: { excludedChannels: [], categoryMode: "all", categories: [] },
        kick: { excludedChannels: [], categoryMode: "all", categories: [] },
      },
    });
  });

  it("shows popup tips by default and preserves an explicit hidden preference", () => {
    expect(mergeSettings(undefined).showTips).toBe(true);
    expect(mergeSettings({ showTips: false }).showTips).toBe(false);
    expect(mergeSettings({ showTips: "no" } as never).showTips).toBe(true);
  });

  it("defaults the drops list view flags while preserving persisted choices", () => {
    expect(DEFAULT_SETTINGS.dropsListFilter).toEqual({
      showUpcoming: true,
      showExpired: false,
      showFinished: true,
      showExcluded: false,
      showNotLinked: true,
      showSubscription: true,
    });
    // A partial persisted record fills the rest from defaults.
    expect(mergeSettings({ dropsListFilter: { showExpired: true } } as never).dropsListFilter).toEqual({
      showUpcoming: true,
      showExpired: true,
      showFinished: true,
      showExcluded: false,
      showNotLinked: true,
      showSubscription: true,
    });
  });

  it("clamps persisted numeric settings to browser-safe ranges", () => {
    expect(mergeSettings({ pollIntervalMinutes: 0, offlineRetryLimit: 0 }).pollIntervalMinutes).toBe(1);
    expect(mergeSettings({ pollIntervalMinutes: 0.75 }).pollIntervalMinutes).toBe(1);
    expect(mergeSettings({ pollIntervalMinutes: 90, offlineRetryLimit: 99 }).pollIntervalMinutes).toBe(60);
    expect(mergeSettings({ pollIntervalMinutes: Number.NaN, offlineRetryLimit: Number.NaN }).pollIntervalMinutes)
      .toBe(DEFAULT_SETTINGS.pollIntervalMinutes);
    expect(mergeSettings({ offlineRetryLimit: Number.NaN }).offlineRetryLimit).toBe(DEFAULT_SETTINGS.offlineRetryLimit);
    expect(mergeSettings({}).kickPageContextRecoverySuccesses).toBe(3);
    expect(mergeSettings({ kickPageContextRecoverySuccesses: 0 } as never).kickPageContextRecoverySuccesses).toBe(1);
    expect(mergeSettings({ kickPageContextRecoverySuccesses: 11 } as never).kickPageContextRecoverySuccesses).toBe(10);
    expect(mergeSettings({ kickPageContextRecoverySuccesses: 4.6 } as never).kickPageContextRecoverySuccesses).toBe(5);
    expect(mergeSettings({ kickPageContextRecoverySuccesses: Number.NaN } as never).kickPageContextRecoverySuccesses).toBe(3);

    expect(DEFAULT_ENGINE_SETTINGS.tablessFallbackFailureLimit).toBe(5);
    expect(mergeEngineSettings({}).tablessFallbackFailureLimit).toBe(5);
    expect(mergeEngineSettings({ tablessFallbackFailureLimit: 0 }).tablessFallbackFailureLimit).toBe(1);
    expect(mergeEngineSettings({ tablessFallbackFailureLimit: 11 }).tablessFallbackFailureLimit).toBe(10);
    expect(mergeEngineSettings({ tablessFallbackFailureLimit: 4.6 }).tablessFallbackFailureLimit).toBe(5);
    expect(mergeEngineSettings({ tablessFallbackFailureLimit: Number.NaN }).tablessFallbackFailureLimit).toBe(5);
    expect(mergeEngineSettings({
      offlineRetryLimit: 9,
      tablessFallbackFailureLimit: 2,
    })).toMatchObject({
      offlineRetryLimit: 9,
      tablessFallbackFailureLimit: 2,
    });
  });

  it("clamps post-claim handoff settings and defaults them when absent", () => {
    expect(mergeSettings({}).postClaimHandoff).toBe(true);
    expect(mergeSettings({}).postClaimHandoffIntervalSeconds).toBe(5);
    expect(mergeSettings({}).postClaimHandoffMaxSeconds).toBe(45);

    expect(mergeSettings({ postClaimHandoffIntervalSeconds: 0 }).postClaimHandoffIntervalSeconds).toBe(1);
    expect(mergeSettings({ postClaimHandoffIntervalSeconds: 99 }).postClaimHandoffIntervalSeconds).toBe(30);
    expect(mergeSettings({ postClaimHandoffMaxSeconds: 1 }).postClaimHandoffMaxSeconds).toBe(5);
    expect(mergeSettings({ postClaimHandoffMaxSeconds: 999 }).postClaimHandoffMaxSeconds).toBe(120);

    expect(mergeSettings({ postClaimHandoffIntervalSeconds: Number.NaN }).postClaimHandoffIntervalSeconds)
      .toBe(DEFAULT_SETTINGS.postClaimHandoffIntervalSeconds);
    expect(mergeSettings({ postClaimHandoffMaxSeconds: Number.NaN }).postClaimHandoffMaxSeconds)
      .toBe(DEFAULT_SETTINGS.postClaimHandoffMaxSeconds);
    expect(mergeSettings({ postClaimHandoff: false }).postClaimHandoff).toBe(false);
  });

  it("normalizes deadline filtering enablement and its safety margin independently", () => {
    expect(DEFAULT_ENGINE_SETTINGS.skipUnfinishableRewards).toBe(true);
    expect(DEFAULT_ENGINE_SETTINGS.deadlineSafetyMarginMinutes).toBe(5);
    expect(mergeEngineSettings({ skipUnfinishableRewards: false }).skipUnfinishableRewards).toBe(false);
    expect(mergeEngineSettings({ skipUnfinishableRewards: "no" } as never).skipUnfinishableRewards).toBe(true);
    expect(mergeEngineSettings({ deadlineSafetyMarginMinutes: -9 }).deadlineSafetyMarginMinutes).toBe(0);
    expect(mergeEngineSettings({ deadlineSafetyMarginMinutes: 0 }).deadlineSafetyMarginMinutes).toBe(0);
    expect(mergeEngineSettings({ deadlineSafetyMarginMinutes: 4.6 }).deadlineSafetyMarginMinutes).toBe(5);
    expect(mergeEngineSettings({ deadlineSafetyMarginMinutes: 99 }).deadlineSafetyMarginMinutes).toBe(60);
    expect(mergeEngineSettings({ deadlineSafetyMarginMinutes: Number.NaN }).deadlineSafetyMarginMinutes).toBe(5);
  });

  it("keeps diagnostic logging independent from the removed engine log-level setting", () => {
    expect(mergeSettings(undefined).diagnosticLogging).toBe(true);
    expect(mergeSettings({ diagnosticLogging: true }).diagnosticLogging).toBe(true);
    expect(mergeSettings({ diagnosticLogging: false, enabledLogLevels: ["debug"] } as never).diagnosticLogging).toBe(false);
    expect("enabledLogLevels" in mergeSettings({ enabledLogLevels: ["debug"] } as never)).toBe(false);
  });

  it("normalizes imported list, priority, mode, and boolean settings", () => {
    const settings = mergeSettings({
      running: "yes",
      keepFarmingVideosUnmuted: false,
      pauseOnManualWatch: "no",
      priorityMode: "bad",
      platform: {
        twitch: {
          enabled: "true",
          idleWatchlistChannels: [" Creator ", "", "creator"],
          excludedChannels: [" @SkipMe ", "skipme"],
          categories: [{ id: " Game-A ", name: " Game A " }, { id: "game-a", name: "Dup" }, { id: "", name: "blank" }],
        },
        kick: { enabled: false, idleWatchlistChannels: ["KickOne"], excludedChannels: ["KickSkip"], categories: [{ id: "cat-1", name: "Category" }] },
      },
      campaignPriorities: {
        " campaign ": 2.6,
        broken: Number.NaN,
      },
      excludedCampaignIds: [" Abc ", "abc", "Abc"],
    } as unknown as Parameters<typeof mergeSettings>[0]);

    expect(settings.keepFarmingVideosUnmuted).toBe(false);
    expect(settings.pauseOnManualWatch).toBe(DEFAULT_SETTINGS.pauseOnManualWatch);
    expect(settings.priorityMode).toBe(DEFAULT_SETTINGS.priorityMode);
    expect(settings.platform.twitch.enabled).toBe(DEFAULT_SETTINGS.platform.twitch.enabled);
    expect(settings.platform.twitch.idleWatchlistChannels).toEqual(["creator"]);
    expect(settings.platform.twitch.excludedChannels).toEqual(["skipme"]);
    // Categories: trimmed, deduped by lowercased id (order preserved), blanks dropped.
    expect(settings.platform.twitch.categories).toEqual([{ id: "Game-A", name: "Game A" }]);
    expect(settings.platform.kick.enabled).toBe(false);
    expect(settings.platform.kick.idleWatchlistChannels).toEqual(["kickone"]);
    expect(settings.platform.kick.excludedChannels).toEqual(["kickskip"]);
    expect(settings.platform.kick.categories).toEqual([{ id: "cat-1", name: "Category" }]);
    expect(settings.campaignPriorities).toEqual({ campaign: 3 });
    // Campaign ids are trimmed and deduped but kept case-sensitive so they match
    // campaign.id verbatim in the scheduler (unlike channel/game lists).
    expect(settings.excludedCampaignIds).toEqual(["Abc", "abc"]);
  });

  it("validates the ad focus mode", () => {
    expect(DEFAULT_SETTINGS.adFocusMode).toBe("window");
    expect(mergeSettings(undefined).adFocusMode).toBe("window");
    expect(mergeSettings({ adFocusMode: "tab" }).adFocusMode).toBe("tab");
    expect(mergeSettings({ adFocusMode: "none" }).adFocusMode).toBe("none");
    expect(mergeSettings({ adFocusMode: "sideways" } as unknown as Parameters<typeof mergeSettings>[0]).adFocusMode)
      .toBe("window");
  });

  it("validates the priority mode", () => {
    expect(DEFAULT_SETTINGS.priorityMode).toBe("ending_soonest");
    expect(mergeSettings(undefined).priorityMode).toBe("ending_soonest");
    expect(mergeSettings({ priorityMode: "lowest_availability" }).priorityMode).toBe("lowest_availability");
    expect(mergeSettings({ priorityMode: "priority_list_only" }).priorityMode).toBe("priority_list_only");
    expect(mergeSettings({ priorityMode: "nonsense" } as unknown as Parameters<typeof mergeSettings>[0]).priorityMode)
      .toBe("ending_soonest");
  });

  it("validates the rate nudge status", () => {
    expect(DEFAULT_SETTINGS.rateNudgeStatus).toBe("pending");
    expect(mergeSettings(undefined).rateNudgeStatus).toBe("pending");
    expect(mergeSettings({ rateNudgeStatus: "rated" }).rateNudgeStatus).toBe("rated");
    expect(mergeSettings({ rateNudgeStatus: "dismissed" }).rateNudgeStatus).toBe("dismissed");
    expect(mergeSettings({ rateNudgeStatus: "bogus" } as unknown as Parameters<typeof mergeSettings>[0]).rateNudgeStatus)
      .toBe("pending");
  });

  it("validates the github star nudge status", () => {
    expect(DEFAULT_SETTINGS.githubStarNudgeStatus).toBe("pending");
    expect(mergeSettings(undefined).githubStarNudgeStatus).toBe("pending");
    expect(mergeSettings({ githubStarNudgeStatus: "starred" }).githubStarNudgeStatus).toBe("starred");
    expect(mergeSettings({ githubStarNudgeStatus: "dismissed" }).githubStarNudgeStatus).toBe("dismissed");
    expect(mergeSettings({ githubStarNudgeStatus: "bogus" } as unknown as Parameters<typeof mergeSettings>[0]).githubStarNudgeStatus)
      .toBe("pending");
  });

  it("validates the language override", () => {
    expect(mergeSettings(undefined).languageOverride).toBe("browser");
    expect(mergeSettings({ languageOverride: "es" }).languageOverride).toBe("es");
    expect(mergeSettings({ languageOverride: "zh_CN" }).languageOverride).toBe("zh_CN");
    expect(mergeSettings({ languageOverride: "pt_BR" }).languageOverride).toBe("pt_BR");
    expect(mergeSettings({ languageOverride: "ar" }).languageOverride).toBe("ar");
    expect(mergeSettings({ languageOverride: "tr" }).languageOverride).toBe("tr");
    expect(mergeSettings({ languageOverride: "pt" } as unknown as Parameters<typeof mergeSettings>[0]).languageOverride)
      .toBe("browser");
  });

  it("preserves idle watchlist channel priority order while removing duplicates", () => {
    const settings = mergeSettings({
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, idleWatchlistChannels: ["third", "first", "second", "first"] },
        kick: { ...DEFAULT_SETTINGS.platform.kick, idleWatchlistChannels: [] },
      },
    });

    expect(settings.platform.twitch.idleWatchlistChannels).toEqual(["third", "first", "second"]);
  });

  it("defaults categoryMode to all and ignores the legacy gamePriority list", () => {
    const settings = mergeSettings({
      platform: {
        twitch: { enabled: true, idleWatchlistChannels: [], gamePriority: ["13", "rust"] },
        kick: { enabled: true, idleWatchlistChannels: [] },
      },
    } as unknown as Parameters<typeof mergeSettings>[0]);

    expect(settings.platform.twitch.categoryMode).toBe("all");
    expect(settings.platform.kick.categoryMode).toBe("all");
    // The legacy ordering list is dropped (it had no display names), so no bare
    // ids like "13" leak in as categories.
    expect(settings.platform.twitch.categories).toEqual([]);
    expect(settings.platform.kick.categories).toEqual([]);
  });

  it("keeps every valid category mode and falls back to all for an invalid one", () => {
    for (const categoryMode of ["all", "include", "exclude"] as const) {
      expect(mergeSettings({ platform: { twitch: { categoryMode } } } as never).platform.twitch.categoryMode)
        .toBe(categoryMode);
    }
    expect(mergeSettings({ platform: { kick: { categoryMode: "everything" } } } as never).platform.kick.categoryMode)
      .toBe("all");
    expect(mergeSettings({ platform: { kick: { categoryMode: false } } } as never).platform.kick.categoryMode)
      .toBe("all");
  });

  it("normalizes and dedupes the category list identically in every mode", () => {
    for (const categoryMode of ["all", "include", "exclude"] as const) {
      const settings = mergeSettings({
        platform: {
          twitch: {
            categoryMode,
            categories: [
              { id: " 13 ", name: " Rust " },
              { id: "13", name: "Rust duplicate" },
              { id: "", name: "No id" },
              { id: "21", name: "Other", imageUrl: "http://insecure.example/art.png" },
            ],
          },
        },
      } as never);

      expect(settings.platform.twitch.categories).toEqual([
        { id: "13", name: "Rust" },
        { id: "21", name: "Other" },
      ]);
    }
  });

  // The whole point of one shared list: an include ordering survives a round
  // trip through exclude untouched, so switching back restores the priority.
  it("preserves the stored list across mode switches", () => {
    const categories = [{ id: "13", name: "Rust" }, { id: "21", name: "Other" }];
    let settings = mergeSettings({ platform: { twitch: { categoryMode: "include", categories } } } as never);
    settings = applySettingsPatch(settings, { platform: { twitch: { categoryMode: "exclude" } } });
    expect(settings.platform.twitch.categories).toEqual(categories);
    settings = applySettingsPatch(settings, { platform: { twitch: { categoryMode: "include" } } });
    expect(settings.platform.twitch.categories).toEqual(categories);
  });

  // Migration then normalization is the pipeline every host runs on a stored
  // document, so an upgrading profile must come out farming the same set.
  it("carries a legacy allowlist through migration into an include-mode profile", () => {
    const categories = [{ id: "13", name: "Rust" }];
    const migrated = migrateSettings({
      schemaVersion: 4,
      platform: { twitch: { farmAllCategories: false, categories }, kick: { farmAllCategories: true } },
    });
    const settings = mergeSettings(migrated.settings as never);

    expect(settings.platform.twitch.categoryMode).toBe("include");
    expect(settings.platform.twitch.categories).toEqual(categories);
    expect(settings.platform.kick.categoryMode).toBe("all");
  });
});

describe("per-platform claim settings", () => {
  it("defaults autoClaimChannelPoints on for Twitch", () => {
    expect(mergeSettings(undefined).platform.twitch.autoClaimChannelPoints).toBe(true);
  });

  it("defaults autoClaimChallenges on for Kick", () => {
    expect(mergeSettings(undefined).platform.kick.autoClaimChallenges).toBe(true);
  });

  it("honors an explicit autoClaimChallenges of false", () => {
    const merged = mergeSettings({
      platform: { ...DEFAULT_SETTINGS.platform, kick: { ...DEFAULT_SETTINGS.platform.kick, autoClaimChallenges: false } },
    });
    expect(merged.platform.kick.autoClaimChallenges).toBe(false);
  });
});

describe("farmingEligibility in the engine contract", () => {
  it("defaults both eligibility flags on", () => {
    expect(DEFAULT_ENGINE_SETTINGS.farmingEligibility).toEqual({
      farmUnlinkedCampaigns: true,
      farmSubscriptionCampaigns: true,
    });
  });

  it("normalizes a partial eligibility record through the engine merge", () => {
    const merged = mergeEngineSettings({ farmingEligibility: { farmUnlinkedCampaigns: false } } as never);
    expect(merged.farmingEligibility.farmUnlinkedCampaigns).toBe(false);
    expect(merged.farmingEligibility.farmSubscriptionCampaigns).toBe(true);
  });

  it("keeps dropsListFilter off the engine contract", () => {
    expect("dropsListFilter" in mergeEngineSettings({})).toBe(false);
  });
});

describe("in-page panel default", () => {
  // On by default is a deliberate product call, not an oversight. The feature
  // exists for people who do not pin the extension and find the toolbar popup
  // awkward to reach; gating it behind a toggle inside that popup would only
  // ever reach the people who already open it comfortably. Flipping this to
  // false silently un-ships the feature for almost everyone, so it is pinned.
  it("shows the in-page panel unless the user turns it off", () => {
    expect(DEFAULT_SETTINGS.showInPagePanel).toBe(true);
    expect(mergeSettings(undefined).showInPagePanel).toBe(true);
    expect(mergeSettings({}).showInPagePanel).toBe(true);
  });

  it("respects an explicit opt-out", () => {
    expect(mergeSettings({ showInPagePanel: false }).showInPagePanel).toBe(false);
  });
});
