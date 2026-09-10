# GitHub star nudge — design

Date: 2026-09-08
Status: approved (design), not yet implemented

## Problem

Lurkloot has thousands of Chrome Web Store users and almost no GitHub stars.
Store users do not discover that the project is open source. The popup footer
already links to GitHub, but it does not ask for a star. The existing rate
card only asks for a Chrome Web Store review, and once it is rated or
dismissed it never returns — so extending that card would miss everyone who
already finished it.

## Goals

- Ask users to star the GitHub repository once they have used the extension
  for a week.
- Reach existing installs on the first popup after this ships (their install
  age is already past the delay).
- Keep a single banner slot: never stack this with the update notice or the
  Chrome Web Store rate card.
- Persist a one-shot outcome (`starred` or `dismissed`) so the prompt does
  not return.

## Non-goals

- Combining Chrome Web Store rating and GitHub starring on one card.
- A second GitHub ask in settings, tips, the marketing site, or store
  listing copy.
- Detecting whether the user actually starred the repo (no GitHub API, no
  auth).
- Changing the Chrome Web Store rate card's 3-day delay, copy, or URL.
- UTM parameters on the popup GitHub link (the footer link has none).

## Timing

Show when all of the following hold:

1. `githubStarNudgeStatus === "pending"`.
2. `installedAt` is present and parseable.
3. The extension has been installed for at least **7 days**.

Existing users whose `installedAt` is already older than 7 days become
eligible immediately after upgrade. There is no extra delay from the update
itself.

The predicate is the same as `shouldShowRateNudge` (pending + parseable
install date + age ≥ `minDays`). Do not fork the logic. Export
`shouldShowGithubStarNudge` as a named wrapper around that function, called
with `githubStarNudgeStatus` and `GITHUB_STAR_NUDGE_MIN_DAYS = 7`. Keep
`shouldShowRateNudge` for existing tests.

## Banner queue

The main popup view has one notice slot. Priority, highest first:

1. Update notice, when present.
2. Chrome Web Store rate nudge, when `shouldShowRateNudge` is true (3 days,
   `rateNudgeStatus`).
3. GitHub star nudge, when the GitHub predicate is true (7 days,
   `githubStarNudgeStatus`).

A user who leaves the rate card sitting there does not see the GitHub card
until they rate or dismiss it. Preview and demo (`preview === true`) never
show either nudge.

## UI and copy

A sibling of `RateNudge`: same card layout (accent background, dismiss X,
one primary button), GitHub mark instead of the filled star.

English copy:

| Key | Message |
| --- | --- |
| `githubStarNudgeTitle` | Lurkloot is open source |
| `githubStarNudgeBody` | If it's been useful, a GitHub star helps others find it. Contributions are welcome, especially features and translations. |
| `githubStarNudgeAction` | Star on GitHub |

Dismiss reuses `rateNudgeDismiss` ("Not now").

The action is an `<a>` to `GITHUB_REPO_URL`
(`https://github.com/jamezrin/lurkloot`) with `target="_blank"` and
`rel="noreferrer"`. Clicking it sets status to `starred`. Dismiss sets
status to `dismissed`. There is no way to reopen the prompt from settings.

Add the three new keys to every locale catalog. English is the source;
other catalogs get translations (key-set sync is already enforced).

## State

New host-only setting next to `rateNudgeStatus`:

```ts
export type GithubStarNudgeStatus = "pending" | "starred" | "dismissed";
```

- Default: `"pending"`.
- `mergeSettings` keeps a valid value and falls back to `"pending"` for
  missing or unknown values, same as `rateNudgeStatus`.
- No schema migration: existing stored settings omit the key and pick up
  the default.
- Engine contract does not include it (`HOST_ONLY_FIELDS`).
- CLI rejects it as extension-only (`EXTENSION_ONLY_KEYS` and the CLI
  README list), same as `rateNudgeStatus`.

## Files

- `packages/shared/src/models.ts` — type + `ExtensionSettings` field.
- `packages/shared/src/settings.ts` — default and merge.
- `packages/cli/src/settings.ts` and `packages/cli/README.md` — extension-only key.
- `packages/popup-ui/src/constants.ts` — `GITHUB_STAR_NUDGE_MIN_DAYS = 7`.
- `packages/popup-ui/src/rateNudge.logic.ts` — keep the shared predicate;
  export `shouldShowGithubStarNudge` as a named wrapper.
- `packages/popup-ui/src/githubStarNudge.tsx` — card component.
- `packages/popup-ui/src/Popup.tsx` — queue the third banner.
- `packages/popup-ui/src/popupNoticeSlot.ts` — pure `"update" | "rate" | "github-star" | null` helper used by the popup.
- `packages/locales/messages/*.json` — three new keys.
- Tests listed below.

Do not add a settings row, a rotating tip, or a screenshot variant.

## Tests

- Predicate: hidden before day 7, shown at 7+, hidden when `starred` or
  `dismissed`, hidden when `installedAt` is missing or unparseable.
- Settings merge: default `pending`, `starred`/`dismissed` kept, garbage
  falls back to `pending`. Host-only field is absent from
  `mergeEngineSettings`.
- Banner slot: GitHub card is not selected while an update notice is
  present or the rate nudge is eligible. Extract the slot choice into a
  small pure helper (`"update" | "rate" | "github-star" | null`) and unit
  test that helper; do not mount the full popup.
- Locale catalogs stay key-synced (existing i18n test).

## Out of scope later

If stars stay flat after this ships, a settings "Support Lurkloot" row or
a rotating tip can be considered then. They are not part of this change.
