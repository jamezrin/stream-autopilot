# Store Screenshot Density Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Chrome Web Store screenshots 02, 03, and 05 the same finished density as 01 and 04 — live popups on extras and easy, a text-only runtime board on updated — without trademarked icons.

**Architecture:** Keep one `StoreScreenshot` shell and the existing five-shot lineup. Promote `extras` and `steps` to popup-carrying variants (`watchlist` on Twitch, `drops` on Kick). `updated` stays popup-free and gains two large type tiles (Chromium-based browsers, CLI · Docker). Capture already keys off `STORE_SCREENSHOT_VARIANTS[].popup`; flip those two flags so Playwright waits on the real popup header.

**Tech Stack:** TypeScript, React, Vitest, `@lurkloot/popup-ui`, `@lurkloot/locales`, WXT screenshot capture.

**Spec:** `docs/superpowers/specs/2026-09-08-store-screenshot-density-design.md`

## Global Constraints

- Work only in `.worktrees/store-screenshot-density` on `feat/store-screenshot-density`.
- Do not change shots 01 or 04, farming behavior, promo tiles, store listing body copy, or CWS upload automation.
- No third-party trademarked icons or logos in any screenshot (browser marks, Docker whale, GitHub, Twitch/Kick). Nominative text is allowed. Colored status dots that are not brand marks stay allowed.
- Live popup is always the real `Popup` at 400×600 — no stretching, no illustrated fake popup UI.
- Do not sell Kick watch time as farmable. Do not pitch the activity log. Do not mention Firefox on shot 05.
- Diagnostic messages stay English literals. Screenshot UI copy is localized. Brand tokens stay untranslated: Twitch, Kick, Chrome Web Store, CLI, Docker, Apache-2.0, Chromium (as part of “Chromium-based browsers”, translate the surrounding words).
- Two-space indentation, double quotes, semicolons, ES modules, `type` imports.
- Use pnpm. Do not regenerate or upload PNGs in this work (`pnpm screenshot:store` is operator follow-up).
- Do not import `demo.ts` from `Popup.tsx` (that would ship demo code into the real popup).

---

### Task 1: Variant model and capture popup flags

**Files:**
- Modify: `packages/popup-ui/src/types.ts`
- Modify: `packages/popup-ui/src/constants.ts`
- Modify: `packages/extension/scripts/store-screenshot-config.mjs`
- Modify: `packages/extension/tests/storeScreenshot.test.tsx`
- Modify: `packages/extension/tests/storeScreenshotFiles.test.ts`

**Interfaces:**
- Produces:

```ts
export type ScreenshotPopupVariant = ScreenshotCopy & {
  layout: "hero" | "extras" | "steps" | "settings";
  platform: Platform;
  view: "drops" | "settings" | "watchlist";
};

export type ScreenshotMarketingVariant = ScreenshotCopy & {
  layout: "updated";
};

export function variantShowsPopup(variant: ScreenshotVariant): variant is ScreenshotPopupVariant {
  return variant.layout !== "updated";
}
```

- `extras` → `{ layout: "extras", platform: "twitch", view: "watchlist", glow: EXTRAS_GLOW, eyebrowKey/headlineKey/subcopyKey unchanged }`
- `easy` → `{ layout: "steps", platform: "kick", view: "drops", glow: EASY_GLOW, keys unchanged }`
- `STORE_SCREENSHOT_VARIANTS` extras and easy: `popup: true`. Updated stays `popup: false`.

- [ ] **Step 1: Rewrite the failing variant tests**

In `packages/extension/tests/storeScreenshot.test.tsx`, replace the popup-gating tests with:

```tsx
  it("mounts a live popup on every shot except updated", () => {
    expect(variantShowsPopup(screenshotVariant("drops"))).toBe(true);
    expect(variantShowsPopup(screenshotVariant("extras"))).toBe(true);
    expect(variantShowsPopup(screenshotVariant("easy"))).toBe(true);
    expect(variantShowsPopup(screenshotVariant("settings"))).toBe(true);
    expect(variantShowsPopup(screenshotVariant("updated"))).toBe(false);
  });

  it("wires extras to the Twitch watchlist and easy to Kick drops", () => {
    const extras = screenshotVariant("extras");
    const easy = screenshotVariant("easy");
    const drops = screenshotVariant("drops");
    const settings = screenshotVariant("settings");
    if (!variantShowsPopup(extras) || !variantShowsPopup(easy) || !variantShowsPopup(drops) || !variantShowsPopup(settings)) {
      throw new Error("expected popup shots");
    }
    expect(extras.platform).toBe("twitch");
    expect(extras.view).toBe("watchlist");
    expect(easy.platform).toBe("kick");
    expect(easy.view).toBe("drops");
    expect(drops.platform).toBe("twitch");
    expect(drops.view).toBe("drops");
    expect(settings.view).toBe("settings");
  });
```

Keep the canonical-id and five-layout tests unchanged.

In `packages/extension/tests/storeScreenshotFiles.test.ts`, add inside `"describes the exact upload order"`:

```ts
expect(STORE_SCREENSHOT_VARIANTS.map((variant: { popup: boolean }) => variant.popup)).toEqual([
  true, true, true, true, false,
]);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/storeScreenshot.test.tsx tests/storeScreenshotFiles.test.ts`

Expected: FAIL — extras/easy still `variantShowsPopup === false` and `popup: false`.

- [ ] **Step 3: Update types and constants**

Replace the variant types in `packages/popup-ui/src/types.ts` with the signatures in Interfaces above.

In `packages/popup-ui/src/constants.ts`, change only `extras` and `easy`:

```ts
const extras: ScreenshotVariant = {
  layout: "extras",
  platform: "twitch",
  view: "watchlist",
  glow: EXTRAS_GLOW,
  eyebrowKey: "screenshotExtrasEyebrow",
  headlineKey: "screenshotExtrasHeadline",
  subcopyKey: "screenshotExtrasSubcopy",
};
const easy: ScreenshotVariant = {
  layout: "steps",
  platform: "kick",
  view: "drops",
  glow: EASY_GLOW,
  eyebrowKey: "screenshotEasyEyebrow",
  headlineKey: "screenshotEasyHeadline",
  subcopyKey: "screenshotEasyHeadline",
};
```

In `packages/extension/scripts/store-screenshot-config.mjs`:

```js
export const STORE_SCREENSHOT_VARIANTS = Object.freeze([
  Object.freeze({ id: "drops", file: "01-drops", popup: true }),
  Object.freeze({ id: "extras", file: "02-extras", popup: true }),
  Object.freeze({ id: "easy", file: "03-easy", popup: true }),
  Object.freeze({ id: "settings", file: "04-settings", popup: true }),
  Object.freeze({ id: "updated", file: "05-updated", popup: false }),
]);
```

`capture-store-screenshot.mjs` already waits on `header img[alt="Lurkloot"]` when `variant.popup` is true. Do not change it.

- [ ] **Step 4: Run the focused tests**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/storeScreenshot.test.tsx tests/storeScreenshotFiles.test.ts`

Expected: FAIL on camera tests that still assert extras has no `LIVE_POPUP` and updated/easy layout class names — leave those for Task 3. Variant-model tests and the popup-flag assertion must PASS. If the whole file fails only on camera tests, that is expected; do not weaken the new variant assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src/types.ts packages/popup-ui/src/constants.ts packages/extension/scripts/store-screenshot-config.mjs packages/extension/tests/storeScreenshot.test.tsx packages/extension/tests/storeScreenshotFiles.test.ts
git commit -m "$(cat <<'EOF'
feat(store): mount extras and easy screenshot popups

EOF
)"
```

---

### Task 2: Screenshot copy catalogs

**Files:**
- Modify: `packages/locales/messages/{en,es,fr,it,ru,de,zh_CN,hi,pt_BR,ar,tr}.json`
- Modify: `packages/extension/tests/i18n.test.ts`

**Interfaces:**
- Delete keys: `screenshotExtrasWatchlistName`, `screenshotExtrasWatchlistMeta`
- Add keys (message values below):
  - `screenshotUpdatedBrowsersTitle`
  - `screenshotUpdatedBrowsersSub`
  - `screenshotUpdatedHeadlessTitle` (`CLI · Docker` in every locale)
  - `screenshotUpdatedHeadlessSub`
  - `screenshotUpdatedLicense` (`Apache-2.0` in every locale)

- [ ] **Step 1: Extend the English screenshot copy test**

In `packages/extension/tests/i18n.test.ts`, in `"defines the reworked store-screenshot copy in English"`:

- Remove `screenshotExtrasWatchlistName` and `screenshotExtrasWatchlistMeta` from the expected object.
- Add:

```ts
screenshotUpdatedBrowsersTitle: "Chromium-based browsers",
screenshotUpdatedBrowsersSub: "Chrome Web Store listing. Same extension.",
screenshotUpdatedHeadlessTitle: "CLI · Docker",
screenshotUpdatedHeadlessSub: "Headless. Same engine.",
screenshotUpdatedLicense: "Apache-2.0",
```

- Add those two deleted keys to the existing `stale` array.
- In `"does not leave non-English catalogs as English except product/common terms"`, add to `allowedSameAsEnglish`:

```ts
"screenshotUpdatedHeadlessTitle",
"screenshotUpdatedLicense",
```

- [ ] **Step 2: Run the i18n test to verify RED**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/i18n.test.ts`

Expected: FAIL — new English keys missing; watchlist card keys still present.

- [ ] **Step 3: Update all 11 catalogs**

Delete the two watchlist card keys from every catalog. Insert the five new keys immediately after `screenshotUpdatedSubcopy` (before `autoClaimReady`).

English:

```json
"screenshotUpdatedBrowsersTitle": { "message": "Chromium-based browsers" },
"screenshotUpdatedBrowsersSub": { "message": "Chrome Web Store listing. Same extension." },
"screenshotUpdatedHeadlessTitle": { "message": "CLI · Docker" },
"screenshotUpdatedHeadlessSub": { "message": "Headless. Same engine." },
"screenshotUpdatedLicense": { "message": "Apache-2.0" }
```

Other locales (keep `CLI · Docker`, `Apache-2.0`, and `Chrome Web Store` intact):

| locale | browsersTitle | browsersSub | headlessSub |
|--------|---------------|-------------|-------------|
| es | Navegadores basados en Chromium | Ficha de Chrome Web Store. La misma extensión. | Sin interfaz. El mismo motor. |
| fr | Navigateurs basés sur Chromium | Fiche Chrome Web Store. La même extension. | Sans interface. Le même moteur. |
| it | Browser basati su Chromium | Scheda Chrome Web Store. La stessa estensione. | Senza interfaccia. Lo stesso motore. |
| ru | Браузеры на базе Chromium | Страница Chrome Web Store. То же расширение. | Без интерфейса. Тот же движок. |
| de | Chromium-basierte Browser | Chrome Web Store-Eintrag. Dieselbe Erweiterung. | Headless. Dieselbe Engine. |
| zh_CN | 基于 Chromium 的浏览器 | Chrome Web Store 上架。同一扩展。 | 无界面。同一引擎。 |
| hi | Chromium-आधारित ब्राउज़र | Chrome Web Store लिस्टिंग। वही एक्सटेंशन। | हेडलेस। वही इंजन। |
| pt_BR | Navegadores baseados em Chromium | Página da Chrome Web Store. A mesma extensão. | Sem interface. O mesmo motor. |
| ar | متصفحات مبنية على Chromium | صفحة Chrome Web Store. نفس الإضافة. | بلا واجهة. نفس المحرك. |
| tr | Chromium tabanlı tarayıcılar | Chrome Web Store kaydı. Aynı eklenti. | Arayüzsüz. Aynı motor. |

Do not add `diagnostic*` keys. Do not invent extra screenshot keys.

- [ ] **Step 4: Run the i18n test**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/i18n.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/locales/messages packages/extension/tests/i18n.test.ts
git commit -m "$(cat <<'EOF'
feat(i18n): add screenshot runtime copy

EOF
)"
```

---

### Task 3: Extras, easy, and updated cameras

**Files:**
- Modify: `packages/popup-ui/src/marketing.tsx`
- Modify: `packages/extension/tests/storeScreenshot.test.tsx`

**Interfaces:**
- Consumes Task 1 layouts (`extras` now shows `children` via `variantShowsPopup`) and Task 2 copy keys.
- `StoreScreenshot` still accepts `{ variant, children, locale }`. Popup child remains wrapped in `PopupFrame` (400×600).

- [ ] **Step 1: Rewrite the camera tests**

Replace the `"store screenshot cameras"` describe in `packages/extension/tests/storeScreenshot.test.tsx` with:

```tsx
describe("store screenshot cameras", () => {
  it("places extras copy and chips beside a live popup", async () => {
    const container = await mountShot("extras", "LIVE_POPUP");
    expect(container.textContent).toContain("More than drops.");
    expect(container.textContent).toContain("Channel points");
    expect(container.textContent).toContain("Daily challenges");
    expect(container.textContent).toContain("LIVE_POPUP");
    expect(container.textContent).not.toContain("Idle watchlist");
    expect(container.querySelector('[data-layout="extras"]')).not.toBeNull();
  });

  it("stacks easy steps on the start side and mounts a live popup", async () => {
    const container = await mountShot("easy", "LIVE_POPUP");
    expect(container.textContent).toContain("That easy.");
    expect(container.textContent).toContain("Install");
    expect(container.textContent).toContain("Pin it");
    expect(container.textContent).toContain("Enable a platform");
    expect(container.textContent).toContain("Profit");
    expect(container.textContent).toContain("LIVE_POPUP");
    const steps = container.querySelector('[data-layout="steps"] [data-steps]');
    expect(steps).not.toBeNull();
    const className = steps?.getAttribute("class") ?? "";
    expect(className).toMatch(/\bstart-\[7%\]/);
    expect(className).not.toMatch(/\bgap-7\b/);
  });

  it("places the live popup inside hero and settings cameras", async () => {
    const hero = await mountShot("drops", "LIVE_POPUP");
    expect(hero.textContent).toContain("Farm drops while you do anything else.");
    expect(hero.textContent).toContain("LIVE_POPUP");
    const settings = await mountShot("settings", "LIVE_POPUP");
    expect(settings.textContent).toContain("Farm exactly how you want.");
    expect(settings.textContent).toContain("LIVE_POPUP");
  });

  it("fills updated with a text runtime board and no popup", async () => {
    const container = await mountShot("updated", "LIVE_POPUP");
    expect(container.textContent).toContain("Featureful. Always updated.");
    expect(container.textContent).toContain("Chromium-based browsers");
    expect(container.textContent).toContain("Chrome Web Store listing. Same extension.");
    expect(container.textContent).toContain("CLI · Docker");
    expect(container.textContent).toContain("Headless. Same engine.");
    expect(container.textContent).toContain("Apache-2.0");
    expect(container.textContent).not.toContain("LIVE_POPUP");
  });
});
```

- [ ] **Step 2: Run camera tests to verify RED**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/storeScreenshot.test.tsx`

Expected: FAIL — extras still cards the watchlist and omits the popup; steps still use a horizontal `gap-7` row; updated has no runtime board.

- [ ] **Step 3: Implement the three cameras in `marketing.tsx`**

Remove the `Gem`, `Gift`, `ListVideo`, and `LucideIcon` imports.

Replace `ExtrasCard` with a platform-dotted callout (no Lucide icons):

```tsx
function ExtraCallout({
  dot,
  name,
  meta,
}: {
  dot: string;
  name: string;
  meta: string;
}): React.ReactElement {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span
        className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
        style={{ background: dot, boxShadow: `0 0 9px ${dot}` }}
      />
      <div className="min-w-0">
        <div className="text-[17px] font-semibold text-[#ecedf5]">{name}</div>
        <div className="mt-1 text-[13px] leading-snug text-[#9c9db4]">{meta}</div>
      </div>
    </div>
  );
}
```

Use Twitch `#a970ff` and Kick `#53fc18` (same dots as `PromoPills`).

Replace the extras layout so copy sits upper-start, callouts under the subcopy, popup on the end side at −2deg (rtl +2deg):

```tsx
{variant.layout === "extras" ? (
  <>
    <div className="absolute start-[7%] top-[12%] end-[42%] z-10">
      <CopyBlock
        eyebrowKey={variant.eyebrowKey}
        headlineKey={variant.headlineKey}
        subcopyKey={variant.subcopyKey}
        translate={translate}
      />
      <div className="mt-8 flex flex-col gap-5">
        <ExtraCallout
          dot="#a970ff"
          name={translate("screenshotExtrasPointsName")}
          meta={translate("screenshotExtrasPointsMeta")}
        />
        <ExtraCallout
          dot="#53fc18"
          name={translate("screenshotExtrasChallengesName")}
          meta={translate("screenshotExtrasChallengesMeta")}
        />
      </div>
    </div>
    {popup ? (
      <div className={`absolute end-[7%] top-[9%] z-20 origin-center ${rtl ? "rotate-[2deg]" : "rotate-[-2deg]"}`}>
        <PopupFrame>{popup}</PopupFrame>
      </div>
    ) : null}
  </>
) : null}
```

Replace `StepItem` so it is a vertical row with a number, and replace the steps layout with a start-side stack plus end-side popup at +2deg (rtl −2deg). Put `data-steps` on the stack. Draw the spine with a 2px purple→lime gradient (`bg-linear-to-b from-[#9147ff] to-[#53fc18]`). Keep numbers `01`–`04`.

```tsx
{variant.layout === "steps" ? (
  <>
    <CopyBlock
      className="absolute start-[7%] top-[10%] end-[46%] z-10"
      eyebrowKey={variant.eyebrowKey}
      headlineKey={variant.headlineKey}
      subcopyKey={variant.subcopyKey}
      translate={translate}
      showSubcopy={false}
    />
    <div data-steps className="absolute start-[7%] top-[34%] bottom-[10%] z-10 flex w-[34%] flex-col justify-between">
      <div className="pointer-events-none absolute start-0 top-2 bottom-6 w-0.5 bg-linear-to-b from-[#9147ff] to-[#53fc18]" />
      <StepItem number="01" title={translate("screenshotEasyInstallTitle")} sub={translate("screenshotEasyInstallSub")} />
      <StepItem number="02" title={translate("screenshotEasyPinTitle")} sub={translate("screenshotEasyPinSub")} />
      <StepItem number="03" title={translate("screenshotEasyEnableTitle")} sub={translate("screenshotEasyEnableSub")} />
      <StepItem number="04" title={translate("screenshotEasyProfitTitle")} sub={translate("screenshotEasyProfitSub")} />
    </div>
    {popup ? (
      <div className={`absolute end-[7%] top-[9%] z-20 origin-center ${rtl ? "rotate-[-2deg]" : "rotate-[2deg]"}`}>
        <PopupFrame>{popup}</PopupFrame>
      </div>
    ) : null}
  </>
) : null}
```

`StepItem` should indent from the spine (`ps-5`) so the number/title do not sit on the line.

Replace the updated layout with copy on the start side, `Apache-2.0` as a quiet footer, and a 400px-wide board of two equal glass tiles (no glyphs, no SVGs):

```tsx
function RuntimeTile({ title, sub }: { title: string; sub: string }): React.ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center rounded-2xl border border-white/8 bg-white/[0.03] px-8 py-7">
      <div className="font-display text-[32px] font-bold leading-[1.05] tracking-normal text-[#ecedf5]">{title}</div>
      <div className="mt-3 text-[16px] leading-snug text-[#9c9db4]">{sub}</div>
    </div>
  );
}

{variant.layout === "updated" ? (
  <>
    <CopyBlock
      className="absolute start-[7%] top-[14%] end-[42%] z-10"
      eyebrowKey={variant.eyebrowKey}
      headlineKey={variant.headlineKey}
      subcopyKey={variant.subcopyKey}
      translate={translate}
    />
    <p className="absolute start-[7%] bottom-[12%] z-10 text-[13px] tracking-[0.08em] text-[#9c9db4]">
      {translate("screenshotUpdatedLicense")}
    </p>
    <div className="absolute end-[7%] top-[12%] bottom-[12%] z-10 flex w-[400px] flex-col gap-4">
      <RuntimeTile
        title={translate("screenshotUpdatedBrowsersTitle")}
        sub={translate("screenshotUpdatedBrowsersSub")}
      />
      <RuntimeTile
        title={translate("screenshotUpdatedHeadlessTitle")}
        sub={translate("screenshotUpdatedHeadlessSub")}
      />
    </div>
  </>
) : null}
```

Leave hero and settings cameras untouched. Leave `PromoTile` untouched.

- [ ] **Step 4: Run camera tests**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/storeScreenshot.test.tsx tests/i18n.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src/marketing.tsx packages/extension/tests/storeScreenshot.test.tsx
git commit -m "$(cat <<'EOF'
feat(store): densify extras easy and updated cameras

EOF
)"
```

---

### Task 4: Watchlist screenshot demo data

**Files:**
- Modify: `packages/popup-ui/src/constants.ts`
- Modify: `packages/popup-ui/src/Popup.tsx`
- Modify: `packages/extension/tests/storeScreenshot.test.tsx`

**Interfaces:**
- Consumes Task 1 `view: "watchlist"` on extras.
- Add beside `SCREENSHOT_VARIANTS`:

```ts
export const SCREENSHOT_WATCHLIST_LIVE: Record<string, { displayName: string; viewers: number; subtitle: string }> = {
  rivalspilot: { displayName: "RivalsPilot", viewers: 18420, subtitle: "Marathon Legends" },
  lootforge: { displayName: "LootForge", viewers: 6210, subtitle: "Starfall Arena" },
  nightrunlive: { displayName: "NightRunLive", viewers: 2480, subtitle: "Spellforge" },
};
```

- `Popup` initializes `watchlistExpanded` when `preview && variantShowsPopup(initialVariant) && initialVariant.view === "watchlist"`.
- When that same condition holds, map `idleWatchlist` through `SCREENSHOT_WATCHLIST_LIVE` so those usernames are live with viewer counts. Production and the site demo (`twitch-drops`) must be unchanged.
- Kick selection for easy is already `useState(preview && variantShowsPopup(initialVariant) ? initialVariant.platform : "twitch")`. Do not add a second Kick special case.

- [ ] **Step 1: Write a failing Popup watchlist test**

Add to `packages/extension/tests/storeScreenshot.test.tsx` (import `Popup` and `createDemoPopupAdapter` from `@lurkloot/popup-ui`):

```tsx
describe("extras screenshot popup", () => {
  it("expands the idle watchlist with live demo rows", async () => {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.getElementById("app")!;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <Popup
          adapter={createDemoPopupAdapter()}
          initialState={{ preview: true, locale: "en", variant: screenshotVariant("extras") }}
        />,
      );
    });
    await waitForCatalog();
    expect(container.textContent).toContain("RivalsPilot");
    expect(container.textContent).toContain("LootForge");
    expect(container.textContent).toContain("NightRunLive");
  });
});
```

If collapsed, channel names are not in the DOM. This test fails until expansion and live decoration land.

- [ ] **Step 2: Run the test to verify RED**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/storeScreenshot.test.tsx`

Expected: FAIL — watchlist collapsed and/or rows are idle usernames without display names.

- [ ] **Step 3: Implement expansion and live decoration**

Add `SCREENSHOT_WATCHLIST_LIVE` to `packages/popup-ui/src/constants.ts`.

In `packages/popup-ui/src/Popup.tsx`:

```ts
const [watchlistExpanded, setWatchlistExpanded] = useState(
  preview && variantShowsPopup(initialVariant) && initialVariant.view === "watchlist",
);
```

After `idleWatchlist` is built from settings + session, replace the value used by `IdleWatchlistPanel` when the extras screenshot is active:

```ts
const idleWatchlist = idleWatchlistChannels.map((username) => streamerItemFromFallback(username, session, t));
const screenshotWatchlist = preview && variantShowsPopup(initialVariant) && initialVariant.view === "watchlist"
  ? idleWatchlist.map((item) => {
      const live = SCREENSHOT_WATCHLIST_LIVE[item.id];
      if (!live) return item;
      return { ...item, name: live.displayName, live: true, viewers: live.viewers, subtitle: live.subtitle };
    })
  : idleWatchlist;
```

Pass `screenshotWatchlist` into `IdleWatchlistPanel`. Import `SCREENSHOT_WATCHLIST_LIVE` from `./constants`. Do not import `./demo`.

- [ ] **Step 4: Run screenshot tests**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/storeScreenshot.test.tsx tests/i18n.test.ts tests/storeScreenshotFiles.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src/constants.ts packages/popup-ui/src/Popup.tsx packages/extension/tests/storeScreenshot.test.tsx
git commit -m "$(cat <<'EOF'
feat(popup): expand watchlist in extras screenshot

EOF
)"
```

---

### Task 5: Workspace verification

**Files:**
- None unless a test or type error names a file.

- [ ] **Step 1: Typecheck**

Run: `pnpm -r typecheck`

Expected: PASS. `variantShowsPopup` narrowing must satisfy `Popup.tsx` and `entrypoints/popup/app.tsx` (extras/easy now mount `<Popup>`).

- [ ] **Step 2: Extension tests**

Run: `pnpm --filter @lurkloot/extension exec vitest run`

Expected: PASS.

- [ ] **Step 3: Confirm docs need no edit**

`docs/chrome-web-store-submission.md` does not describe 02/03/05 as popup-free marketing frames (verified during planning). Do not rewrite store listing copy. Do not run `pnpm screenshot:store`.

- [ ] **Step 4: Commit only if Step 1–2 forced a fix**

If no files changed, skip. If a type/test fix landed, commit it with a message that names the fix, e.g. `fix(store): narrow extras screenshot variant`.

---

## Self-review

1. **Spec coverage:** 02 watchlist popup + two dotted callouts → Tasks 1, 3, 4. 03 vertical steps + Kick popup +2deg → Tasks 1, 3. 05 text runtime board, no icons → Tasks 2, 3. Capture `popup: true` on extras/easy → Task 1. i18n add/delete keys → Task 2. 01/04 untouched. No Firefox, no trademarked marks, no Kick watch-time, no activity log, no PNG upload.
2. **Placeholders:** none.
3. **Types:** `view: "watchlist"` is defined in Task 1 and consumed in Tasks 3–4. `variantShowsPopup` is `layout !== "updated"` everywhere. `screenshotUpdatedHeadlessTitle` / `screenshotUpdatedLicense` are allowed to stay English.
