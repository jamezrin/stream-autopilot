# Store screenshot density design

## Goal

Give Chrome Web Store screenshots 02, 03, and 05 the same finished density as 01 and 04. Those two work because a real 400×600 popup is a solid object on the canvas. 02–03–05 were specified as marketing frames with “lots of void,” so they read empty at store-thumbnail size.

Keep the locked five-shot stories, the signal-broadcast look, and shots 01 and 04 unchanged.

## Scope

This covers the store-screenshot React shell (`StoreScreenshot`), screenshot variant types, demo data used by capture, English marketing copy plus the other ten locale catalogs for any new keys, Playwright capture waits, and `STORE_SCREENSHOT_VARIANTS` popup flags.

It does not change 01/04 layout or copy, farming behavior, listing short/detailed descriptions, promo tiles, or Chrome Web Store upload automation.

## Shot lineup

Chrome still allows five 1280×800 screenshots. Upload order is the number prefix.

| # | File stem | Story | Live popup |
|---|-----------|--------|------------|
| 01 | `01-drops` | Hero: farm Twitch and Kick drops | Yes — drops view, Twitch selected (unchanged) |
| 02 | `02-extras` | Overview of extras besides drop campaigns | Yes — Twitch, idle watchlist expanded |
| 03 | `03-easy` | Install → pin → enable → profit | Yes — Kick selected, both platform toggles on |
| 04 | `04-settings` | Configurable | Yes — settings view (unchanged) |
| 05 | `05-updated` | Featureful, always updated, open source | No — text runtime board (Chromium browsers + CLI/Docker) |

Aliases stay: `twitch-drops` → 01, `settings` → 04, `kick-drops` → 01, `idle-watchlist` → 02, `activity` → 05.

## Visual language

Unchanged from the 2026-08-16 rework, so the set still reads as one listing:

- Canvas `#060609`, Bricolage Grotesque display type, zinc subcopy (`#9c9db4`).
- Purple (`#9147ff`) and lime (`#53fc18`) only as atmospheric radial glows. No decorative gradient bars, no full-canvas wallpaper blobs, no illustrated fake popup UI.
- No third-party trademarked icons or logos anywhere in the five shots: no browser marks, no Docker whale, no GitHub mark, no Twitch/Kick logos. Nominative text is allowed (Twitch, Kick, Chromium, CLI, Docker). Colored status dots that are not brand marks stay allowed, matching the existing promo pills.
- Eyebrows keep the purple→lime text gradient.
- Every live popup is the real `Popup` at **400×600**. Scale, crop (overflow hidden), or slight rotate are allowed. Stretching is not.
- 05’s runtime board is sized to similar mass (~400×560) so it fills like a popup.

Use logical `start`/`end` placement, same as today. In LTR, 01/02/03/05 put the object on the right (`end`); 04 keeps the popup on the left (`start`). RTL flips those sides. 03 step order stays 01→04.

## Shot 02 — extras

Copy stays:

- Eyebrow: `Beyond campaigns`
- Headline: `More than drops.`
- Subcopy: `Channel points, Kick challenges, and 2-minute drops — also claimed for you. An idle watchlist when nothing is left to farm.`

Camera: copy **upper-left** (not 01’s lower-third). Four platform-dotted callouts in a 2×2 under the subcopy, names at 24px:

- Channel points — `Twitch · also claimed for you`
- Daily challenges — `Kick · also claimed for you`
- Idle watchlist — `Watches your streamers between campaigns`
- 2-minute drops — `Kick · picked up as they land`

The idle watchlist is also the product object: a 400×600 popup on the end side, slight −2deg tilt, Twitch selected, watchlist section expanded, 2–3 rows showing live pills and viewer counts. Do not sell Kick watch time as farmable. 2-minute drops are Kick flash campaigns discovered immediately, not a watch-time outcome.

Demo data for this capture must mark watchlist channels live (today only the current farming session channel counts as live). Screenshot-specific demo overlay is allowed; do not change normal demo behavior for the site popup demo.

## Shot 03 — easy

Copy stays. Headline `That easy.` Steps stay a real sequence, so they stay numbered:

1. Install — `Chrome Web Store. No account.`
2. Pin it — `Keep the popup one click away.`
3. Enable a platform — `Twitch, Kick, or both.`
4. Profit — `It farms. You do other things.`

Camera: vertical stack on the start side with a 2px purple→lime spine. The live popup sits on the end side as the destination of the sequence (step 4 is the product, not a fourth text column). Slight **+2deg** tilt so it does not rhyme with 01’s −2deg.

Popup: Kick selected, both platform automation toggles on, drops view with the Kick demo campaign visible. That is the dual-platform proof for “Twitch, Kick, or both,” against 01’s Twitch drops shot.

No fake Chrome toolbar for “Pin it.” Pin remains copy.

## Shot 05 — updated

Copy stays:

- Eyebrow: `Open source`
- Headline: `Featureful. Always updated.`
- Subcopy: `Frequent releases as Twitch and Kick change — and open to ideas and improvements.`
No popup, no changelog dump, no activity-log pitch, no Firefox. Legal constraint: we may say Chromium-based browsers are supported; we must not put trademarked browser (or Docker) marks in the screenshots. Generic window / terminal / box icons and a GitHub mark are allowed.

Copy sits upper-left, aligned with the rating. The object that fills the void is a **listing board** on the end side (400×600), one glass plaque rather than stretched tiles:

- Rating `4.9` with five generic stars, then `1,000+ users`. No review count — that number moves too often to bake into store screenshots.
- Compact runtime rows, one icon each: Chromium-based browsers, CLI, Docker, GitHub / Apache-2.0.

Do not list Edge/Brave/Opera/Vivaldi by name on this shot, and do not copy site browser SVGs into popup-ui. `CLI`, `Docker`, and `Chrome Web Store` stay untranslated.

## Variant model

`ScreenshotVariant` still uses a `layout` discriminant. Popup-carrying layouts gain `platform` and `view`:

| layout | popup | platform | view |
|--------|-------|----------|------|
| `hero` | yes | twitch | drops |
| `extras` | yes | twitch | watchlist |
| `steps` | yes | kick | drops |
| `settings` | yes | twitch | settings |
| `updated` | no | — | — |

`variantShowsPopup` is true for every layout except `updated`. `Popup` initializes `watchlistExpanded` when `view === "watchlist"`, and selects Kick when the variant’s platform is Kick.

`STORE_SCREENSHOT_VARIANTS` sets `popup: true` on extras and easy so capture waits on `header img[alt="Lurkloot"]`. Updated still waits on the marketing `h1`.

## i18n

Keep existing extras/easy/updated copy keys except:

- Keep `screenshotExtrasWatchlistName` / `screenshotExtrasWatchlistMeta` and add `screenshotExtrasFlashName` (`2-minute drops`) / `screenshotExtrasFlashMeta` (`Kick · picked up as they land`) in all 11 catalogs.
- Add `screenshotUpdatedBrowsersTitle` (`Chromium-based browsers`), `screenshotUpdatedBrowsersSub` (`Chrome Web Store listing. Same extension.`), `screenshotUpdatedHeadlessTitle` (`CLI`), `screenshotUpdatedHeadlessSub` (`Headless. Same engine.`), `screenshotUpdatedDockerTitle` (`Docker`), `screenshotUpdatedDockerSub` (`Same engine. In a container.`), `screenshotUpdatedLicense` (`Apache-2.0`), `screenshotUpdatedRating` (`4.9`), and `screenshotUpdatedUsers` (`1,000+ users`) to all 11 catalogs. Do not bake a review count into screenshot copy.

`CLI`, `Docker`, `Apache-2.0`, and `Chrome Web Store` stay untranslated, same as Twitch / Kick. Translate `Chromium-based browsers`, the rest of the browsers sub around the `Chrome Web Store` token, and `Headless. Same engine.`

## Tests and docs

- `packages/extension/tests/storeScreenshot.test.tsx`: extras and easy show a popup; updated does not; `variantShowsPopup` matches the table above; watchlist view is wired.
- `packages/extension/tests/i18n.test.ts`: new keys exist in every catalog; extras watchlist and flash keys are present; placeholders still match.
- Capture config tests: extras and easy are `popup: true`.
- `docs/chrome-web-store-submission.md` only if it still describes 02/03/05 as popup-free marketing frames.

## Out of scope

- Regenerating and uploading PNGs (`pnpm screenshot:store` after implementation; artifacts stay gitignored).
- Changing 01/04, promo tiles, or store listing body copy.
- Firefox on shot 05, AMO, or promising Firefox Add-ons availability.
- Any trademarked third-party icons in screenshots (browser logos, Docker whale, GitHub, Twitch/Kick).
- Kick watch-time outcomes, activity log as a selling point, illustrated fake popups.

## Self-review

- No TBD/TODO in shot copy or layout rules.
- 02 does not sell Kick watch time; 05 does not sell the activity log, Firefox, or any trademarked icons.
- Five shots, 1280×800, popup 400×600 only — no contradiction with CWS limits.
- One capture pipeline and one `StoreScreenshot` component, not a second marketing site.
- Implementation is one focused change: density of 02/03/05, not a new screenshot lineup.
