import type { ChannelCandidate } from "@lurkloot/shared/models";
import { PendingWatcherDiagnostics, type HeartbeatResult, type TablessWatchController, type WatchContext } from "../../core/tablessWatch";
import type { WebSocketFactory, WebSocketLike } from "../../core/webSocket";
import type { PageFetcher } from "../adapter";

// Tabless Kick farming: a viewer WebSocket that advances drop timers with no
// video. Mirrors kickautodrops (references/kickautodrops/core/kick.py:255-436):
// exchange the session token for a viewer token, open the viewer socket, send a
// handshake/ping cadence, and emit a `tracking.user.watch.livestream` event
// every 60s. The constant client token is from kick.py:281.
export const KICK_CLIENT_TOKEN = "e1393935a959b4020a4491574f6490129f678acdaa92760471263db43487f823";

const HANDSHAKE_INTERVAL_MS = 13_000;
const WATCH_EVENT_INTERVAL_MS = 60_000;
const STREAM_TARGET_REFRESH_MS = 60_000;
// A heartbeat counts as healthy if a watch event was accepted recently; gives a
// little slack over the 60s send cadence before the scheduler reacts.
const HEALTH_WINDOW_MS = 2 * 60_000 + 30_000;
const WEBSOCKET_OPEN = 1;

interface KickChannelTargets {
  channelId: string;
  liveStreamId?: string;
  isLive: boolean;
  categoryId?: string;
}

export interface KickWatcherDeps {
  fetcher: PageFetcher;
  // Injectable for tests; defaults to the platform WebSocket. The socket is
  // opened from the background service worker — see the Origin caveat below.
  createWebSocket?: WebSocketFactory;
  now?: () => number;
}

// NOTE: the viewer socket is opened from the service worker, whose Origin is the
// extension, not https://kick.com. If Kick rejects the handshake on that basis
// the watcher reports unhealthy and the scheduler falls back to a real tab, so
// farming still works — it just is not tabless for Kick in that case.
export class KickWatcher implements TablessWatchController {
  readonly platform = "kick" as const;

  private channel?: ChannelCandidate;
  private targets?: KickChannelTargets;
  private ws?: WebSocketLike;
  private connected = false;
  private failed = false;
  private failureMessage?: string;
  private counter = 0;
  private lastWatchSentAt = 0;
  private lastTargetRefreshAt = 0;
  // Whether we have surfaced the one-shot "tabless farming active" info line for
  // the current connection. Reset on connect/stop so each session announces once.
  private watchAnnounced = false;
  private handshakeTimer?: ReturnType<typeof setInterval>;

  private readonly fetcher: PageFetcher;
  private readonly createWebSocket: WebSocketFactory;
  private readonly now: () => number;
  private readonly diagnostics = new PendingWatcherDiagnostics();
  private readonly intentionallyClosedSockets = new WeakSet<WebSocketLike>();

  constructor(deps: KickWatcherDeps) {
    this.fetcher = deps.fetcher;
    this.createWebSocket = deps.createWebSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.now = deps.now ?? (() => Date.now());
  }

  get channelUrl(): string | undefined {
    return this.channel?.url;
  }

  drainEvents() {
    // A watcher outlives its creating adapter/tick. Reconnect and target-refresh
    // counts belong to its own drained heartbeat operation.
    this.fetcher.flushRouteDiagnostics?.(this.diagnostics.emit);
    return this.diagnostics.drain();
  }

  private log(level: "info" | "warn" | "debug" | "error", message: string): void {
    this.diagnostics.push({ category: "diagnostic", platform: "kick", level, message });
  }

  async start(channel: ChannelCandidate, _context: WatchContext): Promise<void> {
    if (this.channel?.url === channel.url && (this.connected || this.ws)) return;
    await this.stop();
    this.channel = channel;
    this.failed = false;
    this.failureMessage = undefined;
    await this.connect();
  }

  async tick(_context: WatchContext): Promise<HeartbeatResult> {
    if (!this.channel) return { ok: false, message: "Kick tabless watcher has no channel" };
    // Reconnect if the socket dropped (e.g. the service worker slept between
    // ticks). A hard failure is left for the scheduler to fall back on.
    if (!this.connected && !this.failed) await this.connect();
    if (this.failed) {
      return { ok: false, live: this.targets?.isLive ?? true, message: this.failureMessage ?? "Kick viewer connection failed" };
    }
    if (!this.targets?.isLive) {
      return { ok: false, live: false, message: "Kick channel is offline" };
    }
    await this.refreshTargetsIfDue();
    if (!this.targets?.isLive) {
      return { ok: false, live: false, message: "Kick channel is offline" };
    }
    const expectedCategoryId = this.channel.categoryId;
    if (expectedCategoryId && this.targets.categoryId && this.targets.categoryId !== expectedCategoryId) {
      return { ok: false, live: true, message: "Kick channel category no longer matches" };
    }
    if (!this.targets.liveStreamId) {
      return { ok: false, live: true, message: "Kick channel is missing a livestream id" };
    }
    const healthy = this.connected && this.now() - this.lastWatchSentAt < HEALTH_WINDOW_MS;
    return { ok: healthy, live: true, message: healthy ? undefined : "Kick viewer connection idle" };
  }

  async stop(): Promise<void> {
    if (this.handshakeTimer) {
      clearInterval(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
    if (this.ws) {
      const ws = this.ws;
      this.intentionallyClosedSockets.add(ws);
      try {
        ws.close();
      } catch {
        // The socket may already be closing; nothing to do.
      }
      this.ws = undefined;
    }
    this.connected = false;
    this.counter = 0;
    this.lastWatchSentAt = 0;
    this.lastTargetRefreshAt = 0;
    this.watchAnnounced = false;
    this.targets = undefined;
  }

  private async connect(): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    this.log("debug", `Opening Kick viewer connection for ${channel.username}`);
    this.watchAnnounced = false;
    try {
      this.targets = await this.fetchTargets(channel);
      this.lastTargetRefreshAt = this.now();
      if (!this.targets.isLive) {
        // Offline: let the scheduler re-evaluate via live:false; not a failure.
        this.connected = false;
        this.log("debug", `Kick channel ${channel.username} is offline; skipping the viewer connection`);
        return;
      }
      const token = await this.fetchViewerToken();
      const ws = this.createWebSocket(`wss://websockets.kick.com/viewer/v1/connect?token=${encodeURIComponent(token)}`);
      this.ws = ws;
      ws.addEventListener("open", () => {
        if (ws !== this.ws) return;
        this.connected = true;
        this.sendHandshake();
        // Prime an immediate watch event so progress starts without a 60s wait.
        this.sendWatchEvent();
        this.startHandshakeTimer();
        this.log("info", `Kick tabless viewer connected for ${channel.username}`);
      });
      ws.addEventListener("close", () => {
        if (ws !== this.ws) {
          this.intentionallyClosedSockets.delete(ws);
          return;
        }
        if (this.intentionallyClosedSockets.delete(ws)) return;
        this.connected = false;
        this.log("debug", `Kick viewer connection closed for ${channel.username}`);
      });
      ws.addEventListener("error", () => {
        if (ws !== this.ws) return;
        this.connected = false;
        this.failed = true;
        this.failureMessage = "Kick viewer WebSocket error; falling back to a watch tab";
        this.log("warn", `${this.failureMessage} (${channel.username})`);
      });
    } catch (error) {
      this.failed = true;
      this.failureMessage = error instanceof Error ? error.message : "Kick viewer connection failed";
      this.log("warn", this.failureMessage);
    }
  }

  private startHandshakeTimer(): void {
    if (this.handshakeTimer) clearInterval(this.handshakeTimer);
    this.handshakeTimer = setInterval(() => {
      if (!this.connected) return;
      this.counter += 1;
      if (this.counter % 2 === 0) this.sendPing();
      else this.sendHandshake();
      if (this.now() - this.lastWatchSentAt >= WATCH_EVENT_INTERVAL_MS) this.sendWatchEvent();
    }, HANDSHAKE_INTERVAL_MS);
  }

  private sendPing(): void {
    this.safeSend({ type: "ping" });
  }

  private sendHandshake(): void {
    if (!this.targets) return;
    this.safeSend({
      type: "channel_handshake",
      data: { message: { channelId: numericOrString(this.targets.channelId) } },
    });
  }

  private sendWatchEvent(): void {
    if (!this.targets?.liveStreamId) return;
    this.safeSend({
      type: "user_event",
      data: {
        message: {
          name: "tracking.user.watch.livestream",
          channel_id: numericOrString(this.targets.channelId),
          livestream_id: numericOrString(this.targets.liveStreamId),
        },
      },
    });
    this.lastWatchSentAt = this.now();
    // Announce once per connection at info level so "tab-less farming is alive"
    // is visible without the verbose/debug filter; later sends stay debug.
    if (!this.watchAnnounced) {
      this.watchAnnounced = true;
      this.log("info", `Kick tabless farming active for ${this.channel?.username ?? "channel"} — sending watch events every 60s`);
    } else {
      this.log("debug", `Sent Kick watch event for ${this.channel?.username ?? "channel"} (livestream ${this.targets.liveStreamId})`);
    }
  }

  private async refreshTargetsIfDue(): Promise<void> {
    const channel = this.channel;
    if (!channel || this.now() - this.lastTargetRefreshAt < STREAM_TARGET_REFRESH_MS) return;
    const previousLiveStreamId = this.targets?.liveStreamId;
    this.targets = await this.fetchTargets(channel, { force: true });
    this.lastTargetRefreshAt = this.now();
    this.log("debug", `Refreshed Kick targets for ${channel.username} (live: ${this.targets.isLive}, category: ${this.targets.categoryId ?? "unknown"})`);
    if (
      this.targets.isLive
      && this.targets.liveStreamId
      && this.targets.liveStreamId !== previousLiveStreamId
      && this.connected
    ) {
      this.sendWatchEvent();
    }
  }

  private safeSend(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WEBSOCKET_OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (error) {
      this.connected = false;
      this.log("debug", `Kick viewer send failed; will reconnect: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async fetchViewerToken(): Promise<string> {
    this.log("debug", `Requesting a Kick viewer token for ${this.channel?.username ?? "channel"}`);
    const response = await this.fetcher.fetchJson<{ data?: { token?: string } }>(
      "https://websockets.kick.com/viewer/v1/token",
      { headers: { "X-Client-Token": KICK_CLIENT_TOKEN } },
      this.diagnostics.emit,
    );
    const token = response?.data?.token;
    if (!token) throw new Error("Kick did not return a viewer token; refresh your Kick login");
    return token;
  }

  private async fetchTargets(channel: ChannelCandidate, options: { force?: boolean } = {}): Promise<KickChannelTargets> {
    if (!options.force && channel.channelId && channel.broadcastId) {
      return {
        channelId: channel.channelId,
        liveStreamId: channel.broadcastId,
        isLive: true,
        categoryId: channel.categoryId,
      };
    }
    const data = await this.fetcher.fetchJson<{
      id?: string | number;
      livestream?: {
        id?: string | number;
        is_live?: boolean;
        category?: { id?: string | number };
        categories?: Array<{ id?: string | number }>;
      } | null;
    }>(`https://kick.com/api/v2/channels/${encodeURIComponent(channel.username)}`, undefined, this.diagnostics.emit);
    const channelId = data.id == null ? channel.channelId : String(data.id);
    if (!channelId) throw new Error(`Could not resolve the Kick channel id for ${channel.username}`);
    const category = data.livestream?.categories?.[0] ?? data.livestream?.category;
    return {
      channelId,
      liveStreamId: data.livestream?.id == null ? channel.broadcastId : String(data.livestream.id),
      categoryId: category?.id == null ? channel.categoryId : String(category.id),
      isLive: Boolean(data.livestream?.is_live ?? data.livestream),
    };
  }
}

// Kick's socket payloads use numeric ids; fall back to the raw string if a value
// is not cleanly numeric so we never send NaN.
function numericOrString(value: string): number | string {
  const numeric = Number(value);
  return Number.isFinite(numeric) && String(numeric) === value ? numeric : value;
}
