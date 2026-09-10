import type { ChannelCandidate } from "@lurkloot/shared/models";

const TWITCH_HOSTS = new Set(["twitch.tv", "www.twitch.tv"]);
const TWITCH_LOGIN = /^[a-z0-9_]{1,25}$/i;
const RESERVED_ROUTES = new Set([
  "activate",
  "bits",
  "broadcast",
  "browse",
  "checkout",
  "communities",
  "creatorcamp",
  "dashboard",
  "directory",
  "downloads",
  "drops",
  "following",
  "friends",
  "inventory",
  "jobs",
  "login",
  "messages",
  "moderator",
  "payments",
  "popout",
  "prime",
  "products",
  "search",
  "settings",
  "store",
  "subscriptions",
  "team",
  "turbo",
  "videos",
  "wallet",
]);

export function twitchChannelFromUrl(url: string | undefined): ChannelCandidate | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !TWITCH_HOSTS.has(parsed.hostname.toLowerCase())) return undefined;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length !== 1) return undefined;
    const username = segments[0].toLowerCase();
    if (!TWITCH_LOGIN.test(username) || RESERVED_ROUTES.has(username)) return undefined;
    return {
      platform: "twitch",
      username,
      url: `https://www.twitch.tv/${username}`,
    };
  } catch {
    return undefined;
  }
}
