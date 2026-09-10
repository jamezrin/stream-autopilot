import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineEvent } from "@lurkloot/shared/events";
import type { ChannelCandidate, WatchSession } from "@lurkloot/shared/models";
import { activityDiagnostic } from "@lurkloot/core/activityDiagnostics";
import {
  AD_FOCUS_MAX_HOLD_MS,
  applyAdFocusWithBrowser,
  cancelTwitchIntegrityAcquisition,
  currentManagedPageContextTabs,
  currentValidTwitchIntegrity,
  currentTwitchIntegrityWaiterCount,
  ensureTwitchIntegrityWithBrowser,
  fetchJsonInPageWithBrowser,
  fetchKickInBackgroundWith,
  fetchTwitchInBackgroundWith,
  hasValidTwitchIntegrity,
  isValidTwitchIntegrity,
  KickWafBlockedError,
  noteTwitchGqlRequest,
  openPinnedMutedTabWithBrowser,
  pageFetchJson,
  PLAYBACK_PRIME_BACKOFF_MS,
  PLAYBACK_PRIME_MAX_ATTEMPTS,
  reconcileManagedPageContextRecoveryWithBrowser,
  recordManagedPageContextFallback,
  registerManagedPageContextTabs,
  resetTwitchIntegrityRefreshBounds,
  resetPlaybackPriming,
  setTwitchIntegrity,
  stopManagedPageContextTabsWithBrowser,
  stopWatchTabWithBrowser,
  type TwitchIntegrityRequest,
} from "@lurkloot/core/tabs";
import { isSafeFetchError } from "@lurkloot/core/fetchError";
import { KICK_BEARER_NEAR_MISS_CASES, KICK_BEARER_POSITIVE_CASES } from "@lurkloot/core/kickBearerCases";

const channel: ChannelCandidate = {
  platform: "twitch",
  username: "creator",
  url: "https://www.twitch.tv/creator",
};

function browserMock() {
  return {
    tabs: {
      get: vi.fn(),
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      query: vi.fn<() => Promise<Array<{ id?: number; url?: string; status?: string }>>>(async () => []),
      create: vi.fn(async () => ({ id: 9 })),
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

// Foreground activations issued by playback priming (`tabs.update(id, { active: true })`).
function activationCalls(browser: ReturnType<typeof browserMock>): unknown[][] {
  return (browser.tabs.update.mock.calls as unknown as unknown[][])
    .filter((call) => (call[1] as { active?: boolean } | undefined)?.active === true);
}

function managedSession(playingVideoCount: number): WatchSession {
  return {
    platform: "twitch",
    status: "watching",
    offlineChecks: 0,
    tabId: 4,
    tabManagedByExtension: true,
    playback: {
      platform: "twitch",
      checkedAt: new Date().toISOString(),
      videoCount: 1,
      mutedVideoCount: 1,
      unmutedVideoCount: 0,
      playingVideoCount,
      blockedPlaybackCount: 1 - playingVideoCount,
      documentHidden: false,
    },
  };
}

// The player never starts, so shouldPrimePlayback stays true on every tick.
const stalledSession = () => managedSession(0);
const healthySession = () => managedSession(1);

describe("tab manager", () => {
  beforeEach(() => {
    registerManagedPageContextTabs({});
    resetPlaybackPriming();
  });

  it("updates retained page contexts only for the requested platform", () => {
    const twitch = {
      platform: "twitch" as const,
      tabId: 10,
      originUrl: "https://www.twitch.tv",
      origin: "https://www.twitch.tv",
      ownedByExtension: true as const,
    };
    const kick = {
      platform: "kick" as const,
      tabId: 20,
      originUrl: "https://kick.com",
      origin: "https://kick.com",
      ownedByExtension: true as const,
    };
    registerManagedPageContextTabs({ twitch, kick });

    registerManagedPageContextTabs({}, ["twitch"]);

    expect(currentManagedPageContextTabs()).toEqual({ kick });
  });

  it("reports tab lifecycle events to the supplied emitter", async () => {
    const events: EngineEvent[] = [];
    const emit = (event: EngineEvent) => events.push(event);

    const browser = browserMock();
    await openPinnedMutedTabWithBrowser(browser, channel, undefined, undefined, emit);

    expect(events.some((event) => event.category === "diagnostic" && event.level === "info" && event.message.includes("Opened watch tab 9"))).toBe(true);
    expect(events.every((event) => event.platform === "twitch")).toBe(true);

    events.length = 0;
    await stopWatchTabWithBrowser(browser, { platform: "twitch", status: "watching", offlineChecks: 0, tabId: 9, tabManagedByExtension: true }, undefined, emit);
    expect(events.some((event) => event.level === "debug" && event.message.includes("Closed managed watch tab 9"))).toBe(true);
  });

  it("reports managed page-context creation and closure as activity", async () => {
    const browser = {
      ...browserMock(),
      scripting: { executeScript: vi.fn(async () => [{ result: { ok: true } }]) },
    };
    browser.tabs.create.mockResolvedValue({ id: 14 });
    const events: EngineEvent[] = [];
    const emit = (event: EngineEvent) => events.push(event);

    await fetchJsonInPageWithBrowser(
      browser,
      "https://kick.com/drops/inventory",
      "https://web.kick.com/api/v1/drops/progress?secret=value",
      undefined,
      { retainPageContext: { platform: "kick" }, emit, openReason: "background_rejected" },
    );
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: "https://kick.com/drops/inventory",
      pinned: false,
      active: false,
    });
    expect(browser.tabs.update).toHaveBeenCalledWith(14, { muted: true, active: false });
    expect(currentManagedPageContextTabs().kick).toMatchObject({
      originUrl: "https://kick.com/drops/inventory",
      origin: "https://kick.com",
    });
    await stopManagedPageContextTabsWithBrowser(browser, currentManagedPageContextTabs(), {
      platforms: ["kick"],
      reason: "background_recovered",
      emit,
    });

    expect(events.filter((event) => event.category === "activity")).toEqual([
      { category: "activity", code: "page_context_opened", level: "info", platform: "kick", data: { host: "kick.com", reason: "background_rejected" } },
      { category: "activity", code: "page_context_closed", level: "info", platform: "kick", data: { host: "kick.com", reason: "background_recovered" } },
    ]);
    expect(events.every((event) => event.category === "activity" || !event.message.includes("secret=value"))).toBe(true);
  });

  it("does not report a close activity when managed page-context removal fails", async () => {
    const browser = browserMock();
    browser.tabs.remove.mockRejectedValue(new Error("already gone"));
    const events: EngineEvent[] = [];
    registerManagedPageContextTabs({
      kick: { platform: "kick", tabId: 14, originUrl: "https://kick.com", origin: "https://kick.com", ownedByExtension: true },
    });

    await stopManagedPageContextTabsWithBrowser(browser, currentManagedPageContextTabs(), {
      platforms: ["kick"],
      reason: "background_recovered",
      emit: (event) => events.push(event),
    });

    expect(events.some((event) => event.category === "activity" && event.code === "page_context_closed")).toBe(false);
  });

  it("does not report a close activity without a browser removal capability", async () => {
    const browser = browserMock();
    browser.tabs.remove = undefined as unknown as typeof browser.tabs.remove;
    const events: EngineEvent[] = [];
    registerManagedPageContextTabs({
      kick: { platform: "kick", tabId: 14, originUrl: "https://kick.com/drops/inventory", origin: "https://kick.com", ownedByExtension: true },
    });

    await stopManagedPageContextTabsWithBrowser(browser, currentManagedPageContextTabs(), {
      platforms: ["kick"],
      reason: "background_recovered",
      emit: (event) => events.push(event),
    });

    expect(events.some((event) => event.category === "activity" && event.code === "page_context_closed")).toBe(false);
    expect(currentManagedPageContextTabs().kick).toBeUndefined();
  });

  it("releases a retained Kick context only after sustained background recovery", async () => {
    const browser = browserMock();
    browser.tabs.get.mockResolvedValue({ id: 14, url: "https://kick.com" });
    const events: EngineEvent[] = [];
    const emit = (event: EngineEvent) => events.push(event);
    const startedAt = Date.parse("2026-07-21T12:00:00.000Z");
    registerManagedPageContextTabs({
      kick: { platform: "kick", tabId: 14, originUrl: "https://kick.com", origin: "https://kick.com", ownedByExtension: true },
    });
    recordManagedPageContextFallback("kick", "web.kick.com", emit, startedAt);

    await reconcileManagedPageContextRecoveryWithBrowser(browser, "kick", { backgroundHosts: ["web.kick.com"], fallbackHosts: [] }, 3, emit);
    await reconcileManagedPageContextRecoveryWithBrowser(browser, "kick", { backgroundHosts: ["web.kick.com"], fallbackHosts: [] }, 3, emit);
    expect(browser.tabs.remove).not.toHaveBeenCalled();

    await reconcileManagedPageContextRecoveryWithBrowser(browser, "kick", { backgroundHosts: ["web.kick.com"], fallbackHosts: [] }, 3, emit);

    expect(browser.tabs.remove).toHaveBeenCalledOnce();
    expect(currentManagedPageContextTabs().kick).toBeUndefined();
    expect(events).toContainEqual({
      category: "activity",
      code: "page_context_closed",
      level: "info",
      platform: "kick",
      data: { host: "kick.com", reason: "background_recovered" },
    });
  });

  it("resets managed context recovery when another page fallback is required", async () => {
    const browser = browserMock();
    const startedAt = Date.parse("2026-07-21T12:00:00.000Z");
    registerManagedPageContextTabs({
      kick: { platform: "kick", tabId: 14, originUrl: "https://kick.com", origin: "https://kick.com", ownedByExtension: true },
    });
    recordManagedPageContextFallback("kick", "web.kick.com", undefined, startedAt);
    await reconcileManagedPageContextRecoveryWithBrowser(browser, "kick", { backgroundHosts: ["web.kick.com"], fallbackHosts: [] }, 3);
    await reconcileManagedPageContextRecoveryWithBrowser(browser, "kick", { backgroundHosts: ["web.kick.com"], fallbackHosts: [] }, 3);
    await reconcileManagedPageContextRecoveryWithBrowser(browser, "kick", { backgroundHosts: ["web.kick.com"], fallbackHosts: ["web.kick.com"] }, 3);
    await reconcileManagedPageContextRecoveryWithBrowser(browser, "kick", { backgroundHosts: ["web.kick.com"], fallbackHosts: [] }, 3);

    expect(browser.tabs.remove).not.toHaveBeenCalled();
    expect(currentManagedPageContextTabs().kick).toMatchObject({ backgroundSuccesses: 1 });
  });

  it("forgets stale recovery ownership without closing a user tab that reused the id", async () => {
    const browser = browserMock();
    browser.tabs.get.mockResolvedValue({ id: 14, url: "https://example.com" });
    registerManagedPageContextTabs({
      kick: {
        platform: "kick",
        tabId: 14,
        originUrl: "https://kick.com",
        origin: "https://kick.com",
        ownedByExtension: true,
        fallbackHost: "kick.com",
        backgroundSuccesses: 0,
      },
    });

    await reconcileManagedPageContextRecoveryWithBrowser(
      browser,
      "kick",
      { backgroundHosts: ["kick.com"], fallbackHosts: [] },
      1,
    );

    expect(browser.tabs.remove).not.toHaveBeenCalled();
    expect(currentManagedPageContextTabs().kick).toBeUndefined();
  });

  it("keeps tab diagnostics scoped to the supplied emitter", async () => {
    const first: EngineEvent[] = [];
    const second: EngineEvent[] = [];
    await openPinnedMutedTabWithBrowser(browserMock(), channel, undefined, { keepVideosUnmuted: false }, (event) => first.push(event));
    await openPinnedMutedTabWithBrowser(browserMock(), channel, undefined, { keepVideosUnmuted: false }, (event) => second.push(event));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).not.toBe(second[0]);
  });

  it("reuses and repins an existing stored tab", async () => {
    const browser = browserMock();
    browser.tabs.get.mockResolvedValue({ id: 4 });

    const result = await openPinnedMutedTabWithBrowser(browser, channel, { platform: "twitch", status: "watching", offlineChecks: 0, tabId: 4, tabManagedByExtension: true });

    expect(result).toEqual({
      tabId: 4,
      managedByExtension: true,
      managedTab: {
        platform: "twitch",
        tabId: 4,
        channelUrl: channel.url,
        ownedByExtension: true,
      },
    });
    expect(browser.tabs.update).toHaveBeenCalledWith(4, {
      url: channel.url,
      pinned: true,
      muted: true,
      active: false,
    });
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });

  it("primes a matching managed tab when playback telemetry is not healthy yet", async () => {
    const browser = browserMock();
    browser.tabs.get.mockResolvedValue({
      id: 4,
      url: channel.url,
      pinned: true,
      mutedInfo: { muted: true },
      active: false,
    });

    await openPinnedMutedTabWithBrowser(browser, channel, { platform: "twitch", status: "watching", offlineChecks: 0, tabId: 4, tabManagedByExtension: true });

    expect(browser.tabs.update).toHaveBeenCalledWith(4, { active: true });
  });

  it("does not update the managed tab when it already matches the target channel, options, and healthy playback", async () => {
    const browser = browserMock();
    browser.tabs.get.mockResolvedValue({
      id: 4,
      url: channel.url,
      pinned: true,
      mutedInfo: { muted: true },
      active: false,
    });

    await openPinnedMutedTabWithBrowser(browser, channel, {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 4,
      tabManagedByExtension: true,
      playback: {
        platform: "twitch",
        checkedAt: new Date().toISOString(),
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
      },
    });

    expect(browser.tabs.update).not.toHaveBeenCalled();
  });

  // A clock rollback can leave `playback.checkedAt` in the future. Reading
  // that as "just checked" would let stale-but-healthy-looking telemetry from
  // before the rollback suppress re-priming indefinitely, so a future stamp
  // counts as stale and re-priming still happens.
  it("re-primes a matching managed tab whose playback telemetry is stamped in the future", async () => {
    const browser = browserMock();
    browser.tabs.get.mockResolvedValue({
      id: 4,
      url: channel.url,
      pinned: true,
      mutedInfo: { muted: true },
      active: false,
    });

    await openPinnedMutedTabWithBrowser(browser, channel, {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 4,
      tabManagedByExtension: true,
      playback: {
        platform: "twitch",
        checkedAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
      },
    });

    expect(browser.tabs.update).toHaveBeenCalledWith(4, { active: true });
  });

  // An unparseable `checkedAt` must land on the same "stale" branch as a
  // future one — previously NaN comparisons were always false, so it fell
  // through to the telemetry check and read as healthy instead.
  it("re-primes a matching managed tab whose playback telemetry has an unparseable timestamp", async () => {
    const browser = browserMock();
    browser.tabs.get.mockResolvedValue({
      id: 4,
      url: channel.url,
      pinned: true,
      mutedInfo: { muted: true },
      active: false,
    });

    await openPinnedMutedTabWithBrowser(browser, channel, {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 4,
      tabManagedByExtension: true,
      playback: {
        platform: "twitch",
        checkedAt: "not-a-date",
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
      },
    });

    expect(browser.tabs.update).toHaveBeenCalledWith(4, { active: true });
  });

  it("does not re-prime a matching managed tab that is playing but muted", async () => {
    const browser = browserMock();
    browser.tabs.get.mockResolvedValue({
      id: 4,
      url: channel.url,
      pinned: true,
      mutedInfo: { muted: true },
      active: false,
    });

    await openPinnedMutedTabWithBrowser(browser, channel, {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 4,
      tabManagedByExtension: true,
      playback: {
        platform: "twitch",
        checkedAt: new Date().toISOString(),
        videoCount: 1,
        mutedVideoCount: 1,
        unmutedVideoCount: 0,
        playingVideoCount: 1,
        blockedPlaybackCount: 1,
        documentHidden: false,
      },
    });

    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(browser.tabs.query).not.toHaveBeenCalled();
  });

  it("stops priming a managed tab whose playback never starts", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2026-07-21T12:00:00.000Z"));
      const browser = browserMock();
      browser.tabs.get.mockResolvedValue({
        id: 4,
        url: channel.url,
        pinned: true,
        mutedInfo: { muted: true },
        active: false,
      });
      const events: EngineEvent[] = [];

      for (let tick = 0; tick < PLAYBACK_PRIME_MAX_ATTEMPTS + 3; tick += 1) {
        await openPinnedMutedTabWithBrowser(browser, channel, stalledSession(), undefined, (event) => events.push(event));
        vi.setSystemTime(Date.now() + PLAYBACK_PRIME_BACKOFF_MS);
      }

      expect(activationCalls(browser)).toHaveLength(PLAYBACK_PRIME_MAX_ATTEMPTS);
      expect(events.some((event) => event.category === "diagnostic" && event.level === "warn" && event.message.includes("priming"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off instead of priming a managed tab on every tick", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2026-07-21T12:00:00.000Z"));
      const browser = browserMock();
      browser.tabs.get.mockResolvedValue({
        id: 4,
        url: channel.url,
        pinned: true,
        mutedInfo: { muted: true },
        active: false,
      });

      await openPinnedMutedTabWithBrowser(browser, channel, stalledSession());
      vi.setSystemTime(Date.now() + 1_000);
      await openPinnedMutedTabWithBrowser(browser, channel, stalledSession());

      expect(activationCalls(browser)).toHaveLength(1);

      vi.setSystemTime(Date.now() + PLAYBACK_PRIME_BACKOFF_MS);
      await openPinnedMutedTabWithBrowser(browser, channel, stalledSession());
      expect(activationCalls(browser)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows priming again once playback recovers on a managed tab", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2026-07-21T12:00:00.000Z"));
      const browser = browserMock();
      browser.tabs.get.mockResolvedValue({
        id: 4,
        url: channel.url,
        pinned: true,
        mutedInfo: { muted: true },
        active: false,
      });

      for (let tick = 0; tick < PLAYBACK_PRIME_MAX_ATTEMPTS; tick += 1) {
        await openPinnedMutedTabWithBrowser(browser, channel, stalledSession());
        vi.setSystemTime(Date.now() + PLAYBACK_PRIME_BACKOFF_MS);
      }
      await openPinnedMutedTabWithBrowser(browser, channel, healthySession());
      vi.setSystemTime(Date.now() + PLAYBACK_PRIME_BACKOFF_MS);
      await openPinnedMutedTabWithBrowser(browser, channel, stalledSession());

      expect(activationCalls(browser)).toHaveLength(PLAYBACK_PRIME_MAX_ATTEMPTS + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  // The scheduler condemns a watch tab whose playback never reports healthy and
  // recreates it, so the tab id is different on every cycle. The priming budget
  // must survive that churn or the cap never engages.
  it("stops priming across watch tab recreation for the same channel", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2026-07-21T12:00:00.000Z"));
      const browser = browserMock();
      browser.tabs.get.mockRejectedValue(new Error("missing"));
      let nextTabId = 1450140654;
      browser.tabs.create.mockImplementation(async () => ({ id: (nextTabId += 4) }));
      const events: EngineEvent[] = [];

      for (let cycle = 0; cycle < PLAYBACK_PRIME_MAX_ATTEMPTS + 3; cycle += 1) {
        await openPinnedMutedTabWithBrowser(
          browser,
          channel,
          { platform: "twitch", status: "watching", offlineChecks: 0, tabId: nextTabId, tabManagedByExtension: true },
          undefined,
          (event) => events.push(event),
        );
        vi.setSystemTime(Date.now() + PLAYBACK_PRIME_BACKOFF_MS);
      }

      expect(browser.tabs.create).toHaveBeenCalledTimes(PLAYBACK_PRIME_MAX_ATTEMPTS + 3);
      expect(activationCalls(browser)).toHaveLength(PLAYBACK_PRIME_MAX_ATTEMPTS);
      expect(events.filter((event) => event.category === "diagnostic" && event.level === "warn")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("primes a recreated watch tab again when the channel changed", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2026-07-21T12:00:00.000Z"));
      const browser = browserMock();
      browser.tabs.get.mockRejectedValue(new Error("missing"));
      let nextTabId = 1450140654;
      browser.tabs.create.mockImplementation(async () => ({ id: (nextTabId += 4) }));

      for (let cycle = 0; cycle < PLAYBACK_PRIME_MAX_ATTEMPTS + 1; cycle += 1) {
        await openPinnedMutedTabWithBrowser(browser, channel);
        vi.setSystemTime(Date.now() + PLAYBACK_PRIME_BACKOFF_MS);
      }
      expect(activationCalls(browser)).toHaveLength(PLAYBACK_PRIME_MAX_ATTEMPTS);

      await openPinnedMutedTabWithBrowser(browser, { ...channel, username: "next", url: "https://www.twitch.tv/next" });

      expect(activationCalls(browser)).toHaveLength(PLAYBACK_PRIME_MAX_ATTEMPTS + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates one new managed tab when the registered tab is stale", async () => {
    const browser = browserMock();
    browser.tabs.get.mockRejectedValue(new Error("missing"));
    browser.tabs.query.mockResolvedValue([{ id: 7 }]);

    const result = await openPinnedMutedTabWithBrowser(browser, channel, { platform: "twitch", status: "watching", offlineChecks: 0, tabId: 4, tabManagedByExtension: true });

    expect(result).toEqual({
      tabId: 9,
      managedByExtension: true,
      managedTab: {
        platform: "twitch",
        tabId: 9,
        channelUrl: channel.url,
        ownedByExtension: true,
      },
    });
    expect(browser.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(browser.tabs.remove).toHaveBeenCalledWith(4);
    expect(browser.tabs.create).toHaveBeenCalledTimes(1);
    expect(browser.tabs.update).toHaveBeenCalledWith(9, { pinned: true, muted: true, active: false });
    expect(browser.tabs.update).toHaveBeenCalledWith(9, { active: true });
    expect(browser.tabs.update).toHaveBeenCalledWith(7, { active: true });
  });

  it("creates pinned tabs and then mutes them", async () => {
    const browser = browserMock();

    const result = await openPinnedMutedTabWithBrowser(browser, channel);

    expect(result).toEqual({
      tabId: 9,
      managedByExtension: true,
      managedTab: {
        platform: "twitch",
        tabId: 9,
        channelUrl: channel.url,
        ownedByExtension: true,
      },
    });
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: channel.url,
      pinned: true,
      active: false,
    });
    expect(browser.tabs.update).toHaveBeenCalledWith(9, { pinned: true, muted: true, active: false });
  });

  it("closes a newly created managed tab when creation finishes after cancellation", async () => {
    const browser = browserMock();
    const abort = new AbortController();
    vi.mocked(browser.tabs.create).mockImplementation(async () => {
      abort.abort(new Error("reset"));
      return { id: 9 };
    });

    await expect(openPinnedMutedTabWithBrowser(
      browser,
      channel,
      undefined,
      { signal: abort.signal },
    )).rejects.toThrow("reset");

    expect(browser.tabs.remove).toHaveBeenCalledWith(9);
    expect(browser.tabs.update).not.toHaveBeenCalledWith(9, expect.anything());
  });

  it("does not foreground-prime new tabs when page video control is disabled", async () => {
    const browser = browserMock();

    await openPinnedMutedTabWithBrowser(browser, channel, undefined, { keepVideosUnmuted: false });

    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: channel.url,
      pinned: true,
      active: false,
    });
    expect(browser.tabs.update).toHaveBeenCalledTimes(1);
    expect(browser.tabs.update).toHaveBeenCalledWith(9, { pinned: true, muted: true, active: false });
    expect(browser.tabs.query).not.toHaveBeenCalled();
  });

  it("updates a registered managed tab when switching channels", async () => {
    const browser = browserMock();
    const nextChannel = { ...channel, username: "next", url: "https://www.twitch.tv/next" };
    browser.tabs.get.mockResolvedValue({ id: 4 });

    const result = await openPinnedMutedTabWithBrowser(browser, nextChannel, undefined, {
      managedTab: {
        platform: "twitch",
        tabId: 4,
        channelUrl: channel.url,
        ownedByExtension: true,
      },
    });

    expect(result).toEqual({
      tabId: 4,
      managedByExtension: true,
      managedTab: {
        platform: "twitch",
        tabId: 4,
        channelUrl: nextChannel.url,
        ownedByExtension: true,
      },
    });
    expect(browser.tabs.update).toHaveBeenCalledWith(4, {
      url: nextChannel.url,
      pinned: true,
      muted: true,
      active: false,
    });
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });

  it("does not treat user-opened matching tabs as managed or close them", async () => {
    const browser = browserMock();
    browser.tabs.query.mockResolvedValue([{ id: 7 }]);

    await openPinnedMutedTabWithBrowser(browser, channel);

    expect(browser.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(browser.tabs.remove).not.toHaveBeenCalled();
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: channel.url,
      pinned: true,
      active: false,
    });
  });

  it("closes extension-managed watch tabs on stop", async () => {
    const browser = browserMock();

    await stopWatchTabWithBrowser(browser, {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 4,
      tabManagedByExtension: true,
    });

    expect(browser.tabs.remove).toHaveBeenCalledWith(4);
    expect(browser.tabs.update).not.toHaveBeenCalled();
  });

  it("restores reused user tabs on stop instead of closing them", async () => {
    const browser = browserMock();

    await stopWatchTabWithBrowser(browser, {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 4,
      tabManagedByExtension: false,
    });

    expect(browser.tabs.remove).not.toHaveBeenCalled();
    expect(browser.tabs.update).toHaveBeenCalledWith(4, { muted: false, pinned: false, active: false });
  });

  it("uses scripting execution for page-context fetches", async () => {
    const browser = {
      ...browserMock(),
      scripting: {
        executeScript: vi.fn(async () => [{ result: { ok: true } }]),
      },
    };
    browser.tabs.query.mockResolvedValue([{ id: 3 }]);

    const result = await fetchJsonInPageWithBrowser<{ ok: boolean }>(
      browser,
      "https://kick.com",
      "https://web.kick.com/api/v1/drops/progress",
    );

    expect(result).toEqual({ ok: true });
    expect(browser.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 3 },
      // MAIN world is required so Cloudflare-protected APIs (Kick) accept the fetch.
      world: "MAIN",
      // args must be JSON-serializable: null, never undefined ("unserializable").
      args: ["https://web.kick.com/api/v1/drops/progress", null],
    }));
    expect(browser.tabs.remove).not.toHaveBeenCalled();
  });

  it("omits AbortSignal from page-world RequestInit while preserving request fields", async () => {
    const browser = {
      ...browserMock(),
      scripting: {
        executeScript: vi.fn(async () => [{ result: { ok: true } }]),
      },
    };
    browser.tabs.query.mockResolvedValue([{ id: 3 }]);
    const abort = new AbortController();

    await fetchJsonInPageWithBrowser(
      browser,
      "https://kick.com",
      "https://web.kick.com/api/v1/drops/progress",
      { method: "POST", body: "{\"campaign\":\"drop\"}", signal: abort.signal },
    );

    expect(browser.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        "https://web.kick.com/api/v1/drops/progress",
        JSON.stringify({ method: "POST", body: "{\"campaign\":\"drop\"}" }),
      ],
    }));
  });

  it("aborts an active page fallback without retaining its newly opened context", async () => {
    const pageExecution = deferred<Array<{ result?: unknown }>>();
    const executeScript = vi.fn()
      .mockResolvedValueOnce([{ result: { usable: true } }])
      .mockReturnValueOnce(pageExecution.promise);
    const browser = {
      ...browserMock(),
      scripting: { executeScript },
    };
    browser.tabs.create.mockResolvedValue({ id: 14 });
    const abort = new AbortController();
    const reason = new Error("auth deadline elapsed");

    const request = fetchJsonInPageWithBrowser(
      browser,
      "https://kick.com/drops/inventory",
      "https://kick.com/api/v1/user",
      { signal: abort.signal },
      { retainPageContext: { platform: "kick" } },
    );
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(2));

    abort.abort(reason);
    pageExecution.reject(new Error("page execution closed after abort"));

    await expect(request).rejects.toBe(reason);
    expect(browser.tabs.remove).toHaveBeenCalledWith(14);
    expect(currentManagedPageContextTabs().kick).toBeUndefined();
  });

  it("does not create a page-context tab when abort lands during tab discovery", async () => {
    const query = deferred<Array<{ id?: number; url?: string; status?: string }>>();
    const browser = {
      ...browserMock(),
      scripting: { executeScript: vi.fn(async () => [{ result: { usable: true } }]) },
    };
    browser.tabs.query.mockReturnValue(query.promise);
    const abort = new AbortController();
    const reason = new Error("auth deadline elapsed during tab discovery");

    const request = fetchJsonInPageWithBrowser(
      browser,
      "https://kick.com/drops/inventory",
      "https://kick.com/api/v1/user",
      { signal: abort.signal },
      { retainPageContext: { platform: "kick" } },
    );
    abort.abort(reason);
    query.resolve([]);

    await expect(request).rejects.toBe(reason);
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });

  it("removes a newly created page-context tab immediately when readiness aborts", async () => {
    const validation = deferred<Array<{ result?: unknown }>>();
    const browser = {
      ...browserMock(),
      scripting: { executeScript: vi.fn(() => validation.promise) },
    };
    browser.tabs.create.mockResolvedValue({ id: 14 });
    const abort = new AbortController();
    const reason = new Error("auth deadline elapsed during page readiness");

    const request = fetchJsonInPageWithBrowser(
      browser,
      "https://kick.com/drops/inventory",
      "https://kick.com/api/v1/user",
      { signal: abort.signal },
      { retainPageContext: { platform: "kick" } },
    );
    const outcome = request.catch((error: unknown) => error);
    await vi.waitFor(() => expect(browser.scripting.executeScript).toHaveBeenCalledOnce());
    abort.abort(reason);
    let cleanupFailure: unknown;
    try {
      await vi.waitFor(() => expect(browser.tabs.remove).toHaveBeenCalledWith(14), {
        timeout: 50,
        interval: 5,
      });
    } catch (error) {
      cleanupFailure = error;
    }
    validation.resolve([{ result: { usable: true } }]);

    expect(await outcome).toBe(reason);
    expect(cleanupFailure).toBeUndefined();
    expect(currentManagedPageContextTabs().kick).toBeUndefined();
  });

  it("reconstructs sanitized page-context failures", async () => {
    const executeScript = vi.fn()
      .mockResolvedValueOnce([{ result: { usable: true } }])
      .mockResolvedValueOnce([{ result: {
        __lurklootPageFetch: true,
        ok: false,
        error: {
          kind: "security_policy_blocked",
          status: 403,
          reason: "Request blocked by security policy.",
          reference: "9e4db7e3",
          token: "must-not-survive",
        },
      } }]);
    const browser = {
      ...browserMock(),
      scripting: { executeScript },
    };
    browser.tabs.query.mockResolvedValue([{ id: 3 }]);

    const error = await fetchJsonInPageWithBrowser(
      browser,
      "https://kick.com",
      "https://kick.com/api/v1/user",
    ).catch((caught: unknown) => caught);

    expect(isSafeFetchError(error)).toBe(true);
    if (!isSafeFetchError(error)) throw new Error("Expected SafeFetchError");
    expect(error.failure).toEqual({
      kind: "security_policy_blocked",
      status: 403,
      reason: "Request blocked by security policy.",
      reference: "9e4db7e3",
    });
    expect(JSON.stringify(error)).not.toContain("must-not-survive");
  });

  it("rejects a completed security-policy document and recovers with a valid Kick context", async () => {
    const executeScript = vi.fn()
      .mockResolvedValueOnce([{ result: {
        usable: false,
        failure: {
          kind: "security_policy_blocked",
          status: 403,
          reason: "Request blocked by security policy.",
          reference: "9e4db7e3",
        },
      } }])
      .mockResolvedValueOnce([{ result: { usable: true } }])
      .mockResolvedValueOnce([{ result: {
        __lurklootPageFetch: true,
        ok: true,
        data: { id: 42, username: "viewer" },
      } }]);
    const browser = {
      ...browserMock(),
      scripting: { executeScript },
    };
    browser.tabs.query.mockResolvedValue([{
      id: 3,
      url: "https://kick.com/",
      status: "complete",
    }]);
    browser.tabs.create.mockResolvedValue({ id: 14 });

    const result = await fetchJsonInPageWithBrowser<{ id: number; username: string }>(
      browser,
      "https://kick.com/drops/inventory",
      "https://kick.com/api/v1/user",
      undefined,
      { retainPageContext: { platform: "kick" } },
    );

    expect(result).toEqual({ id: 42, username: "viewer" });
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: "https://kick.com/drops/inventory",
      pinned: false,
      active: false,
    });
    expect(executeScript.mock.calls.map(([details]) => details.target)).toEqual([
      { tabId: 3 },
      { tabId: 14 },
      { tabId: 14 },
    ]);
    expect(currentManagedPageContextTabs().kick?.tabId).toBe(14);
  });

  it("throws a clear error when page-context execution returns no result", async () => {
    const executeScript = vi.fn()
      .mockResolvedValueOnce([{ result: { usable: true } }])
      .mockResolvedValueOnce([]);
    const browser = {
      ...browserMock(),
      scripting: { executeScript },
    };
    browser.tabs.query.mockResolvedValue([{ id: 3 }]);

    await expect(
      fetchJsonInPageWithBrowser(browser, "https://kick.com", "https://web.kick.com/api/v1/drops/progress"),
    ).rejects.toThrow(/returned no script result/);
  });

  it("closes an extension-created page-context tab after a fetch", async () => {
    const browser = {
      ...browserMock(),
      scripting: {
        executeScript: vi.fn(async () => [{ result: { ok: true } }]),
      },
    };
    browser.tabs.create.mockResolvedValue({ id: 14 });

    const result = await fetchJsonInPageWithBrowser<{ ok: boolean }>(
      browser,
      "https://www.twitch.tv/drops/inventory",
      "https://gql.twitch.tv/gql",
    );

    expect(result).toEqual({ ok: true });
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: "https://www.twitch.tv/drops/inventory",
      pinned: false,
      active: false,
    });
    expect(browser.tabs.update).toHaveBeenCalledWith(14, { muted: true, active: false });
    expect(browser.tabs.remove).toHaveBeenCalledWith(14);
  });

  it("retains an extension-created page-context tab when requested", async () => {
    const browser = {
      ...browserMock(),
      scripting: {
        executeScript: vi.fn(async () => [{ result: { ok: true } }]),
      },
    };
    browser.tabs.create.mockResolvedValue({ id: 14 });

    const result = await fetchJsonInPageWithBrowser<{ ok: boolean }>(
      browser,
      "https://www.twitch.tv/drops/inventory",
      "https://gql.twitch.tv/gql",
      undefined,
      { retainPageContext: { platform: "twitch" } },
    );

    expect(result).toEqual({ ok: true });
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: "https://www.twitch.tv/drops/inventory",
      pinned: false,
      active: false,
    });
    expect(browser.tabs.remove).not.toHaveBeenCalled();
    expect(currentManagedPageContextTabs()).toMatchObject({
      twitch: {
        platform: "twitch",
        tabId: 14,
        originUrl: "https://www.twitch.tv/drops/inventory",
        origin: "https://www.twitch.tv",
        ownedByExtension: true,
      },
    });
  });

  it("reuses a retained page-context tab instead of creating a new one", async () => {
    const browser = {
      ...browserMock(),
      scripting: {
        executeScript: vi.fn(async () => [{ result: { ok: true } }]),
      },
    };
    browser.tabs.get.mockResolvedValue({ id: 14, url: "https://www.twitch.tv/drops/inventory" });
    registerManagedPageContextTabs({
      twitch: {
        platform: "twitch",
        tabId: 14,
        originUrl: "https://www.twitch.tv/drops/inventory",
        origin: "https://www.twitch.tv",
        ownedByExtension: true,
      },
    });

    await fetchJsonInPageWithBrowser(
      browser,
      "https://www.twitch.tv/drops/inventory",
      "https://gql.twitch.tv/gql",
      undefined,
      { retainPageContext: { platform: "twitch" } },
    );

    expect(browser.tabs.get).toHaveBeenCalledWith(14);
    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect(browser.tabs.remove).not.toHaveBeenCalled();
    expect(browser.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 14 },
    }));
  });

  it("replaces a retained page context that navigated away from its origin", async () => {
    const browser = {
      ...browserMock(),
      scripting: { executeScript: vi.fn(async () => [{ result: { ok: true } }]) },
    };
    browser.tabs.get.mockResolvedValue({ id: 14, url: "https://example.com/elsewhere" });
    browser.tabs.create.mockResolvedValue({ id: 15 });
    registerManagedPageContextTabs({
      kick: { platform: "kick", tabId: 14, originUrl: "https://kick.com", origin: "https://kick.com", ownedByExtension: true },
    });
    const events: EngineEvent[] = [];

    await fetchJsonInPageWithBrowser(
      browser,
      "https://kick.com",
      "https://web.kick.com/api/v1/drops/progress",
      undefined,
      { retainPageContext: { platform: "kick" }, emit: (event) => events.push(event), openReason: "background_rejected" },
    );

    expect(browser.tabs.remove).toHaveBeenCalledWith(14);
    expect(browser.tabs.create).toHaveBeenCalledOnce();
    expect(currentManagedPageContextTabs().kick?.tabId).toBe(15);
    expect(events.filter((event) => event.category === "activity")).toEqual([
      { category: "activity", code: "page_context_closed", level: "info", platform: "kick", data: { host: "kick.com", reason: "managed_context_unusable" } },
      { category: "activity", code: "page_context_opened", level: "info", platform: "kick", data: { host: "kick.com", reason: "managed_context_unusable" } },
    ]);
    // The reason survives into the diagnostic log through the controller's
    // mirror rather than a hand-written diagnostic next to each emit site.
    const opened = events.find((event) => event.category === "activity" && event.code === "page_context_opened");
    expect(activityDiagnostic(opened as Extract<EngineEvent, { category: "activity" }>).message)
      .toBe("Opened managed page context on kick.com: reason=managed_context_unusable");
  });

  it("does not close an existing user tab reused for a page-context fetch", async () => {
    const browser = {
      ...browserMock(),
      scripting: {
        executeScript: vi.fn(async () => [{ result: { ok: true } }]),
      },
    };
    browser.tabs.query.mockResolvedValue([{ id: 3 }]);

    await fetchJsonInPageWithBrowser(
      browser,
      "https://kick.com",
      "https://web.kick.com/api/v1/drops/progress",
    );

    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect(browser.tabs.remove).not.toHaveBeenCalled();
  });

  it("prefers an existing user tab over a retained page-context tab", async () => {
    const browser = {
      ...browserMock(),
      scripting: {
        executeScript: vi.fn(async () => [{ result: { ok: true } }]),
      },
    };
    browser.tabs.query.mockResolvedValue([{ id: 3 }, { id: 14 }]);
    registerManagedPageContextTabs({
      kick: {
        platform: "kick",
        tabId: 14,
        originUrl: "https://kick.com",
        origin: "https://kick.com",
        ownedByExtension: true,
      },
    });

    await fetchJsonInPageWithBrowser(
      browser,
      "https://kick.com",
      "https://web.kick.com/api/v1/drops/progress",
      undefined,
      { retainPageContext: { platform: "kick" } },
    );

    expect(browser.tabs.get).not.toHaveBeenCalled();
    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect(browser.tabs.remove).toHaveBeenCalledWith(14);
    expect(browser.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 3 },
    }));
  });

  it("shares one page-context tab creation across concurrent fetches for the same origin", async () => {
    const browser = {
      ...browserMock(),
      scripting: {
        executeScript: vi.fn(async () => [{ result: { ok: true } }]),
      },
    };
    browser.tabs.create.mockImplementation(async () => {
      await Promise.resolve();
      return { id: 14 };
    });

    await Promise.all([
      fetchJsonInPageWithBrowser(browser, "https://www.twitch.tv/drops/inventory", "https://gql.twitch.tv/gql"),
      fetchJsonInPageWithBrowser(browser, "https://www.twitch.tv/drops/inventory", "https://gql.twitch.tv/gql"),
    ]);

    expect(browser.tabs.create).toHaveBeenCalledTimes(1);
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: "https://www.twitch.tv/drops/inventory",
      pinned: false,
      active: false,
    });
    expect(browser.tabs.update).toHaveBeenCalledWith(14, { muted: true, active: false });
    expect(browser.scripting.executeScript).toHaveBeenCalledTimes(2);
    expect(browser.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 14 },
    }));
    expect(browser.tabs.remove).toHaveBeenCalledTimes(1);
    expect(browser.tabs.remove).toHaveBeenCalledWith(14);
  });
});

describe("twitch integrity refresh", () => {
  beforeEach(() => {
    registerManagedPageContextTabs({});
    setTwitchIntegrity(undefined);
    resetTwitchIntegrityRefreshBounds();
  });

  const fresh = () => ({
    integrity: "fresh-token",
    clientSessionId: "page-session",
    deviceId: "page-device",
    expiresAt: Date.now() + 60_000,
  });

  describe("setTwitchIntegrity capture logging", () => {
    it("logs an info entry only when the token is new", () => {
      const events: EngineEvent[] = [];
      const emit = (event: EngineEvent) => events.push(event);

      setTwitchIntegrity(fresh(), { isNew: true }, emit);
      setTwitchIntegrity(fresh(), { isNew: false }, emit);
      setTwitchIntegrity(fresh(), undefined, emit);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        level: "info",
        message: expect.stringContaining("Captured a fresh Twitch integrity token"),
      });
    });
  });

  describe("hasValidTwitchIntegrity", () => {
    it("is false when no token is set", () => {
      expect(hasValidTwitchIntegrity()).toBe(false);
    });

    it("is false for an expired token", () => {
      setTwitchIntegrity({ integrity: "t", expiresAt: Date.now() - 1 });
      expect(hasValidTwitchIntegrity()).toBe(false);
    });

    it("is false for a token expiring within the staleness skew", () => {
      // Inside the 30s skew window — treated as already stale to avoid a mid-flight expiry.
      setTwitchIntegrity({ integrity: "t", expiresAt: Date.now() + 10_000 });
      expect(hasValidTwitchIntegrity()).toBe(false);
    });

    it("is true for a token comfortably beyond the skew", () => {
      setTwitchIntegrity(fresh());
      expect(hasValidTwitchIntegrity()).toBe(true);
    });
  });

  describe("isValidTwitchIntegrity", () => {
    const now = 1_000_000;

    it("accepts a token outside the 30-second expiry skew", () => {
      expect(isValidTwitchIntegrity({
        integrity: "valid-token",
        expiresAt: now + 30_001,
      }, now)).toBe(true);
    });

    it("rejects a missing token", () => {
      expect(isValidTwitchIntegrity(undefined, now)).toBe(false);
    });

    it("rejects an expired token", () => {
      expect(isValidTwitchIntegrity({
        integrity: "expired-token",
        expiresAt: now,
      }, now)).toBe(false);
    });

    it("rejects a token at the 30-second expiry skew boundary", () => {
      expect(isValidTwitchIntegrity({
        integrity: "inside-skew-token",
        expiresAt: now + 30_000,
      }, now)).toBe(false);
    });
  });

  describe("ensureTwitchIntegrityWithBrowser", () => {
    it("fast-returns without touching tabs when a valid token already exists", async () => {
      const browser = browserMock();
      setTwitchIntegrity(fresh());

      const ok = await ensureTwitchIntegrityWithBrowser(browser, "https://www.twitch.tv/drops/inventory");

      expect(ok).toBe(true);
      expect(browser.tabs.query).not.toHaveBeenCalled();
      expect(browser.tabs.create).not.toHaveBeenCalled();
    });

    it("reuses an existing twitch.tv tab and resolves once a token is captured", async () => {
      const browser = browserMock();
      browser.tabs.query.mockResolvedValue([{ id: 3 }]);

      // The webRequest listener captures a token shortly after the page loads.
      setTimeout(() => setTwitchIntegrity(fresh(), { isNew: true }), 20);
      const ok = await ensureTwitchIntegrityWithBrowser(browser, "https://www.twitch.tv/drops/inventory", 5_000);

      expect(ok).toBe(true);
      expect(browser.tabs.create).not.toHaveBeenCalled();
      // A reused tab we did not open must never be closed.
      expect(browser.tabs.remove).not.toHaveBeenCalled();
    });

    it("closes a tab created only to capture Twitch integrity", async () => {
      const browser = browserMock();
      browser.tabs.create.mockResolvedValue({ id: 14 });

      setTimeout(() => setTwitchIntegrity(fresh(), { isNew: true }), 20);
      const ok = await ensureTwitchIntegrityWithBrowser(browser, "https://www.twitch.tv/drops/inventory", 5_000);

      expect(ok).toBe(true);
      expect(browser.tabs.create).toHaveBeenCalledWith({
        url: "https://www.twitch.tv/drops/inventory",
        pinned: false,
        active: false,
      });
      expect(browser.tabs.remove).toHaveBeenCalledWith(14);
      expect(currentManagedPageContextTabs()).not.toHaveProperty("twitch");
    });

    it("opens page context immediately on the first missing-token check", async () => {
      const browser = browserMock();
      browser.tabs.query.mockResolvedValue([]);
      browser.tabs.create.mockResolvedValue({ id: 14 });

      const pending = ensureTwitchIntegrityWithBrowser(
        browser,
        "https://www.twitch.tv/drops/inventory",
        50,
      );

      await vi.waitFor(() => {
        expect(browser.tabs.create).toHaveBeenCalledTimes(1);
      });
      expect(browser.tabs.create).toHaveBeenCalledWith({
        url: "https://www.twitch.tv/drops/inventory",
        pinned: false,
        active: false,
      });
      await expect(pending).resolves.toBe(false);
    });

    it("shares one page-context mint between concurrent ordinary acquisitions", async () => {
      const browser = browserMock();
      browser.tabs.create.mockResolvedValue({ id: 51 });

      const first = ensureTwitchIntegrityWithBrowser(
        browser,
        "https://www.twitch.tv/drops/inventory",
        5_000,
      );
      const second = ensureTwitchIntegrityWithBrowser(
        browser,
        "https://www.twitch.tv/drops/inventory",
        5_000,
      );

      await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledTimes(1));
      setTwitchIntegrity(fresh(), { isNew: true });

      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      expect(browser.tabs.create).toHaveBeenCalledTimes(1);
    });

    it("preserves fresh-context and rejected-token guarantees when a forced caller joins an ordinary acquisition", async () => {
      const browser = browserMock();
      browser.tabs.query.mockResolvedValue([{ id: 3 }]);
      browser.tabs.create.mockResolvedValue({ id: 56 });
      const rejected = {
        integrity: "rejected-token",
        clientSessionId: "page-session",
        deviceId: "page-device",
        expiresAt: Date.now() + 60_000,
      };
      const replacement = {
        ...rejected,
        integrity: "replacement-token",
      };

      const ordinary = ensureTwitchIntegrityWithBrowser(
        browser,
        "https://www.twitch.tv/drops/inventory",
        5_000,
      );
      await vi.waitFor(() => expect(browser.tabs.query).toHaveBeenCalledOnce());
      let forcedSettled = false;
      const forced = ensureTwitchIntegrityWithBrowser(
        browser,
        "https://www.twitch.tv/drops/inventory",
        5_000,
        undefined,
        { forceRefresh: true, rejectedToken: rejected.integrity },
      ).then((result) => {
        forcedSettled = true;
        return result;
      });

      setTwitchIntegrity(rejected, { isNew: true });
      await expect(ordinary).resolves.toBe(true);
      await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(currentTwitchIntegrityWaiterCount()).toBeGreaterThan(0));
      expect(forcedSettled).toBe(false);
      expect(browser.tabs.create).toHaveBeenCalledWith({
        url: "https://www.twitch.tv/drops/inventory",
        pinned: false,
        active: false,
      });

      setTwitchIntegrity(replacement, { isNew: true });

      await expect(forced).resolves.toBe(true);
      expect(browser.tabs.remove).not.toHaveBeenCalledWith(3);
    });

    it("keeps proactive managed-context creation diagnostic-only and reports it for churn accounting", async () => {
      const browser = browserMock();
      browser.tabs.create.mockResolvedValue({ id: 57 });
      const events: EngineEvent[] = [];
      const managedOpen = vi.fn(async () => undefined);
      const pending = ensureTwitchIntegrityWithBrowser(
        browser,
        "https://www.twitch.tv/drops/inventory",
        5_000,
        (event) => events.push(event),
        {
          forceRefresh: true,
          reason: "proactive_refresh",
          onManagedPageContextOpen: managedOpen,
        } as TwitchIntegrityRequest,
      );
      await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledOnce());
      setTwitchIntegrity({
        integrity: "proactive-replacement",
        clientSessionId: "page-session",
        deviceId: "page-device",
        expiresAt: Date.now() + 60_000,
      }, { isNew: true });

      await expect(pending).resolves.toBe(true);

      expect(managedOpen).toHaveBeenCalledOnce();
      expect(events).not.toContainEqual(expect.objectContaining({
        category: "activity",
        code: "page_context_opened",
      }));
      expect(events).toContainEqual(expect.objectContaining({
        category: "diagnostic",
        platform: "twitch",
        level: "debug",
        message: expect.stringContaining("proactive"),
      }));
      expect(events).not.toContainEqual(expect.objectContaining({
        category: "diagnostic",
        message: expect.stringContaining("rejected"),
      }));
    });

    it("keeps initial readiness context creation diagnostic-only", async () => {
      const browser = browserMock();
      browser.tabs.create.mockResolvedValue({ id: 58 });
      const events: EngineEvent[] = [];
      const managedOpen = vi.fn(async () => undefined);
      const pending = ensureTwitchIntegrityWithBrowser(
        browser,
        "https://www.twitch.tv/drops/inventory",
        5_000,
        (event) => events.push(event),
        {
          reason: "readiness",
          onManagedPageContextOpen: managedOpen,
        },
      );
      await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledOnce());
      setTwitchIntegrity({
        integrity: "readiness-token",
        clientSessionId: "page-session",
        deviceId: "page-device",
        expiresAt: Date.now() + 60_000,
      }, { isNew: true });

      await expect(pending).resolves.toBe(true);

      expect(managedOpen).toHaveBeenCalledOnce();
      expect(events).not.toContainEqual(expect.objectContaining({
        category: "activity",
        code: "page_context_opened",
      }));
      expect(events).toContainEqual(expect.objectContaining({
        category: "diagnostic",
        platform: "twitch",
        level: "debug",
        message: expect.stringContaining("readiness"),
      }));
    });

    it("cancels the shared acquisition, removes its new context, and rejects every caller", async () => {
      const browser = browserMock();
      browser.tabs.create.mockResolvedValue({ id: 52 });
      const reason = new DOMException("Host reset", "AbortError");

      const first = ensureTwitchIntegrityWithBrowser(
        browser,
        "https://www.twitch.tv/drops/inventory",
        5_000,
      );
      const second = ensureTwitchIntegrityWithBrowser(
        browser,
        "https://www.twitch.tv/drops/inventory",
        5_000,
      );
      await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledTimes(1));

      cancelTwitchIntegrityAcquisition(reason);

      await expect(first).rejects.toBe(reason);
      await expect(second).rejects.toBe(reason);
      expect(browser.tabs.remove).toHaveBeenCalledWith(52);
    });

    it("removes its waiter after every cancellation", async () => {
      const browser = browserMock();
      let nextTabId = 60;
      browser.tabs.create.mockImplementation(async () => ({ id: nextTabId++ }));

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const reason = new DOMException(`Host reset ${attempt}`, "AbortError");
        const pending = ensureTwitchIntegrityWithBrowser(
          browser,
          "https://www.twitch.tv/drops/inventory",
          5_000,
        );
        await vi.waitFor(() => expect(currentTwitchIntegrityWaiterCount()).toBe(1));

        cancelTwitchIntegrityAcquisition(reason);

        await expect(pending).rejects.toBe(reason);
        expect(currentTwitchIntegrityWaiterCount()).toBe(0);
      }
    });

    it("removes its waiter after every timeout", async () => {
      const browser = browserMock();
      browser.tabs.query.mockResolvedValue([{ id: 3 }]);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(ensureTwitchIntegrityWithBrowser(
          browser,
          "https://www.twitch.tv/drops/inventory",
          5,
        )).resolves.toBe(false);
        expect(currentTwitchIntegrityWaiterCount()).toBe(0);
      }
    });

    it("starts a new acquisition after cancellation settles", async () => {
      const browser = browserMock();
      browser.tabs.create
        .mockResolvedValueOnce({ id: 53 })
        .mockResolvedValueOnce({ id: 54 });
      const reason = new DOMException("Host reset", "AbortError");

      const cancelled = ensureTwitchIntegrityWithBrowser(
        browser,
        "https://www.twitch.tv/drops/inventory",
        5_000,
      );
      await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledTimes(1));
      cancelTwitchIntegrityAcquisition(reason);
      await expect(cancelled).rejects.toBe(reason);

      const restarted = ensureTwitchIntegrityWithBrowser(
        browser,
        "https://www.twitch.tv/drops/inventory",
        5_000,
      );
      await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledTimes(2));
      setTwitchIntegrity(fresh(), { isNew: true });

      await expect(restarted).resolves.toBe(true);
      expect(browser.tabs.remove).toHaveBeenCalledWith(53);
    });

    it("aborts only a joined caller without cancelling the shared acquisition", async () => {
      const browser = browserMock();
      browser.tabs.create.mockResolvedValue({ id: 55 });
      const joinerAbort = new AbortController();
      const reason = new DOMException("Caller stopped", "AbortError");

      const owner = ensureTwitchIntegrityWithBrowser(
        browser,
        "https://www.twitch.tv/drops/inventory",
        5_000,
      );
      const joined = ensureTwitchIntegrityWithBrowser(
        browser,
        "https://www.twitch.tv/drops/inventory",
        5_000,
        undefined,
        { signal: joinerAbort.signal },
      );
      await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledTimes(1));

      joinerAbort.abort(reason);

      await expect(joined).rejects.toBe(reason);
      expect(browser.tabs.remove).not.toHaveBeenCalled();
      setTwitchIntegrity(fresh(), { isNew: true });
      await expect(owner).resolves.toBe(true);
    });

    it.each([
      { reason: "proactive_refresh", forceRefresh: true, level: "debug" },
      { reason: "readiness", forceRefresh: false, level: "warn" },
    ] as const)(
      "resolves false and logs a $reason timeout at $level level",
      async ({ reason, forceRefresh, level }) => {
        const browser = browserMock();
        browser.tabs.query.mockResolvedValue([{ id: 3 }]);
        browser.tabs.create.mockResolvedValue({ id: 59 });
        const events: EngineEvent[] = [];

        const ok = await ensureTwitchIntegrityWithBrowser(
          browser,
          "https://www.twitch.tv/drops/inventory",
          50,
          (event) => events.push(event),
          { reason, forceRefresh },
        );

        const timeouts = events.filter((event) =>
          event.category === "diagnostic"
          && event.message.includes("Timed out waiting for a Twitch integrity token"));
        expect(ok).toBe(false);
        expect(timeouts).toEqual([
          expect.objectContaining({ level }),
        ]);
      },
    );

    it.each([
      { reason: "proactive_refresh", forceRefresh: true, level: "debug" },
      { reason: "readiness", forceRefresh: false, level: "warn" },
    ] as const)(
      "returns false and logs a $reason page-open failure at $level level",
      async ({ reason, forceRefresh, level }) => {
        const browser = browserMock();
        browser.tabs.query.mockResolvedValue([]);
        browser.tabs.create.mockRejectedValue(new Error("tab open denied"));
        const events: EngineEvent[] = [];

        const ok = await ensureTwitchIntegrityWithBrowser(
          browser,
          "https://www.twitch.tv/drops/inventory",
          50,
          (event) => events.push(event),
          { reason, forceRefresh },
        );

        const openFailures = events.filter((event) =>
          event.category === "diagnostic"
          && event.message.includes("Could not open a twitch.tv tab"));
        expect(ok).toBe(false);
        expect(openFailures).toEqual([
          expect.objectContaining({ level }),
        ]);
      },
    );

    // Which page context answered decides whether the wait could ever succeed:
    // only a freshly created tab is guaranteed to boot the SPA and issue the
    // authenticated GQL the listener reads the token from. Reporting it turns a
    // bare timeout into something a diagnostics log can be read against.
    it("names a reused user tab as the page context it waited on", async () => {
      const browser = browserMock();
      browser.tabs.query.mockResolvedValue([{ id: 3 }]);
      const events: EngineEvent[] = [];

      await ensureTwitchIntegrityWithBrowser(browser, "https://www.twitch.tv/drops/inventory", 50, (event) => events.push(event));

      expect(browser.tabs.create).not.toHaveBeenCalled();
      expect(events).toContainEqual(expect.objectContaining({
        level: "debug",
        message: expect.stringContaining("from a user_tab page context (tab 3)"),
      }));
      expect(events).toContainEqual(expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("from a user_tab page context"),
      }));
    });

    it("names a freshly created tab as the page context it waited on", async () => {
      const browser = browserMock();
      browser.tabs.query.mockResolvedValue([]);
      browser.tabs.create.mockResolvedValue({ id: 21 });
      const events: EngineEvent[] = [];

      await ensureTwitchIntegrityWithBrowser(browser, "https://www.twitch.tv/drops/inventory", 50, (event) => events.push(event));

      expect(events).toContainEqual(expect.objectContaining({
        level: "debug",
        message: expect.stringContaining("from a created page context (tab 21)"),
      }));
    });

    // A cold twitch.tv context reports `status === "complete"` as soon as the
    // HTML shell lands, but the token only appears once the SPA has hydrated and
    // solved Kasada's proof-of-work. The aggregate wait duration cannot say which
    // of those phases ran long, so each boundary is reported separately.
    describe("page context boot instrumentation", () => {
      it("reports the phase split when the wait times out on a created context", async () => {
        const browser = browserMock();
        browser.tabs.query.mockResolvedValue([]);
        browser.tabs.create.mockResolvedValue({ id: 21 });
        const events: EngineEvent[] = [];

        await ensureTwitchIntegrityWithBrowser(browser, "https://www.twitch.tv/drops/inventory", 50, (event) => events.push(event));

        expect(events).toContainEqual(expect.objectContaining({
          level: "warn",
          message: expect.stringMatching(/tab ready at \d+ms, first GQL at never, \d+ms since the tab was created/),
        }));
      });

      // An anonymous GQL request carries no Client-Integrity header, so the
      // capture path drops it — but it is the only evidence that the SPA booted
      // at all, which is what separates a slow boot from a slow challenge.
      it("stamps the first GQL request the context issues, header or not", async () => {
        const browser = browserMock();
        browser.tabs.query.mockResolvedValue([]);
        browser.tabs.create.mockResolvedValue({ id: 21 });
        const events: EngineEvent[] = [];

        const pending = ensureTwitchIntegrityWithBrowser(browser, "https://www.twitch.tv/drops/inventory", 50, (event) => events.push(event));
        await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalled());
        noteTwitchGqlRequest(21);
        await pending;

        expect(events).toContainEqual(expect.objectContaining({
          level: "warn",
          message: expect.stringMatching(/first GQL at \d+ms/),
        }));
      });

      it("ignores GQL requests from tabs other than the booting context", async () => {
        const browser = browserMock();
        browser.tabs.query.mockResolvedValue([]);
        browser.tabs.create.mockResolvedValue({ id: 21 });
        const events: EngineEvent[] = [];

        const pending = ensureTwitchIntegrityWithBrowser(browser, "https://www.twitch.tv/drops/inventory", 50, (event) => events.push(event));
        await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalled());
        noteTwitchGqlRequest(999);
        await pending;

        expect(events).toContainEqual(expect.objectContaining({
          level: "warn",
          message: expect.stringContaining("first GQL at never"),
        }));
      });

      // A 20s success is the same latency problem as a 12s timeout; only logging
      // the failure would hide every cold boot that happened to finish in time.
      it("reports the wait duration on the success path too", async () => {
        const browser = browserMock();
        browser.tabs.query.mockResolvedValue([]);
        browser.tabs.create.mockResolvedValue({ id: 21 });
        const events: EngineEvent[] = [];

        const pending = ensureTwitchIntegrityWithBrowser(browser, "https://www.twitch.tv/drops/inventory", 5_000, (event) => events.push(event));
        await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalled());
        setTwitchIntegrity(fresh(), { isNew: true });

        await expect(pending).resolves.toBe(true);
        expect(events).toContainEqual(expect.objectContaining({
          level: "debug",
          message: expect.stringMatching(/Waited \d+ms for a Twitch integrity token from a created page context \(tab ready at/),
        }));
      });
    });

    // Twitch can reject a token the extension still considers unexpired. Forced
    // refresh exists for exactly that case, so the local expiry must not be
    // allowed to short-circuit it.
    describe("forced refresh", () => {
      const rejected = () => ({
        integrity: "rejected-token",
        clientSessionId: "page-session",
        deviceId: "page-device",
        expiresAt: Date.now() + 60_000,
      });

      const replacement = () => ({
        integrity: "replacement-token",
        clientSessionId: "page-session",
        deviceId: "page-device",
        expiresAt: Date.now() + 60_000,
      });

      it("does not fast-return for an apparently unexpired rejected token", async () => {
        const browser = browserMock();
        browser.tabs.create.mockResolvedValue({ id: 31 });
        setTwitchIntegrity(rejected());

        setTimeout(() => setTwitchIntegrity(replacement(), { isNew: true }), 20);
        const ok = await ensureTwitchIntegrityWithBrowser(
          browser,
          "https://www.twitch.tv/drops/inventory",
          5_000,
          undefined,
          { forceRefresh: true },
        );

        expect(ok).toBe(true);
        expect(browser.tabs.create).toHaveBeenCalledTimes(1);
      });

      it("succeeds only once a token different from the rejected one is captured", async () => {
        const browser = browserMock();
        browser.tabs.create.mockResolvedValue({ id: 32 });
        setTwitchIntegrity(rejected());

        // Re-capturing the same token must not satisfy the wait.
        setTimeout(() => setTwitchIntegrity(rejected(), { isNew: true }), 10);
        const ok = await ensureTwitchIntegrityWithBrowser(
          browser,
          "https://www.twitch.tv/drops/inventory",
          60,
          undefined,
          { forceRefresh: true },
        );

        expect(ok).toBe(false);
      });

      it("does not reopen helper tabs when a concurrent user tab replays the rejected token", async () => {
        const browser = browserMock();
        browser.tabs.create.mockResolvedValue({ id: 32 });
        setTwitchIntegrity(rejected(), { sourceTabId: 7 });
        let capturedIntegrity: string | undefined;

        const pending = ensureTwitchIntegrityWithBrowser(
          browser,
          "https://www.twitch.tv/drops/inventory",
          5_000,
          undefined,
          {
            forceRefresh: true,
            rejectedToken: rejected().integrity,
            onIntegrityCaptured: (value) => { capturedIntegrity = value.integrity; },
          },
        );
        await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledOnce());

        // Lurkloot's helper tab mints the replacement and wakes the waiter,
        // but another already-open Twitch tab can immediately issue GQL with
        // the old bundle before the awaiting retry gets its next microtask.
        setTwitchIntegrity(replacement(), { isNew: true, sourceTabId: 32 });
        setTwitchIntegrity(rejected(), { isNew: true, sourceTabId: 7 });

        await expect(pending).resolves.toBe(true);

        expect(browser.tabs.create).toHaveBeenCalledTimes(1);
        expect(browser.tabs.remove).toHaveBeenCalledTimes(1);
        expect(capturedIntegrity).toBe(replacement().integrity);
        // Ordinary capture remains last-writer-wins; the pinned callback above
        // is what protects the immediate retry from this user-tab replay.
        expect(currentValidTwitchIntegrity()?.integrity).toBe(rejected().integrity);
      });

      it("does not let a user-tab capture satisfy a managed helper wait", async () => {
        const browser = browserMock();
        browser.tabs.create.mockResolvedValue({ id: 33 });
        setTwitchIntegrity(rejected(), { sourceTabId: 7 });

        const pending = ensureTwitchIntegrityWithBrowser(
          browser,
          "https://www.twitch.tv/drops/inventory",
          50,
          undefined,
          { forceRefresh: true, rejectedToken: rejected().integrity },
        );
        await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledOnce());

        setTwitchIntegrity(replacement(), { isNew: true, sourceTabId: 7 });

        await expect(pending).resolves.toBe(false);
        expect(browser.tabs.create).toHaveBeenCalledOnce();
      });

      it("does not reuse a prior capture when a helper tab id is recycled", async () => {
        const browser = browserMock();
        browser.tabs.create.mockResolvedValue({ id: 34 });
        setTwitchIntegrity(replacement(), { sourceTabId: 34 });
        setTwitchIntegrity(rejected(), { sourceTabId: 7 });

        const pending = ensureTwitchIntegrityWithBrowser(
          browser,
          "https://www.twitch.tv/drops/inventory",
          50,
          undefined,
          { forceRefresh: true, rejectedToken: rejected().integrity },
        );
        await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledOnce());

        await expect(pending).resolves.toBe(false);
        expect(browser.tabs.create).toHaveBeenCalledOnce();
      });

      it("creates a fresh inactive page context instead of reusing a user-owned tab", async () => {
        const browser = browserMock();
        browser.tabs.query.mockResolvedValue([{ id: 3 }]);
        browser.tabs.create.mockResolvedValue({ id: 33 });
        setTwitchIntegrity(rejected());

        setTimeout(() => setTwitchIntegrity(replacement(), { isNew: true }), 20);
        const ok = await ensureTwitchIntegrityWithBrowser(
          browser,
          "https://www.twitch.tv/drops/inventory",
          5_000,
          undefined,
          { forceRefresh: true },
        );

        expect(ok).toBe(true);
        expect(browser.tabs.create).toHaveBeenCalledWith({
          url: "https://www.twitch.tv/drops/inventory",
          pinned: false,
          active: false,
        });
        // The user's own twitch.tv tab must never be navigated, reloaded or closed.
        const touchedTabIds = (browser.tabs.update.mock.calls as unknown as unknown[][]).map((call) => call[0]);
        expect(touchedTabIds).not.toContain(3);
        expect(browser.tabs.remove).not.toHaveBeenCalledWith(3);
      });

      it("reloads an extension-owned retained context rather than opening another tab", async () => {
        const browser = browserMock();
        registerManagedPageContextTabs({
          twitch: {
            platform: "twitch",
            tabId: 44,
            origin: "https://www.twitch.tv",
            originUrl: "https://www.twitch.tv/drops/inventory",
            ownedByExtension: true,
          },
        });
        browser.tabs.get.mockResolvedValue({ id: 44, url: "https://www.twitch.tv/drops/inventory" });
        setTwitchIntegrity(rejected());

        setTimeout(() => setTwitchIntegrity(replacement(), { isNew: true }), 20);
        const ok = await ensureTwitchIntegrityWithBrowser(
          browser,
          "https://www.twitch.tv/drops/inventory",
          5_000,
          undefined,
          { forceRefresh: true },
        );

        expect(ok).toBe(true);
        expect(browser.tabs.create).not.toHaveBeenCalled();
        expect(browser.tabs.update).toHaveBeenCalledWith(44, {
          url: "https://www.twitch.tv/drops/inventory",
        });
      });

      // Concurrent authenticated reads (discovery fans DropCampaignDetails out
      // with Promise.allSettled) can all be rejected by the same token and all
      // force a refresh at once. Without sharing, a later caller reads the
      // *replacement* as its own rejected token and waits for one that never comes.
      it("shares one in-flight forced refresh between concurrent callers", async () => {
        const browser = browserMock();
        browser.tabs.create.mockResolvedValue({ id: 34 });
        setTwitchIntegrity(rejected());

        setTimeout(() => setTwitchIntegrity(replacement(), { isNew: true }), 20);
        const results = await Promise.all([
          ensureTwitchIntegrityWithBrowser(browser, "https://www.twitch.tv/drops/inventory", 5_000, undefined, { forceRefresh: true }),
          ensureTwitchIntegrityWithBrowser(browser, "https://www.twitch.tv/drops/inventory", 5_000, undefined, { forceRefresh: true }),
          ensureTwitchIntegrityWithBrowser(browser, "https://www.twitch.tv/drops/inventory", 5_000, undefined, { forceRefresh: true }),
        ]);

        expect(results).toEqual([true, true, true]);
        // One page context booted for the whole burst, not one per caller.
        expect(browser.tabs.create).toHaveBeenCalledTimes(1);
      });

      it("aborts an integrity wait and removes the page context it opened", async () => {
        const browser = browserMock();
        browser.tabs.create.mockResolvedValue({ id: 43 });
        const abort = new AbortController();

        const pending = ensureTwitchIntegrityWithBrowser(
          browser,
          "https://www.twitch.tv/drops/inventory",
          5_000,
          undefined,
          { signal: abort.signal },
        );
        await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledOnce());

        abort.abort(new DOMException("Host reset", "AbortError"));

        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(browser.tabs.remove).toHaveBeenCalledWith(43);
      });

      it("starts a new forced refresh once the previous one has settled", async () => {
        const browser = browserMock();
        browser.tabs.create.mockResolvedValue({ id: 35 });
        setTwitchIntegrity(rejected());

        setTimeout(() => setTwitchIntegrity(replacement(), { isNew: true }), 20);
        await expect(ensureTwitchIntegrityWithBrowser(
          browser, "https://www.twitch.tv/drops/inventory", 5_000, undefined, { forceRefresh: true },
        )).resolves.toBe(true);
        const contextsAfterFirstRefresh = browser.tabs.create.mock.calls.length;

        // Twitch later rejects the replacement too. Even though replacement-token
        // is still locally valid, the second forced refresh must boot its own
        // page context and stay pending until a genuinely different token lands —
        // never hand back the first refresh's settled result.
        let settled = false;
        const second = ensureTwitchIntegrityWithBrowser(
          browser, "https://www.twitch.tv/drops/inventory", 5_000, undefined, { forceRefresh: true },
        ).then((ok) => {
          settled = true;
          return ok;
        });

        await vi.waitFor(() => {
          expect(browser.tabs.create.mock.calls.length).toBeGreaterThan(contextsAfterFirstRefresh);
        });
        expect(settled).toBe(false);

        setTwitchIntegrity({ ...replacement(), integrity: "third-token" }, { isNew: true });
        await expect(second).resolves.toBe(true);
      });

      // The expensive case #292 describes: a discovery pass issues ~10 authenticated
      // operations, Twitch refuses them all on the same token, and each rejection
      // used to boot its own cold page context and wait out Kasada again.
      it("mints once for a burst of operations all rejected on the same token", async () => {
        const browser = browserMock();
        browser.tabs.create.mockResolvedValue({ id: 41 });
        setTwitchIntegrity(rejected());
        const staleToken = rejected().integrity;

        // The first operation's refresh lands a replacement.
        setTimeout(() => setTwitchIntegrity(replacement(), { isNew: true }), 20);
        await expect(ensureTwitchIntegrityWithBrowser(
          browser, "https://www.twitch.tv/drops/inventory", 5_000, undefined,
          { forceRefresh: true, rejectedToken: staleToken },
        )).resolves.toBe(true);
        const contextsAfterFirst = browser.tabs.create.mock.calls.length;

        // The rest were refused on the same stale token before that landed. They
        // have never tried the replacement, so nothing needs minting for them.
        for (let index = 0; index < 5; index += 1) {
          await expect(ensureTwitchIntegrityWithBrowser(
            browser, "https://www.twitch.tv/drops/inventory", 5_000, undefined,
            { forceRefresh: true, rejectedToken: staleToken },
          )).resolves.toBe(true);
        }

        expect(browser.tabs.create.mock.calls.length).toBe(contextsAfterFirst);
      });

      // The bound must key on which token was refused, not on elapsed time: a
      // replacement that Twitch itself rejects still has to be re-minted at once.
      it("still mints when the replacement is the token that was rejected", async () => {
        const browser = browserMock();
        browser.tabs.create.mockResolvedValue({ id: 42 });
        setTwitchIntegrity(replacement());
        const contextsBefore = browser.tabs.create.mock.calls.length;

        const pending = ensureTwitchIntegrityWithBrowser(
          browser, "https://www.twitch.tv/drops/inventory", 5_000, undefined,
          { forceRefresh: true, rejectedToken: replacement().integrity },
        );
        await vi.waitFor(() => {
          expect(browser.tabs.create.mock.calls.length).toBeGreaterThan(contextsBefore);
        });

        setTwitchIntegrity({ ...replacement(), integrity: "fourth-token" }, { isNew: true });
        await expect(pending).resolves.toBe(true);
      });

      // A forced refresh can legitimately have no token to compare against —
      // nothing captured yet, or a host that cannot report what it sent. It must
      // still demand a freshly created context: inheriting a user's idle tab
      // yields one that issues no request, so the wait can only time out.
      it("still requires a fresh context when no rejected token is known", async () => {
        const browser = browserMock();
        browser.tabs.query.mockResolvedValue([{ id: 3 }]);
        browser.tabs.create.mockResolvedValue({ id: 43 });

        const pending = ensureTwitchIntegrityWithBrowser(
          browser, "https://www.twitch.tv/drops/inventory", 50, undefined, { forceRefresh: true },
        );
        await pending;

        // Tab 3 was reusable, but a forced refresh must not reuse it.
        expect(browser.tabs.create).toHaveBeenCalled();
      });

      it("leaves the non-forced fast path intact", async () => {
        const browser = browserMock();
        setTwitchIntegrity(fresh());

        const ok = await ensureTwitchIntegrityWithBrowser(browser, "https://www.twitch.tv/drops/inventory");

        expect(ok).toBe(true);
        expect(browser.tabs.query).not.toHaveBeenCalled();
        expect(browser.tabs.create).not.toHaveBeenCalled();
      });
    });
  });
});

describe("fetchTwitchInBackgroundWith", () => {
  const cookieApi = {
    cookies: {
      get: vi.fn(async ({ name }: { name: string }) =>
        name === "auth-token" ? { value: "tok123" } : name === "unique_id" ? { value: "dev456" } : null),
    },
  };

  beforeEach(() => {
    cookieApi.cookies.get.mockClear();
    setTwitchIntegrity(undefined);
  });

  it("attaches the OAuth token, device id and a session id for authenticated GQL", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ data: { currentUser: { id: "u" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const result = await fetchTwitchInBackgroundWith(cookieApi, "https://gql.twitch.tv/gql", {
      method: "POST",
      headers: { "Client-ID": "kimne78kx3ncx6brgo4mv6wki5h1ko" },
      body: "{}",
    });

    const headers = new Headers(captured?.init.headers);
    expect(headers.get("authorization")).toBe("OAuth tok123");
    expect(headers.get("x-device-id")).toBe("dev456");
    expect(headers.get("client-session-id")).toMatch(/^[0-9a-f]{16}$/);
    expect(captured?.init.credentials).toBe("include");
    expect(result).toMatchObject({ data: { currentUser: { id: "u" } } });
    vi.unstubAllGlobals();
  });

  it("preserves multi-operation Twitch GQL batch responses", async () => {
    const response = [
      { data: { dropCampaign: { id: "first" } } },
      { data: { dropCampaign: { id: "second" } } },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(fetchTwitchInBackgroundWith(
      cookieApi,
      "https://gql.twitch.tv/gql",
      { method: "POST", body: "[]" },
    )).resolves.toEqual(response);

    vi.unstubAllGlobals();
  });

  it("replays a captured integrity token with its matching device and session id", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ data: { claimDropRewards: { status: "ELIGIBLE_FOR_ALL" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    setTwitchIntegrity({
      integrity: "integrity-token",
      clientSessionId: "page-session",
      deviceId: "page-device",
      expiresAt: Date.now() + 60_000,
    });

    await fetchTwitchInBackgroundWith(cookieApi, "https://gql.twitch.tv/gql", { method: "POST", body: "{}" });

    const headers = new Headers(captured?.headers);
    expect(headers.get("client-integrity")).toBe("integrity-token");
    // The token is bound to the session/device it was minted with, so those win
    // over the self-generated session id and the cookie device id.
    expect(headers.get("client-session-id")).toBe("page-session");
    expect(headers.get("x-device-id")).toBe("page-device");
    expect(headers.get("authorization")).toBe("OAuth tok123");
    vi.unstubAllGlobals();
  });

  it("ignores an expired integrity token and falls back to the default headers", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    setTwitchIntegrity({
      integrity: "stale-token",
      clientSessionId: "page-session",
      deviceId: "page-device",
      expiresAt: Date.now() - 1,
    });

    await fetchTwitchInBackgroundWith(cookieApi, "https://gql.twitch.tv/gql", { method: "POST", body: "{}" });

    const headers = new Headers(captured?.headers);
    expect(headers.has("client-integrity")).toBe(false);
    expect(headers.get("x-device-id")).toBe("dev456");
    expect(headers.get("client-session-id")).toMatch(/^[0-9a-f]{16}$/);
    vi.unstubAllGlobals();
  });

  it("omits credentials and auth for anonymous public queries", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ data: { user: null } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    await fetchTwitchInBackgroundWith(cookieApi, "https://gql.twitch.tv/gql", { credentials: "omit", body: "{}" });

    expect(cookieApi.cookies.get).not.toHaveBeenCalled();
    expect(new Headers(captured?.headers).has("authorization")).toBe(false);
    expect(captured?.credentials).toBe("omit");
    vi.unstubAllGlobals();
  });

  it("returns a serializable diagnostic envelope when the GQL fetch is blocked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));

    const result = await fetchTwitchInBackgroundWith<{ __twitchGqlError?: string }>(
      cookieApi,
      "https://gql.twitch.tv/gql",
      { body: "{}" },
    );

    expect(result.__twitchGqlError).toContain("request failed (Failed to fetch)");
    expect(result.__twitchGqlError).toContain("authHeader=yes");
    vi.unstubAllGlobals();
  });

  it("returns channel page HTML for non-GQL Twitch URLs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>live</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })));

    const result = await fetchTwitchInBackgroundWith<{ html: string }>(cookieApi, "https://www.twitch.tv/creator");

    expect(result.html).toBe("<html>live</html>");
    vi.unstubAllGlobals();
  });
});

describe("fetchKickInBackgroundWith", () => {
  const cookieApi = {
    cookies: {
      get: vi.fn(async ({ name }: { name: string }) => (name === "session_token" ? { value: "sess%20789" } : null)),
    },
  };

  beforeEach(() => {
    cookieApi.cookies.get.mockClear();
  });

  it("replays the session_token cookie as a Bearer for web.kick.com", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const result = await fetchKickInBackgroundWith<{ data: unknown[] }>(
      cookieApi,
      "https://web.kick.com/api/v1/drops/campaigns",
    );

    // The cookie value is URL-decoded before being sent, mirroring pageFetchJson.
    expect(new Headers(captured?.init.headers).get("authorization")).toBe("Bearer sess 789");
    expect(captured?.init.credentials).toBe("include");
    expect(result).toEqual({ data: [] });
    vi.unstubAllGlobals();
  });

  it("replays the session_token cookie as a Bearer for the kick.com identity endpoint", async () => {
    // Kick serves this endpoint anonymously as `200 {}` rather than a 401, so without the
    // Bearer the auth probe cannot tell a signed-in account from a signed-out one.
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ id: 42 }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    try {
      await fetchKickInBackgroundWith(cookieApi, "https://kick.com/api/v1/user");

      expect(new Headers(captured?.headers).get("authorization")).toBe("Bearer sess 789");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("replays the session_token cookie as a Bearer for the followed-live endpoint", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }));

    try {
      await fetchKickInBackgroundWith(cookieApi, "https://kick.com/api/v1/user/livestreams");

      expect(new Headers(captured?.headers).get("authorization")).toBe("Bearer sess 789");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Shared with cycleKickHeaders.test.ts (kickHeaders) and pageFetchJson's own
  // test, so all three copies of the predicate are pinned to the same
  // expectations. See packages/core/src/core/kickBearerCases.ts.
  it.each(KICK_BEARER_NEAR_MISS_CASES)("never attaches the session token to a %s", async (_case, url) => {
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }));

    try {
      await fetchKickInBackgroundWith(cookieApi, url);

      expect(new Headers(captured?.headers).has("authorization")).toBe(false);
      expect(cookieApi.cookies.get).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws KickWafBlockedError on a 403 security-policy block", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        error: "Request blocked by security policy.",
        reference: "9e4db7e3",
        token: "must-not-survive",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    )));

    const error = await fetchKickInBackgroundWith(cookieApi, "https://web.kick.com/api/v1/drops/progress")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KickWafBlockedError);
    if (!(error instanceof KickWafBlockedError)) throw new Error("Expected KickWafBlockedError");
    expect(error.failure).toEqual({
      kind: "security_policy_blocked",
      status: 403,
      reason: "Request blocked by security policy.",
      reference: "9e4db7e3",
    });
    expect(JSON.stringify(error)).not.toContain("must-not-survive");
    vi.unstubAllGlobals();
  });

  it.each([
    [401, "Unauthenticated", "authentication_rejected"],
    [500, "Internal Server Error", "http_error"],
  ] as const)("classifies HTTP %s as %s", async (status, reason, kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: reason, body: "must-not-survive" }),
      { status, headers: { "content-type": "application/json" } },
    )));

    const error = await fetchKickInBackgroundWith(cookieApi, "https://web.kick.com/api/v1/drops/progress")
      .catch((caught: unknown) => caught);

    expect(isSafeFetchError(error)).toBe(true);
    if (!isSafeFetchError(error)) throw new Error("Expected SafeFetchError");
    expect(error.failure).toEqual({ kind, status, reason });
    expect(JSON.stringify(error)).not.toContain("must-not-survive");
    vi.unstubAllGlobals();
  });

  it("treats a network/CORS rejection as a WAF block", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));

    await expect(fetchKickInBackgroundWith(cookieApi, "https://websockets.kick.com/viewer/v1/token"))
      .rejects.toBeInstanceOf(KickWafBlockedError);
    vi.unstubAllGlobals();
  });

  it("treats a non-JSON 200 from an API endpoint as a challenge block", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>challenge</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })));

    await expect(fetchKickInBackgroundWith(cookieApi, "https://kick.com/api/v2/channels/someone"))
      .rejects.toBeInstanceOf(KickWafBlockedError);
    vi.unstubAllGlobals();
  });

  it("returns HTML for a non-API kick.com page (channel page fallback)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>is_live</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })));

    const result = await fetchKickInBackgroundWith<{ html: string }>(cookieApi, "https://kick.com/streamer");

    expect(result.html).toBe("<html>is_live</html>");
    vi.unstubAllGlobals();
  });
});

// pageFetchJson is injected into a Kick page's MAIN world via executeScript
// (see fetchJsonInPageWithBrowser), whose tests mock executeScript wholesale and
// so never exercise this function's own logic. These tests call it directly with
// a stubbed fetch/document instead, including its inlined Bearer predicate — the
// one copy that cannot import needsKickSessionBearer (see fetchKickInBackgroundWith
// above and kickHeaders in packages/cli/src/transport/cycle.ts for the other two).
describe("pageFetchJson", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { cookie: "session_token=sess%20789" });
  });

  it.each(KICK_BEARER_POSITIVE_CASES)("replays the session_token cookie as a Bearer for %s", async (_case, url) => {
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_target: string, init: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }));

    try {
      await pageFetchJson(url);

      expect(new Headers(captured?.headers).get("authorization")).toBe("Bearer sess 789");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Shared with tabs.test.ts's fetchKickInBackgroundWith suite and
  // cycleKickHeaders.test.ts (kickHeaders), so all three copies of the
  // predicate are pinned to the same expectations. See
  // packages/core/src/core/kickBearerCases.ts.
  it.each(KICK_BEARER_NEAR_MISS_CASES)("never attaches the session token to a %s", async (_case, url) => {
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_target: string, init: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }));

    try {
      await pageFetchJson(url);

      expect(new Headers(captured?.headers).has("authorization")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

interface AdFocusMockTab {
  id?: number;
  windowId?: number;
  active?: boolean;
}

function adFocusBrowserMock(activeTab: AdFocusMockTab = { id: 100, windowId: 1 }) {
  return {
    tabs: {
      get: vi.fn(async (tabId: number): Promise<AdFocusMockTab> => ({ id: tabId, windowId: 2 })),
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      query: vi.fn(async (): Promise<AdFocusMockTab[]> => [activeTab]),
      create: vi.fn(async () => ({ id: 9 })),
    },
    windows: {
      update: vi.fn(async () => undefined),
    },
  };
}

describe("ad focus manager", () => {
  beforeEach(async () => {
    // Drain any focus holds left over from a previous test so module state is clean.
    const reset = adFocusBrowserMock();
    await applyAdFocusWithBrowser(reset, "twitch", undefined, false, "window");
    await applyAdFocusWithBrowser(reset, "kick", undefined, false, "window");
  });

  it("activates the watch tab without raising the window in tab mode", async () => {
    const browser = adFocusBrowserMock();

    await applyAdFocusWithBrowser(browser, "twitch", 42, true, "tab");

    expect(browser.tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect(browser.windows.update).not.toHaveBeenCalled();
  });

  it("raises the window in window mode", async () => {
    const browser = adFocusBrowserMock();

    await applyAdFocusWithBrowser(browser, "twitch", 42, true, "window");

    expect(browser.tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect(browser.windows.update).toHaveBeenCalledWith(2, { focused: true });
  });

  it("does nothing in none mode", async () => {
    const browser = adFocusBrowserMock();

    await applyAdFocusWithBrowser(browser, "twitch", 42, true, "none");

    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(browser.windows.update).not.toHaveBeenCalled();
  });

  it("restores the previously focused tab and window when the ad ends", async () => {
    const browser = adFocusBrowserMock({ id: 100, windowId: 1 });
    await applyAdFocusWithBrowser(browser, "twitch", 42, true, "window");

    // The watch tab is now the active tab while the ad runs.
    browser.tabs.query.mockResolvedValue([{ id: 42, windowId: 2 }]);
    await applyAdFocusWithBrowser(browser, "twitch", 42, false, "window");

    expect(browser.tabs.update).toHaveBeenCalledWith(100, { active: true });
    expect(browser.windows.update).toHaveBeenCalledWith(1, { focused: true });
  });

  it("does not restore focus when the user already moved to another tab", async () => {
    const browser = adFocusBrowserMock({ id: 100, windowId: 1 });
    await applyAdFocusWithBrowser(browser, "twitch", 42, true, "tab");

    // The user manually switched away from the watch tab during the ad.
    browser.tabs.query.mockResolvedValue([{ id: 777, windowId: 1 }]);
    await applyAdFocusWithBrowser(browser, "twitch", 42, false, "tab");

    expect(browser.tabs.update).not.toHaveBeenCalledWith(100, { active: true });
  });

  it("keeps focus until both platforms' ads finish", async () => {
    const browser = adFocusBrowserMock({ id: 100, windowId: 1 });
    await applyAdFocusWithBrowser(browser, "twitch", 42, true, "tab");
    await applyAdFocusWithBrowser(browser, "kick", 55, true, "tab");

    browser.tabs.query.mockResolvedValue([{ id: 55, windowId: 2 }]);
    await applyAdFocusWithBrowser(browser, "twitch", 42, false, "tab");
    expect(browser.tabs.update).not.toHaveBeenCalledWith(100, { active: true });

    await applyAdFocusWithBrowser(browser, "kick", 55, false, "tab");
    expect(browser.tabs.update).toHaveBeenCalledWith(100, { active: true });
  });

  it("does not re-activate the tab while the hold is already held and the tab is active", async () => {
    const browser = adFocusBrowserMock({ id: 100, windowId: 1 });
    await applyAdFocusWithBrowser(browser, "kick", 42, true, "tab");
    expect(browser.tabs.update).toHaveBeenCalledWith(42, { active: true });

    // The watch tab is now the active tab, so a repeated report must be a no-op.
    browser.tabs.get.mockResolvedValue({ id: 42, windowId: 2, active: true });
    browser.tabs.query.mockResolvedValue([{ id: 42, windowId: 2, active: true }]);
    browser.tabs.update.mockClear();
    browser.windows.update.mockClear();

    await applyAdFocusWithBrowser(browser, "kick", 42, true, "tab");
    await applyAdFocusWithBrowser(browser, "kick", 42, true, "tab");

    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(browser.windows.update).not.toHaveBeenCalled();
  });

  it("does not re-focus the window while the tab is active in the focused window", async () => {
    const browser = adFocusBrowserMock({ id: 100, windowId: 1 });
    await applyAdFocusWithBrowser(browser, "kick", 42, true, "window");

    browser.tabs.get.mockResolvedValue({ id: 42, windowId: 2, active: true });
    browser.tabs.query.mockResolvedValue([{ id: 42, windowId: 2, active: true }]);
    browser.tabs.update.mockClear();
    browser.windows.update.mockClear();

    await applyAdFocusWithBrowser(browser, "kick", 42, true, "window");

    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(browser.windows.update).not.toHaveBeenCalled();
  });

  it("re-activates the tab when the user switched away during the ad", async () => {
    const browser = adFocusBrowserMock({ id: 100, windowId: 1 });
    await applyAdFocusWithBrowser(browser, "kick", 42, true, "tab");

    browser.tabs.get.mockResolvedValue({ id: 42, windowId: 2, active: false });
    browser.tabs.update.mockClear();

    await applyAdFocusWithBrowser(browser, "kick", 42, true, "tab");

    expect(browser.tabs.update).toHaveBeenCalledWith(42, { active: true });
  });

  it("releases the hold and stops re-focusing once the maximum hold elapses", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const browser = adFocusBrowserMock({ id: 100, windowId: 1 });
      await applyAdFocusWithBrowser(browser, "kick", 42, true, "window");

      // A stuck detector keeps reporting an ad long past any real ad break.
      browser.tabs.get.mockResolvedValue({ id: 42, windowId: 2, active: false });
      browser.tabs.query.mockResolvedValue([{ id: 42, windowId: 2, active: true }]);
      vi.setSystemTime(new Date(Date.now() + AD_FOCUS_MAX_HOLD_MS + 1));
      browser.tabs.update.mockClear();
      browser.windows.update.mockClear();

      await applyAdFocusWithBrowser(browser, "kick", 42, true, "window");

      // Focus goes back to the user and the watch tab is not raised again.
      expect(browser.tabs.update).toHaveBeenCalledWith(100, { active: true });
      expect(browser.tabs.update).not.toHaveBeenCalledWith(42, { active: true });

      browser.tabs.update.mockClear();
      browser.windows.update.mockClear();
      await applyAdFocusWithBrowser(browser, "kick", 42, true, "window");
      await applyAdFocusWithBrowser(browser, "kick", 42, true, "window");
      expect(browser.tabs.update).not.toHaveBeenCalled();
      expect(browser.windows.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows focus again for a new ad episode after the cap expired", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const browser = adFocusBrowserMock({ id: 100, windowId: 1 });
      await applyAdFocusWithBrowser(browser, "kick", 42, true, "tab");
      vi.setSystemTime(new Date(Date.now() + AD_FOCUS_MAX_HOLD_MS + 1));
      await applyAdFocusWithBrowser(browser, "kick", 42, true, "tab");

      // The ad ends, which clears the expiry, and a later ad may focus again.
      await applyAdFocusWithBrowser(browser, "kick", 42, false, "tab");
      browser.tabs.update.mockClear();
      await applyAdFocusWithBrowser(browser, "kick", 42, true, "tab");

      expect(browser.tabs.update).toHaveBeenCalledWith(42, { active: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
