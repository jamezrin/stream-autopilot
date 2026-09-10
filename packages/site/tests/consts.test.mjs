import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EXTERNAL_URLS, LINKS, SITE } from "../src/consts.ts";

test("attributes Chrome Web Store website referrals", () => {
  const url = new URL(LINKS.chrome);

  assert.equal(url.origin + url.pathname, EXTERNAL_URLS.chrome);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    utm_source: "lurkloot_website",
    utm_medium: "referral",
    utm_campaign: "extension_install",
  });
});

test("attributes every GitHub-owned website destination", () => {
  for (const key of ["github", "cli", "ghcr"]) {
    const url = new URL(LINKS[key]);

    assert.equal(`${url.origin}${url.pathname}`, EXTERNAL_URLS[key]);
    assert.equal(url.searchParams.get("utm_source"), "lurkloot_website");
    assert.equal(url.searchParams.get("utm_medium"), "referral");
    assert.equal(url.searchParams.get("utm_campaign"), "open_source");
  }

  assert.equal(new URL(LINKS.cli).hash, "#readme");
  assert.match(LINKS.cli, /\?[^#]+#readme$/);
});

// Structured data is now per-page (Base.astro emits SoftwareApplication
// everywhere, BreadcrumbList + FAQPage only where the page supplies them), so
// these read every ld+json block and select by @type rather than by position.
async function structuredData(page) {
  const html = await readFile(new URL(`../dist/${page}`, import.meta.url), "utf8");
  return [...html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)].map(
    (match) => JSON.parse(match[1]),
  );
}

const ldOfType = (blocks, type) => blocks.find((block) => block["@type"] === type);
const indexablePages = [
  "index.html",
  "privacy/index.html",
  "changelog/index.html",
  "twitch-drops-farmer/index.html",
  "kick-drops-farmer/index.html",
];

test("keeps the structured download URL canonical", async () => {
  const software = ldOfType(await structuredData("index.html"), "SoftwareApplication");

  assert.ok(software);
  assert.equal(software.downloadUrl, EXTERNAL_URLS.chrome);
});

test("derives the structured software version from the released workspace version", async () => {
  const root = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  const software = ldOfType(await structuredData("index.html"), "SoftwareApplication");

  assert.equal(SITE.version, root.version);
  assert.equal(software.softwareVersion, root.version);
});

test("scopes FAQ structured data to pages that render the questions", async () => {
  for (const page of ["index.html", "twitch-drops-farmer/index.html", "kick-drops-farmer/index.html"]) {
    assert.ok(ldOfType(await structuredData(page), "FAQPage"), `${page} should carry FAQPage`);
  }
  // The layout used to emit the homepage FAQ on every page, describing content
  // that was not there.
  for (const page of ["privacy/index.html", "changelog/index.html"]) {
    assert.equal(ldOfType(await structuredData(page), "FAQPage"), undefined, `${page} should not`);
  }
});

test("drops the meta keywords tag from every page", async () => {
  for (const page of indexablePages) {
    const html = await readFile(new URL(`../dist/${page}`, import.meta.url), "utf8");
    assert.ok(!/<meta name="keywords"/.test(html), `${page} should not declare meta keywords`);
  }
});

test("gives each indexable page a distinct title and description", async () => {
  const titles = new Set();
  const descriptions = new Set();

  for (const page of indexablePages) {
    const html = await readFile(new URL(`../dist/${page}`, import.meta.url), "utf8");
    const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
    const description = html.match(/<meta name="description" content="([^"]+)"/)?.[1];

    assert.ok(title, `${page} has a title`);
    assert.ok(description, `${page} has a description`);
    titles.add(title);
    descriptions.add(description);
  }

  assert.equal(titles.size, indexablePages.length);
  assert.equal(descriptions.size, indexablePages.length);
});

test("describes encrypted transport and only user-initiated credential transfer", async () => {
  const twitch = await readFile(
    new URL("../dist/twitch-drops-farmer/index.html", import.meta.url),
    "utf8",
  );
  const kick = await readFile(
    new URL("../dist/kick-drops-farmer/index.html", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(twitch, /plain HTTP/);
  assert.match(twitch, /through Twitch(?:'s|&#39;s) API/);
  assert.match(kick, /optional, user-initiated session-token transfer/i);
});

test("links the platform landing pages from the homepage and the sitemap", async () => {
  const home = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const sitemap = await readFile(new URL("../dist/sitemap-0.xml", import.meta.url), "utf8");

  for (const href of [LINKS.twitchFarmer, LINKS.kickFarmer]) {
    assert.ok(home.includes(`href="${href}"`), `homepage links to ${href}`);
    assert.ok(sitemap.includes(`${SITE.url}${href}/`), `sitemap lists ${href}`);
  }
});

test("cross-links the two platform pages to each other", async () => {
  const twitch = await readFile(
    new URL("../dist/twitch-drops-farmer/index.html", import.meta.url),
    "utf8",
  );
  const kick = await readFile(
    new URL("../dist/kick-drops-farmer/index.html", import.meta.url),
    "utf8",
  );

  assert.ok(twitch.includes(`href="${LINKS.kickFarmer}"`));
  assert.ok(kick.includes(`href="${LINKS.twitchFarmer}"`));
});
