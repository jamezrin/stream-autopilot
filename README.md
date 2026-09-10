# Lurkloot

**Farm Twitch and Kick drops automatically.** Lurkloot finds eligible campaigns, watches the right channel, switches when needed, and claims your rewards—all through the browser session you already use.

[Website](https://lurkloot.jamezrin.com) · [Install from the Chrome Web Store](https://chromewebstore.google.com/detail/lurkloot/aobaackpofkghaejdnnmpmeaiaoibhdn) · [Changelog](https://lurkloot.jamezrin.com/changelog)

## Why Lurkloot?

- **Set it and leave it:** choose the games and campaigns you care about, or let the scheduler decide what to farm next.
- **Automatic rewards:** claim completed drops and, optionally, Twitch channel points without keeping track yourself.
- **Smart channel switching:** move between eligible live channels as campaigns finish or streams go offline.
- **Light on resources:** use low-resource tabless mode, with an automatic fallback to a pinned, muted tab if progress stalls.
- **Twitch and Kick together:** manage both platforms from one popup, including campaign priorities, idle watchlists, and excluded channels.
- **Private by design:** no Lurkloot account, no password requests, no telemetry, and no remote Lurkloot service handling your session.

Lurkloot is free and open source under the [Apache License 2.0](LICENSE).

## Get started

1. [Install Lurkloot from the Chrome Web Store](https://chromewebstore.google.com/detail/lurkloot/aobaackpofkghaejdnnmpmeaiaoibhdn). Firefox builds are also available from [GitHub Releases](https://github.com/jamezrin/lurkloot/releases). To try a GitHub pre-release Chrome zip, see [Installing a pre-release build](docs/install-prerelease.md).
2. Sign in to Twitch or Kick normally in your browser.
3. Open the Lurkloot popup and enable the platforms you want to use.
4. Pick your preferred campaigns, games, or channels—or keep the defaults and let Lurkloot choose.

By default, Lurkloot farms through visible, pinned, muted tabs. You can enable tabless mode in the advanced settings for lower resource use; if its watch progress becomes unhealthy, Lurkloot falls back to a visible tab automatically.

## Your account stays yours

The extension runs locally and talks directly to Twitch and Kick using your existing signed-in browser session. It does not ask for your password, export your cookies, collect analytics, or route activity through a Lurkloot server. See the [privacy policy](https://lurkloot.jamezrin.com/privacy) for the full details.

## Headless and Docker use

Want to run Lurkloot on a server, NAS, or Raspberry Pi? The project also includes a headless CLI and a prebuilt multi-architecture Docker image. It uses the same farming engine without requiring a browser.

See the [CLI guide](packages/cli/README.md) for authentication, configuration, and Docker instructions.

## Help and feedback

If something is not working, [open a bug report](https://github.com/jamezrin/lurkloot/issues/new?template=bug_report.yml). Include the requested browser, platform, and reproduction details, but never share passwords, cookies, session tokens, or other credentials.

Feature ideas and contributions are welcome through [GitHub Issues](https://github.com/jamezrin/lurkloot/issues) and pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, conventions, and checks a pull request should follow.

## Development

Lurkloot is a TypeScript pnpm monorepo built around a WXT browser extension. To run the main checks locally:

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm build:firefox
```

For implementation details and package boundaries, see [the architecture guide](docs/architecture.md). For how to set up the repository, the branch and commit conventions, and what to run before opening a pull request, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Releasing

Labelling a pull request into `main` with `release/patch`, `release/minor` or `release/major` opens a version-bump pull request from `release/X.Y.Z`; merging that and then running **Release** on `main` tags the commit and publishes every artifact. A hotfix is the same flow, labelling a pull request branched from `main` rather than the `develop` promotion, and is synchronized back to `develop` afterwards.

See [RELEASING.md](RELEASING.md) for the release flow, the environments and approval, credentials, and recovery.

## Disclaimer

Lurkloot is an independent project and is not affiliated with, endorsed by, or sponsored by Twitch or Kick. Platform behavior and terms can change, and automating viewing may be restricted by their terms of service. Use Lurkloot at your own discretion.
