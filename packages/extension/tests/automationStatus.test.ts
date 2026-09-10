import { describe, expect, it } from "vitest";
import type { PlatformAuthHealth, WatchSession } from "@lurkloot/shared/models";
import {
  AUTH_SIGN_IN_URLS,
  automationPresentation,
} from "../../popup-ui/src/automationStatus";

function health(
  status: PlatformAuthHealth["status"],
  reasonCode?: PlatformAuthHealth["reasonCode"],
): PlatformAuthHealth {
  return {
    status,
    reasonCode,
    message: {
      key: status === "blocked" ? "authSecurityPolicyBlocked" : "authPlatformUnavailable",
      values: { reference: "must-not-render" },
    },
  };
}

function session(
  status: WatchSession["status"] = "idle",
  message?: string,
  reasonCode?: WatchSession["reasonCode"],
): WatchSession {
  return {
    platform: "twitch",
    status,
    offlineChecks: 0,
    message,
    reasonCode,
  };
}

describe("automation authentication presentation", () => {
  it("gives pending and paused states precedence", () => {
    expect(automationPresentation({
      platform: "twitch",
      enabled: true,
      pending: true,
      authHealth: health("missing_credentials"),
    }).state).toBe("starting");
    expect(automationPresentation({
      platform: "twitch",
      enabled: false,
      pending: true,
      authHealth: health("healthy"),
    }).state).toBe("stopping");
    expect(automationPresentation({
      platform: "kick",
      enabled: false,
      pending: false,
      authHealth: health("blocked"),
    }).state).toBe("paused");
  });

  it.each([
    ["healthy", undefined, "running", "automationRunning", "accent", undefined, true],
    ["checking", undefined, "checking", "automationChecking", "muted", "authCheckingDetail", false],
    ["missing_credentials", "credentials_missing", "needs_sign_in", "automationNeedsSignIn", "warning", "authSignInMissing", false],
    ["invalid_credentials", "credentials_rejected", "needs_sign_in", "automationNeedsSignIn", "warning", "authSignInRejected", false],
    ["blocked", "security_policy_blocked", "blocked", "automationBlocked", "danger", "authBrowserProfileBlocked", false],
    ["unavailable", "credential_lookup_failed", "unavailable", "automationUnavailable", "warning", "authCredentialCheckUnavailable", false],
    ["unavailable", "network_unavailable", "unavailable", "automationUnavailable", "warning", "authNetworkTemporarilyUnavailable", false],
    ["unavailable", "platform_unavailable", "unavailable", "automationUnavailable", "warning", "authPlatformTemporarilyUnavailable", false],
  ] as const)("maps %s/%s", (status, reasonCode, state, badgeKey, tone, detailKey, operational) => {
    expect(automationPresentation({
      platform: "kick",
      enabled: true,
      pending: false,
      authHealth: health(status, reasonCode),
    })).toMatchObject({ state, badgeKey, tone, detailKey, operational });
  });

  it.each(["missing_credentials", "invalid_credentials"] as const)(
    "provides fixed sign-in actions for %s",
    (status) => {
      expect(automationPresentation({
        platform: "twitch",
        enabled: true,
        pending: false,
        authHealth: health(status),
      }).action).toEqual({ kind: "link", labelKey: "signInToTwitch", url: "https://www.twitch.tv/login" });
      expect(automationPresentation({
        platform: "kick",
        enabled: true,
        pending: false,
        authHealth: health(status),
      }).action).toEqual({ kind: "link", labelKey: "signInToKick", url: "https://kick.com/login" });
    },
  );

  it.each(["checking", "healthy", "blocked", "unavailable"] as const)(
    "does not offer sign-in for %s",
    (status) => {
      expect(automationPresentation({
        platform: "kick",
        enabled: true,
        pending: false,
        authHealth: health(status),
      }).action).toBeUndefined();
    },
  );

  it("surfaces a manual watch-tab close as a resumable pause", () => {
    const result = automationPresentation({
      platform: "kick",
      enabled: true,
      pending: false,
      authHealth: health("healthy"),
      manualClosePaused: true,
    });

    expect(result).toMatchObject({
      state: "paused_tab_closed",
      badgeKey: "automationPausedTabClosed",
      detailKey: "watchTabClosedPauseDetail",
      tone: "warning",
      operational: false,
      action: { kind: "resume", labelKey: "resumeFarming" },
    });
  });

  it("surfaces manual watching as a non-operational pause without an action", () => {
    const result = automationPresentation({
      platform: "twitch",
      enabled: true,
      pending: false,
      authHealth: health("healthy"),
      session: session("paused", "Manual watch detected", "manual_watch"),
    });

    expect(result).toMatchObject({
      state: "paused",
      badgeKey: "automationPausedManualWatch",
      detailKey: "manualWatchPauseDetail",
      tone: "warning",
      operational: false,
    });
    expect(result.action).toBeUndefined();
  });

  it("keeps the manual-close pause visible even while authentication is degraded", () => {
    expect(automationPresentation({
      platform: "twitch",
      enabled: true,
      pending: false,
      authHealth: health("missing_credentials"),
      manualClosePaused: true,
    }).state).toBe("paused_tab_closed");
  });

  it("ignores the manual-close pause when the platform is off or pending", () => {
    expect(automationPresentation({
      platform: "twitch",
      enabled: false,
      pending: false,
      authHealth: health("healthy"),
      manualClosePaused: true,
    }).state).toBe("paused");
    expect(automationPresentation({
      platform: "twitch",
      enabled: true,
      pending: true,
      authHealth: health("healthy"),
      manualClosePaused: true,
    }).state).toBe("starting");
  });

  it("does not propagate authentication message values", () => {
    const result = automationPresentation({
      platform: "kick",
      enabled: true,
      pending: false,
      authHealth: health("blocked", "security_policy_blocked"),
    });
    expect(JSON.stringify(result)).not.toContain("must-not-render");
    expect(result).not.toHaveProperty("message");
  });

  it("uses the typed starting session status after the request settles", () => {
    expect(automationPresentation({
      platform: "twitch",
      enabled: true,
      pending: false,
      authHealth: health("healthy"),
      session: session("starting", "Any display-only detail"),
    })).toMatchObject({
      state: "starting",
      badgeKey: "automationStarting",
      detailKey: "startingAutomation",
      operational: false,
    });
  });

  it.each([
    ["automation_disabled", "Automation disabled"],
    ["platform_disabled", "Platform disabled"],
  ] as const)(
    "keeps a stale %s session paused when automation is re-enabled",
    (reasonCode, message) => {
      const result = automationPresentation({
        platform: "twitch",
        enabled: true,
        pending: false,
        authHealth: health("healthy"),
        session: session("idle", message, reasonCode),
      });

      expect(result.state).toBe("paused");
      expect(result).not.toHaveProperty("statusMessage");
    },
  );

  it.each([
    "Keeping already committed snapshot selection",
    "Snapshot selection discarded stale lifecycle work (revision=42)",
  ])("does not expose internal scheduler detail to a running platform: %s", (message) => {
    const result = automationPresentation({
      platform: "twitch",
      enabled: true,
      pending: false,
      authHealth: health("healthy"),
      session: session("idle", message, "no_eligible_channel"),
    });

    expect(result).toMatchObject({
      state: "running",
      badgeKey: "automationRunning",
    });
    expect(result).not.toHaveProperty("statusMessage");
    expect(JSON.stringify(result)).not.toContain(message);
  });
});
