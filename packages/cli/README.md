# @lurkloot/cli

A headless command-line / Docker runtime for Lurkloot. It reuses the browser
extension's farming engine (`@lurkloot/core`) through clean port/adapter seams —
there is **no faking of `chrome`/`browser` globals**, and **no browser at all**:
both platforms farm over pure HTTP.

## Quick start

```bash
pnpm install
pnpm --filter @lurkloot/cli build          # bundles dist/index.mjs
node packages/cli/dist/index.mjs validate-config --config ./config.json
# or, from the repo root:
pnpm cli validate-config --config ./config.json
```

## Config

The CLI creates the requested config file automatically when it does not exist.
The generated file is JSONC: it lists every supported default and includes
comments explaining the important choices. Existing `.json` and `.jsonc` files
both accept `//` / `/* */` comments and trailing commas.

The CLI has its **own** settings schema — it is *not* the extension's
`ExtensionSettings` verbatim. Only settings that do something in the headless,
tabless watch path are accepted; the schema is validated strictly, so an unknown
key (or an extension-only one copy-pasted from the browser config) is a **hard
error** that names the offender. `running` and `tablessMode` are gone — the CLI
always runs and is always tabless. **Credentials never go in the config** — they
live in the auth store.

Legacy `settings.enabledLogLevels` is accepted but ignored, with one actionable
warning per command; use the global `--log debug|info|warn|error` option instead.
`diagnosticLogging` is extension-only and is rejected because the CLI's `--log`
option is its sole event filter.

Supported `settings` keys: `autoClaim`, `autoClaimChannelPoints`, `priorityMode`,
`campaignPriorities`, `excludedCampaignIds`, `idleWatchlistFallbackOnly`,
`preferKnownChannels`, `offlineRetryLimit`, `pollIntervalMinutes`,
`notifyRewardEarned`, `notifyNoDropsLeft`, `farmingEligibility`, and per-platform
`enabled`, `idleWatchlistChannels`, `excludedChannels`, `categoryMode`,
`categories`.

`categoryMode` is `"all"` (farm every category), `"include"` (farm only the
categories in `categories`, whose order also sets category priority) or
`"exclude"` (farm everything except them; an empty list then behaves like
`"all"`). An unknown value is rejected rather than defaulted. A config still
using the old `farmAllCategories` boolean is migrated automatically — `false`
becomes `"include"`, anything else becomes `"all"` — with a startup warning.

`farmingEligibility` gates what the engine may farm. Its two keys both default
`true`: set `farmUnlinkedCampaigns` to `false` to skip campaigns that need an
account link, and `farmSubscriptionCampaigns` to `false` to skip campaigns that
require a channel subscription; when every discovered campaign is filtered out,
the run logs a warning saying so. A config still using the old name
`campaignVisibility` is migrated automatically (its farming half becomes
`farmingEligibility`), with one deprecation warning per command, rather than
rejected.

Rejected (extension-only, no effect headlessly): `running`, `tablessMode`,
`muteFarmingTabs`, `keepFarmingVideosUnmuted`, `pauseOnManualWatch`,
`adFocusMode`, `autoCloseFinishedDrops`, `autoStartDropFarming`,
`languageOverride`, `rateNudgeStatus`, `githubStarNudgeStatus`, `diagnosticLogging`, `dropsListFilter`.

```jsonc
{
  "transport": "impersonate",   // default; use "http" for Twitch-only setups
  "authDir": "auth",            // resolved relative to this file
  "settings": {                 // CLI settings schema, merged over defaults
    "pollIntervalMinutes": 5,
    "platform": {
      "twitch": { "enabled": true },
      "kick":   { "enabled": true }
    }
  }
}
```

## Transports

| Transport | Twitch | Kick | Notes |
|---|---|---|---|
| `http` | ✅ plain Node fetch | ❌ Cloudflare WAF (403) | Lightest; Twitch-only in practice. |
| `impersonate` | ✅ | ✅ **cycletls Chrome JA3/HTTP-2** | Recommended default. Reaches both with no browser. |

Both transports talk to Twitch as the **Android app client**
(`kd1unb4b3q4t58fwlpcbzcbnm76a8fp`) — the same identity TwitchDropsMiner uses.
Twitch only enforces Client-Integrity (Kasada) for the *web* client id, so under
the Android client discovery, watch progress, **and drop claims** all work with
plain OAuth — no integrity token, no browser.

Kick's Cloudflare WAF inspects the TLS/JA3 + HTTP-2 fingerprint, so a plain Node
request is rejected (HTTP 403). The `impersonate` transport sends a real Chrome
fingerprint via [cycletls](https://github.com/Danny-Dasilva/CycleTLS) and reaches
Kick's API and viewer socket without a browser.

## Auth

Credentials live in `<authDir>/credentials.json`. The `auth` sub-commands write
the store; `auth status` reports what is present.

```bash
pnpm cli auth twitch device-login    # Twitch device-code OAuth, no browser
pnpm cli auth kick device-login      # Kick smart-TV link flow, no browser
pnpm cli auth import creds.json      # import an extension export ("-" = stdin)
pnpm cli auth kick logout            # forget stored credentials for a platform
pnpm cli auth status
```

- **`auth twitch device-login`** runs Twitch's device-code OAuth against the
  Android client (no scopes, like TDM): it prints an activation URL + code, you
  approve it on any device, and the token is saved. The token's client matches
  the Client-ID the transports send, so no integrity is ever required.
- **`auth kick device-login`** runs Kick's smart-TV link flow (the same one the
  Kick TV app uses): it prints a `kick.com/tv/login` URL + a 6-digit code; open
  it on any device where you're signed in to Kick and confirm the code, and the
  session token is saved — no cookie export needed.
- **`auth import`** ingests a credential blob exported by the extension
  (Settings → **Export credentials**) — another way to supply a **Kick** session
  token headlessly.

Env-var overrides (useful for Docker secrets) take precedence over the store:
`SA_TWITCH_AUTH_TOKEN`, `SA_TWITCH_DEVICE_ID`, `SA_TWITCH_CLIENT_ID`,
`SA_KICK_SESSION_TOKEN`.

## Commands

- `validate-config` — load + normalize the config; print the effective settings.
- `discover` — one discovery pass per enabled platform.
- `run` — full farming loop (discovery + watch heartbeats) until SIGINT/SIGTERM,
  persisting `state.json`. `pnpm cli run --once` is the explicit refresh command:
  it discovers campaigns, refreshes authoritative progress, claims eligible
  rewards, persists state, and exits.
- `auth import <file>` — import an extension credential export ("-" = stdin).
- `auth twitch device-login` — Twitch device-code OAuth (no browser).
- `auth kick device-login` — Kick smart-TV link flow (no browser).
- `auth <platform> logout` — forget the stored `twitch` / `kick` credentials (an
  `SA_*` env override, if set, still applies — it warns when that's the case).
- `auth status` — report which credentials are present.

The CLI is built on [yargs](https://yargs.js.org): every command and subcommand
has `--help`, unknown flags/subcommands are rejected, and `--config` / `--log`
are accepted everywhere. For shell autocomplete, source the generated script:

```bash
pnpm cli completion >> ~/.bashrc   # or ~/.zshrc, then restart your shell
```

## Event logging

The farming engine reports typed activity and diagnostic batches directly to
the CLI. The CLI preserves their causal order, formats activity records into
human-readable lines, and passes diagnostic messages through unchanged. Lines
go to stderr and are filtered only by `--log`; `state.json` contains scheduler
state, never new event history. Use Docker logs, systemd/journald, Loki, or
another external collector when retention is needed. Loading and saving an old
state file also removes any legacy embedded `events` field.

Subscription requirements are reported separately from watch progress. The CLI
never tries to satisfy them by opening or farming a stream, and it reports
partial subscription progress as unavailable when Twitch does not provide an
authoritative count rather than inventing `0/N`. During the normal loop, a
waiting requirement is logged only when it first appears; once Twitch confirms
the reward, the next poll detects and claims it, with the existing reward-claimed
engine event providing the notification. Run `pnpm cli run --once` whenever an
immediate non-interactive refresh is needed.

## Docker

No browser means a slim Node image:

```bash
# build from the repo root
docker build -f packages/cli/Dockerfile -t lurkloot-cli .

# Or use the published image. The first command creates a documented config.json.
# Authenticate Twitch and/or Kick before starting the farming loop.
docker run --rm -it -v "$PWD/data:/data" \
  ghcr.io/jamezrin/lurkloot-cli:latest auth twitch device-login
docker run --rm -it -v "$PWD/data:/data" \
  ghcr.io/jamezrin/lurkloot-cli:latest auth kick device-login

# Leave the farming loop running in the background.
docker run -d --name lurkloot --restart unless-stopped \
  -v "$PWD/data:/data" ghcr.io/jamezrin/lurkloot-cli:latest

# The same flow with an image built locally:
docker run --rm -v "$PWD/data:/data" lurkloot-cli
# one-off discovery
docker run --rm -v "$PWD/data:/data" lurkloot-cli discover --config /data/config.json
```

Authenticate first — `auth twitch device-login` / `auth kick device-login` work
headlessly inside the container, or run them on any host and mount the resulting
`auth/` dir in. A Kick token can also come from an extension export
(`auth import`) or `SA_KICK_SESSION_TOKEN`.
