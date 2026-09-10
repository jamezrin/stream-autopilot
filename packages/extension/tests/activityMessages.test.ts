import { describe, expect, it, vi } from "vitest";
import type { ActivityHistoryRecord, EngineEvent } from "@lurkloot/shared/events";
import {
  createActivityEventReporter,
  createActivityMessageHandler,
  createRuntimeMessageDispatcher,
} from "../src/core/activityMessages";

describe("activity message routing", () => {
  it("handles history messages through the extension repository", async () => {
    const page = { events: [], nextCursor: undefined };
    const load = vi.fn(async () => page);
    const exportDiagnostics = vi.fn();
    const clear = vi.fn(async () => undefined);
    const handler = createActivityMessageHandler({ load, exportDiagnostics, clear });

    await expect(handler({ type: "getActivity", category: "activity", platform: "twitch", limit: 80 }))
      .resolves.toBe(page);
    await expect(handler({ type: "clearActivity" })).resolves.toBeUndefined();

    expect(load).toHaveBeenCalledWith({ category: "activity", platform: "twitch", limit: 80 });
    expect(clear).toHaveBeenCalledOnce();
  });

  it("returns undefined without using the repository for non-activity messages", async () => {
    const load = vi.fn();
    const exportDiagnostics = vi.fn();
    const clear = vi.fn();
    const handler = createActivityMessageHandler({ load, exportDiagnostics, clear });

    await expect(handler({ type: "getSnapshot" })).resolves.toBeUndefined();

    expect(load).not.toHaveBeenCalled();
    expect(exportDiagnostics).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("exports diagnostics through the extension repository", async () => {
    const events: ActivityHistoryRecord[] = [
      { id: "d1", at: "2026-08-16T00:00:00.000Z", category: "diagnostic", level: "info", message: "hello" },
    ];
    const exportDiagnostics = vi.fn(async () => events);
    const handler = createActivityMessageHandler({
      load: vi.fn(),
      clear: vi.fn(),
      exportDiagnostics,
    });

    await expect(handler({ type: "exportDiagnostics", platform: "kick" }))
      .resolves.toEqual({ events });
    expect(exportDiagnostics).toHaveBeenCalledWith("kick");
  });
});

describe("activity event reporting", () => {
  const activity: EngineEvent = {
    category: "activity",
    code: "interruption",
    level: "warn",
    data: { reason: "runtime_restart" },
  };
  const diagnostic: EngineEvent = {
    category: "diagnostic",
    level: "debug",
    message: "detail",
  };

  it("always persists activity and omits diagnostics when logging is disabled", async () => {
    const append = vi.fn(async () => undefined);
    const report = createActivityEventReporter({
      loadDiagnosticLogging: async () => false,
      append,
    });

    await report([diagnostic, activity]);

    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith([activity]);
  });

  it("persists one ordered batch when diagnostic logging is enabled", async () => {
    const append = vi.fn(async () => undefined);
    const report = createActivityEventReporter({
      loadDiagnosticLogging: async () => true,
      append,
    });

    await report([diagnostic, activity]);

    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith([diagnostic, activity]);
  });

  it("retains ordered activity when loading diagnostic logging fails", async () => {
    const laterActivity: EngineEvent = {
      category: "activity",
      code: "interruption",
      level: "error",
      data: { reason: "platform_error" },
    };
    const append = vi.fn(async () => undefined);
    const report = createActivityEventReporter({
      loadDiagnosticLogging: async () => { throw new Error("settings unavailable"); },
      append,
    });

    await expect(report([diagnostic, activity, diagnostic, laterActivity])).resolves.toBeUndefined();

    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith([activity, laterActivity]);
  });

  it("does not append a diagnostic-only batch when loading diagnostic logging fails", async () => {
    const append = vi.fn(async () => undefined);
    const report = createActivityEventReporter({
      loadDiagnosticLogging: async () => { throw new Error("settings unavailable"); },
      append,
    });

    await expect(report([diagnostic])).resolves.toBeUndefined();

    expect(append).not.toHaveBeenCalled();
  });
});

describe("runtime message dispatch", () => {
  function setup() {
    const exportCliCredentials = vi.fn(async () => "credentials");
    const resetExtension = vi.fn(async () => "reset");
    const handleActivityMessage = vi.fn(async () => "activity");
    const handleCoreMessage = vi.fn(async () => "core");
    return {
      exportCliCredentials,
      resetExtension,
      handleActivityMessage,
      handleCoreMessage,
      dispatch: createRuntimeMessageDispatcher({
        exportCliCredentials,
        resetExtension,
        handleActivityMessage,
        handleCoreMessage,
      }),
    };
  }

  it("routes credential export before every other handler", async () => {
    const env = setup();

    await expect(env.dispatch({ type: "exportCliCredentials" })).resolves.toBe("credentials");

    expect(env.exportCliCredentials).toHaveBeenCalledOnce();
    expect(env.handleActivityMessage).not.toHaveBeenCalled();
    expect(env.handleCoreMessage).not.toHaveBeenCalled();
  });

  it("routes factory reset to the extension coordinator", async () => {
    const env = setup();

    await expect(env.dispatch({ type: "resetExtension" })).resolves.toBe("reset");

    expect(env.resetExtension).toHaveBeenCalledOnce();
    expect(env.handleActivityMessage).not.toHaveBeenCalled();
    expect(env.handleCoreMessage).not.toHaveBeenCalled();
  });

  it.each([
    { type: "getActivity", category: "activity" } as const,
    { type: "exportDiagnostics", platform: "twitch" } as const,
    { type: "clearActivity" } as const,
  ])("routes $type without calling core", async (message) => {
    const env = setup();

    await expect(env.dispatch(message)).resolves.toBe("activity");

    expect(env.handleActivityMessage).toHaveBeenCalledOnce();
    expect(env.handleActivityMessage).toHaveBeenCalledWith(message);
    expect(env.handleCoreMessage).not.toHaveBeenCalled();
  });

  it("delegates a normal message to core exactly once", async () => {
    const env = setup();
    const message = { type: "getSnapshot" } as const;
    const sender = { tab: { id: 42, url: "https://www.twitch.tv/creator" } };

    await expect(env.dispatch(message, sender)).resolves.toBe("core");

    expect(env.exportCliCredentials).not.toHaveBeenCalled();
    expect(env.handleActivityMessage).not.toHaveBeenCalled();
    expect(env.handleCoreMessage).toHaveBeenCalledOnce();
    expect(env.handleCoreMessage).toHaveBeenCalledWith(message, sender);
  });
});
