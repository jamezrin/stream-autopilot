import { describe, expect, it } from "vitest";
import { createKickFetcher, KickDiscoveryState } from "@lurkloot/core/kick";
import { KickWafBlockedError } from "@lurkloot/core/tabs";
import type { DiagnosticEvent, EngineEvent } from "@lurkloot/shared/events";

function diagnostics(events: EngineEvent[]): DiagnosticEvent[] {
  return events.filter((event): event is DiagnosticEvent => event.category === "diagnostic");
}

describe("Kick route diagnostics", () => {
  it("bounds eleven hours of reconstructed adapters by operations, not request count", async () => {
    const state = new KickDiscoveryState();
    const events: EngineEvent[] = [];
    const emit = (event: EngineEvent) => events.push(event);
    for (let tick = 0; tick < 660; tick += 1) {
      const fetcher = createKickFetcher({
        background: async () => ({}),
        pageFetch: async () => ({}),
        routeState: state.routeDiagnostics,
      });
      for (let request = 0; request < 100; request += 1) {
        await fetcher.fetchJson(`https://${request < 90 ? "kick.com" : "web.kick.com"}/private/${request}?secret=value`, undefined, emit);
      }
      fetcher.flushRouteDiagnostics?.(emit);
      fetcher.flushRouteDiagnostics?.(emit);
    }
    const output = diagnostics(events);
    expect(output.filter((event) => event.level === "info")).toHaveLength(2);
    expect(output.filter((event) => event.code === "kick_fetch_summary")).toHaveLength(660);
    expect(output).toHaveLength(662);
    expect(output.at(-1)?.data).toEqual({
      "kick.com.background": 90,
      "web.kick.com.background": 10,
    });
  });

  it("keeps fallback and recovery transitions across reconstruction with exact success totals", async () => {
    const state = new KickDiscoveryState();
    const events: EngineEvent[] = [];
    const emit = (event: EngineEvent) => events.push(event);
    let fallback = false;
    for (const page of [false, true, true, false]) {
      fallback = page;
      const fetcher = createKickFetcher({
        background: async () => {
          if (fallback) throw new KickWafBlockedError("secret error");
          return {};
        },
        pageFetch: async () => ({}),
        routeState: state.routeDiagnostics,
      });
      for (let request = 0; request < 20; request += 1) {
        await fetcher.fetchJson("https://kick.com/private?secret=value", undefined, emit);
      }
      fetcher.flushRouteDiagnostics?.(emit);
    }
    const output = diagnostics(events);
    expect(output.filter((event) => event.level === "info")).toHaveLength(3);
    expect(output.filter((event) => event.code === "kick_fetch_summary").map((event) => event.data)).toEqual([
      { "kick.com.background": 20 }, { "kick.com.page": 20 },
      { "kick.com.page": 20 }, { "kick.com.background": 20 },
    ]);
    expect(output.filter((event) => event.level === "info").at(-1)?.message).toContain("recovered");
  });

  it("reports lifecycle failures individually and never counts failed page execution as success", async () => {
    const events: EngineEvent[] = [];
    const emit = (event: EngineEvent) => events.push(event);
    let failedPage = false;
    const fetcher = createKickFetcher({
      background: async () => { throw new Error("secret background"); },
      pageFetch: async () => {
        if (failedPage) throw new Error("secret page");
        return {};
      },
      onPageFallback: () => { throw new Error("secret lifecycle"); },
    });
    await fetcher.fetchJson("https://kick.com/private", undefined, emit);
    failedPage = true;
    await expect(fetcher.fetchJson("https://kick.com/private", undefined, emit)).rejects.toThrow("secret page");
    fetcher.flushRouteDiagnostics?.(emit);
    const output = diagnostics(events);
    expect(output.filter((event) => event.message.includes("lifecycle update failed"))).toHaveLength(2);
    expect(output.find((event) => event.code === "kick_fetch_summary")?.data).toEqual({ "kick.com.page": 1 });
    expect(JSON.stringify(output)).not.toContain("secret");
  });

  it("does not flush a partial observation while any fetch or lifecycle callback is active", async () => {
    const events: EngineEvent[] = [];
    const emit = (event: EngineEvent) => events.push(event);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    let delayed = false;
    const fetcher = createKickFetcher({
      background: async () => ({}),
      pageFetch: async () => ({}),
      onBackgroundSuccess: async () => { if (delayed) await pending; },
    });
    await fetcher.fetchJson("https://kick.com/a", undefined, emit);
    delayed = true;
    const request = fetcher.fetchJson("https://web.kick.com/b", undefined, emit);
    await Promise.resolve();
    fetcher.flushRouteDiagnostics?.(emit);
    expect(diagnostics(events).filter((event) => event.code === "kick_fetch_summary")).toHaveLength(0);
    finish();
    await request;
    fetcher.flushRouteDiagnostics?.(emit);
    expect(diagnostics(events).filter((event) => event.code === "kick_fetch_summary").map((event) => event.data))
      .toEqual([{ "kick.com.background": 1, "web.kick.com.background": 1 }]);
  });

  it("uses fixed safe host buckets even for arbitrary hosts and malformed URLs", async () => {
    const events: EngineEvent[] = [];
    const emit = (event: EngineEvent) => events.push(event);
    const fetcher = createKickFetcher({ background: async () => ({ secret: "payload" }), pageFetch: async () => ({}) });
    for (const url of ["https://user:password@kick.com/private?token=secret", "https://secret.example/private", "secret-malformed", "https://web.kick.com:8443/private"]) {
      await fetcher.fetchJson(url, { headers: { Authorization: "Bearer secret" }, body: "secret" }, emit);
    }
    fetcher.flushRouteDiagnostics?.(emit);
    const output = diagnostics(events);
    expect(output.find((event) => event.code === "kick_fetch_summary")?.data).toEqual({
      "kick.com.background": 1, "unknown-host.background": 3,
    });
    expect(JSON.stringify(output)).not.toMatch(/secret|private|password|Authorization|payload|8443/);
  });
});
