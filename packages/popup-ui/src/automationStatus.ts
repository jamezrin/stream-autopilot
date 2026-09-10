import type { Platform, PlatformAuthHealth, WatchSession } from "@lurkloot/shared/models";

export type AutomationPresentationState =
  | "starting"
  | "stopping"
  | "paused"
  | "paused_tab_closed"
  | "running"
  | "checking"
  | "needs_sign_in"
  | "blocked"
  | "unavailable";

export type AutomationTone = "muted" | "accent" | "warning" | "danger";

export interface AutomationPresentation {
  state: AutomationPresentationState;
  badgeKey: string;
  detailKey?: string;
  tone: AutomationTone;
  operational: boolean;
  action?: AutomationAction;
}

export type AutomationAction =
  | { kind: "link"; labelKey: "signInToTwitch" | "signInToKick"; url: string }
  // Undoes a pause the user caused by closing the managed watch tab.
  | { kind: "resume"; labelKey: "resumeFarming" };

export const AUTH_SIGN_IN_URLS: Record<Platform, string> = {
  twitch: "https://www.twitch.tv/login",
  kick: "https://kick.com/login",
};

export function automationPresentation({
  platform,
  enabled,
  pending,
  authHealth,
  session,
  manualClosePaused = false,
}: {
  platform: Platform;
  enabled: boolean;
  pending: boolean;
  authHealth: PlatformAuthHealth;
  session?: WatchSession;
  manualClosePaused?: boolean;
}): AutomationPresentation {
  if (pending) {
    return enabled
      ? presentation("starting", "automationStarting", "startingAutomation")
      : presentation("stopping", "automationStopping", "pausingAutomation");
  }
  if (!enabled) return presentation("paused", "pausedStatus", "watchingPausedHint");
  // Ranked above auth health: the user caused this stop, so telling them why
  // and how to undo it matters more than any background probe result.
  if (manualClosePaused || session?.reasonCode === "manual_tab_close") {
    return {
      ...presentation("paused_tab_closed", "automationPausedTabClosed", "watchTabClosedPauseDetail", "warning"),
      action: { kind: "resume", labelKey: "resumeFarming" },
    };
  }

  switch (authHealth.status) {
    case "healthy": {
      if (session?.status === "starting") {
        return presentation("starting", "automationStarting", "startingAutomation");
      }
      if (session?.status === "paused" && session?.reasonCode === "manual_watch") {
        return presentation("paused", "automationPausedManualWatch", "manualWatchPauseDetail", "warning");
      }
      if (
        session?.status === "paused"
        || session?.reasonCode === "automation_disabled"
        || session?.reasonCode === "platform_disabled"
      ) {
        return presentation("paused", "pausedStatus", "watchingPausedHint");
      }
      return {
        state: "running",
        badgeKey: "automationRunning",
        detailKey: undefined,
        tone: "accent",
        operational: true,
      };
    }
    case "checking":
      return presentation("checking", "automationChecking", "authCheckingDetail");
    case "missing_credentials":
      return signInPresentation(platform, "authSignInMissing");
    case "invalid_credentials":
      return signInPresentation(platform, "authSignInRejected");
    case "blocked":
      return presentation("blocked", "automationBlocked", "authBrowserProfileBlocked", "danger");
    case "unavailable": {
      const detailKey = authHealth.reasonCode === "credential_lookup_failed"
        ? "authCredentialCheckUnavailable"
        : authHealth.reasonCode === "network_unavailable"
          ? "authNetworkTemporarilyUnavailable"
          : "authPlatformTemporarilyUnavailable";
      return presentation("unavailable", "automationUnavailable", detailKey, "warning");
    }
  }
}

function presentation(
  state: AutomationPresentationState,
  badgeKey: string,
  detailKey: string,
  tone: AutomationTone = "muted",
): AutomationPresentation {
  return { state, badgeKey, detailKey, tone, operational: false };
}

function signInPresentation(
  platform: Platform,
  detailKey: string,
): AutomationPresentation {
  return {
    ...presentation("needs_sign_in", "automationNeedsSignIn", detailKey, "warning"),
    action: {
      kind: "link",
      labelKey: platform === "twitch" ? "signInToTwitch" : "signInToKick",
      url: AUTH_SIGN_IN_URLS[platform],
    },
  };
}
