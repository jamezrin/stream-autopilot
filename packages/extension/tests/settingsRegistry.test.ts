import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { COMPATIBILITY_REGISTRY, resolveCompatibility } from "@lurkloot/core";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { buildSettingsRegistry } from "../../popup-ui/src/settingsRegistry";

const englishPath = createRequire(import.meta.url).resolve("@lurkloot/locales/messages/en.json");
const english = JSON.parse(readFileSync(englishPath, "utf8")) as Record<string, { message: string }>;

function registry() {
  return buildSettingsRegistry({
    t: (key: string) => key,
    settings: DEFAULT_SETTINGS,
    onSettingsChange: async () => undefined,
    suggestions: { twitch: [], kick: [] },
    onSearchCategories: async () => [],
    compatibilityRegistry: COMPATIBILITY_REGISTRY,
    compatibilityResolution: resolveCompatibility(DEFAULT_SETTINGS.compatibility, { host: "extension", twitchIdentity: "web" }),
  });
}

// Every entry id in tree order: section rows first, then each group's entries.
// Shared by the uniqueness check and the snapshot below.
function allEntryIds(sections: ReturnType<typeof registry>): string[] {
  return sections.flatMap((section) => [
    ...section.rows.map((row) => row.id),
    ...section.groups.flatMap((group) => group.entries.map((entry) => entry.id)),
  ]);
}

describe("settings registry", () => {
  it("exposes exactly the three top-level sections in order", () => {
    expect(registry().map((section) => section.id)).toEqual(["general", "twitch", "kick"]);
  });

  it("gives every section, group and entry a unique id", () => {
    // Section and group ids key persisted collapse state (settingsControls.tsx),
    // so a duplicate there means two groups silently sharing collapse state at
    // runtime, not just a cosmetic clash.
    const ids = registry().flatMap((section) => [
      section.id,
      ...section.groups.map((group) => group.id),
      ...allEntryIds([section]),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Groups that render exactly one rich editor are exempt from the "no
  // one-setting subsections" rule below — it targets lists of toggles, not
  // editors. Listed explicitly (not by an `endsWith` suffix match) so a future
  // one-toggle group can never be silently exempted by sharing a suffix, and so
  // the assertion also catches an editor group quietly growing a toggle list.
  // Both platforms now end in a `.advanced` group, and only Kick's is an editor
  // group — a suffix match here would wrongly exempt Twitch's toggle list too.
  const EDITOR_GROUP_IDS = [
    "twitch.categories",
    "kick.categories",
    "twitch.channels",
    "kick.channels",
    "kick.advanced",
  ];

  it("gives every non-editor group at least two entries, and every editor group exactly one", () => {
    for (const section of registry()) {
      for (const group of section.groups) {
        if (EDITOR_GROUP_IDS.includes(group.id)) {
          expect(group.entries.length, `${section.id}/${group.id}`).toBe(1);
        } else {
          expect(group.entries.length, `${section.id}/${group.id}`).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("resolves every message key against the English catalog", () => {
    for (const section of registry()) {
      const entries = [...section.rows, ...section.groups.flatMap((group) => group.entries)];
      for (const group of section.groups) expect(english[group.titleKey], group.titleKey).toBeTruthy();
      for (const entry of entries) {
        expect(english[entry.titleKey], entry.titleKey).toBeTruthy();
        expect(english[entry.descriptionKey], entry.descriptionKey).toBeTruthy();
      }
    }
  });

  it("marks exactly one advanced group per section", () => {
    const advanced = registry().flatMap((section) => section.groups.filter((group) => group.advanced).map((group) => group.id));
    // Both platform sections end in an identically titled advanced group;
    // Twitch's also holds a farming toggle, Kick's has only compatibility rows.
    expect(advanced).toEqual([
      "general.advanced",
      "twitch.advanced",
      "kick.advanced",
    ]);
  });

  it("omits the compatibility groups when no registry is supplied", () => {
    const withoutCompatibility = buildSettingsRegistry({
      t: (key: string) => key,
      settings: DEFAULT_SETTINGS,
      onSettingsChange: async () => undefined,
      suggestions: { twitch: [], kick: [] },
      onSearchCategories: async () => [],
    });
    const groups = withoutCompatibility.flatMap((section) => section.groups.map((group) => group.id));
    // Kick's advanced group holds nothing but the compatibility editor, so
    // without a registry Kick gets no advanced group at all.
    expect(groups).not.toContain("kick.advanced");
    // Twitch's advanced group survives without a registry because it also holds
    // the strict-availability toggle, but the compatibility rows are gone.
    const entries = allEntryIds(withoutCompatibility);
    expect(entries).not.toContain("twitch.compatibility.rows");
    expect(entries).not.toContain("kick.compatibility.rows");
    expect(entries).toContain("twitch.advanced.strictCampaignAvailability");
  });

  // A flat list of every entry id, in tree order. This is the real risk for a
  // data tree like this one: a setting silently vanishing (or moving somewhere
  // unintended) in a future edit. It also doubles as readable documentation of
  // the IA — read top to bottom to see exactly what the tree contains.
  it("keeps the full settings tree stable", () => {
    expect(allEntryIds(registry())).toMatchInlineSnapshot(`
      [
        "general.appearance.language",
        "general.appearance.autoStart",
        "general.appearance.pauseOnManualWatch",
        "general.appearance.hideTips",
        "general.appearance.inPagePanel",
        "general.notifications.rewardEarned",
        "general.notifications.noDropsLeft",
        "general.drops.autoClaim",
        "general.drops.farmUnlinked",
        "general.drops.farmSubscription",
        "general.drops.priorityMode",
        "general.drops.skipUnfinishable",
        "general.drops.preferKnownChannels",
        "general.drops.idleWatchlistFallbackOnly",
        "general.drops.dropsListFilter",
        "general.drops.forgetExcluded",
        "general.farmingTabs.tabless",
        "general.farmingTabs.autoClose",
        "general.farmingTabs.mute",
        "general.farmingTabs.keepUnmuted",
        "general.farmingTabs.adFocus",
        "general.advanced.pollInterval",
        "general.advanced.tablessFallbackFailureLimit",
        "general.advanced.postClaimHandoff",
        "general.advanced.postClaimHandoffInterval",
        "general.advanced.postClaimHandoffMax",
        "general.advanced.deadlineSafetyMargin",
        "general.advanced.diagnosticLogging",
        "twitch.autoClaimChannelPoints",
        "twitch.categories.mode",
        "twitch.channels.excluded",
        "twitch.advanced.strictCampaignAvailability",
        "twitch.compatibility.rows",
        "kick.autoClaimChallenges",
        "kick.categories.mode",
        "kick.channels.excluded",
        "kick.compatibility.rows",
      ]
    `);
  });
});
