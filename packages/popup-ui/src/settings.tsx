import React, { useEffect, useMemo, useState } from "react";
import { Download, RotateCcw, Terminal, Upload } from "lucide-react";
import type { CategorySelection, ExtensionSettings, Platform } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { PLATFORMS } from "./constants";
import { SettingsGroup, SettingsSearchBox, SettingsSection } from "./settingsControls";
import { buildSettingsRegistry, type SettingsChangeOptions } from "./settingsRegistry";
import { filterSettingsTree } from "./settingsSearch";
import { useT } from "./context";
import type { GameItem, PopupCompatibilityRegistry, PopupCompatibilityResolution } from "./types";

export function SettingsView({ suggestions, onSearchCategories, settings, onSettingsChange, onExportCredentials, onExportSettings, onImportSettings, onReset, exportConfirmationResetKey, compatibilityRegistry, compatibilityResolution, focusGroupId }: {
  suggestions: Record<Platform, GameItem[]>;
  onSearchCategories(platform: Platform, query: string): Promise<CategorySelection[]>;
  settings: ExtensionSettings;
  onSettingsChange(patch: SettingsPatch, options?: SettingsChangeOptions): Promise<void>;
  // Optional: when provided, the settings view shows an "Export credentials"
  // action for the headless CLI. The extension wires it; the demo omits it.
  onExportCredentials?: () => void | Promise<void>;
  // Optional: download the current settings as a portable JSON file.
  onExportSettings?: () => void | Promise<void>;
  // Optional: prompt for a settings file and apply it. Resolves false when the
  // user cancels the file picker, throws when the file is invalid/corrupt.
  onImportSettings?: () => Promise<boolean>;
  onReset?: () => Promise<void>;
  exportConfirmationResetKey: number;
  compatibilityRegistry?: PopupCompatibilityRegistry;
  compatibilityResolution?: PopupCompatibilityResolution;
  focusGroupId?: string;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [exportArmed, setExportArmed] = useState(false);
  const [exportingSettings, setExportingSettings] = useState(false);
  const [exportSettingsFailed, setExportSettingsFailed] = useState(false);
  const [importArmed, setImportArmed] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importFailed, setImportFailed] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetFailed, setResetFailed] = useState(false);
  useEffect(() => {
    setExportArmed(false);
    setExportingSettings(false);
    setExportSettingsFailed(false);
    setImportArmed(false);
    setImportFailed(false);
    setResetArmed(false);
    setResetFailed(false);
  }, [exportConfirmationResetKey]);

  useEffect(() => {
    if (!focusGroupId) return;
    document.getElementById(`settings-group-${focusGroupId}`)?.scrollIntoView?.({ block: "start" });
  }, [focusGroupId]);

  // Export needs no arm/confirm step (it only reads, never mutates), but it
  // still needs a busy/failure state like import and reset: a slow or failed
  // download (disk full, permission denied) should not look identical to a
  // successful one, and a second click while one is in flight should be a
  // no-op rather than racing two downloads.
  async function confirmExportSettings(): Promise<void> {
    if (!onExportSettings || exportingSettings) return;
    setExportingSettings(true);
    setExportSettingsFailed(false);
    try {
      await onExportSettings();
    } catch {
      setExportSettingsFailed(true);
    } finally {
      setExportingSettings(false);
    }
  }

  async function confirmImport(): Promise<void> {
    if (!onImportSettings || importing) return;
    setImporting(true);
    setImportFailed(false);
    try {
      const applied = await onImportSettings();
      if (applied) setImportArmed(false);
    } catch {
      setImportArmed(true);
      setImportFailed(true);
    } finally {
      setImporting(false);
    }
  }

  async function confirmReset(): Promise<void> {
    if (!onReset || resetting) return;
    setResetting(true);
    setResetFailed(false);
    try {
      await onReset();
    } catch {
      setResetArmed(true);
      setResetFailed(true);
    } finally {
      setResetting(false);
    }
  }

  const sections = useMemo(
    () => buildSettingsRegistry({ t, settings, onSettingsChange, suggestions, onSearchCategories, compatibilityRegistry, compatibilityResolution }),
    [t, settings, onSettingsChange, suggestions, onSearchCategories, compatibilityRegistry, compatibilityResolution],
  );
  const visible = useMemo(
    () => filterSettingsTree(sections, { t, query, showAdvanced: true }),
    [sections, t, query],
  );
  const searching = query.trim().length > 0;
  const hasActions = Boolean(onExportSettings || onImportSettings || onExportCredentials || onReset);
  const actionSearchText = [
    t("settingsSectionAdvancedActions"),
    t("settingsSectionAdvancedActionsDescription"),
    t("settingsExportTitle"),
    t("settingsExportHint"),
    t("settingsExportButton"),
    t("settingsImportButton"),
    t("cliExportTitle"),
    t("cliExportHint"),
    t("cliExportButton"),
    t("factoryResetTitle"),
    t("factoryResetHint"),
    t("factoryResetButton"),
  ].join(" ").toLocaleLowerCase();
  const showActions = hasActions && (!searching || actionSearchText.includes(query.trim().toLocaleLowerCase()));
  const generalSection = visible.find((section) => section.id === "general");
  const platformSections = (Object.keys(PLATFORMS) as Platform[])
    .map((id) => visible.find((section) => section.id === id))
    .filter((section): section is NonNullable<typeof section> => Boolean(section));

  function renderGroupContent(group: typeof sections[number]["groups"][number], includeDescription = true): React.ReactNode {
    return (
      <>
        {includeDescription && group.description ? <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{group.description}</p> : null}
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
          {group.entries.map((entry) => <React.Fragment key={entry.id}>{entry.render()}</React.Fragment>)}
        </div>
      </>
    );
  }

  return (
    <div className="space-y-3">
      <SettingsSearchBox compact value={query} onChange={setQuery} />

      {visible.length === 0 && !showActions ? (
        <p className="px-1 py-6 text-center text-xs text-zinc-400 dark:text-zinc-500">{t("settingsSearchNoResults", query.trim())}</p>
      ) : searching ? (
        <div className="space-y-4">
          {visible.flatMap((section) => [
            section.rows.length > 0 ? (
              <SettingsSection
                key={`${section.id}.rows`}
                id={`${section.id}.rows`}
                title={PLATFORMS[section.id as Platform].label}
              >
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                  {section.rows.map((row) => <React.Fragment key={row.id}>{row.render()}</React.Fragment>)}
                </div>
              </SettingsSection>
            ) : null,
            ...section.groups.map((group) => (
              <div key={group.id} id={`settings-group-${group.id}`}>
                <SettingsSection
                  id={group.id}
                  title={section.id === "general" ? t(group.titleKey) : `${PLATFORMS[section.id as Platform].label} · ${t(group.titleKey)}`}
                >
                  {renderGroupContent(group, false)}
                </SettingsSection>
              </div>
            )),
          ])}
        </div>
      ) : (
        <div className="space-y-4">
          {generalSection?.groups.map((group) => group.id !== "general.advanced" ? (
            <div key={group.id} id={`settings-group-${group.id}`}>
              <SettingsSection id={group.id} title={t(group.titleKey)} description={group.description}>
                {renderGroupContent(group, false)}
              </SettingsSection>
            </div>
          ) : null)}

          {platformSections.map((section) => (
            <SettingsSection
              key={section.id}
              id={section.id}
              title={PLATFORMS[section.id as Platform].label}
              description={section.description}
            >
              {section.rows.length > 0 ? (
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                  {section.rows.map((row) => <React.Fragment key={row.id}>{row.render()}</React.Fragment>)}
                </div>
              ) : null}
              {section.groups.map((group) => (
                <div key={group.id} id={`settings-group-${group.id}`}>
                  <SettingsGroup title={t(group.titleKey)} description={group.description} badge={group.badge}>
                    {group.entries.map((entry) => <React.Fragment key={entry.id}>{entry.render()}</React.Fragment>)}
                  </SettingsGroup>
                </div>
              ))}
            </SettingsSection>
          ))}

          {generalSection?.groups.find((group) => group.id === "general.advanced") ? (
            <SettingsSection id="general.advanced" title={t("settingsGroupAdvanced")} description={generalSection.groups.find((group) => group.id === "general.advanced")!.description}>
              {renderGroupContent(generalSection.groups.find((group) => group.id === "general.advanced")!, false)}
            </SettingsSection>
          ) : null}
        </div>
      )}

      {showActions ? (
        <SettingsSection id="actions" title={t("settingsSectionAdvancedActions")} description={t("settingsSectionAdvancedActionsDescription")}>
          <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200/70 bg-white dark:divide-zinc-800/70 dark:border-zinc-800 dark:bg-zinc-900/40">
            {onExportSettings || onImportSettings ? (
              <div className="p-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{t("settingsExportTitle")}</div>
                {importArmed ? (
                  <div className="mt-1.5 space-y-2">
                    <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">{t("settingsImportConfirm")}</p>
                    {importFailed ? <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">{t("settingsImportFailed")}</p> : null}
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        disabled={importing}
                        className="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        onClick={() => {
                          setImportArmed(false);
                          setImportFailed(false);
                        }}
                      >
                        {t("settingsImportCancel")}
                      </button>
                      <button
                        type="button"
                        disabled={importing}
                        className="rounded-xl bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] disabled:opacity-50"
                        onClick={() => void confirmImport()}
                      >
                        {t("settingsImportConfirmButton")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-1.5 space-y-2">
                    <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t("settingsExportHint")}</p>
                    {exportSettingsFailed ? <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">{t("settingsExportFailed")}</p> : null}
                    <div className="flex flex-wrap justify-end gap-2">
                      {onExportSettings ? (
                        <button
                          type="button"
                          disabled={exportingSettings}
                          className="flex items-center gap-1.5 rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                          onClick={() => void confirmExportSettings()}
                        >
                          <Download size={13} />
                          {t("settingsExportButton")}
                        </button>
                      ) : null}
                      {onImportSettings ? (
                        <button
                          type="button"
                          className="flex items-center gap-1.5 rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                          onClick={() => setImportArmed(true)}
                        >
                          <Upload size={13} />
                          {t("settingsImportButton")}
                        </button>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            {onExportCredentials ? (
              <div className="p-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{t("cliExportTitle")}</div>
                {exportArmed ? (
                  <div className="mt-1.5 space-y-2">
                    <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">{t("cliExportConfirm")}</p>
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        className="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        onClick={() => setExportArmed(false)}
                      >
                        {t("cliExportCancel")}
                      </button>
                      <button
                        type="button"
                        className="rounded-xl bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
                        onClick={() => {
                          setExportArmed(false);
                          void onExportCredentials();
                        }}
                      >
                        {t("cliExportConfirmButton")}
                      </button>
                    </div>
                  </div>
                ) : (
                  // The button stays secondary here and the accent is spent on the
                  // confirm step, which is the one that actually writes session
                  // tokens to disk.
                  <div className="mt-1.5 space-y-2">
                    <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t("cliExportHint")}</p>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        className="flex items-center gap-1.5 rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        onClick={() => setExportArmed(true)}
                      >
                        <Terminal size={13} />
                        {t("cliExportButton")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            {onReset ? (
              <div className="p-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-red-500 dark:text-red-400">{t("factoryResetTitle")}</div>
                {resetArmed ? (
                  <div className="mt-1.5 space-y-2">
                    <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">{t("factoryResetConfirm")}</p>
                    {resetFailed ? <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">{t("factoryResetFailed")}</p> : null}
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        disabled={resetting}
                        className="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        onClick={() => {
                          setResetArmed(false);
                          setResetFailed(false);
                        }}
                      >
                        {t("factoryResetCancel")}
                      </button>
                      <button
                        type="button"
                        disabled={resetting}
                        className="rounded-xl bg-red-600 px-3 py-1.5 text-xs font-semibold text-white outline-none transition-colors hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-50 dark:bg-red-700 dark:hover:bg-red-600"
                        onClick={() => void confirmReset()}
                      >
                        {t(resetting ? "factoryResetProgress" : resetFailed ? "factoryResetRetry" : "factoryResetConfirmButton")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-1.5 space-y-2">
                    <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t("factoryResetHint")}</p>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        className="flex items-center gap-1.5 rounded-xl border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 outline-none transition-colors hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-400 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                        onClick={() => {
                          setResetArmed(true);
                          setResetFailed(false);
                        }}
                      >
                        <RotateCcw size={13} />
                        {t("factoryResetButton")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </SettingsSection>
      ) : null}
    </div>
  );
}
