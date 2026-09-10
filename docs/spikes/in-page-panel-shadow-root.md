# Spike: in-page panel rendering

Tracking issue: [#446](https://github.com/jamezrin/lurkloot/issues/446)

**Outcome: shadow root rejected, iframe adopted.** Kept for the reasoning, so the
shadow-root path is not re-attempted.

## What the shadow-root spike measured, and what it missed

The probe asked whether `--font-sans` and `--accent` resolved inside the shadow
root and whether Tailwind utilities applied. All three passed, and the
architecture was declared settled on that basis.

That was the wrong set of questions. The probe read `getComputedStyle` values; it
never compared a *rendered* panel against the real popup. One screenshot then
found two structural defects the instrumented run could not:

1. **Assets 404.** `Popup.tsx` renders `<img src="/logo-ring.svg">` — root-absolute.
   In an extension document that resolves to `chrome-extension://…/logo-ring.svg`;
   inside a content script it resolved to `https://www.twitch.tv/logo-ring.svg`.
   Fixing it in a shadow root means threading a base URL through `Popup.tsx` and
   `marketing.tsx`, which the site demo also consumes.
2. **`rem` is document-rooted.** `rem` resolves against the document root element
   even inside a shadow root. The built CSS has 25 rem occurrences and Tailwind
   v4's `--spacing` scale is rem-based, so the panel's entire internal layout
   scaled with whatever `html { font-size }` Twitch or Kick set. The outer box
   looked right only because `h-[600px] w-[400px]` are px literals. This stays
   fragile even where the host happens to use 16px.

Neither is fixable without editing `packages/popup-ui`, which is the shared-file
regression risk the shadow-root design existed to avoid.

**Lesson worth keeping: a styling probe is not a rendering check.** Compare
against the real thing, not against computed values.

## Why the iframe is right

The panel is its own extension document, so all three problems dissolve rather
than being worked around:

- Root-absolute asset URLs resolve against the extension origin, as in the popup.
- `rem` resolves against the panel's own root — immune to the host page.
- `styles.css` applies unmodified. No `:host` mirror, no duplicated font tokens
  that could drift, and `packages/popup-ui` is untouched.
- Full origin isolation from Twitch/Kick CSS and JS.

It also restores two-stage injection, which the shadow-root design had given up:

| | shadow root | iframe (two-stage) |
| --- | --- | --- |
| `content-scripts/twitch.js` | 1.2 MB | **6.72 kB** |
| build total | 5.07 MB | 2.56 MB |
| web-accessible resources | `content-scripts/*.css` (WXT auto-generated) | `inpagePanel.html` |

The panel document is exactly 400x600 — the popup's own dimensions — and the
iframe is sized to match, so nothing scrolls.

## Firefox caveat

WXT downlevels the MV3 `{resources, matches}` entry to MV2's flat string array,
verified in the built manifest:

```json
"web_accessible_resources": ["inpagePanel.html"]
```

MV2 has no `matches` field, so on Firefox the panel page is web-accessible to
**every** origin, not just Twitch and Kick. The page exposes no secrets, but it is
fingerprintable browser-wide there. Worth a line in the PR and the AMO listing.

## Still to build

- `inPagePanel` settings block (`enabled` default off, `position`, `open`) plus a
  schema migration — settings go through `@lurkloot/shared/settingsSchema`, at
  `CURRENT_SETTINGS_SCHEMA_VERSION = 4`.
- Managed-tab suppression. Stage 1 runs in the extension's own farming tabs under
  every architecture; it needs an `isManagedTab` round-trip because content
  scripts cannot learn their own tab id.
- Drag + position persistence. The drag handle must live in the content script,
  not the panel document — pointer events inside an iframe do not reach the
  parent — with `pointer-events: none` on the frame mid-drag.
- SPA-navigation and `ctx.onInvalidated` handling so the host element is neither
  duplicated nor orphaned.
- Hide or lower the button in theatre/fullscreen.
