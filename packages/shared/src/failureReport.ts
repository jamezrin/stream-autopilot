import type { CriticalHealthState } from "./criticalHealth";
import type { ActivityHistoryRecord } from "./events";
import type { EngineSettings, Platform, SchedulerState } from "./models";
import { isFarmingActive } from "./settings";

export interface FailureReportInput {
  platform: Platform;
  version: string;
  userAgent: string;
  locale: string;
  at: string;
  settings: EngineSettings;
  state: SchedulerState;
  events: readonly ActivityHistoryRecord[];
}

// The report is pasted into a public GitHub issue, so it carries codes, counts
// and timings only — never cookies, tokens, response bodies or anything the user
// would not knowingly publish.
const EVENT_LIMIT = 40;

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}\n`;
}

function bullets(entries: readonly (readonly [string, unknown])[]): string {
  return entries.map(([label, value]) => `- **${label}:** ${value ?? "—"}`).join("\n");
}

function detector(health: CriticalHealthState | undefined): string {
  if (!health) return "_no detector state_";
  return bullets([
    ["status", health.status],
    ["reason", health.reason],
    ["flagged at", health.flaggedAt],
    ["failing time (ms)", health.failingMs],
    ["failing ticks", health.failingTicks],
    ["last observed at", health.lastObservedAt],
    ["last watched minutes", health.lastWatchedMinutes],
    ["managed tab opens in window", health.managedTabOpens.length],
    ["breaker open", health.breakerOpen],
    ["cooldown until", health.cooldownUntil],
  ]);
}

function records(health: CriticalHealthState | undefined): string {
  if (!health || health.records.length === 0) return "_none recorded_";
  return health.records
    .map((record) => {
      const code = record.code ? ` ${record.code}` : "";
      const status = record.status === undefined ? "" : ` (${record.status})`;
      const detail = record.detail ? ` — ${record.detail}` : "";
      return `- \`${record.at}\` ${record.platform} ${record.kind}${code}${status}${detail}`;
    })
    .join("\n");
}

function recentEvents(entries: readonly ActivityHistoryRecord[]): string {
  if (entries.length === 0) return "_none recorded_";
  return entries
    .slice(-EVENT_LIMIT)
    .map((entry) => {
      const label = "legacy" in entry || entry.category === "diagnostic" ? entry.message : entry.code;
      return `- \`${entry.at}\` [${entry.level}] ${label}`;
    })
    .join("\n");
}

// Farming-relevant settings only, all booleans and enums. Channel lists and
// anything free-form are deliberately excluded. tablessMode is here because the
// motivating user report could not be diagnosed without knowing it.
function settingsSummary(settings: EngineSettings, platform: Platform): string {
  return bullets([
    ["farming active", isFarmingActive(settings)],
    ["tablessMode", settings.tablessMode],
    ["autoClaim", settings.autoClaim],
    ["pauseOnManualWatch", settings.pauseOnManualWatch],
    ["priorityMode", settings.priorityMode],
    ["platform enabled", settings.platform[platform].enabled],
    ["categoryMode", settings.platform[platform].categoryMode],
    ["compatibility profile", settings.compatibility[platform].profile],
    ["criticalFailurePromptEnabled", settings.criticalFailurePromptEnabled],
  ]);
}

export function buildFailureReport(input: FailureReportInput): string {
  const health = input.state.criticalHealth?.[input.platform];
  const session = input.state.sessions[input.platform];
  const auth = input.state.authHealth[input.platform];

  return [
    "# Lurkloot critical failure report",
    "",
    section("Environment", bullets([
      ["version", input.version],
      ["platform", input.platform],
      ["locale", input.locale],
      ["reported at", input.at],
      ["user agent", input.userAgent],
    ])),
    section("Detector", detector(health)),
    section("Session", bullets([
      ["status", session.status],
      ["reason code", session.reasonCode],
      ["watch mode", session.watchMode],
      ["tabless fallback", session.tablessFallback],
      ["last heartbeat ok", session.lastHeartbeatOk],
      ["heartbeat checks", session.heartbeatChecks],
      ["offline checks", session.offlineChecks],
      ["error checks", session.errorChecks],
      ["retry after", session.retryAfter],
      ["auth status", auth.status],
      ["auth reason", auth.reasonCode],
    ])),
    section("Settings", settingsSummary(input.settings, input.platform)),
    section("Failure records", records(health)),
    section("Recent events", recentEvents(input.events)),
  ].join("\n");
}
