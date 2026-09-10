import { describe, expect, it } from "vitest";
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION_KEY,
  UnsupportedSettingsVersionError,
  migrateSettings,
  withSchemaVersion,
} from "@lurkloot/shared/settingsSchema";

describe("settings schema versions", () => {
  it("treats an unversioned object as version 0", () => {
    const result = migrateSettings({ autoClaim: false });
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(result.changed).toBe(true);
  });

  it("treats a missing or non-object payload as an empty version 0 document", () => {
    for (const raw of [undefined, null, "nope", 42, ["a"]]) {
      const result = migrateSettings(raw);
      expect(result.settings).toEqual({ criticalFailurePromptEnabled: true });
      expect(result.fromVersion).toBe(0);
      expect(result.diagnostics).toEqual([]);
    }
  });

  it("is a no-op for a current-version document", () => {
    const stored = withSchemaVersion({ autoClaim: false });
    const result = migrateSettings(stored);
    expect(result.changed).toBe(false);
    expect(result.fromVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(result.diagnostics).toEqual([]);
    expect(result.settings).toEqual({ autoClaim: false });
  });

  it("strips the reserved schemaVersion property from the migrated payload", () => {
    const result = migrateSettings(withSchemaVersion({ autoClaim: true }));
    expect(result.settings).not.toHaveProperty(SETTINGS_SCHEMA_VERSION_KEY);
  });

  it("never mutates its input", () => {
    const stored = { watchQueueFallbackOnly: false, platform: { twitch: { watchQueueChannels: ["A"] } } };
    const snapshot = structuredClone(stored);
    migrateSettings(stored);
    expect(stored).toEqual(snapshot);
  });

  it("is idempotent when re-run on its own output", () => {
    const first = migrateSettings({ watchQueueFallbackOnly: false });
    const second = migrateSettings(withSchemaVersion(first.settings));
    expect(second.settings).toEqual(first.settings);
    expect(second.changed).toBe(false);
  });

  it("rejects a future schema version", () => {
    const future = CURRENT_SETTINGS_SCHEMA_VERSION + 1;
    expect(() => migrateSettings({ [SETTINGS_SCHEMA_VERSION_KEY]: future }))
      .toThrow(UnsupportedSettingsVersionError);
    try {
      migrateSettings({ [SETTINGS_SCHEMA_VERSION_KEY]: future });
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSettingsVersionError);
      expect((error as UnsupportedSettingsVersionError).version).toBe(future);
      expect((error as UnsupportedSettingsVersionError).reason).toBe("future");
    }
  });

  it("rejects a malformed schema version", () => {
    for (const version of [-1, 1.5, Number.NaN, "1", null]) {
      expect(() => migrateSettings({ [SETTINGS_SCHEMA_VERSION_KEY]: version }))
        .toThrow(UnsupportedSettingsVersionError);
    }
  });

  it("stamps the current version with withSchemaVersion", () => {
    expect(withSchemaVersion({ autoClaim: true })).toEqual({
      autoClaim: true,
      [SETTINGS_SCHEMA_VERSION_KEY]: CURRENT_SETTINGS_SCHEMA_VERSION,
    });
  });

  it("upgrades a version 0 document all the way to the current version", () => {
    // Guards sequential application: whatever CURRENT_SETTINGS_SCHEMA_VERSION
    // becomes, entering at 0 must land on it. The contiguity of the registry
    // itself is asserted at module load, so a missing step throws on import
    // rather than letting a host write a half-migrated document.
    expect(migrateSettings({}).toVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(migrateSettings({}).fromVersion).toBe(0);
  });

  it("enters at every intermediate version without skipping steps", () => {
    // Re-migrating from each supported version must converge on the same
    // document as migrating the whole way from 0.
    const target = migrateSettings({ autoClaim: false }).settings;
    for (let version = 0; version <= CURRENT_SETTINGS_SCHEMA_VERSION; version += 1) {
      const result = migrateSettings({ ...target, [SETTINGS_SCHEMA_VERSION_KEY]: version });
      expect(result.settings).toEqual(target);
      expect(result.toVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    }
  });
});

describe("migration 1: legacy aliases", () => {
  it("renames the Watch Queue properties", () => {
    const result = migrateSettings({
      watchQueueFallbackOnly: false,
      platform: {
        twitch: { watchQueueChannels: ["Legacy"] },
        kick: { watchQueueChannels: ["KickLegacy"] },
      },
    });
    expect(result.settings).toEqual({
      idleWatchlistFallbackOnly: false,
      criticalFailurePromptEnabled: true,
      platform: {
        twitch: { idleWatchlistChannels: ["Legacy"] },
        kick: { idleWatchlistChannels: ["KickLegacy"] },
      },
    });
    expect(result.settings).not.toHaveProperty("watchQueueFallbackOnly");
  });

  it("moves a top-level autoClaimChannelPoints onto platform.twitch", () => {
    const result = migrateSettings({ autoClaimChannelPoints: false });
    expect(result.settings).toEqual({ platform: { twitch: { autoClaimChannelPoints: false } }, criticalFailurePromptEnabled: true });
    expect(result.diagnostics).toContainEqual({
      code: "moved_property",
      path: "autoClaimChannelPoints",
      replacement: "platform.twitch.autoClaimChannelPoints",
      message: "autoClaimChannelPoints moved to platform.twitch.autoClaimChannelPoints",
    });
  });

  it("renames verboseLogging to diagnosticLogging", () => {
    expect(migrateSettings({ verboseLogging: true }).settings).toEqual({ diagnosticLogging: true, criticalFailurePromptEnabled: true });
    expect(migrateSettings({ verboseLogging: false }).settings).toEqual({ diagnosticLogging: false, criticalFailurePromptEnabled: true });
  });

  it("drops an unhomeable legacy autoClaimChannelPoints when platform is not an object", () => {
    // The value cannot be rehomed into a corrupt platform block, and leaving it
    // at the top level would be dead data. Normalization defaults the whole
    // corrupt block anyway, so this is consistent, not a meaningful loss. The
    // malformed platform is left verbatim for each host to surface.
    const result = migrateSettings({ autoClaimChannelPoints: false, platform: "nope" });
    expect(result.settings).toEqual({ platform: "nope", criticalFailurePromptEnabled: true });
    expect(result.diagnostics).toEqual([]);
  });

  it("drops an unhomeable legacy autoClaimChannelPoints when platform.twitch is not an object", () => {
    const result = migrateSettings({ autoClaimChannelPoints: false, platform: { twitch: null } });
    expect(result.settings).toEqual({ platform: { twitch: null }, criticalFailurePromptEnabled: true });
    expect(result.diagnostics).toEqual([]);
  });

  it("lets a wrong-typed current value win over a legacy one", () => {
    // Deliberate: migrations never inspect types, so normalization sees the
    // wrong-typed current value and applies its default. The pre-registry
    // inline fallbacks instead fell through to the legacy value here.
    const logging = migrateSettings({ diagnosticLogging: "yes", verboseLogging: true });
    expect(logging.settings).toEqual({ diagnosticLogging: "yes", criticalFailurePromptEnabled: true });
    expect(logging.diagnostics.map((d) => d.path)).toEqual(["verboseLogging"]);

    const points = migrateSettings({
      autoClaimChannelPoints: false,
      platform: { twitch: { autoClaimChannelPoints: "yes" } },
    });
    expect(points.settings).toEqual({ platform: { twitch: { autoClaimChannelPoints: "yes" } }, criticalFailurePromptEnabled: true });
    expect(points.diagnostics.map((d) => d.path)).toEqual(["autoClaimChannelPoints"]);
  });

  it("keeps a non-boolean legacy value verbatim so normalization decides", () => {
    // mergeSettings applies booleanOr afterwards; the migration only reshapes.
    expect(migrateSettings({ autoClaimChannelPoints: "yes" }).settings)
      .toEqual({ platform: { twitch: { autoClaimChannelPoints: "yes" } }, criticalFailurePromptEnabled: true });
  });

  it("lets the current property win while still reporting the deprecated one", () => {
    const result = migrateSettings({
      idleWatchlistFallbackOnly: true,
      watchQueueFallbackOnly: false,
      diagnosticLogging: false,
      verboseLogging: true,
      autoClaimChannelPoints: false,
      platform: {
        twitch: { idleWatchlistChannels: [], watchQueueChannels: ["legacy"], autoClaimChannelPoints: true },
        kick: { idleWatchlistChannels: ["new"], watchQueueChannels: ["legacy"] },
      },
    });
    expect(result.settings).toEqual({
      idleWatchlistFallbackOnly: true,
      diagnosticLogging: false,
      criticalFailurePromptEnabled: true,
      platform: {
        twitch: { idleWatchlistChannels: [], autoClaimChannelPoints: true },
        kick: { idleWatchlistChannels: ["new"] },
      },
    });
    expect(result.diagnostics.map((d) => d.path)).toEqual([
      "watchQueueFallbackOnly",
      "verboseLogging",
      "autoClaimChannelPoints",
      "platform.twitch.watchQueueChannels",
      "platform.kick.watchQueueChannels",
    ]);
  });

  it("emits a stable, deduplicated diagnostic per deprecated property", () => {
    const result = migrateSettings({ watchQueueFallbackOnly: false });
    expect(result.diagnostics).toEqual([{
      code: "deprecated_property",
      path: "watchQueueFallbackOnly",
      replacement: "idleWatchlistFallbackOnly",
      message: "watchQueueFallbackOnly is deprecated; use idleWatchlistFallbackOnly",
    }]);
  });

  it("reports nothing for a payload that only uses current names", () => {
    const result = migrateSettings({
      idleWatchlistFallbackOnly: true,
      platform: { twitch: { idleWatchlistChannels: ["a"] } },
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.changed).toBe(true); // unversioned input still gets stamped
  });

  it("leaves unrelated and malformed platform blocks alone", () => {
    expect(migrateSettings({ platform: "nope", other: 1 }).settings).toEqual({ platform: "nope", other: 1, criticalFailurePromptEnabled: true });
    expect(migrateSettings({ platform: { twitch: null } }).settings).toEqual({ platform: { twitch: null }, criticalFailurePromptEnabled: true });
  });
});

describe("schema v2", () => {
  it("moves all six display keys of campaignVisibility into dropsListFilter", () => {
    // campaignVisibility was DISPLAY-ONLY in the shipped release. All six keys —
    // including notLinked/subscription, which dropsListFilter now expresses as
    // showNotLinked/showSubscription — carry over as display preferences.
    // farmingEligibility is NEVER produced here, so normalization defaults both
    // farming flags on. A false value survives verbatim.
    const result = migrateSettings({
      schemaVersion: 1,
      campaignVisibility: {
        notLinked: false,
        subscription: true,
        upcoming: false,
        expired: true,
        finished: false,
        excluded: true,
      },
    });

    expect(result.settings.dropsListFilter).toEqual({
      showUpcoming: false,
      showExpired: true,
      showFinished: false,
      showExcluded: true,
      showNotLinked: false,
      showSubscription: true,
    });
    // The migration never derives farming eligibility from a display-only
    // setting; normalization defaults both flags to on.
    expect(result.settings.farmingEligibility).toBeUndefined();
    expect(result.settings.campaignVisibility).toBeUndefined();
    expect(result.toVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(result.changed).toBe(true);
    expect(result.diagnostics).toContainEqual({
      code: "moved_property",
      path: "campaignVisibility",
      replacement: "dropsListFilter",
      message: "campaignVisibility display preferences moved to dropsListFilter; farming eligibility is controlled separately and defaults to on",
    });
  });

  it("never carries a legacy notLinked display preference into farming eligibility", () => {
    // Guard for the migration-safety fix: a user who had merely hidden unlinked
    // campaigns from their list must keep farming them. farmUnlinkedCampaigns is
    // NOT derived from notLinked; farmingEligibility stays absent so it defaults
    // to on. The notLinked display preference IS preserved — as the display flag
    // showNotLinked, never as a farming flag. If the old notLinked -> farming
    // mapping returns, this fails.
    const result = migrateSettings({
      schemaVersion: 1,
      campaignVisibility: { notLinked: false, subscription: false },
    });

    expect(result.settings.farmingEligibility).toBeUndefined();
    // The two class keys are display preferences, preserved on dropsListFilter.
    expect(result.settings.dropsListFilter).toEqual({
      showNotLinked: false,
      showSubscription: false,
    });
    // The move is still reported.
    expect(result.diagnostics.map((d) => d.path)).toContain("campaignVisibility");
  });

  it("carries over only the lifecycle keys present, leaving the rest for normalization", () => {
    const result = migrateSettings({
      schemaVersion: 1,
      campaignVisibility: { expired: true },
    });

    expect(result.settings.dropsListFilter).toEqual({ showExpired: true });
    expect(result.settings.farmingEligibility).toBeUndefined();
  });

  it("leaves a document that never had the key alone", () => {
    const result = migrateSettings({ schemaVersion: 1, autoClaim: false });

    expect(result.settings.farmingEligibility).toBeUndefined();
    expect(result.settings.dropsListFilter).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  it("drops a non-object campaignVisibility without writing garbage", () => {
    const result = migrateSettings({ schemaVersion: 1, campaignVisibility: "nonsense" });

    expect(result.settings.campaignVisibility).toBeUndefined();
    expect(result.settings.farmingEligibility).toBeUndefined();
    expect(result.settings.dropsListFilter).toBeUndefined();
  });

  it("drops a stray interim campaignFilters key that never shipped", () => {
    const result = migrateSettings({ schemaVersion: 1, campaignFilters: { notLinked: false } });

    expect(result.settings.campaignFilters).toBeUndefined();
  });
});

describe("schema v4", () => {
  it("drops the running flag and keeps enabled platforms farming when it was on", () => {
    const migrated = migrateSettings({
      schemaVersion: 3,
      running: true,
      platform: { twitch: { enabled: true }, kick: { enabled: true } },
    });

    expect(migrated.settings.running).toBeUndefined();
    expect(migrated.settings.platform).toMatchObject({
      twitch: { enabled: true },
      kick: { enabled: true },
    });
    expect(migrated.toVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
  });

  // The popup rendered `running && enabled`, so a stored `running: false` showed
  // every platform as off. Carrying the enabled flags across unchanged would
  // start farming on upgrade for platforms the user last saw switched off.
  it("switches every platform off when automation was off, whatever the flags said", () => {
    const migrated = migrateSettings({
      schemaVersion: 3,
      running: false,
      platform: { twitch: { enabled: true }, kick: { enabled: true } },
    });

    expect(migrated.settings.running).toBeUndefined();
    expect(migrated.settings.platform).toMatchObject({
      twitch: { enabled: false },
      kick: { enabled: false },
    });
    expect(migrated.diagnostics).toContainEqual(expect.objectContaining({
      code: "deprecated_property",
      path: "running",
    }));
  });

  it("reports nothing when automation was off and the platforms already were", () => {
    const migrated = migrateSettings({
      schemaVersion: 3,
      running: false,
      platform: { twitch: { enabled: false }, kick: { enabled: false } },
    });

    expect(migrated.diagnostics.filter((diagnostic) => diagnostic.path === "running")).toEqual([]);
  });

  it("leaves a document without the flag untouched", () => {
    const migrated = migrateSettings({
      schemaVersion: 3,
      platform: { twitch: { enabled: true }, kick: { enabled: false } },
    });

    expect(migrated.settings.platform).toMatchObject({
      twitch: { enabled: true },
      kick: { enabled: false },
    });
  });
});

describe("schema v3", () => {
  it("adds the critical failure prompt toggle at version 3", () => {
    const migrated = migrateSettings({ schemaVersion: 2, running: true });

    expect(migrated.settings.criticalFailurePromptEnabled).toBe(true);
    expect(migrated.toVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
  });

  it("preserves an explicit opt-out through migration", () => {
    const migrated = migrateSettings({ schemaVersion: 2, criticalFailurePromptEnabled: false });

    expect(migrated.settings.criticalFailurePromptEnabled).toBe(false);
  });
});

describe("schema v5", () => {
  const CATEGORIES = [
    { id: "13", name: "Rust" },
    { id: "21", name: "Other" },
  ];

  it("maps an explicit farm-all off to include mode, preserving the list and its order", () => {
    const migrated = migrateSettings({
      schemaVersion: 4,
      platform: { twitch: { farmAllCategories: false, categories: CATEGORIES } },
    });

    expect(migrated.settings.platform).toMatchObject({
      twitch: { categoryMode: "include", categories: CATEGORIES },
    });
    expect((migrated.settings.platform as Record<string, Record<string, unknown>>).twitch.farmAllCategories).toBeUndefined();
    expect(migrated.diagnostics).toContainEqual(expect.objectContaining({
      code: "deprecated_property",
      path: "platform.twitch.farmAllCategories",
      replacement: "platform.twitch.categoryMode",
    }));
  });

  it("maps farm-all on to all mode on both platforms", () => {
    const migrated = migrateSettings({
      schemaVersion: 4,
      platform: { twitch: { farmAllCategories: true }, kick: { farmAllCategories: true } },
    });

    expect(migrated.settings.platform).toMatchObject({
      twitch: { categoryMode: "all" },
      kick: { categoryMode: "all" },
    });
  });

  // The old normalizer read the boolean as booleanOr(value, true), so anything
  // that was not exactly `false` already meant farm-all.
  it("treats a wrong-typed legacy value the way the old normalizer did", () => {
    const migrated = migrateSettings({
      schemaVersion: 4,
      platform: { kick: { farmAllCategories: "no" } },
    });

    expect(migrated.settings.platform).toMatchObject({ kick: { categoryMode: "all" } });
  });

  it("lets an already-current key win over the legacy one", () => {
    const migrated = migrateSettings({
      schemaVersion: 4,
      platform: { twitch: { farmAllCategories: false, categoryMode: "exclude" } },
    });

    expect(migrated.settings.platform).toMatchObject({ twitch: { categoryMode: "exclude" } });
  });

  it("leaves a document without the legacy key untouched and reports nothing", () => {
    const migrated = migrateSettings({
      schemaVersion: 4,
      platform: { twitch: { categories: CATEGORIES } },
    });

    expect(migrated.settings.platform).toMatchObject({ twitch: { categories: CATEGORIES } });
    expect((migrated.settings.platform as Record<string, Record<string, unknown>>).twitch.categoryMode).toBeUndefined();
    expect(migrated.diagnostics.filter((diagnostic) => diagnostic.path.endsWith("farmAllCategories"))).toEqual([]);
  });
});
