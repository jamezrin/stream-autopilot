import type { CategorySelection, DropCampaign, PlatformSettings } from "./models";

// Sentinel id for the synthetic "No category" selection. Some drop campaigns
// carry no game/category at all (e.g. Kick's org-wide event drops, where the
// reward category_id is 0). They are real and farmable, so we let users pick
// this pseudo-category to farm exactly those. The value is namespaced so it can
// never collide with a real platform category id or name.
export const NO_CATEGORY_ID = "__none__";

// A campaign has no category when it carries neither a category id nor a game
// name. Such a campaign only ever matches the "No category" selection.
export function isUncategorizedCampaign(campaign: Pick<DropCampaign, "categoryId" | "gameName">): boolean {
  return !campaign.categoryId && !campaign.gameName;
}

// Position of a campaign's category in a selection list, by id or name
// (case-insensitive); -1 when absent. Campaigns sometimes carry only a gameName.
// An uncategorized campaign matches only the synthetic NO_CATEGORY_ID entry.
export function categoryListIndex(campaign: DropCampaign, list: CategorySelection[]): number {
  if (list.length === 0) return -1;
  const candidates = [campaign.categoryId, campaign.gameName]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  if (candidates.length === 0) return list.findIndex((category) => category.id === NO_CATEGORY_ID);
  return list.findIndex((category) =>
    candidates.includes(category.id.toLowerCase()) || candidates.includes(category.name.toLowerCase()));
}

// The single definition of "does this campaign's category pass the user's
// filter". Farming eligibility (campaignFarming), campaign visibility and
// scheduler rejection summaries (campaignFilters, scheduler) all call this, so
// they cannot disagree about what a mode means.
//
// "exclude" with an empty list passes everything, which falls out of
// categoryListIndex short-circuiting to -1 on an empty list — the
// empty-exclude-is-all rule is asserted directly in categories.test.ts so it
// stays true if that short circuit ever changes.
export function campaignPassesCategoryFilter(
  campaign: DropCampaign,
  platformSettings: Pick<PlatformSettings, "categoryMode" | "categories">,
): boolean {
  if (platformSettings.categoryMode === "all") return true;
  const listed = categoryListIndex(campaign, platformSettings.categories) !== -1;
  return platformSettings.categoryMode === "exclude" ? !listed : listed;
}

// Order within the per-platform categories list sets farming priority — but
// only in "include" mode, where the list IS the user's ordered preference.
// In "all" the (hidden) list must never silently reorder anything, and in
// "exclude" the list is a denylist: position in it says nothing about how much
// the user wants a category, so every campaign scores equal in both.
export function categoryPriorityScore(
  campaign: DropCampaign,
  platformSettings: Pick<PlatformSettings, "categoryMode" | "categories">,
): number {
  if (platformSettings.categoryMode !== "include") return Number.MAX_SAFE_INTEGER;
  const index = categoryListIndex(campaign, platformSettings.categories);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}
