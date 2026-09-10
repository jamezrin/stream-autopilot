import { describe, expect, it, vi } from "vitest";
import type { DiagnosticEvent } from "@lurkloot/shared/events";
import type { ChannelCandidate } from "@lurkloot/shared/models";
import { PendingDiscoverySignalDiagnostics } from "@lurkloot/core/discoverySignals";
import type { DiscoverySignalController, DiscoverySignalTarget } from "@lurkloot/core/discoverySignals";
import type { WebSocketLike, WebSocketMessageEventLike } from "@lurkloot/core/webSocket";
import { buildMinuteWatchedEvent, buildSpadeInput, gzipBase64 } from "@lurkloot/core/twitch/watch";
import { createTwitchGqlTransport } from "@lurkloot/core/twitch";
import { createKickFetcher } from "@lurkloot/core/kick";
import { KickWatcher } from "@lurkloot/core/kick/watch";
import { PendingWatcherDiagnostics } from "@lurkloot/core/tablessWatch";
import { kickAdapter, twitchAdapter } from "./helpers/adapters";
import { testCompatibility } from "./helpers/compatibility";

const TWITCH_COMPAT = testCompatibility().twitch;

const discoveryContractFixture = (
  controller: DiscoverySignalController,
  target: DiscoverySignalTarget,
): Promise<void> => controller.start(target, () => undefined);

void discoveryContractFixture;

describe("discovery signal diagnostics", () => {
  it("retains the newest 250 pending diagnostics", () => {
    const diagnostics = new PendingDiscoverySignalDiagnostics();
    for (let index = 0; index < 260; index += 1) {
      diagnostics.push({ category: "diagnostic", platform: "kick", level: "debug", message: `signal-${index}` });
    }

    const drained = diagnostics.drain();

    expect(drained).toHaveLength(250);
    expect(drained[0]?.message).toBe("signal-10");
    expect(drained.at(-1)?.message).toBe("signal-259");
  });

  it("empties pending diagnostics when drained", () => {
    const diagnostics = new PendingDiscoverySignalDiagnostics();
    diagnostics.push({ category: "diagnostic", platform: "kick", level: "debug", message: "signal" });

    expect(diagnostics.drain()).toEqual([
      { category: "diagnostic", platform: "kick", level: "debug", message: "signal" },
    ]);
    expect(diagnostics.drain()).toEqual([]);
  });
});

async function gunzipBase64(b64: string): Promise<string> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

describe("twitch minute-watched payload", () => {
  it("builds a single minute-watched event with the expected properties", () => {
    const [event] = buildMinuteWatchedEvent({
      broadcastId: "111",
      channelId: "222",
      channelLogin: "creator",
      userId: "333",
      gameId: "444",
      gameName: "Some Game",
      clientTime: "2026-06-02T00:00:00.000Z",
    });

    expect(event.event).toBe("minute-watched");
    expect(event.properties).toMatchObject({
      broadcast_id: "111",
      channel_id: "222",
      channel: "creator",
      user_id: "333",
      game: "Some Game",
      game_id: "444",
      live: true,
      logged_in: true,
      muted: false,
      hidden: false,
      minutes_logged: 1,
      client_time: "2026-06-02T00:00:00.000Z",
    });
  });

  it("gzip+base64 round-trips through the spade input encoding", async () => {
    const input = await buildSpadeInput({
      broadcastId: "111",
      channelId: "222",
      channelLogin: "creator",
      userId: "333",
    });

    expect(input.repository).toBe("twilight");
    expect(input.encoding).toBe("GZIP_B64");

    const decoded = JSON.parse(await gunzipBase64(input.data));
    expect(decoded[0].event).toBe("minute-watched");
    expect(decoded[0].properties.channel).toBe("creator");
  });

  it("gzipBase64 decompresses back to the original string", async () => {
    const original = JSON.stringify({ hello: "world", n: 42 });
    expect(await gunzipBase64(await gzipBase64(original))).toBe(original);
  });
});

class FakeSocket implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  private readonly listeners: Record<string, Array<(event: WebSocketMessageEventLike) => void>> = {};

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: WebSocketMessageEventLike) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  emit(type: "open" | "message" | "close" | "error"): void {
    (this.listeners[type] ?? []).forEach((listener) => listener({}));
  }

  parsed(): Array<Record<string, unknown>> {
    return this.sent.map((value) => JSON.parse(value));
  }
}

class AsyncCloseSocket extends FakeSocket {
  override close(): void {
    super.close();
    queueMicrotask(() => this.emit("close"));
  }
}

const kickChannel: ChannelCandidate = {
  platform: "kick",
  username: "creator",
  url: "https://kick.com/creator",
};

describe("kick viewer watcher", () => {
  it("routes later adapter-created watcher fetch diagnostics through its pending queue", async () => {
    const socket = new FakeSocket();
    const creationEvents: DiagnosticEvent[] = [];
    const background = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) return { id: 123, livestream: { id: 456, is_live: true } };
      if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } };
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = kickAdapter(
      createKickFetcher({ background, pageFetch: async () => { throw new Error("page fallback not expected"); } }),
      undefined,
      () => socket,
      (event) => creationEvents.push(event as DiagnosticEvent),
    );
    const watcher = adapter.createTablessWatcher?.();
    expect(watcher).toBeDefined();

    await watcher?.start({ ...kickChannel, categoryId: "10" }, {});
    watcher?.drainEvents();
    socket.emit("open");
    watcher?.drainEvents();
    socket.emit("close");
    await watcher?.tick({});

    const reconnectEvents = watcher?.drainEvents() ?? [];
    const refreshFetches = reconnectEvents.filter((event) => event.code === "kick_fetch_summary");
    expect(refreshFetches).toHaveLength(1);
    expect(refreshFetches[0].data).toEqual({ "kick.com.background": 1, "websockets.kick.com.background": 1 });
    expect(reconnectEvents).toContainEqual(expect.objectContaining({ message: "Kick viewer connection closed for creator" }));
    expect(creationEvents.filter((event) => event.message.includes("Kick fetch kick.com"))).toEqual([]);
    await watcher?.stop();
  });

  it("opens the viewer socket and sends a watch event on connect", async () => {
    const socket = new FakeSocket();
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) return { id: 123, livestream: { id: 456, is_live: true } } as unknown;
      if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as unknown;
      throw new Error(`unexpected url ${url}`);
    });

    const watcher = new KickWatcher({
      fetcher: { fetchJson: fetchJson as never },
      createWebSocket: () => socket,
      now: () => 1000,
    });

    await watcher.start(kickChannel, {});
    socket.emit("open");

    const watchEvent = socket.parsed().find((message) => message.type === "user_event");
    expect(watchEvent).toBeDefined();
    expect((watchEvent?.data as { message?: Record<string, unknown> })?.message).toMatchObject({
      name: "tracking.user.watch.livestream",
      channel_id: 123,
      livestream_id: 456,
    });
    expect(socket.parsed().some((message) => message.type === "channel_handshake")).toBe(true);

    await expect(watcher.tick({})).resolves.toMatchObject({ ok: true, live: true });
    await watcher.stop();
  });

  it("surfaces a one-shot info line when tabless farming becomes active", async () => {
    const socket = new FakeSocket();
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) return { id: 123, livestream: { id: 456, is_live: true } } as unknown;
      if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as unknown;
      throw new Error(`unexpected url ${url}`);
    });

    const watcher = new KickWatcher({
      fetcher: { fetchJson: fetchJson as never },
      createWebSocket: () => socket,
      now: () => 1000,
    });

    await watcher.start(kickChannel, {});
    watcher.drainEvents();
    socket.emit("open");

    // Exactly one info-level "farming active" line so launch-day verification is
    // legible without the verbose/debug filter.
    const active = watcher.drainEvents().filter((entry) => entry.level === "info" && /farming active/i.test(entry.message));
    expect(active).toHaveLength(1);
    expect(watcher.drainEvents()).toEqual([]);
    await watcher.stop();
  });

  it("queues callback diagnostics for one causal drain", async () => {
    const socket = new FakeSocket();
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) return { id: 123, livestream: { id: 456, is_live: true } } as unknown;
      if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as unknown;
      throw new Error(`unexpected url ${url}`);
    });
    const watcher = new KickWatcher({
      fetcher: { fetchJson: fetchJson as never },
      createWebSocket: () => socket,
      now: () => 1000,
    });

    await watcher.start(kickChannel, {});
    watcher.drainEvents();
    socket.emit("open");
    const callbackEvents = watcher.drainEvents();

    expect(callbackEvents.map((event) => event.message)).toEqual([
      "Kick tabless farming active for creator — sending watch events every 60s",
      "Kick tabless viewer connected for creator",
    ]);
    expect(watcher.drainEvents()).toEqual([]);

    await watcher.stop();
  });

  it("caps pending diagnostics at 250 while preserving the newest causal order", () => {
    const diagnostics = new PendingWatcherDiagnostics();
    for (let index = 0; index < 260; index += 1) {
      diagnostics.push({ category: "diagnostic", platform: "kick", level: "debug", message: `event-${index}` });
    }

    const drained = diagnostics.drain();
    expect(drained).toHaveLength(250);
    expect(drained[0]?.message).toBe("event-10");
    expect(drained.at(-1)?.message).toBe("event-259");
    expect(diagnostics.drain()).toEqual([]);
  });

  it("does not strand an expected close diagnostic after intentional stop", async () => {
    const socket = new AsyncCloseSocket();
    const adapter = kickAdapter(
      {
        fetchJson: vi.fn(async (url: string) => {
          if (url.includes("/api/v2/channels/")) return { id: 123, livestream: { id: 456, is_live: true } } as never;
          if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as never;
          throw new Error(`unexpected url ${url}`);
        }),
      },
      undefined,
      () => socket,
    );
    const watcher = adapter.createTablessWatcher?.();

    await watcher?.start(kickChannel, {});
    watcher?.drainEvents();
    socket.emit("open");
    watcher?.drainEvents();
    await watcher?.stop();
    await Promise.resolve();

    expect(watcher?.drainEvents()).toEqual([]);
  });

  it("ignores stale callbacks from a replaced socket", async () => {
    const oldSocket = new FakeSocket();
    const replacementSocket = new FakeSocket();
    const sockets = [oldSocket, replacementSocket];
    const fetchJson = vi.fn(async (url: string) => {
      const username = decodeURIComponent(url.split("/").at(-1) ?? "");
      if (url.includes("/api/v2/channels/")) {
        return { id: username === "next" ? 2 : 1, livestream: { id: username === "next" ? 22 : 11, is_live: true } } as never;
      }
      if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as never;
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = kickAdapter(
      { fetchJson },
      undefined,
      () => sockets.shift()!,
    );
    const watcher = adapter.createTablessWatcher?.();

    await watcher?.start(kickChannel, {});
    oldSocket.emit("open");
    watcher?.drainEvents();
    await watcher?.start({ ...kickChannel, username: "next", url: "https://kick.com/next" }, {});
    replacementSocket.emit("open");
    watcher?.drainEvents();

    oldSocket.emit("close");
    oldSocket.emit("open");
    oldSocket.emit("error");

    await expect(watcher?.tick({})).resolves.toMatchObject({ ok: true, live: true });
    expect(watcher?.drainEvents()).toEqual([]);
    await watcher?.stop();
  });

  it("reports unhealthy when the viewer token cannot be obtained", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) return { id: 1, livestream: { id: 2, is_live: true } } as unknown;
      if (url.includes("/viewer/v1/token")) return { data: {} } as unknown;
      throw new Error(`unexpected url ${url}`);
    });

    const watcher = new KickWatcher({
      fetcher: { fetchJson: fetchJson as never },
      createWebSocket: () => new FakeSocket(),
    });

    await watcher.start(kickChannel, {});
    await expect(watcher.tick({})).resolves.toMatchObject({ ok: false });
    await watcher.stop();
  });

  it("logs a warning when the viewer WebSocket errors", async () => {
    const socket = new FakeSocket();
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) return { id: 1, livestream: { id: 2, is_live: true } } as unknown;
      if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as unknown;
      throw new Error(`unexpected url ${url}`);
    });

    const watcher = new KickWatcher({
      fetcher: { fetchJson: fetchJson as never },
      createWebSocket: () => socket,
    });

    await watcher.start(kickChannel, {});
    socket.emit("open");
    socket.emit("error");

    expect(watcher.drainEvents().some((entry) => entry.level === "warn" && /WebSocket error/.test(entry.message))).toBe(true);
    await expect(watcher.tick({})).resolves.toMatchObject({ ok: false });
    await watcher.stop();
  });

  it("treats an offline channel as not earning without opening a socket", async () => {
    const createWebSocket = vi.fn(() => new FakeSocket());
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) return { id: 1, livestream: null } as unknown;
      throw new Error(`unexpected url ${url}`);
    });

    const watcher = new KickWatcher({
      fetcher: { fetchJson: fetchJson as never },
      createWebSocket,
    });

    await watcher.start(kickChannel, {});
    expect(createWebSocket).not.toHaveBeenCalled();
    await expect(watcher.tick({})).resolves.toMatchObject({ ok: false, live: false });
    await watcher.stop();
  });

  it("reports unhealthy when a connected Kick stream goes offline", async () => {
    let now = 1000;
    const socket = new FakeSocket();
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) {
        return fetchJson.mock.calls.filter(([calledUrl]) => String(calledUrl).includes("/api/v2/channels/")).length === 1
          ? { id: 1, livestream: { id: 2, is_live: true, categories: [{ id: 10 }] } } as unknown
          : { id: 1, livestream: null } as unknown;
      }
      if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as unknown;
      throw new Error(`unexpected url ${url}`);
    });

    const watcher = new KickWatcher({
      fetcher: { fetchJson: fetchJson as never },
      createWebSocket: () => socket,
      now: () => now,
    });

    await watcher.start({ ...kickChannel, categoryId: "10" }, {});
    socket.emit("open");
    await expect(watcher.tick({})).resolves.toMatchObject({ ok: true, live: true });

    now += 61_000;
    await expect(watcher.tick({})).resolves.toMatchObject({ ok: false, live: false });
    await watcher.stop();
  });

  it("reports unhealthy when a connected Kick stream changes category", async () => {
    let now = 1000;
    const socket = new FakeSocket();
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) {
        return fetchJson.mock.calls.filter(([calledUrl]) => String(calledUrl).includes("/api/v2/channels/")).length === 1
          ? { id: 1, livestream: { id: 2, is_live: true, categories: [{ id: 10 }] } } as unknown
          : { id: 1, livestream: { id: 2, is_live: true, categories: [{ id: 20 }] } } as unknown;
      }
      if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as unknown;
      throw new Error(`unexpected url ${url}`);
    });

    const watcher = new KickWatcher({
      fetcher: { fetchJson: fetchJson as never },
      createWebSocket: () => socket,
      now: () => now,
    });

    await watcher.start({ ...kickChannel, categoryId: "10" }, {});
    socket.emit("open");

    now += 61_000;
    await expect(watcher.tick({})).resolves.toMatchObject({
      ok: false,
      live: true,
      message: "Kick channel category no longer matches",
    });
    await watcher.stop();
  });

  it("refreshes the Kick livestream id while connected", async () => {
    let now = 1000;
    const socket = new FakeSocket();
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) {
        return fetchJson.mock.calls.filter(([calledUrl]) => String(calledUrl).includes("/api/v2/channels/")).length === 1
          ? { id: 1, livestream: { id: 2, is_live: true, categories: [{ id: 10 }] } } as unknown
          : { id: 1, livestream: { id: 3, is_live: true, categories: [{ id: 10 }] } } as unknown;
      }
      if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as unknown;
      throw new Error(`unexpected url ${url}`);
    });

    const watcher = new KickWatcher({
      fetcher: { fetchJson: fetchJson as never },
      createWebSocket: () => socket,
      now: () => now,
    });

    await watcher.start({ ...kickChannel, categoryId: "10" }, {});
    socket.emit("open");

    now += 61_000;
    await expect(watcher.tick({})).resolves.toMatchObject({ ok: true, live: true });

    const watchEvents = socket.parsed().filter((message) => message.type === "user_event");
    expect(watchEvents).toHaveLength(2);
    expect((watchEvents[1].data as { message?: Record<string, unknown> }).message).toMatchObject({
      livestream_id: 3,
    });
    await watcher.stop();
  });
});

describe("adapter-created twitch watcher diagnostics", () => {
  it("builds a reporter-neutral GQL transport from fetcher and identity values", async () => {
    const events: DiagnosticEvent[] = [];
    let calls = 0;
    const fetchJson = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      expect(new Headers(init?.headers).get("client-id")).toBe("neutral-client");
      if (calls === 1) return { errors: [{ message: "service unavailable" }] };
      return { data: { user: { id: "channel-id" } } };
    });
    const transport = createTwitchGqlTransport(
      { fetchJson: fetchJson as never },
      { clientId: "neutral-client", userAgent: "neutral-agent", compatibility: TWITCH_COMPAT },
    );

    await transport("StreamInfo", "hash", { channel: "creator" }, "query StreamInfo { user { id } }", "omit", (event) => {
      if (event.category === "diagnostic") events.push(event);
    });

    expect(events).toEqual([
      expect.objectContaining({ message: "GQL StreamInfo returned a transient error; retrying once" }),
    ]);
  });

  it("routes a later transient GQL retry through the watcher queue", async () => {
    const creationEvents: DiagnosticEvent[] = [];
    let streamCalls = 0;
    const fetchJson = vi.fn(async (_url: string, init?: RequestInit) => {
      const operationName = JSON.parse(String(init?.body)).operationName;
      if (operationName === "StreamInfo") {
        streamCalls += 1;
        if (streamCalls === 1) return { errors: [{ message: "service unavailable" }] };
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game", name: "Game" } } } } };
      }
      if (operationName === "SendEvents") return { data: { sendSpadeEvents: { statusCode: 204 } } };
      throw new Error(`unexpected operation ${operationName}`);
    });
    // GQL-v1 heartbeat: it sends minute-watched via the SendEvents GQL mutation
    // mocked below, unlike the recommended Spade profile (a separate page-fetch
    // transport this fixture does not wire up).
    const adapter = twitchAdapter(
      { fetchJson: fetchJson as never },
      undefined,
      undefined,
      { compatibility: { ...TWITCH_COMPAT, heartbeat: "twitch-heartbeat-gql-v1" } },
      (event) => creationEvents.push(event as DiagnosticEvent),
    );
    const watcher = adapter.createTablessWatcher?.();

    await watcher?.start({ platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" }, { userId: "viewer-id" });
    await watcher?.tick({ userId: "viewer-id" });

    expect(watcher?.drainEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "GQL StreamInfo returned a transient error; retrying once" }),
    ]));
    expect(creationEvents.filter((event) => event.message.includes("GQL StreamInfo returned a transient error"))).toEqual([]);
  });

  // The watcher resolves its own viewer id when discovery did not supply one.
  // That CurrentUser read is authenticated, so an integrity rejection must be
  // recoverable — while the anonymous StreamInfo and the heartbeat telemetry
  // around it stay out of integrity recovery entirely.
  it("recovers its authenticated CurrentUser fallback from an integrity rejection", async () => {
    let currentUserCalls = 0;
    let sendEventsCalls = 0;
    const fetchJson = vi.fn(async (_url: string, init?: RequestInit) => {
      const operationName = JSON.parse(String(init?.body)).operationName;
      if (operationName === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game", name: "Game" } } } } };
      }
      if (operationName === "CurrentUser") {
        currentUserCalls += 1;
        if (currentUserCalls === 1) return { error: "failed integrity check" };
        return { data: { currentUser: { id: "viewer-id" } } };
      }
      if (operationName === "SendEvents") {
        sendEventsCalls += 1;
        return { data: { sendSpadeEvents: { statusCode: 204 } } };
      }
      throw new Error(`unexpected operation ${operationName}`);
    });
    const ensureIntegrity = vi.fn(async (request?: { forceRefresh?: boolean }) => request?.forceRefresh === true);
    // GQL-v1 heartbeat: it sends minute-watched via the SendEvents GQL mutation
    // mocked below, unlike the recommended Spade profile (a separate page-fetch
    // transport this fixture does not wire up).
    const adapter = twitchAdapter(
      { fetchJson: fetchJson as never },
      ensureIntegrity,
      undefined,
      { compatibility: { ...TWITCH_COMPAT, heartbeat: "twitch-heartbeat-gql-v1" } },
    );
    const watcher = adapter.createTablessWatcher?.();

    // No userId in the context, so the watcher must resolve it itself.
    await watcher?.start({ platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" }, {});
    const result = await watcher?.tick({});

    expect(result).toMatchObject({ ok: true });
    expect(currentUserCalls).toBe(2);
    expect(ensureIntegrity).toHaveBeenCalledOnce();
    expect(ensureIntegrity).toHaveBeenCalledWith(expect.objectContaining({
      forceRefresh: true,
      reason: "rejection_recovery",
    }));
    // The heartbeat itself is never replayed by integrity recovery.
    expect(sendEventsCalls).toBe(1);
  });
});
