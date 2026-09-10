import { useRef } from "react";
import type { KeyboardEvent } from "react";
import { motion } from "motion/react";
import { Eye, Gift, Play, Radio } from "lucide-react";
import type { Platform } from "@lurkloot/shared/models";
import type { AutomationPresentation } from "./automationStatus";
import { PLATFORMS } from "./constants";
import { usePopupRuntime, useT } from "./context";
import { formatViewers } from "./format";
import type { FarmingChannelView } from "./types";
import { Pill, Toggle, cn } from "./primitives";

// Both names in the status line open something — the channel its stream, the
// campaign its card — so both carry a standing underline rather than only
// revealing one on hover.
const LINK_CLASS = "truncate font-semibold text-zinc-800 underline decoration-dotted decoration-current/30 underline-offset-2 outline-none hover:text-[var(--accent-text)] hover:decoration-current focus-visible:text-[var(--accent-text)] dark:text-zinc-100";

/** Colour of the status dot for a platform's current automation state. Shared by
 * the platform tabs and the status line so both read the same at a glance. */
export function statusColor(presentation: AutomationPresentation, operationalColor: string): string | undefined {
  if (presentation.operational) return operationalColor;
  if (presentation.state === "blocked") return "#ef4444";
  if (presentation.state === "needs_sign_in" || presentation.state === "unavailable") return "#f59e0b";
  return undefined;
}

/** Platform picker where each half carries its own automation switch.
 *
 * Every tab is a cell, not a button: a full-area button behind the content
 * selects the platform, and the switch sits above it, so a switch can live
 * inside a tab without nesting one button in another. Each half then reads
 * name-left / control-right, the same rhythm as the status line under it, and
 * a platform can be turned on without first switching to it. */
export function PlatformBar({ active, presentation, enabled, pending, onChange, onToggle }: { active: Platform; presentation: Record<Platform, AutomationPresentation>; enabled: Record<Platform, boolean>; pending: Record<Platform, boolean>; onChange(platform: Platform): void; onToggle(platform: Platform, value: boolean): Promise<void> }) {
  const t = useT();
  const tabRefs = useRef<Partial<Record<Platform, HTMLButtonElement | null>>>({});
  const platformIds = Object.keys(PLATFORMS) as Platform[];

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, platform: Platform): void {
    const currentIndex = platformIds.indexOf(platform);
    if (currentIndex === -1) return;
    const nextIndex = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? (currentIndex + 1) % platformIds.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? (currentIndex - 1 + platformIds.length) % platformIds.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? platformIds.length - 1
            : -1;
    if (nextIndex === -1) return;
    event.preventDefault();
    const nextPlatform = platformIds[nextIndex];
    onChange(nextPlatform);
    tabRefs.current[nextPlatform]?.focus();
  }

  return (
    // The selected platform owns its span of the shared tab track; the accent
    // surface, border, and underline keep it visually distinct at a glance.
    <div role="tablist" aria-orientation="horizontal" className="mt-2 grid grid-cols-2 gap-3 border-b border-zinc-200 dark:border-zinc-800">
      {Object.entries(PLATFORMS).map(([key, platform]) => {
        const id = key as Platform;
        const selected = active === id;
        const status = presentation[id];
        const indicatorColor = statusColor(status, platform.color);
        return (
          <div
            key={id}
            data-platform-status={id}
            data-state={status.state}
            className={cn(
              "relative -mb-px flex min-w-0 items-center gap-1.5 rounded-t-md border px-2 pb-2 pt-1 transition-colors",
              selected
                ? "border-[var(--accent-ring)] border-b-[var(--accent-soft)] bg-[var(--accent-soft)] shadow-sm"
                : "border-transparent hover:bg-zinc-100/80 dark:hover:bg-zinc-800/60",
            )}
          >
            <button
              type="button"
              role="tab"
              onClick={() => onChange(id)}
              onKeyDown={(event) => handleTabKeyDown(event, id)}
              aria-selected={selected}
              aria-controls="popup-platform-panel"
              aria-label={platform.label}
              tabIndex={selected ? 0 : -1}
              ref={(element) => { tabRefs.current[id] = element; }}
              title={`${platform.label}: ${t(status.badgeKey)}`}
              className="absolute inset-0 z-[1] rounded outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
            />
            <span className={cn("pointer-events-none relative z-10 flex min-w-0 flex-1 items-center gap-1.5 text-[12px] font-semibold transition-colors", selected ? "text-zinc-900 dark:text-white" : "text-zinc-400 dark:text-zinc-500")}>
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-black transition-opacity" style={{ backgroundColor: selected ? platform.color : "transparent", color: selected ? (id === "kick" ? "#07140a" : "#fff") : platform.color, boxShadow: selected ? `0 0 12px -2px ${platform.color}` : undefined, opacity: selected ? 1 : 0.6 }}>
                {platform.mark}
              </span>
              <span className="truncate">{platform.label}</span>
              <span className="flex shrink-0 items-center" aria-hidden>
                {indicatorColor ? <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: indicatorColor, boxShadow: `0 0 6px ${indicatorColor}` }} /> : <span className="h-1.5 w-1.5 rounded-full border border-zinc-400 dark:border-zinc-500" />}
              </span>
            </span>
            <span className="relative z-10 shrink-0">
              <Toggle
                size="sm"
                color={platform.color}
                checked={enabled[id]}
                onChange={(value) => onToggle(id, value)}
                label={t("automationTitle", platform.label)}
                disabled={pending[id]}
              />
            </span>
            {selected && (
              <motion.span
                layoutId="platform-tab"
                transition={{ type: "spring", stiffness: 520, damping: 38 }}
                className="absolute inset-x-0 -bottom-px z-10 h-[2px] rounded-full"
                style={{ backgroundColor: platform.color, boxShadow: `0 0 8px -1px ${platform.color}` }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** What the automation is doing right now, on one line of popup chrome.
 *
 * The line height is fixed for every steady state (running/paused/checking/…) so
 * the five-second snapshot poll can never resize the header and shove the
 * campaign list under the pointer. Only the states carrying a call to action —
 * sign-in, blocked, unavailable, tab-closed — are allowed to grow, and there the
 * movement is the point. */
export function AutomationStatusLine({ platform, presentation, farmingTitle, farmingChannel, watchingIdleWatchlist = false, onFarmingTitleClick, onResume }: { platform: Platform; presentation: AutomationPresentation; farmingTitle?: string; farmingChannel?: FarmingChannelView; watchingIdleWatchlist?: boolean; onFarmingTitleClick?(): void; onResume?(): void }) {
  const t = useT();
  const runtime = usePopupRuntime();
  const action = presentation.action;
  const dotColor = statusColor(presentation, "var(--accent)") ?? "#a1a1aa";
  // States that carry a call to action, or a diagnosis too long to read in one
  // truncated line, get a second line. Everything the five-second poll actually
  // flaps between stays on the fixed single line.
  const roomy = Boolean(action) || presentation.state === "blocked" || presentation.state === "unavailable";
  const detail = presentation.detailKey ? t(presentation.detailKey) : undefined;

  return (
    <div data-automation-state={presentation.state} className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
      <div className={cn("flex gap-1.5", roomy ? "items-start" : "h-5 items-center")}>
        <span
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", roomy && "mt-1.5")}
          style={{ backgroundColor: dotColor, boxShadow: presentation.operational ? `0 0 6px ${dotColor}` : undefined }}
        />
        {presentation.state === "running" && farmingChannel ? (
          // Two groups, each labelled by a glyph so the numbers and names are not
          // bare: where it is watching (channel + eye/viewers) and what that earns
          // (gift/campaign). Both names are links, so both are underlined.
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <Radio size={11} className="shrink-0" style={{ color: "var(--accent-text)" }} />
            <span className="shrink-0">{t("watchingLabel")}</span>
            {/* The channel holds its width and the campaign absorbs the
                truncation: the campaign name is also spelled out in the list
                below, the channel is not written anywhere else. */}
            {farmingChannel.url ? (
              <a href={farmingChannel.url} target="_blank" rel="noreferrer" title={`${t("watchingLabel")} ${farmingChannel.name}`} className={cn(LINK_CLASS, "max-w-[7.5rem] shrink-0")}>{farmingChannel.name}</a>
            ) : (
              <span className="max-w-[7.5rem] shrink-0 truncate font-semibold text-zinc-800 dark:text-zinc-100">{farmingChannel.name}</span>
            )}
            {farmingChannel.viewers != null && (
              // The eye carries the meaning visually; role+label carries it to a
              // screen reader, which would otherwise hear a bare "18K".
              <span className="shrink-0" role="img" aria-label={t("viewerCount", formatViewers(farmingChannel.viewers))} title={t("viewerCount", formatViewers(farmingChannel.viewers))}>
                <Pill tone="muted"><Eye size={9} aria-hidden />{formatViewers(farmingChannel.viewers)}</Pill>
              </span>
            )}
            {farmingTitle && (
              <span className="ml-auto flex min-w-0 items-center gap-1 pl-1">
                <Gift size={11} className="shrink-0" aria-hidden style={{ color: "var(--accent-text)" }} />
                {onFarmingTitleClick ? (
                  <button type="button" onClick={onFarmingTitleClick} title={`${t("farmingLabel")} ${farmingTitle}`} className={cn(LINK_CLASS, "min-w-0 text-left")}>{farmingTitle}</button>
                ) : (
                  <span className="min-w-0 truncate font-semibold text-zinc-800 dark:text-zinc-100">{farmingTitle}</span>
                )}
              </span>
            )}
            {watchingIdleWatchlist && (
              <span className="ml-auto flex min-w-0 items-center gap-1 pl-1 text-zinc-700 dark:text-zinc-200">
                <Play size={11} className="shrink-0" aria-hidden style={{ color: "var(--accent-text)" }} />
                <span className="truncate font-semibold">{t("idleWatchlistTab")}</span>
              </span>
            )}
          </span>
        ) : presentation.state === "running" ? (
          <span className="truncate" title={t("waitingEligibleStream")}>{t("waitingEligibleStream")}</span>
        ) : (
          <span
            className={cn("min-w-0", roomy ? "line-clamp-2 leading-snug" : "truncate")}
            title={detail ? `${t(presentation.badgeKey)} · ${detail}` : t(presentation.badgeKey)}
          >
            <span className="font-semibold text-zinc-600 dark:text-zinc-300">{t(presentation.badgeKey)}</span>
            {detail ? (
              <>
                <span className="text-zinc-300 dark:text-zinc-600"> · </span>
                {detail}
              </>
            ) : null}
          </span>
        )}
      </div>
      {action?.kind === "link" ? (
        <button type="button" data-auth-action={platform} onClick={() => runtime.adapter.openLink(action.url)} className="mt-1 w-fit rounded-md bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent-text)] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]">
          {t(action.labelKey)}
        </button>
      ) : null}
      {action?.kind === "resume" ? (
        <button type="button" data-resume-action={platform} onClick={() => onResume?.()} className="mt-1 flex w-fit items-center gap-1 rounded-md bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent-text)] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]">
          <Play size={10} strokeWidth={2.6} />
          {t(action.labelKey)}
        </button>
      ) : null}
    </div>
  );
}
