const DAY_MS = 24 * 60 * 60 * 1000;

// Pure trigger predicate, kept dependency-free so it can be unit-tested without
// pulling in the React component tree. Shows the nudge only while pending and
// once the extension has been installed for at least `minDays`. A missing or
// unparseable `installedAt` keeps it hidden.
export function shouldShowRateNudge(
  installedAt: string | undefined,
  status: string,
  now: Date,
  minDays: number,
): boolean {
  if (status !== "pending" || !installedAt) return false;
  const installedMs = Date.parse(installedAt);
  if (Number.isNaN(installedMs)) return false;
  return now.getTime() - installedMs >= minDays * DAY_MS;
}

export function shouldShowGithubStarNudge(
  installedAt: string | undefined,
  status: string,
  now: Date,
  minDays: number,
): boolean {
  return shouldShowRateNudge(installedAt, status, now, minDays);
}
