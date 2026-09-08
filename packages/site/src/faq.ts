// FAQ content — rendered both as the on-page accordion and as FAQPage JSON-LD.
// Answers are plain text (no markup) so they're valid for structured data.

export interface FaqItem {
  q: string;
  a: string;
}

export const faqItems: FaqItem[] = [
  {
    q: "Is Lurkloot free?",
    a: "Yes. Lurkloot is completely free and open source. There are no accounts, no subscriptions, and no paywalled features — install it from the Chrome Web Store and it works immediately. The headless CLI and its Docker image are free too.",
  },
  {
    q: "Does it need my Twitch or Kick password?",
    a: "Never. The browser extension reuses the session you are already logged into, and the headless CLI authorizes through each platform's device-login — a short code you approve on any device. Either way it does not ask for your password, and it does not export or upload your cookies or tokens. Your credentials stay where they are.",
  },
  {
    q: "Does it farm drops while I'm AFK or the tab is in the background?",
    a: "Yes — that is the whole point. By default it uses a lightweight background mode that keeps your watch time counting without a video tab open at all. If progress ever stalls, it automatically falls back to a pinned, muted tab to keep your drops moving while you do other things.",
  },
  {
    q: "Can I run it without a browser, on a server?",
    a: "Yes. Alongside the browser extension, Lurkloot ships a headless command-line version that runs the exact same farming engine with no browser at all — both Twitch and Kick farm over plain HTTP. There is a prebuilt, multi-arch Docker image, so you can leave it running 24/7 on a server, a NAS, or a Raspberry Pi. You authorize each platform once with a device-login code, then it just collects.",
  },
  {
    q: "Is Lurkloot open source?",
    a: "Yes. The whole codebase is open source on GitHub — the extension, the headless CLI, and the shared farming engine. You can read every line, build it yourself, and confirm exactly what it does. Since nothing is hidden and nothing phones home, you do not have to take our word for the privacy claims.",
  },
  {
    q: "Which games and drops does it support?",
    a: "It works with any Twitch or Kick drops campaign the platform offers — including popular titles like Rust and Valorant, plus everything else with active drops. It discovers live campaigns automatically, tracks the right channel for each drop, and switches channels as campaigns finish.",
  },
  {
    q: "Is it safe to use? Will I get banned?",
    a: "Lurkloot operates entirely within your own normal, logged-in browser session and does not touch your password or export any data. That said, it is an unofficial tool and is not affiliated with, endorsed by, or sponsored by Twitch or Kick. Automating viewing may be against a platform's terms of service, so use it at your own discretion.",
  },
  {
    q: "How does the auto-claim work?",
    a: "When a drop becomes claimable, Lurkloot claims it for you automatically. The same goes for Twitch channel points and Kick's daily challenge cards, which are opened as soon as their watch-time goal is met — both are on by default, with a separate toggle per platform. You can also turn on notifications so you know the moment a reward lands, and it tells you when all campaigns are exhausted.",
  },
  {
    q: "Can I control which campaigns it prioritizes?",
    a: "Fully. Drag campaigns to set an explicit farming order, or pick a strategy: ending soonest first, lowest availability first, or priority-list only. You can exclude specific campaigns and channels, choose which games to farm, and keep a per-platform Idle Watchlist as a fallback for when no eligible drops are available.",
  },
];

// Twitch landing page (/twitch-drops-farmer). Deliberately different questions
// from the homepage set and from the Kick page: these are the things people ask
// about *Twitch* drops specifically — integrity, tiers, channel points, the
// Android-client headless path.
export const twitchFaqItems: FaqItem[] = [
  {
    q: "How does Lurkloot farm Twitch Drops automatically?",
    a: "It reads your Twitch inventory and the live drops directory to work out which campaigns you can still earn, picks a channel that is actually live in the campaign's game and has drops enabled, and keeps your watch time counting there. When a campaign ends, a stream goes offline, or a reward tier completes, it re-routes to the next eligible channel on its own.",
  },
  {
    q: "Do I need to keep a Twitch tab open?",
    a: "No. The default mode sends the same minute-watched heartbeat Twitch's own player sends, with no video tab open at all, so your machine stays cool and your bandwidth stays free. If those heartbeats ever stop registering progress, Lurkloot falls back to a pinned, muted twitch.tv tab automatically so the drop keeps moving.",
  },
  {
    q: "Does it claim Twitch Drops and channel points for me?",
    a: "Yes, both. A drop is claimed as soon as its watch requirement is met, and Twitch channel points bonuses are collected on the channel you are farming. Each is a separate toggle, both on by default. Multi-tier campaigns are tracked tier by tier, so a five-hour campaign claims its one-hour reward without waiting for the rest.",
  },
  {
    q: "Can I farm Twitch Drops on a server, with no browser?",
    a: "Yes. The headless CLI talks to Twitch as the Android app client, which Twitch does not gate behind Client-Integrity, so discovery, watch progress and drop claims all work through Twitch's API with no browser and no integrity token. You authorize once with Twitch's device-code login — an activation URL and a short code you approve on any device — and a prebuilt multi-arch Docker image runs it 24/7 on a server, NAS or Raspberry Pi.",
  },
  {
    q: "Which browsers does the Twitch Drops extension work in?",
    a: "Any Chromium browser: Chrome, Edge, Brave, Opera and Vivaldi all install it from the Chrome Web Store. Firefox builds are published on GitHub Releases. It runs on the Twitch session you are already signed into, so there is nothing to connect and no password to hand over.",
  },
  {
    q: "Can I choose which Twitch campaigns it farms first?",
    a: "Yes. Drag campaigns into an explicit order, or pick a strategy — ending soonest, lowest availability, or priority-list only. You can exclude individual campaigns and channels, restrict it to chosen games, and decide whether campaigns that need an account link or an active channel subscription are farmed at all. A per-platform Idle Watchlist covers the hours when nothing is droppable.",
  },
];

// Kick landing page (/kick-drops-farmer). Kick's mechanics differ enough from
// Twitch's that these are genuinely separate answers, not restatements: the
// viewer socket, the Pusher campaign-start signal, gamification challenge
// cards, and the Cloudflare-fingerprint constraint on the headless path.
export const kickFaqItems: FaqItem[] = [
  {
    q: "How does Lurkloot farm Kick Drops automatically?",
    a: "It follows Kick's live drops campaigns, picks a channel streaming the campaign's category right now, and holds a viewer session on it so the drop's watch timer advances. As campaigns finish or a streamer ends their broadcast, it moves to the next channel that still counts toward a reward you have not earned.",
  },
  {
    q: "How fast does it notice a new Kick campaign?",
    a: "Usually within seconds. Alongside its regular polling, Lurkloot subscribes to Kick's realtime campaign channel and gets pushed a signal the moment a campaign starts in a category you farm — which is what makes short flash-drop windows catchable at all instead of being missed between polls.",
  },
  {
    q: "Does it claim Kick Drops and daily challenges?",
    a: "Yes. Kick drops are claimed as soon as their watch requirement is met, and Kick's daily challenge cards are opened the moment their goal is reached rather than sitting unclaimed until you remember them. Both are on by default and can be switched off independently of the Twitch side.",
  },
  {
    q: "Does Kick farming need a visible tab?",
    a: "Usually not. Lurkloot opens Kick's viewer socket directly from the extension's background worker, which advances the watch timer with no video playing. Because that socket is opened from the extension rather than from kick.com itself, Kick can occasionally refuse the handshake — when that happens Lurkloot notices the watch is unhealthy and falls back to a pinned, muted kick.com tab, so farming carries on either way.",
  },
  {
    q: "Can I farm Kick Drops headless, in Docker?",
    a: "Yes, with one caveat worth knowing. Kick's Cloudflare protection inspects the TLS and HTTP/2 fingerprint of every request, so a plain Node request is rejected outright — the CLI's default transport sends a real Chrome fingerprint instead and reaches Kick's API and viewer socket with no browser. Authorization uses Kick's smart-TV link flow: the CLI prints a kick.com/tv/login URL and a six-digit code that you confirm on a device where you are already signed in.",
  },
  {
    q: "Do I need a Kick password or a cookie export?",
    a: "Neither. In the browser the extension reuses the Kick session you are already logged into. Headless, the smart-TV link approval hands back a session token directly, so the CLI requires no export. An optional, user-initiated session-token transfer from the extension is also available if you want to move an existing session.",
  },
];
