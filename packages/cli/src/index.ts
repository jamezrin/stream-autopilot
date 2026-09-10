#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import yargs, { type Argv, type ArgumentsCamelCase, type CommandModule } from "yargs";
import { hideBin } from "yargs/helpers";
import type { DropCampaign, Platform } from "@lurkloot/shared/models";
import type { EngineEvent } from "@lurkloot/shared/events";
import { KickWafBlockedError } from "@lurkloot/core/tabs";
import { assertExportOutputPath, loadConfig, saveConfigSettings, TRANSPORTS, type CliConfig, type Transport } from "./config";
import { buildCliSettingsExportPayload, parseCliSettingsImportPayload } from "./settings";
import { credentialAvailabilityOf, describeCredentialHealth, forgetCredentials, hasKickAuth, hasTwitchAuth, loadCredentials } from "./authStore";
import { createTransport, type EnabledPlatforms } from "./transport";
import { runLoop } from "./runtime/run";
import { formatDiscoveredCampaign } from "./runtime/status";
import { importCredentials } from "./auth/importCredentials";
import { twitchDeviceLogin } from "./auth/twitchDeviceFlow";
import { kickDeviceLogin } from "./auth/kickDeviceFlow";
import { createLogger } from "./logger";
import { reportCliEvents } from "./events";
import { toEngineSettings } from "./settings";
import type { LogLevel } from "@lurkloot/shared/logging";

// Global options carried by every command (yargs makes them inheritable), so the
// handlers below read them straight off argv.
function loggerOf(argv: ArgumentsCamelCase): ReturnType<typeof createLogger> {
  return createLogger((argv.log as LogLevel | undefined) ?? "info");
}
function configOf(argv: ArgumentsCamelCase, logger: ReturnType<typeof createLogger>): CliConfig {
  const config = loadConfig((argv.config as string | undefined) ?? "config.json");
  for (const warning of config.warnings) logger.warn(warning, "config");
  return config;
}

function resolveTransport(config: CliConfig, override?: string): Transport {
  // yargs `choices` already rejects bad values, but discover/run can also fall
  // back to the configured transport when none is passed.
  return (override as Transport | undefined) ?? config.transport;
}

function enabledPlatforms(config: CliConfig): EnabledPlatforms {
  return {
    twitch: config.settings.platform.twitch.enabled,
    kick: config.settings.platform.kick.enabled,
  };
}

function statePath(stateArg: string | undefined, config: CliConfig): string {
  if (stateArg) return resolve(process.cwd(), stateArg);
  return join(dirname(config.configPath), "state.json");
}

// Re-reads the file/env credential store each tick (so a login mid-run is
// noticed) and reports availability to the engine's pre-probe gate. Never
// inspects browser cookies and never returns a credential value.
function runCredentialAvailability(authDir: string, platform: Platform) {
  return credentialAvailabilityOf(describeCredentialHealth(authDir)[platform]);
}

const validateConfigCommand: CommandModule = {
  command: "validate-config",
  describe: "Load + normalize the config and print the effective settings",
  handler: (argv) => {
    const logger = loggerOf(argv);
    const config = configOf(argv, logger);
    process.stdout.write(`${JSON.stringify({ transport: config.transport, authDir: config.authDir, settings: config.settings }, null, 2)}\n`);
  },
};

const configCommand: CommandModule = {
  command: "config",
  describe: "Export or import the settings block of the config file",
  builder: (y) => y
    .command({
      command: "export",
      describe: 'Print the current settings as a portable file ("-" or --out - = stdout)',
      builder: (yy) => yy.option("out", { type: "string", default: "-", describe: 'Output file, or "-" for stdout' }),
      handler: (argv) => {
        const logger = loggerOf(argv);
        const config = configOf(argv, logger);
        const payload = buildCliSettingsExportPayload(config.settings);
        const text = `${JSON.stringify(payload, null, 2)}\n`;
        const out = String(argv.out ?? "-");
        if (out === "-") {
          process.stdout.write(text);
        } else {
          const outputPath = resolve(process.cwd(), out);
          assertExportOutputPath(outputPath, config);
          writeFileSync(outputPath, text, "utf8");
          logger.info(`Exported settings to ${outputPath}`, "config");
        }
      },
    })
    .command({
      command: "import <file>",
      describe: 'Import a settings export into the config file ("-" = stdin)',
      builder: (yy) => yy.positional("file", { type: "string", describe: "Export file, or - to read stdin", demandOption: true }),
      handler: (argv) => {
        const logger = loggerOf(argv);
        const config = configOf(argv, logger);
        // yargs-parser renders a bare "-" positional as "" — restore the stdin sentinel.
        const file = argv.file === "" ? "-" : String(argv.file);
        const text = file === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(process.cwd(), file), "utf8");
        const raw = JSON.parse(text);
        const { settings, diagnostics } = parseCliSettingsImportPayload(raw);
        for (const diagnostic of diagnostics) logger.warn(diagnostic.message, "config");
        saveConfigSettings(config, settings);
        logger.info(`Imported settings into ${config.configPath} (comments in the config file were not preserved)`, "config");
      },
    })
    .demandCommand(1, "Specify a config subcommand (export | import)")
    .strict(),
  handler: () => { /* a subcommand always runs; see demandCommand above */ },
};

const discoverCommand: CommandModule = {
  command: "discover",
  describe: "Run one discovery pass per enabled platform",
  builder: (y) => y.option("transport", { type: "string", choices: TRANSPORTS, describe: "Override the config transport" }),
  handler: async (argv) => {
    const logger = loggerOf(argv);
    const config = configOf(argv, logger);
    const transport = resolveTransport(config, argv.transport as string | undefined);
    const creds = loadCredentials(config.authDir);
    const enabled = enabledPlatforms(config);
    const handle = await createTransport(transport, creds, config.authDir, enabled);
    try {
      for (const platform of ["twitch", "kick"] as Platform[]) {
        if (!enabled[platform]) {
          logger.info("disabled in config — skipping", platform);
          continue;
        }
        const events: EngineEvent[] = [];
        const emit = (event: EngineEvent) => events.push(event);
        const { adapter } = handle.createAdapter(platform, emit, toEngineSettings(config.settings));
        try {
          await discoverPlatform(platform, adapter, logger);
        } finally {
          adapter.flushRouteDiagnostics?.(emit);
          await reportCliEvents(events, logger);
        }
      }
    } finally {
      await handle.dispose();
    }
  },
};

const runCommand: CommandModule = {
  command: "run",
  describe: "Full farming loop until SIGINT/SIGTERM",
  builder: (y) => y
    .option("transport", { type: "string", choices: TRANSPORTS, describe: "Override the config transport" })
    .option("state", { type: "string", describe: "State file (default: <configDir>/state.json)" })
    .option("once", { type: "boolean", default: false, describe: "Run a single tick, then exit" }),
  handler: async (argv) => {
    const logger = loggerOf(argv);
    const config = configOf(argv, logger);
    const transport = resolveTransport(config, argv.transport as string | undefined);
    const creds = loadCredentials(config.authDir);
    const handle = await createTransport(transport, creds, config.authDir, enabledPlatforms(config));
    await runLoop({
      settings: config.settings,
      statePath: statePath(argv.state as string | undefined, config),
      transport: handle,
      logger,
      once: Boolean(argv.once),
      checkCredentialAvailability: async (platform) => runCredentialAvailability(config.authDir, platform),
    });
  },
};

// `auth <platform> device-login | logout` — declared explicitly per platform so
// each verb gets its own --help entry and shows up in shell completion.
function platformAuthCommand(platform: "twitch" | "kick"): CommandModule {
  const loginBrief = platform === "twitch" ? "Twitch device-code OAuth (no browser)" : "Kick smart-TV link flow (no browser)";
  return {
    command: platform,
    describe: `Manage ${platform} credentials`,
    builder: (y) => y
      .command({
        command: "device-login",
        describe: loginBrief,
        handler: async (argv) => {
          const logger = loggerOf(argv);
          const { authDir } = configOf(argv, logger);
          if (platform === "twitch") await twitchDeviceLogin(authDir, logger);
          else await kickDeviceLogin(authDir, logger);
        },
      })
      .command({
        command: "logout",
        describe: `Forget stored ${platform} credentials`,
        handler: (argv) => {
          const logger = loggerOf(argv);
          const { authDir } = configOf(argv, logger);
          const forgotten = forgetCredentials(authDir, platform);
          logger.info(forgotten ? `Forgot stored ${platform} credentials` : `No stored ${platform} credentials to forget`, "auth");
          // The on-disk store is gone, but loadCredentials still layers SA_* env
          // overrides on top — flag that so "logged out" is not misleading.
          const remaining = loadCredentials(authDir);
          if (platform === "twitch" ? hasTwitchAuth(remaining) : hasKickAuth(remaining)) {
            logger.warn(`${platform} is still authenticated via an SA_* env override; unset it to fully log out`, "auth");
          }
        },
      })
      .demandCommand(1, "Specify a verb: device-login or logout")
      .strict(),
    handler: () => { /* a subcommand always runs; see demandCommand above */ },
  };
}

const authCommand: CommandModule = {
  command: "auth",
  describe: "Manage stored credentials",
  builder: (y) => y
    .command({
      command: "import <file>",
      describe: 'Import an extension credential export ("-" = stdin)',
      builder: (yy) => yy.positional("file", { type: "string", describe: "Export file, or - to read stdin", demandOption: true }),
      handler: (argv) => {
        const logger = loggerOf(argv);
        const { authDir } = configOf(argv, logger);
        // yargs-parser renders a bare "-" positional as "" — restore the stdin sentinel.
        const file = argv.file === "" ? "-" : String(argv.file);
        const creds = importCredentials(authDir, file);
        logger.info(`Imported credentials${creds.twitch?.authToken ? " (twitch)" : ""}${creds.kick?.sessionToken ? " (kick)" : ""} into ${authDir}`, "auth");
      },
    })
    .command(platformAuthCommand("twitch"))
    .command(platformAuthCommand("kick"))
    .command({
      command: "status",
      describe: "Report which credentials are available",
      handler: (argv) => {
        const logger = loggerOf(argv);
        const { authDir } = configOf(argv, logger);
        const creds = loadCredentials(authDir);
        const health = describeCredentialHealth(authDir);
        // Reports presence, source, and the shared safe status/reason code — never
        // the credential values themselves. "checking" here means a credential is
        // present but unverified; `run` performs the live probe.
        process.stdout.write(`${JSON.stringify({
          authDir,
          twitch: {
            authToken: hasTwitchAuth(creds),
            deviceId: Boolean(creds.twitch?.deviceId),
            source: health.twitch.source,
            status: health.twitch.status,
            ...(health.twitch.reasonCode ? { reasonCode: health.twitch.reasonCode } : {}),
          },
          kick: {
            sessionToken: hasKickAuth(creds),
            source: health.kick.source,
            status: health.kick.status,
            ...(health.kick.reasonCode ? { reasonCode: health.kick.reasonCode } : {}),
          },
        }, null, 2)}\n`);
      },
    })
    .demandCommand(1, "Specify an auth subcommand (import | twitch | kick | status)")
    .strict(),
  handler: () => { /* a subcommand always runs; see demandCommand above */ },
};

async function discoverPlatform(platform: Platform, adapter: { refreshCampaigns(): Promise<DropCampaign[]> }, logger: ReturnType<typeof createLogger>): Promise<void> {
  try {
    const campaigns = await adapter.refreshCampaigns();
    logger.info(`discovered ${campaigns.length} campaign(s)`, platform);
    for (const campaign of campaigns.slice(0, 20)) {
      for (const line of formatDiscoveredCampaign(campaign)) logger.info(line, platform);
    }
  } catch (error) {
    if (error instanceof KickWafBlockedError) {
      logger.warn(`Cloudflare WAF blocked the request (HTTP 403). Use the "impersonate" transport to reach Kick without a browser. (${error.message})`, platform);
      return;
    }
    logger.error(error instanceof Error ? error.message : String(error), platform);
  }
}

function buildCli(argv: string[]): Argv {
  return yargs(argv)
    .scriptName("lurkloot")
    .usage("$0 <command> [options]")
    .option("config", { type: "string", default: "config.json", describe: "Config file (created with defaults if missing)", global: true })
    .option("log", { type: "string", choices: ["debug", "info", "warn", "error"], default: "info", describe: "Log level", global: true })
    .command(validateConfigCommand)
    .command(configCommand)
    .command(discoverCommand)
    .command(runCommand)
    .command(authCommand)
    .demandCommand(1, "Specify a command (run with --help to list them)")
    .strict()
    .completion("completion", "Print a shell-completion script (eval it in bash/zsh)")
    .alias("h", "help")
    .help()
    .wrap(Math.min(110, process.stdout.columns ?? 110));
}

buildCli(hideBin(process.argv))
  .parseAsync()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
