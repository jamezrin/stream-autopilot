import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDemoPopupAdapter,
  Popup,
  SCREENSHOT_VARIANTS,
  StoreScreenshot,
  screenshotVariant,
  variantShowsPopup,
} from "@lurkloot/popup-ui";
import { resetCatalogTracking, waitForCatalog } from "./helpers/popupCatalog";

vi.mock("@lurkloot/locales", async (importOriginal) =>
  (await import("./helpers/popupCatalog")).delayedLocales(importOriginal));

let root: Root | undefined;

afterEach(() => {
  resetCatalogTracking();
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

async function mountShot(id: string, childText?: string) {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.getElementById("app")!;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <StoreScreenshot variant={screenshotVariant(id)} locale="en">
        {childText ? <div data-testid="live-popup">{childText}</div> : null}
      </StoreScreenshot>,
    );
  });
  await waitForCatalog();
  return container;
}

describe("store screenshot variants", () => {
  it("resolves canonical ids and aliases to the locked layouts", () => {
    expect(screenshotVariant("drops").layout).toBe("hero");
    expect(screenshotVariant("twitch-drops")).toBe(screenshotVariant("drops"));
    expect(screenshotVariant("kick-drops")).toBe(screenshotVariant("drops"));
    expect(screenshotVariant("extras").layout).toBe("extras");
    expect(screenshotVariant("idle-watchlist")).toBe(screenshotVariant("extras"));
    expect(screenshotVariant("easy").layout).toBe("steps");
    expect(screenshotVariant("settings").layout).toBe("settings");
    expect(screenshotVariant("updated").layout).toBe("updated");
    expect(screenshotVariant("activity")).toBe(screenshotVariant("updated"));
    expect(screenshotVariant(null).layout).toBe("hero");
    expect(screenshotVariant("nope").layout).toBe("hero");
  });

  it("mounts a live popup on every shot except updated", () => {
    expect(variantShowsPopup(screenshotVariant("drops"))).toBe(true);
    expect(variantShowsPopup(screenshotVariant("extras"))).toBe(true);
    expect(variantShowsPopup(screenshotVariant("easy"))).toBe(true);
    expect(variantShowsPopup(screenshotVariant("settings"))).toBe(true);
    expect(variantShowsPopup(screenshotVariant("updated"))).toBe(false);
  });

  it("wires extras to the Twitch watchlist and easy to Kick drops", () => {
    const extras = screenshotVariant("extras");
    const easy = screenshotVariant("easy");
    const drops = screenshotVariant("drops");
    const settings = screenshotVariant("settings");
    if (!variantShowsPopup(extras) || !variantShowsPopup(easy) || !variantShowsPopup(drops) || !variantShowsPopup(settings)) {
      throw new Error("expected popup shots");
    }
    expect(extras.platform).toBe("twitch");
    expect(extras.view).toBe("watchlist");
    expect(easy.platform).toBe("kick");
    expect(easy.view).toBe("drops");
    expect(drops.platform).toBe("twitch");
    expect(drops.view).toBe("drops");
    expect(settings.view).toBe("settings");
  });

  it("exports five canonical layouts", () => {
    expect(Object.keys(SCREENSHOT_VARIANTS)).toEqual(expect.arrayContaining([
      "drops", "extras", "easy", "settings", "updated",
      "twitch-drops", "kick-drops", "idle-watchlist", "activity",
    ]));
  });
});

describe("extras screenshot popup", () => {
  it("expands the idle watchlist with live demo rows", async () => {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(Date.now());
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));
    const scrollIntoView = vi.fn();
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { value: scrollIntoView });
    const container = document.getElementById("app")!;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <Popup
          adapter={createDemoPopupAdapter()}
          initialState={{ preview: true, locale: "en", variant: screenshotVariant("extras") }}
        />,
      );
    });
    await waitForCatalog();
    const watchlistToggle = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Idle Watchlist"));
    expect(watchlistToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("#idle-watchlist")).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(container.textContent).toContain("LootForge");
    expect(container.textContent).toContain("NightRunLive");
    expect(container.textContent).toContain("6.2K");
    expect(container.textContent).toContain("2.5K");
  });
});

describe("store screenshot cameras", () => {
  it("places extras copy and chips beside a live popup", async () => {
    const container = await mountShot("extras", "LIVE_POPUP");
    expect(container.textContent).toContain("More than drops.");
    expect(container.textContent).toContain("Channel points");
    expect(container.textContent).toContain("Daily challenges");
    expect(container.textContent).toContain("Idle watchlist");
    expect(container.textContent).toContain("2-minute drops");
    expect(container.textContent).toContain("LIVE_POPUP");
    expect(container.querySelector('[data-layout="extras"]')).not.toBeNull();
  });

  it("stacks easy steps on the start side and mounts a live popup", async () => {
    const container = await mountShot("easy", "LIVE_POPUP");
    expect(container.textContent).toContain("That easy.");
    expect(container.textContent).toContain("Install");
    expect(container.textContent).toContain("Pin it");
    expect(container.textContent).toContain("Enable a platform");
    expect(container.textContent).toContain("Profit");
    expect(container.textContent).toContain("LIVE_POPUP");
    const steps = container.querySelector('[data-layout="steps"] [data-steps]');
    expect(steps).not.toBeNull();
    const className = steps?.getAttribute("class") ?? "";
    expect(className).toMatch(/\bstart-\[7%\]/);
    expect(className).not.toMatch(/\bgap-7\b/);
  });

  it("places the live popup inside hero and settings cameras", async () => {
    const hero = await mountShot("drops", "LIVE_POPUP");
    expect(hero.textContent).toContain("Farm drops while you do anything else.");
    expect(hero.textContent).toContain("LIVE_POPUP");
    const settings = await mountShot("settings", "LIVE_POPUP");
    expect(settings.textContent).toContain("Farm exactly how you want.");
    expect(settings.textContent).toContain("LIVE_POPUP");
  });

  it("fills updated with a text runtime board and no popup", async () => {
    const container = await mountShot("updated", "LIVE_POPUP");
    expect(container.textContent).toContain("Featureful. Always updated.");
    expect(container.textContent).toContain("4.9");
    expect(container.textContent).toContain("1,000+ users");
    expect(container.textContent).not.toContain("25 reviews");
    expect(container.textContent).toContain("Chromium-based browsers");
    expect(container.textContent).toContain("Chrome Web Store listing. Same extension.");
    expect(container.textContent).toContain("CLI");
    expect(container.textContent).toContain("Headless. Same engine.");
    expect(container.textContent).toContain("Docker");
    expect(container.textContent).toContain("Same engine. In a container.");
    expect(container.textContent).not.toContain("CLI · Docker");
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("Open source");
    expect(container.textContent).toContain("Apache-2.0");
    expect(container.textContent).not.toContain("LIVE_POPUP");
    expect(container.querySelector('[data-layout="updated"] svg')).not.toBeNull();
    expect(container.querySelector("[data-updated-board]")).not.toBeNull();
  });
});
