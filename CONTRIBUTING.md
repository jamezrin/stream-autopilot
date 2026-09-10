# Contributing to Lurkloot

Thanks for your interest in Lurkloot. Bug reports, translation fixes, documentation, and code changes
are all welcome.

This guide covers the whole contributor path: reporting an issue, setting up the repository, the
conventions a pull request has to follow, and the rules that are specific to this project.

## Ways to contribute

- **Report a bug** — [open a bug report](https://github.com/jamezrin/lurkloot/issues/new?template=bug_report.yml)
  with your browser, platform, and reproduction steps. Never paste passwords, cookies, session
  tokens, or a Twitch `auth-token` into an issue, a pull request, or a log excerpt; redact them
  first.
- **Suggest a feature** — [open a feature request](https://github.com/jamezrin/lurkloot/issues/new?template=feature_request.yml).
  For anything large, please open the issue before writing code so the approach can be agreed on.
- **Improve a translation** — see [docs/translations.md](docs/translations.md). Translations are
  generated with AI and native speakers are very welcome to correct them.
- **Improve documentation** — README, the guides under `docs/`, and package READMEs are all fair
  game.
- **Send code** — read the rest of this guide first.

## Project layout

Lurkloot is a TypeScript pnpm monorepo. The packages under `packages/`:

| Package | Import name | What it is |
| --- | --- | --- |
| `packages/extension` | `@lurkloot/extension` | The WXT WebExtension shell: entrypoints, browser adapters, and the test suite. |
| `packages/core` | `@lurkloot/core` | The browser-free farming engine: scheduler, controller, platform adapters and parsers. |
| `packages/cli` | `@lurkloot/cli` | The headless/Docker runtime built on the same engine. |
| `packages/popup-ui` | `@lurkloot/popup-ui` | The shared React popup UI, used by the extension and the site demo. |
| `packages/locales` | `@lurkloot/locales` | Localized message catalogs and the catalog loader. |
| `packages/shared` | `@lurkloot/shared` | Framework-agnostic contracts: models, settings, messages, logging. |
| `packages/site` | `@lurkloot/site` | The Astro marketing site. |

For how these fit together at runtime — scheduler flow, watch tabs, tabless watching, the Twitch and
Kick integrations — read [docs/architecture.md](docs/architecture.md) before changing farming
behavior.

## Development setup

CI runs Node 24 and pnpm 11.24.0; use those versions locally to avoid surprises. The repository does
not pin them itself.

Fork the repository on GitHub, then clone your fork and add this repository as `upstream` so you can
keep `develop` current:

```bash
git clone https://github.com/<your-username>/lurkloot.git
cd lurkloot
git remote add upstream https://github.com/jamezrin/lurkloot.git
pnpm install
```

Run the extension against a real browser:

```bash
pnpm dev           # WXT dev server for Chromium
pnpm dev:firefox   # WXT dev server for Firefox
pnpm dev:site      # Astro site dev server
```

WXT launches a browser profile with the extension loaded. Sign in to Twitch or Kick normally in that
profile — Lurkloot only ever uses an existing signed-in browser session.

Production builds:

```bash
pnpm build          # Chromium extension
pnpm build:firefox  # Firefox extension
pnpm build:site     # Astro site
pnpm build:cli      # CLI bundle at packages/cli/dist/index.mjs
pnpm build:all      # every package
```

## Checks to run before you open a pull request

| Command | What it runs |
| --- | --- |
| `pnpm test` | Every package's test script (`pnpm -r --if-present test`). |
| `pnpm typecheck` | `tsc --noEmit` in every package. |
| `pnpm check` | Script tests (`cws:test`, `release:test`), workspace typechecks, package tests, and the site build. |
| `pnpm verify` | `pnpm check` plus both browser builds. |

For a change confined to one package, `pnpm test` and `pnpm typecheck` are usually enough. Run
`pnpm verify` for anything that touches the manifest, the build, or release tooling.

**`pnpm check` needs a Playwright Chromium.** The store screenshot tests drive a real browser against
local HTML fixtures, so install it once:

```bash
pnpm --filter @lurkloot/extension exec playwright install chromium
```

Do not add `--with-deps`: on CI the runner already carries the required system libraries, and it only
adds a slow font download.

## Testing guidelines

Tests use Vitest in a Node environment with globals enabled and live in `packages/extension/tests/`.
Add focused `*.test.ts` files named after the module under test, such as `scheduler.test.ts` or
`parsers.test.ts`.

- Prefer deterministic unit tests with mocked adapters, browser APIs, and storage. Do not write tests
  that make live Twitch or Kick calls.
- Never assert on the contents of `.github/workflows/**`. Those snapshots break on every unrelated
  workflow edit. Tests for the scripts under `scripts/` are fine and already exist.
- `packages/extension/tests/coreBoundary.test.ts` fails if `@lurkloot/core` imports WXT or a browser
  global. That boundary is what lets the CLI reuse the engine — keep it intact.

## Coding conventions

Use strict TypeScript and ES modules, two-space indentation, double quotes, and semicolons. Use
camelCase for functions and variables, PascalCase for React components and TypeScript types, and
`import type` for type-only imports.

Project-specific rules that will otherwise send a pull request back:

- **`@lurkloot/core` stays browser-free.** No WXT imports, no `chrome`/`browser` globals, no DOM.
- **Cross-package types go in `@lurkloot/shared`** rather than being duplicated per package.
- **Platform behavior stays behind `PlatformAdapter`.** Do not put Twitch or Kick parsing logic into
  the scheduler or the UI.
- **Diagnostics are always English literals.** Never add `diagnostic*` keys to a locale catalog and
  never translate a diagnostic body. Only activity events (structured `code` + `data`, localized by
  the host UI) and OS notification copy are localized; an activity event gets its English diagnostic
  counterpart automatically from `packages/core/src/core/activityDiagnostics.ts`, so do not hand-write
  one next to an activity emit.

## Security and privacy constraints

These are product constraints, not just style preferences:

- Do not add features that store credentials, export cookies, or bypass platform detection. Lurkloot
  relies on a normal logged-in browser session and visible muted tabs.
- Keep `permissions` and `host_permissions` in `packages/extension/wxt.config.ts` scoped to the
  services already declared, and document any new permission in the pull request description.
- No telemetry, no Lurkloot account, and no routing of user activity through a Lurkloot server.

If you believe you have found a security vulnerability, please report it privately by email to
[jaime@jamezrin.name](mailto:jaime@jamezrin.name) rather than opening a public issue, and give the maintainer a chance to ship a
fix before disclosing it.

## Branches and commits

Branch from `develop`. It is the integration branch; `main` runs ahead of it between releases, so a
branch cut from `main` will produce a confusing diff.

```bash
git fetch upstream develop
git switch -c feat/popup-schedule-refresh upstream/develop
```

If you work in a clone of this repository directly rather than a fork, use `origin` in place of
`upstream` above, and develop in a git worktree under `.worktrees/` rather than in the main
checkout — several sessions share that checkout, and feature work there ends up on the wrong
branch:

```bash
git fetch origin develop
git worktree add .worktrees/popup-schedule-refresh -b feat/popup-schedule-refresh origin/develop
cd .worktrees/popup-schedule-refresh
pnpm install --frozen-lockfile   # each worktree needs its own node_modules
```

Name the directory after the branch with the `<type>/` prefix dropped, create it before the first
edit, and leave the main checkout parked on `develop`. Run `git worktree list` first to reuse an
existing worktree, and `git worktree remove .worktrees/<name>` once the branch is merged.

Name branches `<type>/<short-kebab-case-description>`, using the same types as commits — for example
`feat/popup-schedule-refresh`, `fix/scheduler-viewer-count`, or `docs/release-process`. Only include
an issue number when it helps identify the work, as in `fix/123-scheduler-timeout`.

Commits follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):
`<type>[optional scope]: <description>`. Use a lowercase type and an imperative, present-tense
description with no trailing period. The allowed types are `feat`, `fix`, `docs`, `style`,
`refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `revert`. Mark a breaking change with `!`
before the colon and explain it in a `BREAKING CHANGE:` footer.

```text
feat(popup): add schedule refresh button
fix(scheduler): refresh viewer counts
```

## Pull requests

1. Open the pull request from your fork with base branch **`develop`**.
2. Title it with the same Conventional Commit format, so a squash merge keeps a valid subject.
3. Include a concise summary, the testing you performed, any linked issues, and screenshots or
   recordings for popup UI changes.
4. Note any new permission or host permission explicitly.

Pull request validation runs `pnpm release:check` and `pnpm check`, packages the Chromium and
Firefox zips, and builds the Docker image. Keep commits focused; unrelated cleanups are easier to review as a separate pull
request.

Contributors do not cut releases. Versioning, tagging, and store publication are maintainer-only and
documented in [RELEASING.md](RELEASING.md) — please do not bump the version in your pull request.

## AI-assisted contributions

These are welcome, and the repository's conventions are written down for agents in
[AGENTS.md](AGENTS.md) (`CLAUDE.md` is a symlink to it). Point your tool at that file. You are still
responsible for the diff: run the checks, read what was generated, and make sure it follows the rules
above.

## Reference implementations and licensing

Lurkloot is licensed under the [Apache License 2.0](LICENSE), and your contributions are covered by
the same license.

The optional, untracked `references/` directory is used locally for snapshots of similar open-source
drop-farming projects. Use them as inspiration for platform behavior and edge cases, but adapt ideas
to this codebase — do not copy code unless its license is compatible and its obligations, including
copyright, attribution, and `NOTICE` requirements, are satisfied. Record significant changes to
Apache-2.0 files as that license requires.

## Where to look next

- [docs/architecture.md](docs/architecture.md) — runtime components, scheduler flow, platform
  integrations.
- [docs/translations.md](docs/translations.md) — improving or adding a locale.
- [packages/cli/README.md](packages/cli/README.md) — the headless CLI and Docker image.
- [docs/install-prerelease.md](docs/install-prerelease.md) — installing a pre-release build to test a
  fix.
- [RELEASING.md](RELEASING.md) — the release flow, for maintainers.
