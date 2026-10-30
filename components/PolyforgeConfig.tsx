"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { PolyforgeDetectStatus } from "@/lib/polyforge-detect";
import type { PolyforgeConfigHistoryEntry } from "@/lib/polyforge-config-history";
import type { PolyforgeConfigItem, PolyforgeConfigRead } from "@/lib/polyforge-config";
import { configValueError } from "@/lib/polyforge-config-schema";
import type { PluginPackageInfo } from "@/lib/api-types";
import { shortenPath } from "@/lib/display-path";
import {
  POLYFORGE_POLL_INTERVAL,
  POLYFORGE_TITLE_LENGTH,
  writePolyforgePreference,
  type PolyforgePreferenceSpec,
} from "@/lib/polyforge-panel-preferences";
import { usePolyforgePanelPreferences } from "@/hooks/usePolyforgePanelPreferences";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailGrid,
  ConfigDetailGridRow,
  ConfigDetailStack,
  ConfigFooter,
  ConfigFooterStatus,
  ConfigSectionTitle,
  ConfigSwitch,
} from "./SettingsUi";
import {
  groupConfigItems,
  groupStepsByProject,
  isUnsetValue,
  workspaceProjects,
  workspaceSectionPath,
  type ConfigGroupId,
} from "./polyforge-config-helpers";

/**
 * Settings › Polyforge: machine-level detection (pi#122) plus the
 * configuration panel. Every read and write goes through
 * `/api/polyforge/**`, which in turn calls `pf`; this component never reads
 * or writes cli.toml / `.polyforge.yaml`. Why a control is unavailable is
 * visible text, never only a tooltip, and an api_key value is write-only.
 * The Jobs-tab card preferences are the one exception to
 * "through pf": two numbers kept in this browser's localStorage only.
 */

interface Props {
  cwd: string | null;
  /** True while the section is the settings dialog's active section. */
  active: boolean;
}

type SourceState = { status: "pending" | "found" | "missing"; source: string | null };

const WRITABLE = new Set([
  "max_concurrent_jobs",
  "step_timeout",
  "stall_window",
  "summarize.models",
  "summarize.language",
  "summarize.interval_sec",
  "api_key",
]);

function isNumericKey(key: string): boolean {
  return key === "max_concurrent_jobs" || key === "summarize.interval_sec";
}

/** pf's reload classes, localized. An unknown class still
 *  renders pf's own name through the fallback, never as a bare raw token. */
const RELOAD_CLASS_KEYS: Record<string, string> = {
  "restart-only": "polyforge.settings.classRestartOnly",
  "cli-only": "polyforge.settings.classCliOnly",
  live: "polyforge.settings.classLive",
  "next-claim": "polyforge.settings.classNextClaim",
};

/** A list-valued key (summarize.models) renders as chips, never one comma string. */
function isModelListKey(item: PolyforgeConfigItem): boolean {
  return item.schema?.kind === "model-list" || item.key === "summarize.models";
}

function modelListValue(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : typeof value === "string"
      ? value.split(",").map((part) => part.trim()).filter(Boolean)
      : [];
  // Chips key on the model name, so a duplicate from pf must not collide.
  return [...new Set(list)];
}

/** The three keys the spec gives a daemon column (claude_bin does not). */
function isDaemonColumnKey(key: string): boolean {
  return key === "max_concurrent_jobs" || key === "step_timeout" || key === "stall_window";
}

/** Each source card's title and one-line hint. */
const GROUP_TITLE: Record<ConfigGroupId, string> = {
  flat: "polyforge.settings.configGroupFlat",
  daemon: "polyforge.settings.configGroupDaemon",
  workspace: "polyforge.settings.configGroupWorkspace",
  summarize: "polyforge.settings.configGroupSummarize",
};
const GROUP_HINT: Record<ConfigGroupId, string> = {
  flat: "polyforge.settings.configGroupFlatHint",
  daemon: "polyforge.settings.configGroupDaemonHint",
  workspace: "polyforge.settings.configGroupWorkspaceHint",
  summarize: "polyforge.settings.configGroupSummarizeHint",
};

/** The read snapshot the CAS compares: only the keys the file actually
 *  declares (source `file`), with api_key reduced to {set}. Keyed to the file
 *  the write targets, never the other file's keys. */
function expectedValues(items: PolyforgeConfigItem[], workspace: boolean): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const item of items) {
    if (item.section) continue;
    if (item.key.startsWith("summarize.") !== workspace) continue;
    if (item.source !== "file") continue;
    if (item.key === "api_key") { values[item.key] = { set: item.set === true }; continue; }
    if (item.value !== undefined) values[item.key] = item.value;
  }
  return values;
}

function itemValue(item: PolyforgeConfigItem): unknown {
  if (item.key === "api_key") return "";
  return item.value ?? "";
}

function formValue(key: string, raw: string): unknown {
  if (key === "api_key") return raw;
  if (isNumericKey(key)) return Number(raw);
  if (key === "summarize.models") return raw.split(",").map((part) => part.trim()).filter(Boolean);
  return raw;
}

/** One browser-stored numeric preference: the input, its Save beside it,
 *  and its visible hint. Saving clamps, stores and notifies the open panel;
 *  no request is made. */
function PanelPreferenceRow({ spec, value, label, hint, saveLabel }: {
  spec: PolyforgePreferenceSpec;
  value: number;
  label: string;
  hint: string;
  saveLabel: string;
}) {
  // null: untouched, the input shows the stored value.
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    writePolyforgePreference(spec, draft ?? value);
    setDraft(null);
  };
  return (
    <ConfigDetailGridRow label={label} tone="plain">
      <span className="polyforge-config-write">
        <input
          type="number"
          aria-label={label}
          min={spec.min}
          max={spec.max}
          step={1}
          value={draft ?? String(value)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); save(); }
          }}
        />
        <ConfigButton size="small" onClick={save}>{saveLabel}</ConfigButton>
      </span>
      <span className="config-scope-switch-reason">{hint}</span>
    </ConfigDetailGridRow>
  );
}

export function PolyforgeConfig({ cwd, active }: Props) {
  const { t } = useI18n();
  const [detect, setDetect] = useState<PolyforgeDetectStatus | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [sourceState, setSourceState] = useState<SourceState>({ status: "pending", source: null });
  const [toggleBusy, setToggleBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [config, setConfig] = useState<PolyforgeConfigRead | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [history, setHistory] = useState<PolyforgeConfigHistoryEntry[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [modelEdits, setModelEdits] = useState<Record<string, string[]>>({});
  const [modelAdds, setModelAdds] = useState<Record<string, string>>({});
  const [writeBusy, setWriteBusy] = useState<string | null>(null);
  const detectRanForActive = useRef(false);
  const { titleLength, pollIntervalSec } = usePolyforgePanelPreferences();

  const runDetect = useCallback(async (force: boolean) => {
    try {
      const response = await fetch(`/api/polyforge/detect${force ? "?force=1" : ""}`);
      const data = await response.json() as PolyforgeDetectStatus & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setDetect(data);
      setDetectError(null);
    } catch (error) {
      setDetectError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    if (!active) {
      detectRanForActive.current = false;
      return;
    }
    if (detectRanForActive.current) return;
    detectRanForActive.current = true;
    void runDetect(false);
  }, [active, runDetect]);

  const runConfigRead = useCallback(async () => {
    try {
      const response = await fetch(`/api/polyforge/config?cwd=${encodeURIComponent(cwd ?? "")}`);
      const data = await response.json() as PolyforgeConfigRead & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setConfig(data);
      setConfigError(null);
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : String(error));
    }
  }, [cwd]);

  const runHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/polyforge/config/history");
      const data = await response.json() as { entries?: PolyforgeConfigHistoryEntry[] };
      if (response.ok) setHistory(Array.isArray(data.entries) ? data.entries : []);
    } catch {
      // An unreadable history is simply empty; the write paths still work.
    }
  }, []);

  // A cwd change is a NEW snapshot: two mapped workspaces never share one
  // read's summarize values.
  useEffect(() => {
    if (!active) return;
    setDrafts({});
    setModelEdits({});
    setModelAdds({});
    void runConfigRead();
    void runHistory();
  }, [active, cwd, runConfigRead, runHistory]);

  useEffect(() => {
    if (!active) return;
    if (!cwd || !detect?.piSkillInstalled) {
      setSourceState({ status: "missing", source: null });
      return;
    }
    let cancelled = false;
    setSourceState({ status: "pending", source: null });
    void fetch(`/api/plugins?cwd=${encodeURIComponent(cwd)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as { packages?: PluginPackageInfo[] };
      })
      .then((data) => {
        if (cancelled) return;
        const row = data?.packages?.find((pkg) => pkg.scope === "global" && pkg.packageName === "polyforge") ?? null;
        setSourceState({ status: row ? "found" : "missing", source: row?.source ?? null });
      })
      .catch(() => {
        if (!cancelled) setSourceState({ status: "missing", source: null });
      });
    return () => { cancelled = true; };
  }, [active, cwd, detect?.piSkillInstalled]);

  const togglePackage = useCallback(async (enabled: boolean) => {
    if (!cwd || !sourceState.source) return;
    setToggleBusy(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const response = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: enabled ? "enable" : "disable", source: sourceState.source, scope: "global", cwd }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setActionMessage(t("polyforge.settings.packageToggled"));
      await runDetect(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setToggleBusy(false);
    }
  }, [cwd, sourceState.source, runDetect, t]);

  const save = useCallback(async (item: PolyforgeConfigItem) => {
    if (!config) return;
    const raw = isModelListKey(item)
      ? [
          ...(modelEdits[item.key] ?? modelListValue(item.value)),
          ...((modelAdds[item.key] ?? "").trim() ? [(modelAdds[item.key] ?? "").trim()] : []),
        ].filter((model, index, all) => all.indexOf(model) === index).join(",")
      : drafts[item.key] ?? String(itemValue(item));
    const value = formValue(item.key, raw);
    // pf's schema is enforced HERE so the form cannot submit 0 or 9; the
    // route still hands the value to pf, which stays the authority.
    const invalid = configValueError(item.key, value, item.schema);
    if (invalid) {
      setActionError(`${item.key}: ${invalid}`);
      setActionMessage(null);
      return;
    }
    setWriteBusy(item.key);
    setActionError(null);
    setActionMessage(null);
    try {
      const workspace = item.key.startsWith("summarize.");
      const hash = workspace ? config.workspaceFile?.sha256 : config.file?.sha256;
      const expectState = { file_sha256: hash ?? null, values: expectedValues(config.items, workspace) };
      const response = await fetch("/api/polyforge/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set",
          key: item.key,
          value,
          cwd: cwd ?? "",
          expect_state: expectState,
        }),
      });
      const data = await response.json() as { error?: string; message?: string; diff?: unknown };
      if (!response.ok || data.error) {
        throw new Error(data.diff ? `${data.error ?? "refused"} (${JSON.stringify(data.diff)})` : data.error ?? `HTTP ${response.status}`);
      }
      setActionMessage(data.message ?? t("polyforge.settings.configSaved"));
      setDrafts((current) => ({ ...current, [item.key]: item.key === "api_key" ? "" : current[item.key] ?? "" }));
      if (isModelListKey(item)) {
        setModelEdits((current) => { const next = { ...current }; delete next[item.key]; return next; });
        setModelAdds((current) => ({ ...current, [item.key]: "" }));
      }
      await runConfigRead();
      await runHistory();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setWriteBusy(null);
    }
  }, [config, cwd, drafts, modelAdds, modelEdits, runConfigRead, runHistory, t]);

  const reload = useCallback(async () => {
    setWriteBusy("__reload__");
    setActionError(null);
    try {
      const response = await fetch("/api/polyforge/config/reload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: cwd ?? "" }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setActionMessage(t("polyforge.settings.configReloaded"));
      await runConfigRead();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setWriteBusy(null);
    }
  }, [cwd, runConfigRead, t]);

  const rollback = useCallback(async (entry: PolyforgeConfigHistoryEntry) => {
    if (entry.key === "api_key" || entry.rollbackable === false) return;
    setWriteBusy(entry.id);
    setActionError(null);
    try {
      const response = await fetch("/api/polyforge/config/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, key: entry.key, old: entry.old, entry, cwd: cwd ?? "" }),
      });
      const data = await response.json() as { error?: string; message?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setActionMessage(data.message ?? t("polyforge.settings.configRolledBack"));
      await runConfigRead();
      await runHistory();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setWriteBusy(null);
    }
  }, [cwd, runConfigRead, runHistory, t]);

  const installCommand = t("polyforge.settings.installCommand");
  const copyInstallCommand = useCallback(async () => {
    setActionError(null);
    try {
      await navigator.clipboard.writeText(installCommand);
      setActionMessage(t("polyforge.settings.installCopied"));
    } catch {
      // Clipboard unavailable: the command text stays copyable by hand.
    }
  }, [installCommand, t]);

  const lineLabel = detect?.line === "internal"
    ? t("polyforge.settings.line.internal")
    : detect?.line === "public"
      ? t("polyforge.settings.line.public")
      : t("polyforge.settings.line.unknown");
  const switchReason = !cwd
    ? t("polyforge.settings.switchNeedsProject")
    : sourceState.status === "pending"
      ? t("polyforge.settings.switchResolving")
      : !sourceState.source
        ? t("polyforge.settings.switchNoPackage")
        : null;
  const switchReasonId = useId();
  const unset = t("polyforge.settings.configUnset");
  const configReason = !cwd
    ? t("polyforge.settings.configNeedsProject")
    : config?.capable === false
      ? config.reason ?? t("polyforge.settings.configUnavailable")
      : config && !config.mapped
        ? t("polyforge.settings.configUnmapped")
        : null;

  const reloadClassLabel = (reloadClass: string): string => {
    const key = RELOAD_CLASS_KEYS[reloadClass];
    return key ? t(key) : t("polyforge.settings.classUnknown", { class: reloadClass });
  };

  const addModel = (item: PolyforgeConfigItem) => {
    const addition = (modelAdds[item.key] ?? "").trim();
    if (!addition) return;
    setModelEdits((current) => {
      const base = current[item.key] ?? modelListValue(item.value);
      return { ...current, [item.key]: base.includes(addition) ? base : [...base, addition] };
    });
    setModelAdds((current) => ({ ...current, [item.key]: "" }));
  };

  const removeModel = (item: PolyforgeConfigItem, model: string) => {
    setModelEdits((current) => ({
      ...current,
      [item.key]: (current[item.key] ?? modelListValue(item.value)).filter((entry) => entry !== model),
    }));
  };

  const renderValue = (item: PolyforgeConfigItem, writable: boolean) => {
    if (item.section) {
      const projects = workspaceProjects(item.value);
      return projects.length > 0 ? (
        <span className="polyforge-config-chips" aria-label={t("polyforge.settings.configProjects")}>
          {projects.map((project) => (
            <span key={project} className="polyforge-config-chip">{project}</span>
          ))}
        </span>
      ) : <span className="polyforge-config-empty">{unset}</span>;
    }

    if (isModelListKey(item)) {
      const models = modelEdits[item.key] ?? modelListValue(item.value);
      const chips = models.length > 0 ? (
        <span className="polyforge-config-chips" aria-label={t("polyforge.settings.configModels")}>
          {models.map((model) => (
            <span key={model} className="polyforge-config-chip">
              <span className="polyforge-config-chip-label">{model}</span>
              {writable && (
                <button
                  type="button"
                  className="polyforge-config-chip-remove"
                  aria-label={`${t("polyforge.settings.configRemoveModel")} ${model}`}
                  onClick={() => removeModel(item, model)}
                >×</button>
              )}
            </span>
          ))}
        </span>
      ) : <span className="polyforge-config-empty">{unset}</span>;
      if (!writable) return chips;
      return (
        <span className="polyforge-config-write is-multiline">
          {chips}
          <span className="polyforge-config-write-row">
            <input
              type="text"
              aria-label={item.key}
              placeholder={t("polyforge.settings.configAddModel")}
              value={modelAdds[item.key] ?? ""}
              onChange={(event) => setModelAdds((current) => ({ ...current, [item.key]: event.target.value }))}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); addModel(item); }
              }}
            />
            <ConfigButton size="small" disabled={writeBusy !== null} onClick={() => void save(item)}>
              {t("polyforge.settings.configSave")}
            </ConfigButton>
          </span>
        </span>
      );
    }

    if (writable) {
      return (
        <span className="polyforge-config-write">
          <input
            type={item.key === "api_key" ? "password" : isNumericKey(item.key) ? "number" : "text"}
            aria-label={item.key}
            placeholder={item.key === "api_key" ? t("polyforge.settings.configApiKeyWriteOnly") : undefined}
            value={drafts[item.key] ?? String(itemValue(item))}
            min={item.schema?.min}
            max={item.schema?.max}
            step={item.schema?.kind === "int" ? 1 : undefined}
            onChange={(event) => setDrafts((current) => ({ ...current, [item.key]: event.target.value }))}
          />
          <ConfigButton size="small" disabled={writeBusy !== null} onClick={() => void save(item)}>
            {t("polyforge.settings.configSave")}
          </ConfigButton>
        </span>
      );
    }

    if (item.key !== "api_key" && isUnsetValue(item.value)) {
      return <span className="polyforge-config-empty">{unset}</span>;
    }
    return (
      <span className="polyforge-config-value">
        {item.key === "api_key" ? (item.set ? "<set>" : "<unset>") : JSON.stringify(item.value ?? null)}
      </span>
    );
  };

  // The section host is a block box, so the shared pane's own `flex: 1`
  // cannot bound it: the pane takes the host's height as the page's one
  // scroll region, and it brings the shared `.config-detail` inset
  //.
  return (
    <ConfigDetail>
      <ConfigDetailStack className="settings-polyforge">
        <ConfigSectionTitle>{t("polyforge.title")}</ConfigSectionTitle>

        {detectError && (
          <p role="alert" className="config-add-source-error">{detectError}</p>
        )}

        {detect?.pfPresent === false && (
          <p className="config-empty-state">{t("polyforge.settings.notInstalled")}</p>
        )}

        {detect && (
          <section className="polyforge-config-card polyforge-config-status" aria-label={t("polyforge.settings.configStatusTitle")}>
            <p className="polyforge-config-card-title">{t("polyforge.settings.configStatusTitle")}</p>
            <ConfigDetailGrid>
              <ConfigDetailGridRow label={t("polyforge.settings.version")} tone="plain" mono>
                {detect.pfVersion ?? t("polyforge.settings.line.unknown")}
                {detect.pfVersionBelowMinimum && (
                  <span style={{ color: "#d97706", marginLeft: 6 }}>{t("polyforge.settings.belowMinimum")}</span>
                )}
              </ConfigDetailGridRow>
              <ConfigDetailGridRow label={t("polyforge.settings.line")} tone="plain">
                {lineLabel}
              </ConfigDetailGridRow>
              <ConfigDetailGridRow label={t("polyforge.settings.piSkill")} tone="plain">
                {detect.piSkillInstalled
                  ? detect.piSkillEnabled
                    ? t("polyforge.settings.state.enabled")
                    : t("polyforge.settings.state.disabled")
                  : t("polyforge.settings.state.notInstalled")}
              </ConfigDetailGridRow>
              <ConfigDetailGridRow label={t("polyforge.settings.claudeSymlink")} tone="plain">
                {detect.claudeSkillsSymlink ? t("polyforge.settings.state.present") : t("polyforge.settings.state.absent")}
              </ConfigDetailGridRow>
              <ConfigDetailGridRow label={t("polyforge.settings.claudeHook")} tone="plain">
                {detect.claudeSessionStartHook ? t("polyforge.settings.state.present") : t("polyforge.settings.state.absent")}
              </ConfigDetailGridRow>
              <ConfigDetailGridRow label={t("polyforge.settings.daemon")} tone="plain">
                {detect.daemon === null
                  ? t("polyforge.settings.daemonNotApplicable")
                  : detect.daemon.reachable
                    ? t("polyforge.settings.daemonReachable")
                    : `${t("polyforge.settings.daemonUnreachable")}${detect.daemon.error ? `: ${detect.daemon.error}` : ""}`}
              </ConfigDetailGridRow>
            </ConfigDetailGrid>
          </section>
        )}

        {/* the Jobs-tab card preferences — browser-only, so
            shown whether or not pf is detected. Exactly these two controls. */}
        <section className="polyforge-config-card polyforge-config-cards" aria-label={t("polyforge.settings.cardsTitle")}>
          <p className="polyforge-config-card-title">{t("polyforge.settings.cardsTitle")}</p>
          <p className="polyforge-config-card-hint">{t("polyforge.settings.cardsHint")}</p>
          <ConfigDetailGrid>
            <PanelPreferenceRow
              spec={POLYFORGE_TITLE_LENGTH}
              value={titleLength}
              label={t("polyforge.settings.cardsTitleLength")}
              hint={t("polyforge.settings.cardsTitleLengthHint")}
              saveLabel={t("polyforge.settings.configSave")}
            />
            <PanelPreferenceRow
              spec={POLYFORGE_POLL_INTERVAL}
              value={pollIntervalSec}
              label={t("polyforge.settings.cardsPollInterval")}
              hint={t("polyforge.settings.cardsPollIntervalHint")}
              saveLabel={t("polyforge.settings.configSave")}
            />
          </ConfigDetailGrid>
        </section>

        <section className="polyforge-config-card polyforge-config-package" aria-label={t("polyforge.settings.packageSwitch")}>
          <p className="polyforge-config-card-title">{t("polyforge.settings.packageSwitch")}</p>
          <p className="polyforge-config-card-hint">{t("polyforge.settings.configPackageHint")}</p>
          <div className="polyforge-config-switch-row">
            {detect?.piSkillInstalled && (
              <ConfigSwitch
                checked={detect.piSkillEnabled}
                disabled={!cwd || !sourceState.source}
                loading={toggleBusy}
                label={t("polyforge.settings.packageSwitch")}
                describedBy={switchReason ? switchReasonId : undefined}
                onChange={(enabled) => void togglePackage(enabled)}
              />
            )}
            {switchReason && detect?.piSkillInstalled && (
              <span id={switchReasonId} className="config-scope-switch-reason">{switchReason}</span>
            )}
          </div>
        </section>

        <div className="polyforge-config-panel">
          <ConfigSectionTitle>{t("polyforge.settings.configTitle")}</ConfigSectionTitle>
          <p className="config-scope-switch-reason">{t("polyforge.settings.configMachineScope")}</p>
          {configError && <p role="alert" className="config-add-source-error">{configError}</p>}
          {configReason && <p className="config-scope-switch-reason">{configReason}</p>}
          {config && (
            <>
              {config.capable && groupConfigItems(config.items ?? []).map((group) => {
                const hasDaemon = group.id === "daemon";
                const classes = [...new Set(group.items.map((item) => item.class).filter((value): value is string => Boolean(value)))];
                return (
                  <section key={group.id} className="polyforge-config-card" aria-label={t(GROUP_TITLE[group.id])}>
                    <p className="polyforge-config-card-title">{t(GROUP_TITLE[group.id])}</p>
                    <p className="polyforge-config-card-hint">{t(GROUP_HINT[group.id])}</p>
                    {classes.length > 0 && (
                      <p className="polyforge-config-legend">
                        <span>{t("polyforge.settings.configLegend")}</span>
                        {classes.map((reloadClass) => (
                          <span key={reloadClass} className="polyforge-config-badge" title={reloadClass}>
                            {reloadClassLabel(reloadClass)}
                          </span>
                        ))}
                      </p>
                    )}
                    <div className={`polyforge-config-grid${hasDaemon ? " has-daemon" : ""}`}>
                      <div className="polyforge-config-grid-header" aria-hidden="true">
                        <span>{t("polyforge.settings.configColKey")}</span>
                        <span>{t("polyforge.settings.configColClass")}</span>
                        <span>{group.id === "workspace" ? t("polyforge.settings.configProjects") : t("polyforge.settings.configColFile")}</span>
                        {hasDaemon && <span>{t("polyforge.settings.configColDaemon")}</span>}
                      </div>
                      {group.items.map((item) => {
                        const writable = WRITABLE.has(item.key) && !item.section && (!item.key.startsWith("summarize.") || config.mapped);
                        const workspacePath = item.section ? workspaceSectionPath(item.key) : null;
                        const daemonCell = hasDaemon && isDaemonColumnKey(item.key);
                        return (
                          <div key={item.key} className={`polyforge-config-row${writable ? "" : " is-readonly"}${daemonCell ? "" : hasDaemon ? " no-daemon" : ""}`}>
                            <span className="polyforge-config-key">
                              {workspacePath !== null
                                ? <span className="polyforge-config-workspace-path">{shortenPath(workspacePath)}</span>
                                : item.key}
                            </span>
                            <span className="polyforge-config-class">
                              {item.class
                                ? <span className="polyforge-config-badge" title={item.class}>{reloadClassLabel(item.class)}</span>
                                : null}
                            </span>
                            <span className="polyforge-config-file">{renderValue(item, writable)}</span>
                            {daemonCell && (
                              <span className="polyforge-config-daemon">
                                {config.daemonReachable === false
                                  ? t("polyforge.settings.configDaemonDown")
                                  : item.daemon
                                    ? <>{t("polyforge.settings.configDaemonValue")}: {String(item.daemon.value)}{item.stale_reason ? ` (${item.stale_reason})` : ""}</>
                                    : <span className="polyforge-config-empty">{t("polyforge.settings.configUnset")}</span>}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
              {config.steps && config.steps.length > 0 && (
                <section className="polyforge-config-card polyforge-config-steps" aria-label={t("polyforge.settings.configCandidates")}>
                  <p className="polyforge-config-card-title">{t("polyforge.settings.configCandidates")}</p>
                  <p className="polyforge-config-card-hint">{t("polyforge.settings.configGroupCandidatesHint")}</p>
                  {groupStepsByProject(config.steps).map((group) => (
                    <details key={group.project ?? ""} className="polyforge-config-candidate-group" open>
                      <summary>
                        <span className="polyforge-config-candidate-project">{group.project ?? t("polyforge.settings.configAllProjects")}</span>
                        <span className="polyforge-config-candidate-count">{t("polyforge.settings.configCandidateCount", { count: group.steps.length })}</span>
                      </summary>
                      {group.steps.map((step) => (
                        <div key={step.step} className="polyforge-config-candidate-step">
                          <span className="polyforge-config-key">{step.step}</span>
                          {step.declared ? (
                            <span className="polyforge-config-chips">
                              {(step.models ?? []).map((model, index) => (
                                <span key={`${index}:${model}`} className="polyforge-config-chip">{model}</span>
                              ))}
                            </span>
                          ) : (
                            <span className="polyforge-config-empty">{t("polyforge.settings.configBundleDefault")}</span>
                          )}
                        </div>
                      ))}
                    </details>
                  ))}
                  {config.steps_complete === false && <p className="config-scope-switch-reason">{t("polyforge.settings.configStepsIncomplete")}</p>}
                </section>
              )}
              <div>
                <ConfigButton size="small" disabled={writeBusy !== null || !config.capable} onClick={() => void reload()}>
                  {t("polyforge.settings.configReload")}
                </ConfigButton>
              </div>
            </>
          )}
          {history.length > 0 && (
            <div className="polyforge-config-history">
              <p className="config-add-source-examples-label">{t("polyforge.settings.configHistory")}</p>
              {history.map((entry) => (
                <div key={entry.id} className="polyforge-config-history-row">
                  <span>{entry.key}</span>
                  <span>{JSON.stringify(entry.old)} → {JSON.stringify(entry.new)}</span>
                  {entry.rollbackable && entry.key !== "api_key" && (
                    <ConfigButton size="small" disabled={writeBusy !== null} onClick={() => void rollback(entry)}>
                      {t("polyforge.settings.configRollback")}
                    </ConfigButton>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <p className="config-add-source-examples-label">{t("polyforge.settings.installCommandTitle")}</p>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 12, margin: 0, wordBreak: "break-all", color: "var(--text-muted)" }}>
            {installCommand}
          </p>
          <ConfigButton size="small" onClick={() => void copyInstallCommand()}>
            {t("polyforge.settings.copyInstall")}
          </ConfigButton>
        </div>

        <ConfigFooter
          status={
            <ConfigFooterStatus
              summary={actionError ?? actionMessage ?? (detect ? t("polyforge.settings.detected") : t("polyforge.loading"))}
              tone={actionError ? "error" : "default"}
            />
          }
        >
          <ConfigButton size="small" disabled={!detect} onClick={() => void runDetect(true)}>
            {t("polyforge.settings.redetect")}
          </ConfigButton>
        </ConfigFooter>
      </ConfigDetailStack>
    </ConfigDetail>
  );
}
