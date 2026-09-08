# Search visibility

How the marketing site (`packages/site`) is organized for organic search, what
each page is meant to rank for, and the operational steps that live outside the
repository. Tracking issue: [#485](https://github.com/jamezrin/lurkloot/issues/485).

## Information architecture

```text
/                        product + brand hub (both platforms)
├── twitch-drops-farmer/ Twitch search intent
├── kick-drops-farmer/   Kick search intent
├── changelog/           release notes
└── privacy/             privacy policy
```

The homepage stays broad on purpose. It is the brand page and the internal-link
hub; it is deliberately *not* an exact-match keyword page, because trying to make
one page rank for both platforms' head terms is what produced the flat, generic
metadata this structure replaces.

### Page → intent map

| Page | Primary intent | Also targets |
| --- | --- | --- |
| `/` | `lurkloot`, brand and category ("twitch drops extension") | `farm twitch and kick drops` |
| `/twitch-drops-farmer` | `farm twitch drops`, `twitch drops farmer` | `auto farm twitch drops`, `afk twitch drops`, `twitch drops auto claim`, `twitch drops extension`, `headless twitch drops` |
| `/kick-drops-farmer` | `farm kick drops`, `kick drops farmer` | `auto farm kick drops`, `afk kick drops`, `kick drops auto claim`, `kick drops extension`, `headless kick drops` |
| `/changelog` | `lurkloot changelog`, version-specific queries | — |
| `/privacy` | `lurkloot privacy` | — |

Every page carries a distinct `<title>` and description; `tests/consts.test.mjs`
asserts that, so two pages cannot silently converge on the same snippet.

## Avoiding cannibalization

The Twitch and Kick pages share a *shell* — `SubNav.astro`, `Faq.astro`, and the
`.lp-*` styles in `global.css` — and nothing else. Their body copy is written
against what each adapter genuinely does, and it differs because the platforms
differ:

- **Twitch**: inventory-aware discovery, minute-watched heartbeats with a muted
  tab fallback, tier-by-tier claiming, channel points, and the Android-client
  headless path that sidesteps Client-Integrity.
- **Kick**: realtime campaign-start signals over Kick's socket, a viewer session
  instead of watch heartbeats (with the honest caveat that Kick may refuse the
  extension-origin handshake), gamification challenge cards, and the Cloudflare
  fingerprint constraint that shapes the headless transport.

**When editing either page, do not paraphrase the other one.** A shared
`PlatformPage.astro` fed by a `{ twitch, kick }` object would be the natural
refactor and it is exactly the wrong one here: parallel sentences with the nouns
swapped is the shape crawlers read as duplicate content, and it would put the two
pages in competition for the same results.

## Adding a game page later

Reserved shape, not yet built:

```text
/twitch-drops/<game>/    e.g. /twitch-drops/rust/
```

Everything needed to add one already exists: create
`src/pages/twitch-drops/<game>.astro`, compose `Base` (passing `faq` and
`breadcrumbs`), `SubNav`, `Faq` and `Footer`, and use the `.lp-*` classes. The
sitemap picks it up automatically, and `LINKS` in `src/consts.ts` is where its
path belongs so other pages can link to it.

The bar for creating one is content, not routing: a game page must say something
true and specific about *that* campaign — how its tiers are structured, how long
its windows run, which channels enrol, what trips people up — that the platform
page does not already say. Candidates by search volume: Rust, Valorant, Warframe,
Escape from Tarkov, Rainbow Six Siege. A page that only swaps the game name in
would dilute the platform page rather than add to it; leave the game as plain
text on `/twitch-drops-farmer` until there is more to say.

Kick game pages are worth revisiting once Kick campaigns have enough recurring,
searched-for titles to justify separate pages.

## Structured data

Emitted from `src/layouts/Base.astro`:

- **`SoftwareApplication`** on every page. `softwareVersion` reads the root
  `package.json`, which `scripts/release.mjs` keeps equal to every published
  manifest — it used to be hardcoded `"1.0"`. Note the site's own
  `package.json` is *not* in that script's `packagePaths`, so it is the wrong
  file to read.
- **`BreadcrumbList`** on pages that pass `breadcrumbs`.
- **`FAQPage`** only on pages that pass `faq`. It used to be layout-global,
  which shipped the homepage FAQ inside `/privacy` and `/changelog` — schema
  describing content that was not on the page. Treat FAQ schema as semantic
  markup, **not** as a rich-result feature: Google restricted FAQ rich results
  to authoritative government and health sites in 2023, so it will not draw an
  expanded SERP listing here.

`<meta name="keywords">` has been removed. Google has not used it for ranking in
well over a decade, and keeping it invited keyword-stuffed edits to a tag nobody
reads.

## Search Console — operator checklist

Not automated; these need the site owner's Google account. No code-side
integration is planned unless reporting is later automated.

- [ ] Add and verify `https://lurkloot.jamezrin.com/` in Google Search Console
      (DNS verification via the Cloudflare zone is the least fragile option).
- [ ] Submit `https://lurkloot.jamezrin.com/sitemap-index.xml`.
- [ ] After this change deploys, run URL Inspection → *Request indexing* once
      each for `/twitch-drops-farmer` and `/kick-drops-farmer`.
- [ ] Confirm the Rich Results Test parses `SoftwareApplication` and
      `BreadcrumbList` on both new pages.
- [ ] Set up a Performance report filtered to the target queries in the table
      above, and record impressions, clicks, CTR and average position ~4 and ~12
      weeks after launch.
- [ ] Watch for the two platform pages trading positions on the same query —
      that is the cannibalization signal, and the fix is editorial (sharpen the
      weaker page's angle), not more keywords.

Prerelease deploys set `robots.txt` to `Disallow: /` plus a `noindex` header (see
`astro.config.mjs`), so only production deploys are indexable.

## Off-page opportunities

Natural mentions only — no bought links, no exact-match anchor campaigns, no
posting where a self-promotional link is off-topic or against community rules.

| Channel | Notes |
| --- | --- |
| Reddit | Answer real questions in r/Twitch, r/RustGame, r/Kick threads about drop farming; link only where it is the actual answer. |
| GitHub awesome lists | Browser-extension and self-hosted/Docker lists — the CLI and the multi-arch image are the angle for the self-hosted ones. |
| Extension directories | Listings that index Chrome Web Store extensions. |
| Twitch Drops guides | Guide sites and wikis that maintain tool lists. |
| Kick Drops guides | Thinner ground today; worth revisiting as Kick's drops ecosystem grows. |
| Game communities | Rust and other drop-heavy titles, around campaign launches when the question is being asked anyway. |
| YouTube | Creators covering drop farming; the headless Docker setup is the most distinctive demo. |

Track what has actually been done here rather than in an issue comment, so the
next person can see which of these were tried and which paid off.
