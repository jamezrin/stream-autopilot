import type { EventEmitter } from "@lurkloot/shared/events";

type KickRouteHost = "kick.com" | "web.kick.com" | "websockets.kick.com" | "unknown-host";
type KickRoute = "background" | "page";

export function safeKickRouteHost(url: string): KickRouteHost {
  try {
    const host = new URL(url).host;
    if (host === "kick.com" || host === "web.kick.com" || host === "websockets.kick.com") return host;
  } catch {
    // Invalid URLs and unexpected hosts share one bounded, non-sensitive bucket.
  }
  return "unknown-host";
}

// Host-owned, runtime-lifetime state. Reconstructing adapters must not announce
// an unchanged route as a transition. This contains no request or account data.
export class KickRouteState {
  private readonly routes = new Map<KickRouteHost, KickRoute>();

  report(emit: EventEmitter, host: KickRouteHost, route: KickRoute, detail: string): void {
    const previous = this.routes.get(host);
    if (previous === route) return;
    this.routes.set(host, route);
    emit({
      category: "diagnostic", platform: "kick", level: "info", code: "kick_fetch_route",
      message: `Kick fetch ${host} ${detail}${previous === "page" && route === "background" ? " (background route recovered)" : ""}`,
    });
  }
}

// One operation's counters, separate from page-context recovery observations.
// Flushing never consumes lifecycle evidence and never stores raw HTTP events.
export class KickRouteCounts {
  private counts = new Map<`${KickRouteHost}.${KickRoute}`, number>();

  record(host: KickRouteHost, route: KickRoute): void {
    const key = `${host}.${route}` as const;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  flush(emit: EventEmitter): void {
    if (this.counts.size === 0) return;
    const entries = [...this.counts].sort(([left], [right]) => left.localeCompare(right));
    this.counts = new Map();
    emit({
      category: "diagnostic", platform: "kick", level: "debug", code: "kick_fetch_summary",
      message: `Kick fetch success summary: ${entries.map(([key, count]) => `${key}=${count}`).join(", ")}`,
      data: Object.fromEntries(entries),
    });
  }
}
