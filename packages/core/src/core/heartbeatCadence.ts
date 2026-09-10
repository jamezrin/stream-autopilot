import type { TablessHeartbeatCadence, WatchSession } from "@lurkloot/shared/models";

export const HEARTBEAT_INTERVAL_MS = 60_000;

export function nextHeartbeatDueAt(previousDueAt: number, attemptAt: number): number {
  const elapsed = Math.max(0, attemptAt - previousDueAt);
  return previousDueAt
    + (Math.floor(elapsed / HEARTBEAT_INTERVAL_MS) + 1) * HEARTBEAT_INTERVAL_MS;
}

export function heartbeatContextKey(session: WatchSession): string | undefined {
  const channel = session.channel;
  if (session.watchMode !== "tabless" || !channel || !session.campaignId || !session.rewardId) return undefined;
  return JSON.stringify([
    session.platform,
    channel.url,
    channel.username,
    channel.broadcastId ?? "",
    channel.channelId ?? "",
    channel.categoryId ?? "",
    session.campaignId,
    session.rewardId,
  ]);
}

export function validHeartbeatGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function validTablessHeartbeatCadence(
  session: WatchSession,
): TablessHeartbeatCadence | undefined {
  const cadence = session.tablessHeartbeat as Partial<TablessHeartbeatCadence> | null | undefined;
  const contextKey = heartbeatContextKey(session);
  if (
    !cadence
    || !contextKey
    || !validHeartbeatGeneration(cadence.generation)
    || typeof cadence.contextKey !== "string"
    || cadence.contextKey.length === 0
    || cadence.contextKey !== contextKey
    || typeof cadence.nextDueAt !== "string"
    || !Number.isFinite(Date.parse(cadence.nextDueAt))
  ) {
    return undefined;
  }
  return cadence as TablessHeartbeatCadence;
}

export function nextHeartbeatGeneration(...candidates: unknown[]): number {
  let highWater = 0;
  for (const candidate of candidates) {
    if (validHeartbeatGeneration(candidate)) highWater = Math.max(highWater, candidate);
  }
  return highWater < Number.MAX_SAFE_INTEGER ? highWater + 1 : highWater;
}
