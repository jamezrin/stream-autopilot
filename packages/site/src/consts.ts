// Shared, single-source-of-truth content for the landing page.
import rootPackage from "../../../package.json" with { type: "json" };

export const SITE = {
  name: "Lurkloot",
  tagline: "Farm Twitch & Kick drops on autopilot.",
  // Used for canonical/OG absolute URLs. Mirrors astro.config `site`.
  url: "https://lurkloot.jamezrin.com",
  description:
    "Lurkloot is a free, open-source farmer for Twitch and Kick drops that runs through your own logged-in session. Use it as a browser extension, or run it headless with the prebuilt Docker image — lightweight tabless mode, auto-claim, smart channel switching, and a private, no-password design. Works with Rust, Valorant, and any drops campaign.",
  // Released workspace version, kept in step with every published manifest by
  // the release flow (scripts/release.mjs `packagePaths`). Surfaced in the
  // SoftwareApplication structured data so it cannot go stale. The site's own
  // package.json is deliberately not bumped by that flow, so read the root one.
  version: rootPackage.version,
} as const;

// Published headless image — built multi-arch (amd64 + arm64) on GHCR by the
// unified release workflow. Used verbatim in the CLI section's snippet.
export const DOCKER_IMAGE = "ghcr.io/jamezrin/lurkloot-cli:latest";

export const EXTERNAL_URLS = {
  chrome:
    "https://chromewebstore.google.com/detail/lurkloot/aobaackpofkghaejdnnmpmeaiaoibhdn",
  github: "https://github.com/jamezrin/lurkloot",
  cli: "https://github.com/jamezrin/lurkloot/tree/main/packages/cli",
  ghcr: "https://github.com/jamezrin/lurkloot/pkgs/container/lurkloot-cli",
} as const;

function withCampaign(url: string, campaign: "extension_install" | "open_source"): string {
  const attributed = new URL(url);
  attributed.searchParams.set("utm_source", "lurkloot_website");
  attributed.searchParams.set("utm_medium", "referral");
  attributed.searchParams.set("utm_campaign", campaign);
  return attributed.href;
}

export const LINKS = {
  chrome: withCampaign(EXTERNAL_URLS.chrome, "extension_install"),
  // On-site pages (no trailing slash, matching `trailingSlash: "ignore"`).
  privacy: "/privacy",
  changelog: "/changelog",
  twitchFarmer: "/twitch-drops-farmer",
  kickFarmer: "/kick-drops-farmer",
  x: "https://x.com/jamezrin",
  // The open-source repo (not the profile) — surfaced across hero/CLI/footer.
  github: withCampaign(EXTERNAL_URLS.github, "open_source"),
  cli: withCampaign(`${EXTERNAL_URLS.cli}#readme`, "open_source"),
  ghcr: withCampaign(EXTERNAL_URLS.ghcr, "open_source"),
} as const;
