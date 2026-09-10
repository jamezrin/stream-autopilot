import React, { useEffect, useMemo, useRef, useState } from "react";
import { arrayMove } from "@dnd-kit/helpers";
import { DragDropProvider } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { AlertTriangle, Plus, Search } from "lucide-react";
import type { CategoryMode, CategorySelection, ExtensionSettings, Platform } from "@lurkloot/shared/models";
import { GAME_ACCENTS, PLATFORMS } from "./constants";
import { useT } from "./context";
import { initials } from "./format";
import type { GameItem } from "./types";
import {
  CompactRow,
  DragHandle,
  Pill,
  RemoveRowButton,
  reorderFromDragEnd,
  preventNativeDrag,
  type SortableDragEndEvent,
} from "./primitives";
import { SelectSettingRow } from "./settingsControls";

// The three category modes share ONE stored list, so switching mode only
// changes how that list is read — it never rewrites or reorders the array.
// Switching to exclude and back therefore restores the include priority order
// the user had set.
export function PlatformCategorySettings({ platform, suggestions, settings, onCategoryModeChange, onCategoriesChange, onSearchCategories }: {
  platform: Platform;
  suggestions: GameItem[];
  settings: ExtensionSettings;
  onCategoryModeChange(mode: CategoryMode): void | Promise<void>;
  onCategoriesChange(categories: CategorySelection[]): void | Promise<void>;
  onSearchCategories(query: string): Promise<CategorySelection[]>;
}) {
  const t = useT();
  const details = PLATFORMS[platform];
  const platformSettings = settings.platform[platform];

  return (
    <>
      <SelectSettingRow<CategoryMode>
        title={t("categoryModeTitle")}
        description={t("categoryModeDescription", details.label)}
        value={platformSettings.categoryMode}
        options={[
          { value: "all", label: t("categoryModeAll") },
          { value: "include", label: t("categoryModeInclude") },
          { value: "exclude", label: t("categoryModeExclude") },
        ]}
        onChange={onCategoryModeChange}
      />
      {platformSettings.categoryMode === "all" ? null : (
        <div className="py-2">
          <CategoryFilterEditor
            platform={platform}
            mode={platformSettings.categoryMode}
            categories={platformSettings.categories}
            suggestions={suggestions}
            onChange={onCategoriesChange}
            onSearch={onSearchCategories}
          />
        </div>
      )}
    </>
  );
}

export function PlatformExcludedChannels({ platform, settings, onExcludedChannelsChange }: {
  platform: Platform;
  settings: ExtensionSettings;
  onExcludedChannelsChange(channels: string[]): void | Promise<void>;
}) {
  const t = useT();
  return (
    <div className="py-2">
      <ChannelListEditor
        empty={t("excludedChannelsEmpty")}
        channels={settings.platform[platform].excludedChannels ?? []}
        onChange={onExcludedChannelsChange}
      />
    </div>
  );
}

// Renders bare: the enclosing SettingsGroup supplies the heading, the
// description and the channel count.
function ChannelListEditor({ empty, channels, onChange }: {
  empty: string;
  channels: string[];
  onChange(channels: string[]): void | Promise<void>;
}) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");

  function addChannel(): void {
    const username = value.trim().replace(/^@+/, "").toLowerCase();
    if (!username || channels.includes(username)) {
      setValue("");
      setAdding(false);
      return;
    }
    void onChange([...channels, username]);
    setValue("");
    setAdding(false);
  }

  function removeChannel(username: string): void {
    void onChange(channels.filter((channel) => channel !== username));
  }

  return (
    <div className="space-y-2">
      {channels.length === 0 ? <div className="text-[11px] text-zinc-400">{empty}</div> : (
        <div className="flex flex-wrap gap-1.5">
          {channels.map((channel) => (
            <span key={channel} className="inline-flex max-w-full items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
              <span className="truncate">{channel}</span>
              <RemoveRowButton label={t("removeItem", channel)} onClick={() => removeChannel(channel)} />
            </span>
          ))}
        </div>
      )}
      {adding ? (
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); addChannel(); }}>
          <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder={t("channelPlaceholder")} className="min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-900 outline-none focus:border-[var(--accent-ring)] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />
          <button type="submit" className="rounded-xl bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--accent-contrast)]">{t("add")}</button>
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-300 py-2 text-xs font-medium text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-200">
          <Plus size={14} /> {t("addChannel")}
        </button>
      )}
    </div>
  );
}

// The category list editor, shown in both filtered modes. In "include" the list
// is an ordered allowlist (order = farming priority), so rows are reorderable.
// In "exclude" it is an unordered denylist: reordering is removed entirely
// rather than left as a control that quietly does nothing. Categories are added
// the same way in both: drop-aware quick suggestions (no network) or a
// debounced live search.
function CategoryFilterEditor({ platform, mode, categories, suggestions, onChange, onSearch }: {
  platform: Platform;
  mode: Exclude<CategoryMode, "all">;
  categories: CategorySelection[];
  suggestions: GameItem[];
  onChange(categories: CategorySelection[]): void | Promise<void>;
  onSearch(query: string): Promise<CategorySelection[]>;
}) {
  const t = useT();
  const reorderable = mode === "include";

  const selectedIds = useMemo(() => new Set(categories.map((category) => category.id.toLowerCase())), [categories]);

  function addCategory(category: CategorySelection): void {
    if (selectedIds.has(category.id.toLowerCase())) return;
    void onChange([...categories, category]);
  }

  function endDrag(event: SortableDragEndEvent): void {
    const next = reorderFromDragEnd(categories, event);
    if (next === categories) return;
    void onChange(next);
  }

  const accentFor = (index: number): string => GAME_ACCENTS[index % GAME_ACCENTS.length];
  const label = PLATFORMS[platform].label;

  const rows = categories.map((category, index) => (
    <CategoryRow
      key={category.id}
      category={category}
      index={index}
      count={categories.length}
      accent={accentFor(index)}
      reorderable={reorderable}
      onRemove={() => void onChange(categories.filter((entry) => entry.id !== category.id))}
      onMove={(toIndex) => void onChange(arrayMove(categories, index, toIndex))}
    />
  ));

  return (
    <div className="space-y-2.5">
      {/* The group header carries the label and the count; what is left is the
          mode-specific instruction, plus the reordering hint that only means
          anything in include mode with a non-empty list. */}
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
          {t(reorderable ? "includeCategoriesInstruction" : "excludeCategoriesInstruction", label)}
        </span>
        {reorderable && categories.length > 0 ? <Pill tone="accent">{t("dragToPrioritize")}</Pill> : null}
      </div>
      {categories.length === 0 ? (
        reorderable ? (
          // Include with an empty list farms nothing, which is almost never
          // what the user meant: warn.
          <div className="flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{t("noCategoriesSelected", label)}</span>
          </div>
        ) : (
          // Exclude with an empty list is exactly "all categories" — a valid
          // state on the way to picking something, so it states the effect
          // instead of raising an alarm.
          <div className="rounded-lg border border-zinc-200 px-2.5 py-2 text-[11px] leading-snug text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            {t("noCategoriesExcluded", label)}
          </div>
        )
      ) : reorderable ? (
        <DragDropProvider onDragEnd={endDrag}>
          <div className="space-y-1.5">{rows}</div>
        </DragDropProvider>
      ) : (
        <div className="space-y-1.5">{rows}</div>
      )}

      <CategoryPickerCombobox platform={platform} suggestions={suggestions} selectedIds={selectedIds} onSearch={onSearch} onSelect={addCategory} />
    </div>
  );
}

// Combobox-style category picker: a single search input that opens a
// popover listbox on focus, grouped into categories with active drops
// (already loaded, no network) and other categories (from a debounced live
// search). Collapses when not focused so a long active-drops list doesn't
// dominate the settings screen (issue #326).
function CategoryPickerCombobox({ platform, suggestions, selectedIds, onSearch, onSelect }: {
  platform: Platform;
  suggestions: GameItem[];
  selectedIds: Set<string>;
  onSearch(query: string): Promise<CategorySelection[]>;
  onSelect(category: CategorySelection): void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CategorySelection[]>([]);
  const [searching, setSearching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // onSearch is a fresh closure each render; ref it so the debounce effect can
  // depend only on the query and not re-fire on every parent render.
  const searchRef = useRef(onSearch);
  searchRef.current = onSearch;

  const trimmedQuery = query.trim();
  const unaddedSuggestions = useMemo(
    () => suggestions.filter((suggestion) => !selectedIds.has(suggestion.id.toLowerCase())),
    [suggestions, selectedIds],
  );
  const activeDropsMatches = trimmedQuery
    ? unaddedSuggestions.filter((suggestion) => suggestion.name.toLowerCase().includes(trimmedQuery.toLowerCase()))
    : unaddedSuggestions;
  const activeDropIds = useMemo(() => new Set(activeDropsMatches.map((item) => item.id.toLowerCase())), [activeDropsMatches]);
  const otherResults = results.filter((result) => !selectedIds.has(result.id.toLowerCase()) && !activeDropIds.has(result.id.toLowerCase()));

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent): void {
      // Use composedPath() rather than event.target: the popup can render
      // inside a shadow root (e.g. the site's live demo), and shadow
      // boundaries retarget .target on composed events like mousedown to the
      // shadow host, which breaks a plain .contains() containment check.
      if (containerRef.current && !event.composedPath().includes(containerRef.current)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(() => {
      void searchRef.current(trimmed)
        .then((found) => { if (!cancelled) setResults(found); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [query]);

  function select(category: CategorySelection): void {
    onSelect(category);
    setQuery("");
    setOpen(false);
  }

  const showActiveDrops = activeDropsMatches.length > 0;
  const showOther = trimmedQuery.length > 0;
  const isEmpty = !showActiveDrops && (!showOther || (!searching && otherResults.length === 0));

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
        <input
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          placeholder={t("searchCategories", PLATFORMS[platform].label)}
          className="w-full rounded-xl border border-zinc-200 bg-white py-2 pl-8 pr-3 text-xs font-medium text-zinc-900 outline-none focus:border-[var(--accent-ring)] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
        />
      </div>
      {open ? (
        <div className="absolute inset-x-0 top-full z-10 mt-1.5 max-h-64 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1.5 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
          {showActiveDrops ? (
            <CategoryPickerGroup label={t("hasActiveDrops")} items={activeDropsMatches} onSelect={select} />
          ) : null}
          {showOther ? (
            searching ? (
              <div className="px-2 py-1.5 text-[11px] text-zinc-400">{t("searching")}</div>
            ) : otherResults.length > 0 ? (
              <CategoryPickerGroup label={t("otherCategories")} items={otherResults} onSelect={select} />
            ) : null
          ) : null}
          {isEmpty ? <div className="px-2 py-1.5 text-[11px] text-zinc-400">{t("noCategoriesFound")}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function CategoryPickerGroup({ label, items, onSelect }: {
  label: string;
  items: (CategorySelection | GameItem)[];
  onSelect(category: CategorySelection): void;
}) {
  return (
    <div className="space-y-0.5 py-1 first:pt-0">
      <div className="px-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{label}</div>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect({ id: item.id, name: item.name, ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}) })}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          {item.imageUrl ? <img src={item.imageUrl} alt="" className="h-4 w-4 shrink-0 rounded object-cover" /> : null}
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          <Plus size={12} className="shrink-0 text-zinc-400" />
        </button>
      ))}
    </div>
  );
}

// Reorderable rows must call useSortable, which is only valid inside the
// DragDropProvider the include branch renders, so the exclude branch gets a
// plain row rather than a sortable one with its drag affordances disabled.
function CategoryRow({ category, index, count, accent, reorderable, onRemove, onMove }: { category: CategorySelection; index: number; count: number; accent: string; reorderable: boolean; onRemove(): void; onMove(toIndex: number): void }) {
  const t = useT();
  if (!reorderable) {
    return (
      <CompactRow avatar={initials(category.name)} avatarImageUrl={category.imageUrl} avatarStyle={{ backgroundColor: accent, color: "#fff" }} title={category.name} trailing={<RemoveRowButton label={t("removeItem", category.name)} onClick={onRemove} />} />
    );
  }
  return <SortableCategoryRow category={category} index={index} count={count} accent={accent} onRemove={onRemove} onMove={onMove} />;
}

function SortableCategoryRow({ category, index, count, accent, onRemove, onMove }: { category: CategorySelection; index: number; count: number; accent: string; onRemove(): void; onMove(toIndex: number): void }) {
  const t = useT();
  const { ref, handleRef, isDragging } = useSortable({ id: category.id, index });
  return (
    <div ref={ref} onDragStart={preventNativeDrag}>
      <CompactRow index={index} rankCount={count} rankLabel={category.name} onRankMove={onMove} avatar={initials(category.name)} avatarImageUrl={category.imageUrl} avatarStyle={{ backgroundColor: accent, color: "#fff" }} title={category.name} dimmed={isDragging} dragHandle={<DragHandle handleRef={handleRef} label={t("reorderItem", category.name)} />} trailing={<RemoveRowButton label={t("removeItem", category.name)} onClick={onRemove} />} />
    </div>
  );
}
