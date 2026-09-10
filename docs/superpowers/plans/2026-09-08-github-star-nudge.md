# GitHub Star Nudge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a one-shot popup banner asking users to star the GitHub repo after 7 days, behind the update notice and the Chrome Web Store rate card.

**Architecture:** Reuse the existing install-age predicate for eligibility. Persist `githubStarNudgeStatus` as a host-only setting (default `pending`). A pure `popupNoticeSlot` helper picks at most one banner. A `GithubStarNudge` card, sibling of `RateNudge`, opens `GITHUB_REPO_URL`.

**Tech Stack:** TypeScript, React, Vitest, locale JSON catalogs, pnpm workspace.

**Workspace:** `/home/jamezrin/dev/lurkloot/.worktrees/github-star-nudge` on `feat/github-star-nudge`. If `node_modules` is missing, run `pnpm install --frozen-lockfile` before Task 1.

## Global Constraints

- Chrome Web Store rate card stays at 3 days; do not change its copy or URL.
- GitHub star card shows at **7 days** from `installedAt`, status `pending`.
- One banner slot: update notice > CWS rate nudge > GitHub star nudge.
- Preview/demo (`preview === true`) never shows the rate or GitHub cards.
- Existing installs past 7 days become eligible immediately (no extra delay from this update).
- Default `githubStarNudgeStatus` is `"pending"`; `starred` or `dismissed` never shows again.
- No GitHub API, no settings row, no rotating tip, no screenshot variant, no UTM on the popup GitHub link.
- Dismiss reuses `rateNudgeDismiss`. New keys: `githubStarNudgeTitle`, `githubStarNudgeBody`, `githubStarNudgeAction`.
- English source copy: title `Lurkloot is open source`; body `If it's been useful, a GitHub star helps others find it. Contributions are welcome, especially features and translations.`; action `Star on GitHub`.
- Engine contract and CLI must not accept the new setting. No schema migration.
- Non-English catalogs must not copy the English strings (existing i18n test).

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/shared/src/models.ts` | `GithubStarNudgeStatus` type and `ExtensionSettings.githubStarNudgeStatus` |
| `packages/shared/src/settings.ts` | Default `"pending"` and merge validation |
| `packages/cli/src/settings.ts` | Reject `githubStarNudgeStatus` as extension-only |
| `packages/cli/README.md` | Document the rejected key |
| `packages/popup-ui/src/constants.ts` | `GITHUB_STAR_NUDGE_MIN_DAYS = 7` |
| `packages/popup-ui/src/rateNudge.logic.ts` | `shouldShowGithubStarNudge` wrapper around `shouldShowRateNudge` |
| `packages/popup-ui/src/popupNoticeSlot.ts` | Pure `"update" \| "rate" \| "github-star" \| null` queue |
| `packages/popup-ui/src/githubStarNudge.tsx` | Banner card |
| `packages/popup-ui/src/rateNudge.tsx` | Re-export `shouldShowGithubStarNudge` for the popup |
| `packages/popup-ui/src/Popup.tsx` | Render the chosen slot |
| `packages/popup-ui/package.json` | Export `./popupNoticeSlot` |
| `packages/locales/messages/*.json` | Three new keys in every catalog |

---

### Task 1: Persist `githubStarNudgeStatus`

**Files:**
- Modify: `packages/shared/src/models.ts`
- Modify: `packages/shared/src/settings.ts`
- Modify: `packages/cli/src/settings.ts`
- Modify: `packages/cli/README.md`
- Modify: `packages/extension/tests/settings.test.ts`
- Modify: `packages/cli/tests/settings.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: `export type GithubStarNudgeStatus = "pending" | "starred" | "dismissed"`; `ExtensionSettings.githubStarNudgeStatus`; `DEFAULT_SETTINGS.githubStarNudgeStatus === "pending"`; `mergeSettings` keeps valid values and falls back to `"pending"`; CLI `parseCliSettings({ githubStarNudgeStatus: "pending" })` throws `/githubStarNudgeStatus.*extension-only/`.

- [ ] **Step 1: Write the failing settings tests**

In `packages/extension/tests/settings.test.ts`, add `"githubStarNudgeStatus"` to `HOST_ONLY_FIELDS` next to `"rateNudgeStatus"`. In the `"layers host-only fields"` test, add:

```ts
expect(DEFAULT_SETTINGS.githubStarNudgeStatus).toBe("pending");
```

After the `"validates the rate nudge status"` test, add:

```ts
it("validates the github star nudge status", () => {
  expect(DEFAULT_SETTINGS.githubStarNudgeStatus).toBe("pending");
  expect(mergeSettings(undefined).githubStarNudgeStatus).toBe("pending");
  expect(mergeSettings({ githubStarNudgeStatus: "starred" }).githubStarNudgeStatus).toBe("starred");
  expect(mergeSettings({ githubStarNudgeStatus: "dismissed" }).githubStarNudgeStatus).toBe("dismissed");
  expect(mergeSettings({ githubStarNudgeStatus: "bogus" } as unknown as Parameters<typeof mergeSettings>[0]).githubStarNudgeStatus)
    .toBe("pending");
});
```

In `packages/cli/tests/settings.test.ts`, inside `"hard-errors on extension-only keys, naming them"`, add:

```ts
expect(() => parseCliSettings({ githubStarNudgeStatus: "pending" })).toThrow(/"githubStarNudgeStatus" is an extension-only setting/);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test tests/settings.test.ts
pnpm --filter @lurkloot/cli test tests/settings.test.ts
```

Expected: FAIL because `githubStarNudgeStatus` does not exist on `ExtensionSettings` / `DEFAULT_SETTINGS`.

- [ ] **Step 3: Add the setting**

In `packages/shared/src/models.ts`, immediately after `RateNudgeStatus`:

```ts
// Lifecycle of the one-time GitHub star nudge. "pending" until the user either
// stars or dismisses it, after which it never shows again.
export type GithubStarNudgeStatus = "pending" | "starred" | "dismissed";
```

On `ExtensionSettings`, immediately after `rateNudgeStatus: RateNudgeStatus;`:

```ts
  githubStarNudgeStatus: GithubStarNudgeStatus;
```

In `packages/shared/src/settings.ts`, add `GithubStarNudgeStatus` to the type import from `./models`. After `RATE_NUDGE_STATUSES`:

```ts
const GITHUB_STAR_NUDGE_STATUSES: GithubStarNudgeStatus[] = ["pending", "starred", "dismissed"];
```

In `DEFAULT_SETTINGS`, immediately after `rateNudgeStatus: "pending",`:

```ts
  githubStarNudgeStatus: "pending",
```

In `mergeSettings`, immediately after the `rateNudgeStatus` ternary:

```ts
    githubStarNudgeStatus: GITHUB_STAR_NUDGE_STATUSES.includes(value?.githubStarNudgeStatus as GithubStarNudgeStatus)
      ? (value!.githubStarNudgeStatus as GithubStarNudgeStatus)
      : DEFAULT_SETTINGS.githubStarNudgeStatus,
```

In `packages/cli/src/settings.ts`, add `"githubStarNudgeStatus"` to `EXTENSION_ONLY_KEYS` immediately after `"rateNudgeStatus"`.

In `packages/cli/README.md`, change the rejected-keys sentence so it lists `githubStarNudgeStatus` next to `rateNudgeStatus`:

```
`languageOverride`, `rateNudgeStatus`, `githubStarNudgeStatus`, `diagnosticLogging`, `dropsListFilter`.
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
pnpm --filter @lurkloot/extension test tests/settings.test.ts
pnpm --filter @lurkloot/cli test tests/settings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/models.ts packages/shared/src/settings.ts packages/cli/src/settings.ts packages/cli/README.md packages/extension/tests/settings.test.ts packages/cli/tests/settings.test.ts
git commit -m "$(cat <<'EOF'
feat(settings): persist github star nudge status

EOF
)"
```

---

### Task 2: Eligibility predicate

**Files:**
- Modify: `packages/popup-ui/src/rateNudge.logic.ts`
- Modify: `packages/popup-ui/src/constants.ts`
- Modify: `packages/extension/tests/rateNudge.test.ts`

**Interfaces:**
- Consumes: `shouldShowRateNudge(installedAt: string | undefined, status: string, now: Date, minDays: number): boolean`
- Produces: `export const GITHUB_STAR_NUDGE_MIN_DAYS = 7`; `export function shouldShowGithubStarNudge(installedAt: string | undefined, status: string, now: Date, minDays: number): boolean` which only calls `shouldShowRateNudge` with the same arguments.

- [ ] **Step 1: Write the failing predicate tests**

In `packages/extension/tests/rateNudge.test.ts`, change the import to:

```ts
import { shouldShowGithubStarNudge, shouldShowRateNudge } from "@lurkloot/popup-ui/rateNudge";
```

Append:

```ts
describe("shouldShowGithubStarNudge", () => {
  const now = new Date("2026-06-14T12:00:00.000Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

  it("hides until the extension has been installed at least minDays", () => {
    expect(shouldShowGithubStarNudge(daysAgo(6), "pending", now, 7)).toBe(false);
    expect(shouldShowGithubStarNudge(daysAgo(7), "pending", now, 7)).toBe(true);
    expect(shouldShowGithubStarNudge(daysAgo(30), "pending", now, 7)).toBe(true);
  });

  it("stays hidden once starred or dismissed, regardless of age", () => {
    expect(shouldShowGithubStarNudge(daysAgo(30), "starred", now, 7)).toBe(false);
    expect(shouldShowGithubStarNudge(daysAgo(30), "dismissed", now, 7)).toBe(false);
  });

  it("stays hidden when the install date is missing or unparseable", () => {
    expect(shouldShowGithubStarNudge(undefined, "pending", now, 7)).toBe(false);
    expect(shouldShowGithubStarNudge("not-a-date", "pending", now, 7)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test tests/rateNudge.test.ts
```

Expected: FAIL with `shouldShowGithubStarNudge is not a function` / is not exported.

- [ ] **Step 3: Implement the wrapper and constant**

In `packages/popup-ui/src/constants.ts`, immediately after `RATE_NUDGE_MIN_DAYS`:

```ts
// How long after install before the one-time GitHub star nudge appears.
export const GITHUB_STAR_NUDGE_MIN_DAYS = 7;
```

In `packages/popup-ui/src/rateNudge.logic.ts`, after `shouldShowRateNudge`:

```ts
export function shouldShowGithubStarNudge(
  installedAt: string | undefined,
  status: string,
  now: Date,
  minDays: number,
): boolean {
  return shouldShowRateNudge(installedAt, status, now, minDays);
}
```

Do not copy the date-math body. Do not import `GITHUB_STAR_NUDGE_MIN_DAYS` into the logic file; callers pass `7`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm --filter @lurkloot/extension test tests/rateNudge.test.ts
```

Expected: PASS. Existing `shouldShowRateNudge` cases still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src/rateNudge.logic.ts packages/popup-ui/src/constants.ts packages/extension/tests/rateNudge.test.ts
git commit -m "$(cat <<'EOF'
feat(popup): add github star nudge eligibility predicate

EOF
)"
```

---

### Task 3: Banner slot helper

**Files:**
- Create: `packages/popup-ui/src/popupNoticeSlot.ts`
- Create: `packages/extension/tests/popupNoticeSlot.test.ts`
- Modify: `packages/popup-ui/package.json`

**Interfaces:**
- Consumes: none (predicates are evaluated by the caller).
- Produces:

```ts
export type PopupNoticeSlot = "update" | "rate" | "github-star" | null;

export function popupNoticeSlot(input: {
  preview: boolean;
  hasUpdateNotice: boolean;
  showRateNudge: boolean;
  showGithubStarNudge: boolean;
}): PopupNoticeSlot;
```

Priority: update (even in preview) > preview forces `null` > rate > github-star > `null`.

- [ ] **Step 1: Write the failing slot tests**

Create `packages/extension/tests/popupNoticeSlot.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { popupNoticeSlot } from "@lurkloot/popup-ui/popupNoticeSlot";

describe("popupNoticeSlot", () => {
  const bothNudges = { showRateNudge: true, showGithubStarNudge: true };

  it("selects the update notice over both nudges, including in preview", () => {
    expect(popupNoticeSlot({ preview: false, hasUpdateNotice: true, ...bothNudges })).toBe("update");
    expect(popupNoticeSlot({ preview: true, hasUpdateNotice: true, ...bothNudges })).toBe("update");
  });

  it("hides both nudges in preview when there is no update notice", () => {
    expect(popupNoticeSlot({ preview: true, hasUpdateNotice: false, ...bothNudges })).toBe(null);
  });

  it("selects the rate nudge over the github star nudge", () => {
    expect(popupNoticeSlot({ preview: false, hasUpdateNotice: false, ...bothNudges })).toBe("rate");
  });

  it("selects the github star nudge when it is the only eligible banner", () => {
    expect(popupNoticeSlot({
      preview: false,
      hasUpdateNotice: false,
      showRateNudge: false,
      showGithubStarNudge: true,
    })).toBe("github-star");
  });

  it("returns null when nothing is eligible", () => {
    expect(popupNoticeSlot({
      preview: false,
      hasUpdateNotice: false,
      showRateNudge: false,
      showGithubStarNudge: false,
    })).toBe(null);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test tests/popupNoticeSlot.test.ts
```

Expected: FAIL because `@lurkloot/popup-ui/popupNoticeSlot` is not exported.

- [ ] **Step 3: Implement the helper and export**

Create `packages/popup-ui/src/popupNoticeSlot.ts`:

```ts
export type PopupNoticeSlot = "update" | "rate" | "github-star" | null;

export function popupNoticeSlot(input: {
  preview: boolean;
  hasUpdateNotice: boolean;
  showRateNudge: boolean;
  showGithubStarNudge: boolean;
}): PopupNoticeSlot {
  if (input.hasUpdateNotice) return "update";
  if (input.preview) return null;
  if (input.showRateNudge) return "rate";
  if (input.showGithubStarNudge) return "github-star";
  return null;
}
```

In `packages/popup-ui/package.json` `exports`, add after `"./rateNudge"`:

```json
    "./popupNoticeSlot": "./src/popupNoticeSlot.ts",
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm --filter @lurkloot/extension test tests/popupNoticeSlot.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src/popupNoticeSlot.ts packages/popup-ui/package.json packages/extension/tests/popupNoticeSlot.test.ts
git commit -m "$(cat <<'EOF'
feat(popup): queue github star nudge behind rate and updates

EOF
)"
```

---

### Task 4: Locale copy

**Files:**
- Modify: `packages/locales/messages/en.json`
- Modify: `packages/locales/messages/es.json`
- Modify: `packages/locales/messages/fr.json`
- Modify: `packages/locales/messages/it.json`
- Modify: `packages/locales/messages/ru.json`
- Modify: `packages/locales/messages/de.json`
- Modify: `packages/locales/messages/zh_CN.json`
- Modify: `packages/locales/messages/hi.json`
- Modify: `packages/locales/messages/pt_BR.json`
- Modify: `packages/locales/messages/ar.json`
- Modify: `packages/locales/messages/tr.json`

**Interfaces:**
- Consumes: none.
- Produces: keys `githubStarNudgeTitle`, `githubStarNudgeBody`, `githubStarNudgeAction` in every catalog. Dismiss is **not** a new key; the card uses `rateNudgeDismiss`.

Insert each block immediately after `rateNudgeDismiss` so related keys stay together.

- [ ] **Step 1: Add English keys first so the sync test can fail on other locales**

In `packages/locales/messages/en.json`:

```json
  "githubStarNudgeTitle": {
    "message": "Lurkloot is open source"
  },
  "githubStarNudgeBody": {
    "message": "If it's been useful, a GitHub star helps others find it. Contributions are welcome, especially features and translations."
  },
  "githubStarNudgeAction": {
    "message": "Star on GitHub"
  },
```

- [ ] **Step 2: Run the i18n test and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test tests/i18n.test.ts
```

Expected: FAIL on `keeps locale catalog keys in sync` because other locales are missing the three keys.

- [ ] **Step 3: Add translations**

Use these exact messages. Do not paste the English strings into non-English catalogs.

`es.json`:

```json
  "githubStarNudgeTitle": {
    "message": "Lurkloot es código abierto"
  },
  "githubStarNudgeBody": {
    "message": "Si te ha resultado útil, una estrella en GitHub ayuda a que otros lo encuentren."
  },
  "githubStarNudgeAction": {
    "message": "Dar estrella en GitHub"
  },
```

`fr.json`:

```json
  "githubStarNudgeTitle": {
    "message": "Lurkloot est open source"
  },
  "githubStarNudgeBody": {
    "message": "S’il vous a été utile, une étoile GitHub aide les autres à le trouver."
  },
  "githubStarNudgeAction": {
    "message": "Mettre une étoile sur GitHub"
  },
```

`it.json`:

```json
  "githubStarNudgeTitle": {
    "message": "Lurkloot è open source"
  },
  "githubStarNudgeBody": {
    "message": "Se ti è stato utile, una stella su GitHub aiuta gli altri a trovarlo."
  },
  "githubStarNudgeAction": {
    "message": "Metti una stella su GitHub"
  },
```

`de.json`:

```json
  "githubStarNudgeTitle": {
    "message": "Lurkloot ist Open Source"
  },
  "githubStarNudgeBody": {
    "message": "Wenn es nützlich war, hilft ein GitHub-Stern anderen, das Projekt zu finden."
  },
  "githubStarNudgeAction": {
    "message": "Auf GitHub mit Stern markieren"
  },
```

`ru.json`:

```json
  "githubStarNudgeTitle": {
    "message": "Lurkloot — проект с открытым исходным кодом"
  },
  "githubStarNudgeBody": {
    "message": "Если расширение оказалось полезным, звезда на GitHub поможет другим его найти."
  },
  "githubStarNudgeAction": {
    "message": "Поставить звезду на GitHub"
  },
```

`zh_CN.json`:

```json
  "githubStarNudgeTitle": {
    "message": "Lurkloot 是开源的"
  },
  "githubStarNudgeBody": {
    "message": "如果它对你有帮助，在 GitHub 上点一颗星能让更多人发现它。"
  },
  "githubStarNudgeAction": {
    "message": "在 GitHub 上加星"
  },
```

`hi.json`:

```json
  "githubStarNudgeTitle": {
    "message": "Lurkloot ओपन सोर्स है"
  },
  "githubStarNudgeBody": {
    "message": "अगर यह उपयोगी रहा, तो GitHub पर एक स्टार दूसरों को इसे खोजने में मदद करता है।"
  },
  "githubStarNudgeAction": {
    "message": "GitHub पर स्टार दें"
  },
```

`pt_BR.json`:

```json
  "githubStarNudgeTitle": {
    "message": "Lurkloot é código aberto"
  },
  "githubStarNudgeBody": {
    "message": "Se foi útil, uma estrela no GitHub ajuda outras pessoas a encontrá-lo."
  },
  "githubStarNudgeAction": {
    "message": "Dar estrela no GitHub"
  },
```

`ar.json`:

```json
  "githubStarNudgeTitle": {
    "message": "Lurkloot مفتوح المصدر"
  },
  "githubStarNudgeBody": {
    "message": "إذا كان مفيدًا، فإن نجمة على GitHub تساعد الآخرين على العثور عليه."
  },
  "githubStarNudgeAction": {
    "message": "ضع نجمة على GitHub"
  },
```

`tr.json`:

```json
  "githubStarNudgeTitle": {
    "message": "Lurkloot açık kaynaklıdır"
  },
  "githubStarNudgeBody": {
    "message": "İşine yaradıysa GitHub yıldızı, başkalarının onu bulmasına yardımcı olur."
  },
  "githubStarNudgeAction": {
    "message": "GitHub'da yıldızla"
  },
```

- [ ] **Step 4: Run the i18n test and verify GREEN**

Run:

```bash
pnpm --filter @lurkloot/extension test tests/i18n.test.ts
```

Expected: PASS, including `keeps locale catalog keys in sync` and `does not leave non-English catalogs as English except product/common terms`.

- [ ] **Step 5: Commit**

```bash
git add packages/locales/messages/*.json
git commit -m "$(cat <<'EOF'
feat(locales): add github star nudge copy

EOF
)"
```

---

### Task 5: Card and popup wiring

**Files:**
- Create: `packages/popup-ui/src/githubStarNudge.tsx`
- Modify: `packages/popup-ui/src/rateNudge.tsx`
- Modify: `packages/popup-ui/src/Popup.tsx`

**Interfaces:**
- Consumes: `shouldShowGithubStarNudge`, `GITHUB_STAR_NUDGE_MIN_DAYS`, `popupNoticeSlot`, `GITHUB_REPO_URL`, `settings.githubStarNudgeStatus`, locale keys from Task 4.
- Produces: `export function GithubStarNudge({ onStar, onDismiss }: { onStar(): void; onDismiss(): void }): React.ReactElement`. Popup renders at most one of `UpdateNotice`, `RateNudge`, `GithubStarNudge` via `popupNoticeSlot`. Star click sets `{ githubStarNudgeStatus: "starred" }`. Dismiss sets `{ githubStarNudgeStatus: "dismissed" }`.

- [ ] **Step 1: Re-export the predicate from the React module**

In `packages/popup-ui/src/rateNudge.tsx`, change the re-export to:

```ts
export { shouldShowGithubStarNudge, shouldShowRateNudge } from "./rateNudge.logic";
```

- [ ] **Step 2: Add the card component**

Create `packages/popup-ui/src/githubStarNudge.tsx`. Copy the `RateNudge` layout (accent card, dismiss X, one primary button). Use an inline GitHub mark instead of the filled star. Link to `GITHUB_REPO_URL`. Use `rateNudgeDismiss` for the X button.

```tsx
import React from "react";
import { motion } from "motion/react";
import { X } from "lucide-react";
import { GITHUB_REPO_URL } from "./constants";
import { useT } from "./context";
import { cn } from "./primitives";

export function GithubStarNudge({ onStar, onDismiss }: { onStar(): void; onDismiss(): void }): React.ReactElement {
  const t = useT();
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18 }}
      className="relative flex items-start gap-2.5 rounded-xl px-3 py-2.5"
      style={{ backgroundColor: "var(--accent-soft)" }}
    >
      <span className="mt-0.5 shrink-0" style={{ color: "var(--accent-text)" }}>
        <GithubMark size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-tight" style={{ color: "var(--accent-text)" }}>
          {t("githubStarNudgeTitle")}
        </p>
        <p className="mt-0.5 text-[11px] leading-snug text-zinc-600 dark:text-zinc-300">
          {t("githubStarNudgeBody")}
        </p>
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noreferrer"
          onClick={onStar}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-contrast)] outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
          style={{ backgroundColor: "var(--accent)" }}
        >
          <GithubMark size={12} />
          {t("githubStarNudgeAction")}
        </a>
      </div>
      <button
        type="button"
        title={t("rateNudgeDismiss")}
        aria-label={t("rateNudgeDismiss")}
        onClick={onDismiss}
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-md outline-none transition-colors",
          "text-zinc-400 hover:bg-black/5 hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:text-zinc-500 dark:hover:bg-white/5 dark:hover:text-zinc-200",
        )}
      >
        <X size={13} />
      </button>
    </motion.div>
  );
}

function GithubMark({ size }: { size: number }): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}
```

The SVG paths match `packages/popup-ui/src/footer.tsx`. Do not export the footer icon; do not add a settings row or tip.

- [ ] **Step 3: Wire `Popup.tsx`**

Add `GITHUB_STAR_NUDGE_MIN_DAYS` to the `./constants` import.

Change:

```ts
import { RateNudge, shouldShowRateNudge } from "./rateNudge";
```

to:

```ts
import { RateNudge, shouldShowGithubStarNudge, shouldShowRateNudge } from "./rateNudge";
import { GithubStarNudge } from "./githubStarNudge";
import { popupNoticeSlot } from "./popupNoticeSlot";
```

Inside the popup component function, next to other derived values (not at module scope), compute:

```ts
const now = new Date();
const noticeSlot = popupNoticeSlot({
  preview,
  hasUpdateNotice: Boolean(updateNotice),
  showRateNudge: shouldShowRateNudge(snapshot.state.installedAt, settings.rateNudgeStatus, now, RATE_NUDGE_MIN_DAYS),
  showGithubStarNudge: shouldShowGithubStarNudge(snapshot.state.installedAt, settings.githubStarNudgeStatus, now, GITHUB_STAR_NUDGE_MIN_DAYS),
});
```

Replace the `AnimatePresence` block that currently renders `UpdateNotice` / `RateNudge` with:

```tsx
                <AnimatePresence initial={false}>
                  {noticeSlot === "update" && updateNotice ? (
                    <UpdateNotice
                      key="update-notice"
                      version={updateNotice.version}
                      href={updateNotice.href}
                      onDismiss={dismissUpdateNotice}
                    />
                  ) : null}
                  {noticeSlot === "rate" ? (
                    <RateNudge
                      key="rate-nudge"
                      onRate={() => void updateSettings({ rateNudgeStatus: "rated" })}
                      onDismiss={() => void updateSettings({ rateNudgeStatus: "dismissed" })}
                    />
                  ) : null}
                  {noticeSlot === "github-star" ? (
                    <GithubStarNudge
                      key="github-star-nudge"
                      onStar={() => void updateSettings({ githubStarNudgeStatus: "starred" })}
                      onDismiss={() => void updateSettings({ githubStarNudgeStatus: "dismissed" })}
                    />
                  ) : null}
                </AnimatePresence>
```

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
pnpm --filter @lurkloot/extension test tests/rateNudge.test.ts tests/popupNoticeSlot.test.ts tests/settings.test.ts tests/i18n.test.ts
pnpm --filter @lurkloot/cli test tests/settings.test.ts
pnpm --filter @lurkloot/popup-ui typecheck
pnpm --filter @lurkloot/shared typecheck
```

Expected: all PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src/githubStarNudge.tsx packages/popup-ui/src/rateNudge.tsx packages/popup-ui/src/Popup.tsx
git commit -m "$(cat <<'EOF'
feat(popup): show the github star nudge card

EOF
)"
```

---

### Task 6: Verify

- [ ] **Step 1: Run repository verification**

Run:

```bash
pnpm test && pnpm typecheck
```

Expected: all commands exit 0.

Do not run `pnpm build:site` unless typecheck/tests fail in site packages; this change does not touch the site.

- [ ] **Step 2: Manual check (if `pnpm dev` is available)**

Open the popup in preview/demo: neither nudge should appear. There is no screenshot variant for this card.

- [ ] **Step 3: No extra commit unless verification forced a fix**

If verification found a defect, fix it and commit with `fix(popup): ...` describing the defect. Do not amend.
