import { browser } from "wxt/browser";
import type { AdFocusMode, ChannelCandidate, Platform, WatchSession } from "@lurkloot/shared/models";
import type { EventEmitter, PageContextCloseReason } from "@lurkloot/shared/events";
import {
  applyAdFocusWithBrowser,
  currentValidTwitchIntegrity,
  ensureTwitchIntegrityWithBrowser,
  fetchJsonInPageWithBrowser,
  fetchKickInBackgroundWith,
  fetchTwitchInBackgroundWith,
  openPinnedMutedTabWithBrowser,
  reconcileManagedPageContextRecoveryWithBrowser,
  stopManagedPageContextTabsWithBrowser,
  stopWatchTabWithBrowser,
  TWITCH_PAGE_CONTEXT_URL,
  type BrowserTabApi,
  type CookieApi,
  type PageFetchOptions,
  type SchedulerManagedPageContexts,
  type TwitchIntegrityRequest,
} from "@lurkloot/core/tabs";
import type { KickPageContextCycleObservation, PreparedWatchTab, WatchTabOptions } from "@lurkloot/core/adapter";

// Browser-backed wrappers binding the pure `*WithBrowser` engine functions in
// @lurkloot/core/tabs to the extension's live wxt/browser tabs/cookies APIs.
// This is the seam that keeps the engine browser-free: the headless CLI injects
// its own port implementations instead of these wrappers. New tab-bound logic
// belongs in core's `*WithBrowser` function; only the `browser` binding lives here.

export function openPinnedMutedTab(channel: ChannelCandidate, session?: WatchSession, options?: Partial<WatchTabOptions>, emit?: EventEmitter): Promise<PreparedWatchTab> {
  return openPinnedMutedTabWithBrowser(browser as BrowserTabApi, channel, session, options, emit);
}

export function stopWatchTab(session: WatchSession, options?: Partial<WatchTabOptions>, emit?: EventEmitter): Promise<void> {
  return stopWatchTabWithBrowser(browser as BrowserTabApi, session, options, emit);
}

export function applyAdFocus(platform: Platform, tabId: number | undefined, adActive: boolean, mode: AdFocusMode, emit?: EventEmitter): Promise<void> {
  return applyAdFocusWithBrowser(browser as BrowserTabApi, platform, tabId, adActive, mode, emit);
}

export function ensureTwitchIntegrity(emit?: EventEmitter, request?: TwitchIntegrityRequest): Promise<boolean> {
  return ensureTwitchIntegrityWithBrowser(browser as BrowserTabApi, TWITCH_PAGE_CONTEXT_URL, undefined, emit, request);
}

export { cancelTwitchIntegrityAcquisition, currentValidTwitchIntegrity } from "@lurkloot/core/tabs";

export function fetchTwitchInBackground<T>(url: string, init?: RequestInit): Promise<T> {
  return fetchTwitchInBackgroundWith<T>(browser as CookieApi, url, init);
}

export function fetchKickInBackground<T>(url: string, init?: RequestInit): Promise<T> {
  return fetchKickInBackgroundWith<T>(browser as CookieApi, url, init);
}

export function fetchJsonInPage<T>(originUrl: string, url: string, init?: RequestInit, options?: PageFetchOptions): Promise<T> {
  return fetchJsonInPageWithBrowser<T>(browser as BrowserTabApi, originUrl, url, init, options);
}

export function reconcileManagedPageContextRecovery(
  platform: Platform,
  observation: KickPageContextCycleObservation,
  requiredSuccesses: number,
  emit?: EventEmitter,
): Promise<void> {
  return reconcileManagedPageContextRecoveryWithBrowser(
    browser as BrowserTabApi,
    platform,
    observation,
    requiredSuccesses,
    emit,
  );
}

export function stopManagedPageContextTabs(
  contexts: SchedulerManagedPageContexts,
  options: { platforms?: Platform[]; reason?: PageContextCloseReason; emit?: EventEmitter } = {},
): Promise<SchedulerManagedPageContexts> {
  return stopManagedPageContextTabsWithBrowser(browser as BrowserTabApi, contexts, options);
}
