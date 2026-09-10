import React, { useEffect, useState } from "react";
import { Ban, ChevronDown, Lock } from "lucide-react";
import type { ExtensionSettings } from "@lurkloot/shared/models";
import {
  COLLAPSED_SETTINGS_SECTIONS_KEY,
  DROPS_LIST_FILTERS,
} from "./constants";
import { usePopupRuntime, useT } from "./context";
import { SearchBox, Toggle, cn } from "./primitives";

export function SettingsSection({ id, title, description, badge, forceExpanded, children }: {
  // Stable, locale-independent identity. Collapse state is keyed by this, not by
  // the translated title, so changing language does not reset the accordion.
  id: string;
  title: string;
  description?: string;
  badge?: React.ReactNode;
  // While searching, sections holding matches are opened regardless of the
  // persisted state, and the persisted state is left untouched.
  forceExpanded?: boolean;
  children: React.ReactNode;
}) {
  const { adapter, preview } = usePopupRuntime();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (preview) return;
    let mounted = true;
    void adapter.getStorage(COLLAPSED_SETTINGS_SECTIONS_KEY).then((stored) => {
      if (!mounted) return;
      const map = stored[COLLAPSED_SETTINGS_SECTIONS_KEY] as Record<string, boolean | undefined> | undefined;
      setCollapsed(map?.[id] === true);
    });
    return () => {
      mounted = false;
    };
  }, [adapter, preview, id]);

  function toggleCollapsed(): void {
    const nextCollapsed = !collapsed;
    setCollapsed(nextCollapsed);
    if (preview) return;
    void adapter.getStorage(COLLAPSED_SETTINGS_SECTIONS_KEY).then((stored) => {
      const map = (stored[COLLAPSED_SETTINGS_SECTIONS_KEY] as Record<string, boolean> | undefined) ?? {};
      const next = { ...map, [id]: nextCollapsed };
      void adapter.setStorage({ [COLLAPSED_SETTINGS_SECTIONS_KEY]: next });
    });
  }

  const expanded = forceExpanded || !collapsed;

  return (
    <section id={`settings-section-${id}`} className="scroll-mt-2">
      <header className="mb-1.5 px-0.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggleCollapsed}
          className="flex w-full items-start justify-between gap-3 rounded-lg px-1 py-1 text-left outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:hover:bg-zinc-900/70"
        >
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</span>
              {badge}
            </span>
            {description ? <span className="mt-1 block text-[11px] leading-snug text-zinc-400 dark:text-zinc-500">{description}</span> : null}
          </span>
          <ChevronDown size={14} className={cn("mt-0.5 shrink-0 text-zinc-400 transition-transform dark:text-zinc-500", expanded && "rotate-180")} />
        </button>
      </header>
      {expanded ? <div className="space-y-3 px-0.5">{children}</div> : null}
    </section>
  );
}

// A labelled divider inside the flat settings flow. Groups do not collapse:
// search is the direct route to a long page, and all advanced settings remain
// available without a separate visual warning state.
export function SettingsGroup({ title, description, badge, children }: {
  title: string;
  // Groups whose whole body is one editor carry that editor's subtitle and count
  // here, so the editor itself renders bare instead of repeating the heading.
  description?: string;
  badge?: React.ReactNode;
  advanced?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3 first:mt-0">
      <div className="mb-0.5 flex items-center gap-1.5 pt-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{title}</span>
        <span className="h-px flex-1 bg-zinc-100 dark:bg-zinc-800/70" />
        {badge}
      </div>
      {description ? <p className="mb-1.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</p> : null}
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">{children}</div>
    </div>
  );
}

export function SettingsSearchBox({ value, onChange, autoFocus = false, compact = false }: { value: string; onChange(value: string): void; autoFocus?: boolean; compact?: boolean }) {
  const t = useT();
  return <SearchBox autoFocus={autoFocus} compact={compact} value={value} onChange={onChange} placeholder={t("settingsSearchPlaceholder")} />;
}

export function AdvancedSettingsSwitch({ checked, onChange }: { checked: boolean; onChange(value: boolean): void }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-3 px-1">
      <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{t("settingsShowAdvancedTitle")}</span>
      <Toggle checked={checked} onChange={onChange} label={t("settingsShowAdvancedTitle")} />
    </div>
  );
}

export function SettingRow({ title, description, checked, onChange, disabled = false, disabledReason }: {
  title: string;
  description: string;
  checked: boolean;
  onChange(value: boolean): void | Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3 py-2.5", disabled && "opacity-60")} title={disabled ? disabledReason : undefined}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{title}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} disabled={disabled} />
    </div>
  );
}

// The Drops-list view control: one labelled group of chips over the
// dropsListFilter flags. Pure display — the farming axis is now separate
// SettingRow toggles — so there is a single group here, not the old
// farming/display split.
//
// The not-linked/subscription chips carry a `lockedBy` farming flag. While that
// flag is on, the matching class of campaign is always farmed and therefore
// always visible (isCampaignVisible enforces this), so the chip is forced on and
// disabled: it surfaces the invariant rather than offering a toggle that could
// not take effect. The lock is display-only — a locked chip never writes to the
// stored show-flag, so the user's hidden/shown preference survives to reappear
// when farming is turned back off.
export function DropsListFilterRow({ value, farmingEligibility, onChange }: {
  value: ExtensionSettings["dropsListFilter"];
  farmingEligibility: ExtensionSettings["farmingEligibility"];
  onChange(value: ExtensionSettings["dropsListFilter"]): void | Promise<void>;
}) {
  const t = useT();
  const toggle = (key: keyof ExtensionSettings["dropsListFilter"]) => onChange({ ...value, [key]: !value[key] });
  return (
    // role="group" + aria-labelledby, so a screen-reader user hears the row's
    // name around the chips instead of an anonymous run of buttons.
    // aria-labelledby rather than aria-label keeps the visible and accessible
    // names from drifting apart; the id is unique on the page.
    <div className="py-2.5" role="group" aria-labelledby="dropsListFilter-label">
      <div id="dropsListFilter-label" className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{t("dropsListFilterTitle")}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
        {t("dropsListFilterDescription")}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {DROPS_LIST_FILTERS.map(({ key, label, lockedBy }) => {
          // Farming forces the chip visible; otherwise it reflects the stored flag.
          const locked = lockedBy ? farmingEligibility[lockedBy] : false;
          const active = locked || value[key];
          return (
            <button
              key={key}
              type="button"
              // Guard rather than omit: a locked chip must not mutate the stored
              // show-flag, so the preference is preserved for when farming stops.
              onClick={locked ? undefined : () => toggle(key)}
              disabled={locked}
              aria-disabled={locked}
              aria-pressed={active}
              title={locked ? t("dropsListFilterLockedHint") : undefined}
              className={cn(
                "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold transition",
                active
                  ? "border-transparent text-[var(--accent-contrast)]"
                  : "border-zinc-200 text-zinc-400 dark:border-zinc-700",
                locked && "cursor-not-allowed opacity-70",
              )}
              style={active ? { backgroundColor: "var(--accent)" } : undefined}
            >
              {locked
                ? <Lock size={8} style={{ color: "var(--accent-contrast)" }} aria-hidden />
                : <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: active ? "var(--accent-contrast)" : "var(--accent)" }} />}
              {t(label)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ForgetExcludedCampaignsRow({ count, onForget }: { count: number; onForget(): void | Promise<void> }) {
  const t = useT();
  const disabled = count === 0;
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{t("forgetExcludedTitle")}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
          {t("forgetExcludedDescription")}
        </div>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void onForget()}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
          disabled
            ? "border-zinc-200 text-zinc-300 dark:border-zinc-800 dark:text-zinc-700"
            : "border-red-500/30 text-red-600 hover:border-red-500/60 hover:bg-red-500/5 dark:text-red-400",
        )}
      >
        <Ban size={12} />
        {t("forget")}
        <span className="tabular">{count}</span>
      </button>
    </div>
  );
}

// The bare select control. A native <select> sizes itself to its longest option,
// so it is capped and allowed to shrink; long labels ellipsize instead of
// squeezing whatever sits beside it. The full label stays available on hover.
export function SelectControl<T extends string>({ label, value, options, onChange, disabled = false, disabledReason }: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange(value: T): void | Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <label className={cn("flex min-w-0 max-w-[45%] shrink-0 items-center rounded-lg border border-zinc-200 bg-white px-2 py-1 text-[11px] font-semibold text-zinc-500 focus-within:border-[var(--accent-ring)] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400", disabled && "cursor-not-allowed")}>
      <select
        aria-label={label}
        title={disabled ? disabledReason : options.find((option) => option.value === value)?.label}
        disabled={disabled}
        value={value}
        onChange={(event) => void onChange(event.target.value as T)}
        className={cn("w-full truncate bg-transparent pr-1 outline-none", disabled && "cursor-not-allowed")}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

export function SelectSettingRow<T extends string>({ title, description, value, options, onChange, disabled = false, disabledReason }: {
  title: string;
  description: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange(value: T): void | Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3 py-2.5", disabled && "opacity-60")} title={disabled ? disabledReason : undefined}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{title}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</div>
      </div>
      <SelectControl label={title} value={value} options={options} onChange={onChange} disabled={disabled} disabledReason={disabledReason} />
    </div>
  );
}

export function NumberSettingRow({ title, description, value, min, max, suffix, onChange, disabled = false, disabledReason }: { title: string; description: string; value: number; min: number; max: number; suffix: string; onChange(value: number): void | Promise<void>; disabled?: boolean; disabledReason?: string }) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit(rawValue = draft): void {
    const nextValue = Number(rawValue);
    if (!Number.isFinite(nextValue)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(nextValue)));
    setDraft(String(clamped));
    void onChange(clamped);
  }

  return (
    <div className={cn("flex items-center gap-3 py-2.5", disabled && "opacity-60")} title={disabled ? disabledReason : undefined}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{title}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</div>
      </div>
      <label className={cn("flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-[11px] font-semibold text-zinc-500 focus-within:border-[var(--accent-ring)] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400", disabled && "cursor-not-allowed")}>
        <input
          aria-label={title}
          type="number"
          disabled={disabled}
          min={min}
          max={max}
          step={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="w-12 bg-transparent text-right text-xs font-semibold tabular text-zinc-900 outline-none dark:text-zinc-100"
        />
        {suffix}
      </label>
    </div>
  );
}
