import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { resolveCompatibility } from "@lurkloot/core";
import type { CompatibilityWarning } from "@lurkloot/shared/compatibility";
import { CURRENT_SETTINGS_SCHEMA_VERSION, type SettingsMigrationDiagnostic } from "@lurkloot/shared/settingsSchema";
import { DEFAULT_CLI_SETTINGS, parseCliSettingsWithDiagnostics, type CliSettings } from "./settings";

export const TRANSPORTS = ["http", "impersonate"] as const;
export type Transport = (typeof TRANSPORTS)[number];

export interface CliConfig {
  transport: Transport;
  // Absolute, resolved relative to the config file's directory.
  authDir: string;
  settings: CliSettings;
  configPath: string;
  warnings: string[];
}

export const ENABLED_LOG_LEVELS_WARNING = "settings.enabledLogLevels is deprecated and ignored; use --log debug|info|warn|error";

const CONFIG_KEYS = new Set<string>(["transport", "authDir", "settings"]);

function json(value: unknown): string {
  return JSON.stringify(value);
}

// The generated file is intentionally verbose: it doubles as the complete CLI
// settings reference while remaining safe to edit as JSONC. Values are read
// from DEFAULT_CLI_SETTINGS so the template cannot silently drift from runtime
// behavior when a shared default changes.
export function defaultConfigJsonc(): string {
  const defaults = DEFAULT_CLI_SETTINGS;
  const twitch = defaults.platform.twitch;
  const kick = defaults.platform.kick;
  const eligibility = defaults.farmingEligibility;
  return `{
  // "impersonate" works with both Twitch and Kick. Use "http" only for a
  // lighter Twitch-only setup; Kick's API rejects plain Node TLS requests.
  "transport": "impersonate",

  // Credentials are stored separately in this directory, relative to this file.
  "authDir": "auth",

  "settings": {
    // Schema version of this settings block. Leave it alone unless a release
    // note tells you otherwise; it lets LurkLoot skip replaying old migrations.
    "schemaVersion": ${CURRENT_SETTINGS_SCHEMA_VERSION},

    // Automatically claim completed drops.
    "autoClaim": ${json(defaults.autoClaim)},

    // ending_soonest | lowest_availability | priority_list_only
    "priorityMode": ${json(defaults.priorityMode)},
    // Map campaign IDs to numeric priorities; larger numbers are preferred.
    "campaignPriorities": ${json(defaults.campaignPriorities)},
    "excludedCampaignIds": ${json(defaults.excludedCampaignIds)},

    // Keep eligible drops first; use the Idle Watchlist only when none are available.
    "idleWatchlistFallbackOnly": ${json(defaults.idleWatchlistFallbackOnly)},
    // Prefer an Idle Watchlist or followed channel over a bigger anonymous one
    // when picking who to farm a campaign on.
    "preferKnownChannels": ${json(defaults.preferKnownChannels)},
    "offlineRetryLimit": ${json(defaults.offlineRetryLimit)},
    // How often campaign discovery and watch state are refreshed (1-60 minutes).
    "pollIntervalMinutes": ${json(defaults.pollIntervalMinutes)},

    // After claiming a reward, briefly re-check for the next one in the chain
    // instead of waiting for the regular one-minute watch cycle. Twitch only.
    "postClaimHandoff": ${json(defaults.postClaimHandoff)},
    // Seconds between re-checks (1-30) and the total budget before giving up
    // and falling back to the regular schedule (5-120).
    "postClaimHandoffIntervalSeconds": ${json(defaults.postClaimHandoffIntervalSeconds)},
    "postClaimHandoffMaxSeconds": ${json(defaults.postClaimHandoffMaxSeconds)},
    // Skip rewards that cannot finish before their earliest valid deadline.
    "skipUnfinishableRewards": ${json(defaults.skipUnfinishableRewards)},
    // 0 uses exact feasibility; 1-60 adds a safety buffer.
    "deadlineSafetyMarginMinutes": ${json(defaults.deadlineSafetyMarginMinutes)},
    // Kill switch for the critical-failure detector that flags the extension/CLI
    // as broken and stops farming. Thresholds are fixed constants.
    "criticalFailurePromptEnabled": ${json(defaults.criticalFailurePromptEnabled)},
    "notifyRewardEarned": ${json(defaults.notifyRewardEarned)},
    "notifyNoDropsLeft": ${json(defaults.notifyNoDropsLeft)},

    // Which campaigns LurkLoot is allowed to farm. Both default true; set a key
    // to false to skip campaigns needing an account link or requiring a channel
    // subscription. (The extension's display-only Drops-list filter is not a CLI
    // setting — a headless run has no Drops list.)
    "farmingEligibility": {
      "farmUnlinkedCampaigns": ${json(eligibility.farmUnlinkedCampaigns)},
      "farmSubscriptionCampaigns": ${json(eligibility.farmSubscriptionCampaigns)}
    },

    // Compatibility identifiers are bundled with this LurkLoot release.
    // "auto" is recommended. Raw destinations and hashes cannot be supplied.
    "compatibility": {
      "twitch": {
        // Profile selector, then expert heartbeat and inventory overrides.
        "profile": ${json(defaults.compatibility.twitch.profile)},
        "heartbeatTransport": ${json(defaults.compatibility.twitch.heartbeatTransport)},
        "inventoryQueryVersion": ${json(defaults.compatibility.twitch.inventoryQueryVersion)}
      },
      "kick": {
        // Profile selector, then expert claim-link handling override.
        "profile": ${json(defaults.compatibility.kick.profile)},
        "claimLinkHandling": ${json(defaults.compatibility.kick.claimLinkHandling)}
      }
    },

    "platform": {
      "twitch": {
        "enabled": ${json(twitch.enabled)},
        "idleWatchlistChannels": ${json(twitch.idleWatchlistChannels)},
        "excludedChannels": ${json(twitch.excludedChannels)},
        // "all" farms every category, "include" farms only the categories
        // listed below, "exclude" farms everything except them.
        "categoryMode": ${json(twitch.categoryMode)},
        // Used by "include" and "exclude". In "include" the order also sets
        // category priority; in "exclude" the order does not matter.
        "categories": ${json(twitch.categories)},
        // Claim channel-point bonuses while farming this platform.
        "autoClaimChannelPoints": ${json(twitch.autoClaimChannelPoints)},
        // Advanced: only farm a campaign on channels Twitch's AvailableDrops
        // query lists it for. Twitch often omits farmable campaigns there, so
        // enabling this can leave drops unfarmed.
        "strictCampaignAvailability": ${json(twitch.strictCampaignAvailability)}
      },
      "kick": {
        "enabled": ${json(kick.enabled)},
        "idleWatchlistChannels": ${json(kick.idleWatchlistChannels)},
        "excludedChannels": ${json(kick.excludedChannels)},
        // "all" farms every category, "include" farms only the categories
        // listed below, "exclude" farms everything except them.
        "categoryMode": ${json(kick.categoryMode)},
        // Used by "include" and "exclude". In "include" the order also sets
        // category priority; in "exclude" the order does not matter.
        "categories": ${json(kick.categories)},
        // Claim Kick's daily gamification challenges automatically.
        "autoClaimChallenges": ${json(kick.autoClaimChallenges)}
      }
    }
  }
}
`;
}

// Builds a validated config from already-parsed JSON. `transport` and `authDir`
// are CLI-specific; `settings` is the CLI's own settings schema (see settings.ts)
// — decoupled from the extension's ExtensionSettings and strict about unknown or
// extension-only keys. Credentials never live here (see authStore).
export function parseConfig(raw: unknown, configPath: string): CliConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Config must be a JSON object");
  }
  const data = raw as Record<string, unknown>;
  const unknown = Object.keys(data).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown config ${unknown.length === 1 ? "key" : "keys"}: ${unknown.map((k) => `"${k}"`).join(", ")}; expected one of: ${[...CONFIG_KEYS].join(", ")}`);
  }
  const transport = (data.transport as string | undefined) ?? "impersonate";
  if (!TRANSPORTS.includes(transport as Transport)) {
    throw new Error(`Unknown transport "${transport}"; expected one of: ${TRANSPORTS.join(", ")}`);
  }
  const authDir = resolve(dirname(configPath), (data.authDir as string | undefined) ?? "auth");
  const rawSettings = data.settings;
  const warnings: string[] = rawSettings !== null
    && typeof rawSettings === "object"
    && !Array.isArray(rawSettings)
    && Object.hasOwn(rawSettings, "enabledLogLevels")
    ? [ENABLED_LOG_LEVELS_WARNING]
    : [];
  const parsed = parseCliSettingsWithDiagnostics(data.settings);
  const settings = parsed.settings;
  warnings.push(...parsed.diagnostics.map(formatMigrationWarning));
  const webWarnings = resolveCompatibility(settings.compatibility, { host: "cli", twitchIdentity: "web" }).warnings;
  const androidWarnings = resolveCompatibility(settings.compatibility, { host: "cli", twitchIdentity: "android" }).warnings;
  warnings.push(...webWarnings.filter((candidate) => androidWarnings.some((warning) =>
    warning.code === candidate.code
    && warning.platform === candidate.platform
    && warning.field === candidate.field
    && warning.requested === candidate.requested
    && warning.resolved === candidate.resolved
  )).map(formatCompatibilityWarning));
  return {
    transport: transport as Transport,
    authDir,
    settings,
    configPath,
    warnings,
  };
}

// Warnings name the complete deprecated path and its replacement so the user
// can find and fix the exact line. The CLI config file is intentionally never
// rewritten, so these repeat on every startup until the file is edited. A future
// migration that removes a property outright carries no replacement, so fall
// back to a bare deprecation notice rather than printing "settings.undefined".
function formatMigrationWarning(diagnostic: SettingsMigrationDiagnostic): string {
  if (!diagnostic.replacement) {
    return `settings.${diagnostic.path} is deprecated and ignored`;
  }
  const verb = diagnostic.code === "moved_property" ? "moved to" : "is deprecated; use";
  return `settings.${diagnostic.path} ${verb} settings.${diagnostic.replacement}`;
}

function formatCompatibilityWarning(warning: CompatibilityWarning): string {
  const reason = warning.code === "unknown_selection" ? "Unknown" : "Host-incompatible";
  let field: string;
  if (warning.platform === "twitch") {
    field = warning.field === "profile"
      ? "Twitch profile"
      : warning.field === "heartbeatTransport" ? "Twitch heartbeat" : "Twitch inventory";
  } else {
    field = warning.field === "profile" ? "Kick profile" : "Kick claim";
  }
  return `${reason} ${field} compatibility selection; using ${warning.resolved}`;
}

export function loadConfig(configPath: string): CliConfig {
  const absolute = resolve(process.cwd(), configPath);
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw new Error(`Could not read config at ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, defaultConfigJsonc(), { encoding: "utf8", flag: "wx", mode: 0o644 });
      process.stderr.write(`Created default config at ${absolute}\n`);
    } catch (writeError) {
      // Another process may have initialized the same mounted data directory
      // between our read and write. In that case, keep its file and read it.
      if (!isErrno(writeError, "EEXIST")) {
        throw new Error(`Could not create default config at ${absolute}: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
      }
    }
    try {
      text = readFileSync(absolute, "utf8");
    } catch (readError) {
      throw new Error(`Could not read config at ${absolute}: ${readError instanceof Error ? readError.message : String(readError)}`);
    }
  }
  const errors: ParseError[] = [];
  const raw = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0];
    const before = text.slice(0, first.offset);
    const line = before.split("\n").length;
    const lastNewline = before.lastIndexOf("\n");
    const column = first.offset - lastNewline;
    throw new Error(`Config at ${absolute} is not valid JSONC: ${printParseErrorCode(first.error)} at line ${line}, column ${column}`);
  }
  return parseConfig(raw, absolute);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

// Overwrites the config's `settings` block in place, keeping `transport` and
// `authDir` untouched. Used only by `config import`: the config file is
// otherwise never rewritten (see the warning-formatting comments above), so
// this is a deliberate, explicit exception the user asked for by running that
// command. The commented JSONC template is not preserved — the file becomes
// plain JSON after the first import — which is why the CLI logs where it wrote.
export function saveConfigSettings(config: CliConfig, settings: CliSettings): void {
  writeFileSync(config.configPath, `${JSON.stringify({
    transport: config.transport,
    authDir: relative(dirname(config.configPath), config.authDir) || ".",
    settings,
  }, null, 2)}\n`, "utf8");
}

// `config export --out` must never resolve to the active config file: the
// export envelope carries only `settings`, not `transport`/`authDir`, so
// writing it over config.json would silently drop both on the next load.
export function assertExportOutputPath(outputPath: string, config: CliConfig): void {
  if (outputPath === config.configPath) {
    throw new Error(`--out must not be the active config file (${config.configPath}); the export envelope does not carry "transport"/"authDir" and would corrupt it`);
  }
}
