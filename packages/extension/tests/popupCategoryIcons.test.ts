import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DropCampaign } from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";
import { PlatformCategorySettings } from "../../popup-ui/src/settingsPlatform";
import { gameItemsFromCampaigns } from "../../popup-ui/src/viewModels";

const t = (key: string): string => key;

describe("popup category icons", () => {
  function renderSelectedCategory(imageUrl?: string, categoryMode: "include" | "exclude" = "include"): string {
    const settings = mergeSettings(undefined);
    settings.platform.twitch.categoryMode = categoryMode;
    settings.platform.twitch.categories = [{
      id: "33214",
      name: "Fort Night",
      ...(imageUrl ? { imageUrl } : {}),
    }];

    return renderToStaticMarkup(createElement(PlatformCategorySettings, {
      platform: "twitch",
      suggestions: [],
      settings,
      onCategoryModeChange: () => {},
      onCategoriesChange: () => {},
      onSearchCategories: async () => [],
    }));
  }

  it("renders selected category artwork as a rounded-square image", () => {
    const markup = renderSelectedCategory("https://art.example/fortnite.jpg");

    expect(markup).toContain('src="https://art.example/fortnite.jpg"');
    expect(markup).toContain("h-8 w-8");
    expect(markup).toContain("rounded-lg");
  });

  it("keeps initials when selected category artwork is absent", () => {
    const markup = renderSelectedCategory();

    expect(markup).not.toContain("<img");
    expect(markup).toContain(">FN</span>");
  });

  // Exclude mode drops the reordering affordances (order is meaningless in a
  // denylist) but keeps the row itself — artwork, name and removal — intact.
  it("renders the same category artwork without rank controls in exclude mode", () => {
    const markup = renderSelectedCategory("https://art.example/fortnite.jpg", "exclude");

    expect(markup).toContain('src="https://art.example/fortnite.jpg"');
    expect(markup).not.toContain("reorderItem");
    expect(markup).toContain("removeItem");
  });

  it("preserves campaign category artwork in active-drop suggestions", () => {
    const campaign: DropCampaign = {
      id: "fortnite-drops",
      platform: "twitch",
      name: "Fortnite Drops",
      categoryId: "33214",
      gameName: "Fortnite",
      gameImageUrl: "https://art.example/fortnite.jpg",
      status: "active",
      rewards: [],
    };

    expect(gameItemsFromCampaigns([campaign], t)).toEqual([
      expect.objectContaining({
        id: "33214",
        name: "Fortnite",
        imageUrl: "https://art.example/fortnite.jpg",
      }),
    ]);
  });

  it("fills missing artwork from a later campaign in the same category", () => {
    const firstCampaign: DropCampaign = {
      id: "fortnite-drops-first",
      platform: "twitch",
      name: "Fortnite Drops First",
      categoryId: "33214",
      gameName: "Fortnite First",
      status: "active",
      rewards: [],
    };
    const laterCampaign: DropCampaign = {
      id: "fortnite-drops-later",
      platform: "twitch",
      name: "Fortnite Drops Later",
      categoryId: "33214",
      gameName: "Fortnite Later",
      gameImageUrl: "https://art.example/fortnite-later.jpg",
      status: "active",
      rewards: [],
    };

    expect(gameItemsFromCampaigns([firstCampaign, laterCampaign], t)).toEqual([
      expect.objectContaining({
        id: "33214",
        name: "Fortnite First",
        imageUrl: "https://art.example/fortnite-later.jpg",
      }),
    ]);
  });

  it("keeps the synthetic no-category suggestion on the initials fallback", () => {
    const campaign: DropCampaign = {
      id: "uncategorized-drops",
      platform: "kick",
      name: "Event Drops",
      gameImageUrl: "https://art.example/unused.jpg",
      status: "active",
      rewards: [],
    };

    expect(gameItemsFromCampaigns([campaign], t)[0]).not.toHaveProperty("imageUrl");
  });
});
