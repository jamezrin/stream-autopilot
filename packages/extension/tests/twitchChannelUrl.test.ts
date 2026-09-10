import { describe, expect, it } from "vitest";
import { twitchChannelFromUrl } from "@lurkloot/core/twitch/channelUrl";

describe("Twitch channel URLs", () => {
  it.each([
    ["https://www.twitch.tv/Creator_1?ref=x#chat", "creator_1"],
    ["https://twitch.tv/UPPERCASE", "uppercase"],
  ])("normalizes a canonical channel URL: %s", (url, username) => {
    expect(twitchChannelFromUrl(url)).toEqual({
      platform: "twitch",
      username,
      url: `https://www.twitch.tv/${username}`,
    });
  });

  it.each([
    "https://www.twitch.tv/",
    "https://www.twitch.tv/directory",
    "https://www.twitch.tv/downloads",
    "https://www.twitch.tv/drops",
    "https://www.twitch.tv/following",
    "https://www.twitch.tv/inventory",
    "https://www.twitch.tv/jobs",
    "https://www.twitch.tv/login",
    "https://www.twitch.tv/messages",
    "https://www.twitch.tv/payments",
    "https://www.twitch.tv/search",
    "https://www.twitch.tv/settings",
    "https://www.twitch.tv/subscriptions",
    "https://www.twitch.tv/turbo",
    "https://www.twitch.tv/videos",
    "https://www.twitch.tv/creator/videos",
    "http://www.twitch.tv/creator",
    "https://clips.twitch.tv/creator",
    "https://twitch.tv.example.com/creator",
    "https://twitch.tv@evil.example/creator",
    "https://www.twitch.tv/not-valid!",
    "https://www.twitch.tv/abcdefghijklmnopqrstuvwxyz",
    "not a url",
  ])("rejects a non-channel Twitch URL: %s", (url) => {
    expect(twitchChannelFromUrl(url)).toBeUndefined();
  });

  it("rejects missing sender URL metadata", () => {
    expect(twitchChannelFromUrl(undefined)).toBeUndefined();
  });
});
