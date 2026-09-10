import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform, PlatformAuthHealth } from "@lurkloot/shared/models";
import { AutomationStatusLine, PlatformBar } from "../../popup-ui/src/automation";
import type { AutomationPresentation } from "../../popup-ui/src/automationStatus";
import { automationPresentation } from "../../popup-ui/src/automationStatus";
import { I18nContext, PopupRuntimeContext } from "../../popup-ui/src/context";
import type { PopupAdapter } from "../../popup-ui/src/types";

const messages: Record<string, string> = {
  automationTitle: "$1 automation",
  automationRunning: "Running",
  automationChecking: "Checking",
  automationNeedsSignIn: "Needs sign-in",
  automationBlocked: "Blocked",
  automationUnavailable: "Unavailable",
  authSignInMissing: "Sign in to continue farming drops.",
  authSignInRejected: "Your session is no longer valid. Sign in again to continue.",
  authBrowserProfileBlocked: "Kick rejected this browser profile. Signing in alone may not resolve it.",
  authPlatformTemporarilyUnavailable: "The platform is temporarily unavailable. Lurkloot will retry automatically.",
  signInToTwitch: "Sign in to Twitch",
  signInToKick: "Sign in to Kick",
  watchingLabel: "Watching",
  farmingLabel: "Farming",
  waitingEligibleStream: "No eligible live stream is currently available for this campaign",
  automationPausedTabClosed: "Paused — tab closed",
  watchTabClosedPauseDetail: "You closed the farming tab, so Lurkloot stopped farming here.",
  resumeFarming: "Resume farming",
};

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function presentation(platform: Platform, authHealth: PlatformAuthHealth) {
  return automationPresentation({ platform, enabled: true, pending: false, authHealth });
}

function mount(element: React.ReactElement) {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr" }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const openLink = vi.fn();
  const adapter = { openLink } as unknown as PopupAdapter;
  const container = document.getElementById("app")!;
  act(() => {
    root = createRoot(container);
    root.render(
      <I18nContext.Provider value={{
        t: (key, substitutions) => (messages[key] ?? key).replace("$1", typeof substitutions === "string" ? substitutions : ""),
        dir: "ltr",
        locale: "en",
      }}>
        <PopupRuntimeContext.Provider value={{ adapter, preview: false }}>
          {element}
        </PopupRuntimeContext.Provider>
      </I18nContext.Provider>,
    );
  });
  return { container, openLink };
}

// The popup header renders the platform bar (tabs + automation switch) directly
// above the status line, so the assertions below exercise the pair the way the
// user actually sees it.
function mountHeader(options: {
  platform: Platform;
  presentation: AutomationPresentation;
  other?: AutomationPresentation;
  farmingTitle?: string;
  farmingChannel?: { name: string };
  onResume?(): void;
  onChange?(platform: Platform): void;
  onToggle?(platform: Platform, value: boolean): Promise<void>;
}) {
  const otherPlatform: Platform = options.platform === "twitch" ? "kick" : "twitch";
  const fallback = options.other ?? presentation(otherPlatform, { status: "healthy" });
  return mount(
    <>
      <PlatformBar
        active={options.platform}
        presentation={{
          [options.platform]: options.presentation,
          [otherPlatform]: fallback,
        } as Record<Platform, AutomationPresentation>}
        enabled={{ twitch: true, kick: true }}
        pending={{ twitch: false, kick: false }}
        onChange={options.onChange ?? (() => undefined)}
        onToggle={options.onToggle ?? (async () => undefined)}
      />
      <AutomationStatusLine
        platform={options.platform}
        presentation={options.presentation}
        farmingTitle={options.farmingTitle}
        farmingChannel={options.farmingChannel}
        onResume={options.onResume}
      />
    </>,
  );
}

describe("automation authentication status UI", () => {
  it("shows an explicit Twitch sign-in action and keeps the toggle enabled", () => {
    const { container, openLink } = mountHeader({
      platform: "twitch",
      presentation: presentation("twitch", { status: "missing_credentials" }),
    });

    expect(container.textContent).toContain("Needs sign-in");
    expect(container.textContent).toContain("Sign in to Twitch");
    const action = container.querySelector<HTMLButtonElement>('[data-auth-action="twitch"]');
    expect(action).not.toBeNull();
    act(() => action?.click());
    expect(openLink).toHaveBeenCalledWith("https://www.twitch.tv/login");
    expect(container.querySelector('[data-platform-status="twitch"] [role="switch"]')?.hasAttribute("disabled")).toBe(false);
  });

  it("offers a one-click resume after the user closed the farming tab", () => {
    const onResume = vi.fn();
    const { container } = mountHeader({
      platform: "kick",
      presentation: automationPresentation({
        platform: "kick",
        enabled: true,
        pending: false,
        authHealth: { status: "healthy" },
        manualClosePaused: true,
      }),
      onResume,
    });

    expect(container.querySelector('[data-automation-state="paused_tab_closed"]')).not.toBeNull();
    expect(container.textContent).toContain("Paused — tab closed");
    expect(container.textContent).toContain("You closed the farming tab");
    const resume = container.querySelector<HTMLButtonElement>('[data-resume-action="kick"]');
    expect(resume).not.toBeNull();
    expect(resume?.textContent).toContain("Resume farming");
    act(() => resume?.click());
    expect(onResume).toHaveBeenCalledOnce();
  });

  it("explains a Kick browser-profile block without offering sign-in", () => {
    const { container } = mountHeader({
      platform: "kick",
      presentation: presentation("kick", { status: "blocked", reasonCode: "security_policy_blocked" }),
    });

    expect(container.querySelector('[data-automation-state="blocked"]')).not.toBeNull();
    expect(container.textContent).toContain("Kick rejected this browser profile");
    expect(container.querySelector("[data-auth-action]")).toBeNull();
    expect(container.querySelector('[data-platform-status="kick"] [role="switch"]')?.hasAttribute("disabled")).toBe(false);
  });

  it("shows operational state independently for each platform", () => {
    const { container } = mountHeader({
      platform: "twitch",
      presentation: presentation("twitch", { status: "healthy" }),
      other: presentation("kick", { status: "unavailable", reasonCode: "platform_unavailable" }),
    });

    expect(container.querySelector('[data-platform-status="twitch"]')?.getAttribute("data-state")).toBe("running");
    expect(container.querySelector('[data-platform-status="kick"]')?.getAttribute("data-state")).toBe("unavailable");
  });

  it("shows localized eligibility status instead of internal scheduler detail", () => {
    const internalMessage = "Keeping already committed snapshot selection";
    const { container } = mountHeader({
      platform: "twitch",
      presentation: automationPresentation({
        platform: "twitch",
        enabled: true,
        pending: false,
        authHealth: { status: "healthy" },
        session: {
          platform: "twitch",
          status: "idle",
          offlineChecks: 0,
          reasonCode: "keeping_current_watch",
          message: internalMessage,
        },
      }),
    });

    const status = container.querySelector('[data-automation-state="running"]');
    expect(status?.textContent).toContain("No eligible live stream is currently available for this campaign");
    expect(status?.textContent).not.toContain(internalMessage);
  });

  it("hides stale farming detail while authentication is degraded", () => {
    const { container } = mountHeader({
      platform: "kick",
      presentation: presentation("kick", { status: "unavailable" }),
      farmingTitle: "Stale campaign",
      farmingChannel: { name: "stale-channel" },
    });

    expect(container.textContent).toContain("temporarily unavailable");
    expect(container.textContent).not.toContain("Stale campaign");
    expect(container.textContent).not.toContain("stale-channel");
  });

  it("toggles an unselected platform without selecting it", () => {
    const onChange = vi.fn();
    const onToggle = vi.fn(async () => undefined);
    const { container } = mountHeader({
      platform: "twitch",
      presentation: presentation("twitch", { status: "healthy" }),
      onChange,
      onToggle,
    });

    const kickSwitch = container.querySelector<HTMLButtonElement>('[data-platform-status="kick"] [role="switch"]');
    act(() => kickSwitch?.click());

    expect(onToggle).toHaveBeenCalledWith("kick", false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses roving tab stops and arrow navigation for platform tabs", () => {
    const onChange = vi.fn();
    const { container } = mountHeader({
      platform: "twitch",
      presentation: presentation("twitch", { status: "healthy" }),
      onChange,
    });

    const twitchTab = container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Twitch"]');
    const kickTab = container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Kick"]');
    expect(twitchTab?.getAttribute("tabindex")).toBe("0");
    expect(kickTab?.getAttribute("tabindex")).toBe("-1");

    const keydown = new window.Event("keydown", { bubbles: true });
    Object.defineProperty(keydown, "key", { value: "ArrowRight" });
    act(() => twitchTab?.dispatchEvent(keydown));

    expect(onChange).toHaveBeenCalledWith("kick");
  });

  it("renders the selected platform as an accent-tinted active tab", () => {
    const { container } = mountHeader({
      platform: "twitch",
      presentation: presentation("twitch", { status: "healthy" }),
    });

    const twitchTab = container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Twitch"]');
    const kickTab = container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Kick"]');

    expect(twitchTab?.parentElement?.className).toContain("-mb-px");
    expect(twitchTab?.parentElement?.className).toContain("border-[var(--accent-ring)]");
    expect(twitchTab?.parentElement?.className).toContain("bg-[var(--accent-soft)]");
    expect(kickTab?.parentElement?.className).not.toContain("bg-[var(--accent-soft)]");
    expect(twitchTab?.parentElement?.querySelector(".inset-x-0.-bottom-px")).not.toBeNull();
  });
});
