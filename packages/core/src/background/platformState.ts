import type { Platform, SchedulerState } from "@lurkloot/shared/models";

function mergeOptionalEntry<T>(
  destination: Partial<Record<Platform, T>> | undefined,
  source: Partial<Record<Platform, T>> | undefined,
  platform: Platform,
): Partial<Record<Platform, T>> {
  const merged = { ...destination };
  const value = source?.[platform];
  if (value === undefined) delete merged[platform];
  else merged[platform] = value;
  return merged;
}

function newestTimestamp(
  destination: string | undefined,
  source: string | undefined,
): string | undefined {
  if (!destination) return source;
  if (!source) return destination;
  const destinationTime = Date.parse(destination);
  const sourceTime = Date.parse(source);
  if (!Number.isFinite(destinationTime)) return source;
  if (!Number.isFinite(sourceTime)) return destination;
  return sourceTime > destinationTime ? source : destination;
}

export function mergePlatformState(
  destination: SchedulerState,
  source: SchedulerState,
  platform: Platform,
): SchedulerState {
  return {
    ...destination,
    sessions: {
      ...destination.sessions,
      [platform]: source.sessions[platform],
    },
    authHealth: {
      ...destination.authHealth,
      [platform]: source.authHealth[platform],
    },
    campaigns: {
      ...destination.campaigns,
      [platform]: source.campaigns[platform],
    },
    criticalHealth: mergeOptionalEntry(
      destination.criticalHealth,
      source.criticalHealth,
      platform,
    ),
    managedWatchTabs: mergeOptionalEntry(
      destination.managedWatchTabs,
      source.managedWatchTabs,
      platform,
    ),
    managedPageContextTabs: mergeOptionalEntry(
      destination.managedPageContextTabs,
      source.managedPageContextTabs,
      platform,
    ),
    manualWatch: mergeOptionalEntry(
      destination.manualWatch,
      source.manualWatch,
      platform,
    ),
    manualClosePause: mergeOptionalEntry(
      destination.manualClosePause,
      source.manualClosePause,
      platform,
    ),
    gamification: mergeOptionalEntry(
      destination.gamification,
      source.gamification,
      platform,
    ),
    campaignSearchBackoffs: mergeOptionalEntry(
      destination.campaignSearchBackoffs,
      source.campaignSearchBackoffs,
      platform,
    ),
    deadlineInfeasibleRewardIds: mergeOptionalEntry(
      destination.deadlineInfeasibleRewardIds,
      source.deadlineInfeasibleRewardIds,
      platform,
    ),
    lastTickAt: newestTimestamp(destination.lastTickAt, source.lastTickAt),
  };
}
