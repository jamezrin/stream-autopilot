import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { defaultConfigJsonc, loadConfig, parseConfig } from "../src/config";
import { DEFAULT_CLI_SETTINGS } from "../src/settings";
import { CURRENT_SETTINGS_SCHEMA_VERSION } from "@lurkloot/shared/settingsSchema";

const CONFIG_PATH = "/tmp/lurkloot/config.json";
const CLI_PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = join(CLI_PACKAGE_DIR, "dist/index.mjs");
const LEGACY_WARNING = "settings.enabledLogLevels is deprecated and ignored; use --log debug|info|warn|error";

beforeAll(() => {
  execFileSync("pnpm", ["build"], { cwd: CLI_PACKAGE_DIR, stdio: "pipe" });
});

function runCli(configPath: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_PATH, ...args, "--config", configPath], {
    cwd: CLI_PACKAGE_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      SA_TWITCH_AUTH_TOKEN: undefined,
      SA_TWITCH_DEVICE_ID: undefined,
      SA_KICK_SESSION_TOKEN: undefined,
    },
  });
}

function writeLegacyConfig(dir: string): string {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({
    transport: "http",
    settings: {
      enabledLogLevels: ["error"],
      platform: {
        twitch: { enabled: false },
        kick: { enabled: false },
      },
    },
  }));
  return path;
}

describe("parseConfig", () => {
  it("defaults to the impersonate transport and <configDir>/auth", () => {
    const config = parseConfig({}, CONFIG_PATH);
    expect(config.transport).toBe("impersonate");
    expect(config.authDir).toBe(resolve("/tmp/lurkloot", "auth"));
  });

  it("resolves authDir relative to the config file directory", () => {
    const config = parseConfig({ authDir: "creds" }, CONFIG_PATH);
    expect(config.authDir).toBe(resolve("/tmp/lurkloot", "creds"));
  });

  it("merges settings over the CLI defaults", () => {
    const config = parseConfig({ settings: { pollIntervalMinutes: 7 } }, CONFIG_PATH);
    expect(config.settings.pollIntervalMinutes).toBe(7);
    // A field left out of the config still gets its default.
    expect(typeof config.settings.autoClaim).toBe("boolean");
    expect(config.settings.platform.twitch).toBeDefined();
  });

  it("warns once when enabledLogLevels is present", () => {
    const config = parseConfig({ settings: { enabledLogLevels: ["error"] } }, CONFIG_PATH);
    expect(config.warnings).toEqual([
      "settings.enabledLogLevels is deprecated and ignored; use --log debug|info|warn|error",
    ]);
  });

  it("has no config warnings by default", () => {
    expect(parseConfig({}, CONFIG_PATH).warnings).toEqual([]);
  });

  it("surfaces credential-safe compatibility resolver warnings", () => {
    const config = parseConfig({
      settings: { compatibility: { twitch: { profile: "secret-unknown-profile" } } },
    }, CONFIG_PATH);

    expect(config.warnings).toEqual([
      "Unknown Twitch profile compatibility selection; using twitch-2026-07",
    ]);
    expect(config.warnings.join(" ")).not.toContain("secret-unknown-profile");
  });

  it("defers identity-specific Twitch compatibility warnings until credentials are loaded", () => {
    const config = parseConfig({
      settings: { compatibility: { twitch: { heartbeatTransport: "twitch-heartbeat-trowel-v1" } } },
    }, CONFIG_PATH);

    expect(config.warnings).toEqual([]);
  });

  it("rejects extension-only settings copied from the browser config", () => {
    expect(() => parseConfig({ settings: { adFocusMode: "window" } }, CONFIG_PATH)).toThrow(/extension-only/);
  });

  it("rejects diagnosticLogging as extension-only", () => {
    expect(() => parseConfig({ settings: { diagnosticLogging: true } }, CONFIG_PATH)).toThrow(/extension-only/);
  });

  it("rejects an unknown top-level config key", () => {
    expect(() => parseConfig({ credentials: {} }, CONFIG_PATH)).toThrow(/Unknown config key/);
  });

  it("accepts every known transport", () => {
    for (const transport of ["http", "impersonate"] as const) {
      expect(parseConfig({ transport }, CONFIG_PATH).transport).toBe(transport);
    }
  });

  it("rejects the retired browser transport", () => {
    expect(() => parseConfig({ transport: "browser" }, CONFIG_PATH)).toThrow(/Unknown transport/);
  });

  it("rejects an unknown transport", () => {
    expect(() => parseConfig({ transport: "carrier-pigeon" }, CONFIG_PATH)).toThrow(/Unknown transport/);
  });

  it("rejects a non-object config", () => {
    expect(() => parseConfig([], CONFIG_PATH)).toThrow(/must be a JSON object/);
    expect(() => parseConfig(null, CONFIG_PATH)).toThrow(/must be a JSON object/);
  });

  it("warns with the full deprecated and replacement paths", () => {
    const config = parseConfig({
      settings: { watchQueueFallbackOnly: false, platform: { kick: { watchQueueChannels: ["a"] } } },
    }, CONFIG_PATH);
    expect(config.warnings).toContain("settings.watchQueueFallbackOnly is deprecated; use settings.idleWatchlistFallbackOnly");
    expect(config.warnings).toContain("settings.platform.kick.watchQueueChannels is deprecated; use settings.platform.kick.idleWatchlistChannels");
  });

  it("warns about a moved property with its destination path", () => {
    const config = parseConfig({ settings: { autoClaimChannelPoints: false } }, CONFIG_PATH);
    expect(config.warnings).toContain("settings.autoClaimChannelPoints moved to settings.platform.twitch.autoClaimChannelPoints");
  });

  it("repeats the warnings on every independent load", () => {
    const raw = { settings: { watchQueueFallbackOnly: false } };
    expect(parseConfig(raw, CONFIG_PATH).warnings).toEqual(parseConfig(raw, CONFIG_PATH).warnings);
  });

  it("emits no migration warnings for a config with no deprecated keys", () => {
    expect(parseConfig({ settings: { schemaVersion: 1, autoClaim: true } }, CONFIG_PATH).warnings).toEqual([]);
  });

  it("generates a template that carries the current schema version", () => {
    expect(defaultConfigJsonc()).toContain(`"schemaVersion": ${CURRENT_SETTINGS_SCHEMA_VERSION}`);
    expect(parseConfig(parseJsonc(defaultConfigJsonc()), CONFIG_PATH).warnings).toEqual([]);
  });

  it("never rewrites the config file while migrating", () => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-config-"));
    const path = join(dir, "config.jsonc");
    writeFileSync(path, '{ "settings": { "watchQueueFallbackOnly": false } }\n');
    const before = readFileSync(path, "utf8");
    const beforeStat = statSync(path).mtimeMs;

    const config = loadConfig(path);

    expect(config.settings.idleWatchlistFallbackOnly).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(statSync(path).mtimeMs).toBe(beforeStat);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("loadConfig", () => {
  it("creates and loads a documented default JSONC config when the file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-config-"));
    try {
      const path = join(dir, "nested", "config.json");
      const config = loadConfig(path);
      const generated = readFileSync(path, "utf8");

      expect(generated).toContain("// Credentials are stored separately");
      expect(generated).toContain('"transport": "impersonate"');
      expect(generated).toContain("Compatibility identifiers are bundled");
      expect(generated).toContain("Raw destinations and hashes cannot be supplied");
      expect(generated).toContain('"heartbeatTransport": "auto"');
      expect(generated).toContain('"inventoryQueryVersion": "auto"');
      expect(generated).toContain('"claimLinkHandling": "auto"');
      expect(config.transport).toBe("impersonate");
      expect(config.authDir).toBe(join(dir, "nested", "auth"));
      expect(config.settings).toEqual(DEFAULT_CLI_SETTINGS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts comments and trailing commas in an existing config", () => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-config-"));
    try {
      const path = join(dir, "config.jsonc");
      writeFileSync(path, `{
        // Kick-compatible transport
        "transport": "impersonate",
        "settings": {
          "pollIntervalMinutes": 7,
        },
      }`);

      expect(loadConfig(path).settings.pollIntervalMinutes).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a useful location for malformed JSONC", () => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-config-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, "{\n  \"transport\":,\n}\n");
      expect(() => loadConfig(path)).toThrow(/not valid JSONC: .*line 2, column/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the generated template aligned with runtime defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-config-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, defaultConfigJsonc());
      expect(defaultConfigJsonc()).toContain('"skipUnfinishableRewards": true');
      expect(defaultConfigJsonc()).toContain("0 uses exact feasibility; 1-60 adds a safety buffer.");
      expect(defaultConfigJsonc()).toContain('"deadlineSafetyMarginMinutes": 5');
      expect(loadConfig(path).settings).toEqual(DEFAULT_CLI_SETTINGS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("documents the farming-eligibility keys in the template", () => {
    // farmingEligibility gates what a headless run earns, so an omitted block is
    // a real documentation gap — and the round-trip above cannot catch it.
    const template = defaultConfigJsonc();
    for (const [key, value] of Object.entries(DEFAULT_CLI_SETTINGS.farmingEligibility)) {
      expect(template).toContain(`"${key}": ${value}`);
    }
    expect(parseJsonc(defaultConfigJsonc()).settings.farmingEligibility).toEqual(DEFAULT_CLI_SETTINGS.farmingEligibility);
  });

  it("documents the category mode and its three values in the template", () => {
    // The round-trip merges defaults, so an omitted key would still pass there.
    // Assert the template renders the key and explains every mode, since the
    // template doubles as the CLI settings reference.
    const template = defaultConfigJsonc();
    expect(template).toContain(`"categoryMode": "${DEFAULT_CLI_SETTINGS.platform.twitch.categoryMode}"`);
    expect(template).not.toContain("farmAllCategories");
    for (const mode of ["all", "include", "exclude"]) expect(template).toContain(`"${mode}"`);
  });

  it("documents the post-claim handoff settings in the template", () => {
    // The round-trip above merges defaults, so an omitted key would still pass
    // there. Assert the template itself carries them, with the rendered values.
    const template = defaultConfigJsonc();
    expect(template).toContain(`"postClaimHandoff": ${DEFAULT_CLI_SETTINGS.postClaimHandoff}`);
    expect(template).toContain(`"postClaimHandoffIntervalSeconds": ${DEFAULT_CLI_SETTINGS.postClaimHandoffIntervalSeconds}`);
    expect(template).toContain(`"postClaimHandoffMaxSeconds": ${DEFAULT_CLI_SETTINGS.postClaimHandoffMaxSeconds}`);
  });
});

describe("CLI config warning integration", () => {
  it("reports Kick route transitions and one summary from discover --log debug", () => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-discover-routes-"));
    try {
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, JSON.stringify({ transport: "http", settings: {
        platform: { twitch: { enabled: false }, kick: { enabled: true } },
      } }));
      const fakeNetwork = "globalThis.fetch = async (url) => { if (!['https://web.kick.com/api/v1/drops/campaigns', 'https://web.kick.com/api/v1/drops/progress'].includes(String(url))) throw new Error('Unexpected request'); return new Response(JSON.stringify({data: []}), {status: 200, headers: {'content-type': 'application/json'}}); };";
      const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(fakeNetwork)}`, CLI_PATH, "discover", "--log", "debug", "--config", configPath], {
        cwd: CLI_PACKAGE_DIR,
        encoding: "utf8",
        env: { ...process.env, SA_KICK_SESSION_TOKEN: undefined, SA_TWITCH_AUTH_TOKEN: undefined, SA_TWITCH_DEVICE_ID: undefined },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("discovered 0 campaign(s)");
      expect(result.stderr.match(/INFO \[kick\] Kick fetch web\.kick\.com/g) ?? []).toHaveLength(1);
      expect(result.stderr.match(/DEBUG \[kick\] Kick fetch success summary: web\.kick\.com\.background=2/g) ?? []).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["validate-config", ["validate-config"]],
    ["discover", ["discover"]],
    ["run once", ["run", "--once"]],
    ["auth status", ["auth", "status"]],
  ])("emits the legacy warning exactly once for %s", (_name, args) => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-command-"));
    try {
      const result = runCli(writeLegacyConfig(dir), args);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr.split(LEGACY_WARNING)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters the legacy warning at --log error", () => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-command-"));
    try {
      const result = runCli(writeLegacyConfig(dir), ["validate-config", "--log", "error"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain(LEGACY_WARNING);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps validate-config stdout as valid JSON while warning on stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-command-"));
    try {
      const result = runCli(writeLegacyConfig(dir), ["validate-config"]);
      expect(result.status, result.stderr).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({ transport: "http" });
      expect(result.stdout).not.toContain(LEGACY_WARNING);
      expect(result.stderr).toContain(LEGACY_WARNING);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("config export/import", () => {
  it("refuses to export over the active config file and leaves it untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-command-"));
    try {
      const configPath = writeLegacyConfig(dir);
      const before = readFileSync(configPath, "utf8");
      const result = runCli(configPath, ["config", "export", "--out", configPath]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/--out must not be the active config file/);
      expect(readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips settings through export and import", () => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-command-"));
    try {
      const configPath = writeLegacyConfig(dir);
      const exportPath = join(dir, "exported.json");
      const exportResult = runCli(configPath, ["config", "export", "--out", exportPath]);
      expect(exportResult.status, exportResult.stderr).toBe(0);

      const importResult = runCli(configPath, ["config", "import", exportPath]);
      expect(importResult.status, importResult.stderr).toBe(0);

      const validateResult = runCli(configPath, ["validate-config"]);
      expect(validateResult.status, validateResult.stderr).toBe(0);
      const settings = JSON.parse(validateResult.stdout).settings;
      expect(settings.platform.twitch.enabled).toBe(false);
      expect(settings.platform.kick.enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
