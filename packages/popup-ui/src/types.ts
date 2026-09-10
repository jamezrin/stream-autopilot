import type { CliCredentialBlob, RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { ClaimGuidance, CompatibilitySettings, DropCampaign, Platform, RewardRequirementType, SupportedLocale } from "@lurkloot/shared/models";
import type { SettingsExportPayload } from "@lurkloot/shared/settingsExport";
import type { CampaignFarmingEvaluation } from "@lurkloot/shared/campaignFarming";

export type CompatibilityLifecycle = "recommended" | "legacy" | "experimental";
export interface CompatibilityOptionMetadata {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly lifecycle: CompatibilityLifecycle;
  readonly hosts: readonly string[];
  readonly identities?: readonly string[];
  // Set on superseded options: the id that replaces this one. Surfaced so a
  // legacy selection says what to move to.
  readonly replacement?: string;
}
export interface PopupCompatibilityRegistry {
  readonly twitch: {
    readonly profiles: Readonly<Record<string, CompatibilityOptionMetadata>>;
    readonly heartbeat: Readonly<Record<string, CompatibilityOptionMetadata>>;
    readonly inventory: Readonly<Record<string, CompatibilityOptionMetadata>>;
  };
  readonly kick: {
    readonly profiles: Readonly<Record<string, CompatibilityOptionMetadata>>;
    readonly claim: Readonly<Record<string, CompatibilityOptionMetadata>>;
  };
}
export interface PopupCompatibilityResolution {
  readonly compatibility: {
    readonly twitch: { readonly profile: string; readonly heartbeat: string; readonly inventory: string };
    readonly kick: { readonly profile: string; readonly claim: string };
  };
  readonly warnings: readonly unknown[];
}

export type GameItem = {
  id: string;
  name: string;
  short: string;
  accent: string;
  imageUrl?: string;
};
export type StreamerItem = { id: string; name: string; live: boolean; subtitle?: string; viewers?: number };
export type FarmingChannelView = { name: string; category?: string; viewers?: number; url?: string };
export type ChannelLink = { name: string; url: string };
export type RewardView = {
  id: string;
  name: string;
  progress?: number;
  requiredMinutes: number;
  requiredSubs?: number;
  requirement: RewardRequirementType;
  obtained: boolean;
  art: string;
  tint: string;
  imageUrl?: string;
  claimGuidance?: ClaimGuidance;
  ineligibilityReason?: "insufficient_time";
};
export type CampaignLifecycleState = "upcoming" | "expired" | "finished";

export type CampaignStats = {
  kind: "watch" | "subscription" | "mixed" | "action";
  totalRequired: number;
  totalFarmed: number;
  remaining: number;
  progress?: number;
  completed: number;
  totalRewards: number;
  nextReward?: RewardView;
  nextRewardRemaining?: number;
  complete: boolean;
};

export type CampaignView = {
  id: string;
  gameId: string;
  title: string;
  status: DropCampaign["status"];
  lifecycle?: CampaignLifecycleState;
  linked: boolean;
  // The org account-link URL (Kick connect_url / Twitch accountLinkURL), when the
  // campaign actually requires linking. Absent when there is nothing to link.
  linkUrl?: string;
  // The campaign's info/landing page, when one is provided.
  pageUrl?: string;
  excluded: boolean;
  starts: string;
  ends: string;
  // All channels this drop is restricted to, each with a link to its page. Empty
  // for general drops (farmable on any channel in the category).
  channels: ChannelLink[];
  farmingChannel?: FarmingChannelView;
  thumbnail: string;
  tint: string;
  imageUrl?: string;
  rewards: RewardView[];
  hasWatchRewards: boolean;
  hasSubscriptionRewards: boolean;
  farmingRejection?: Extract<CampaignFarmingEvaluation, { farmable: false }>;
};

export type TFunction = (key: string, substitutions?: string | string[]) => string;

export type ScreenshotLayout = "hero" | "extras" | "steps" | "settings" | "updated";

type ScreenshotCopy = {
  glow: string;
  eyebrowKey: string;
  headlineKey: string;
  subcopyKey: string;
};

export type ScreenshotPopupVariant = ScreenshotCopy & {
  layout: "hero" | "extras" | "steps" | "settings";
  platform: Platform;
  view: "drops" | "settings" | "watchlist";
};

export type ScreenshotMarketingVariant = ScreenshotCopy & {
  layout: "updated";
};

export type ScreenshotVariant = ScreenshotPopupVariant | ScreenshotMarketingVariant;

export function variantShowsPopup(variant: ScreenshotVariant): variant is ScreenshotPopupVariant {
  return variant.layout !== "updated";
}

export interface PopupAdapter {
  version: string;
  send<T>(message: RuntimeMessage): Promise<T>;
  getStorage(keys?: string | string[]): Promise<Record<string, unknown>>;
  setStorage(values: Record<string, unknown>): Promise<void>;
  getMessage(key: string, substitutions?: string | string[]): string;
  getUiLanguage(): string;
  openLink(url: string): void;
  // Optional extension lifecycle hooks. Demo/site hosts omit these, which also
  // keeps update notices out of screenshots and the landing-page popup demo.
  getPendingChangelogVersion?(): Promise<string | undefined>;
  dismissPendingChangelogVersion?(): Promise<void>;
  changelogUrl?(version: string): string;
  // Optional: download/persist an exported credential blob for the headless CLI.
  // Only the live extension implements it (the demo omits it, hiding the action).
  exportCredentials?(blob: CliCredentialBlob): void;
  // Optional: download the current settings as a portable JSON file. Only the
  // live extension implements it (the demo omits it, hiding the action).
  exportSettings?(payload: SettingsExportPayload): void;
  // Optional: prompt the user for a settings file and resolve its raw parsed
  // JSON contents (or null if they cancel the picker). Validation/migration of
  // the result happens in Popup.tsx via @lurkloot/shared/settingsExport, not
  // here, so this stays a thin file-read.
  importSettings?(): Promise<unknown | null>;
  // Optional: write text to the system clipboard, resolving to whether it
  // worked. Hosts that omit it (the site demo) make the critical-failure panel
  // fall back to a selectable textarea instead of pretending the copy succeeded.
  writeClipboard?(text: string): Promise<boolean>;
  // Optional: download a text file from the popup. The live extension implements
  // it with a Blob URL; hosts that omit it (the site demo) hide Export all.
  downloadFile?(filename: string, contents: string, mimeType?: string): void;
  resetExtension?(): Promise<RuntimeSnapshot>;
  compatibilityRegistry?: PopupCompatibilityRegistry;
  resolveCompatibility?(settings: CompatibilitySettings): PopupCompatibilityResolution;
}

export interface PopupInitialState {
  preview?: boolean;
  locale?: SupportedLocale | null;
  variant?: ScreenshotVariant;
}
