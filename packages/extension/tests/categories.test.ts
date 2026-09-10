import { describe, expect, it } from "vitest";
import type { CategorySelection, DropCampaign, PlatformSettings } from "@lurkloot/shared/models";
import { NO_CATEGORY_ID, campaignPassesCategoryFilter, categoryListIndex, categoryPriorityScore, isUncategorizedCampaign } from "@lurkloot/shared/categories";

const campaign = (patch: Partial<DropCampaign> = {}): DropCampaign => ({
  id: "c",
  platform: "kick",
  name: "Football Drop: Streamer Jersey",
  status: "active",
  rewards: [],
  ...patch,
});

describe("categoryListIndex", () => {
  const rust: CategorySelection = { id: "13", name: "Rust" };
  const noCategory: CategorySelection = { id: NO_CATEGORY_ID, name: "No category" };

  it("matches a categorized campaign by id or name", () => {
    expect(categoryListIndex(campaign({ categoryId: "13", gameName: "Rust" }), [rust])).toBe(0);
    expect(categoryListIndex(campaign({ gameName: "Rust" }), [rust])).toBe(0);
  });

  it("never matches a categorized campaign against the No category sentinel", () => {
    expect(categoryListIndex(campaign({ categoryId: "13", gameName: "Rust" }), [noCategory])).toBe(-1);
  });

  it("matches a category-less campaign only against the No category sentinel", () => {
    const uncategorized = campaign(); // no categoryId, no gameName
    expect(categoryListIndex(uncategorized, [noCategory])).toBe(0);
    expect(categoryListIndex(uncategorized, [rust])).toBe(-1);
    expect(categoryListIndex(uncategorized, [rust, noCategory])).toBe(1);
  });

  it("returns -1 for an empty selection list", () => {
    expect(categoryListIndex(campaign(), [])).toBe(-1);
    expect(categoryListIndex(campaign({ gameName: "Rust" }), [])).toBe(-1);
  });
});

describe("isUncategorizedCampaign", () => {
  it("is true only when both categoryId and gameName are absent", () => {
    expect(isUncategorizedCampaign(campaign())).toBe(true);
    expect(isUncategorizedCampaign(campaign({ gameName: "Rust" }))).toBe(false);
    expect(isUncategorizedCampaign(campaign({ categoryId: "13" }))).toBe(false);
  });
});

describe("campaignPassesCategoryFilter", () => {
  const rust: CategorySelection = { id: "13", name: "Rust" };
  const noCategory: CategorySelection = { id: NO_CATEGORY_ID, name: "No category" };
  const rustCampaign = campaign({ categoryId: "13", gameName: "Rust" });
  const other = campaign({ categoryId: "21", gameName: "Other" });
  const uncategorized = campaign();

  it("passes everything in all mode, whatever the list holds", () => {
    for (const c of [rustCampaign, other, uncategorized]) {
      expect(campaignPassesCategoryFilter(c, { categoryMode: "all", categories: [] })).toBe(true);
      expect(campaignPassesCategoryFilter(c, { categoryMode: "all", categories: [rust] })).toBe(true);
    }
  });

  it("passes only listed categories in include mode", () => {
    const include: Pick<PlatformSettings, "categoryMode" | "categories"> = { categoryMode: "include", categories: [rust] };
    expect(campaignPassesCategoryFilter(rustCampaign, include)).toBe(true);
    expect(campaignPassesCategoryFilter(other, include)).toBe(false);
  });

  it("passes everything except listed categories in exclude mode", () => {
    const exclude: Pick<PlatformSettings, "categoryMode" | "categories"> = { categoryMode: "exclude", categories: [rust] };
    expect(campaignPassesCategoryFilter(rustCampaign, exclude)).toBe(false);
    expect(campaignPassesCategoryFilter(other, exclude)).toBe(true);
  });

  it("farms nothing on an empty include list and everything on an empty exclude list", () => {
    expect(campaignPassesCategoryFilter(rustCampaign, { categoryMode: "include", categories: [] })).toBe(false);
    expect(campaignPassesCategoryFilter(rustCampaign, { categoryMode: "exclude", categories: [] })).toBe(true);
    expect(campaignPassesCategoryFilter(uncategorized, { categoryMode: "exclude", categories: [] })).toBe(true);
  });

  it("applies both modes to the No category sentinel", () => {
    expect(campaignPassesCategoryFilter(uncategorized, { categoryMode: "include", categories: [noCategory] })).toBe(true);
    expect(campaignPassesCategoryFilter(uncategorized, { categoryMode: "exclude", categories: [noCategory] })).toBe(false);
    // A categorized campaign never matches the sentinel, so exclude keeps it.
    expect(campaignPassesCategoryFilter(rustCampaign, { categoryMode: "exclude", categories: [noCategory] })).toBe(true);
    expect(campaignPassesCategoryFilter(rustCampaign, { categoryMode: "include", categories: [noCategory] })).toBe(false);
  });
});

describe("categoryPriorityScore", () => {
  const rust: CategorySelection = { id: "13", name: "Rust" };
  const other: CategorySelection = { id: "21", name: "Other" };
  const rustCampaign = campaign({ categoryId: "13", gameName: "Rust" });

  it("uses list position only in include mode", () => {
    expect(categoryPriorityScore(rustCampaign, { categoryMode: "include", categories: [other, rust] })).toBe(1);
    expect(categoryPriorityScore(rustCampaign, { categoryMode: "include", categories: [rust, other] })).toBe(0);
  });

  it("scores every campaign equal in all and exclude modes", () => {
    const list = [other, rust];
    expect(categoryPriorityScore(rustCampaign, { categoryMode: "all", categories: list })).toBe(Number.MAX_SAFE_INTEGER);
    expect(categoryPriorityScore(rustCampaign, { categoryMode: "exclude", categories: list })).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("scores an unlisted campaign last in include mode", () => {
    expect(categoryPriorityScore(campaign({ gameName: "Unlisted" }), { categoryMode: "include", categories: [rust] }))
      .toBe(Number.MAX_SAFE_INTEGER);
  });
});
