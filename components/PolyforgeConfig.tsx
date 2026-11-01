"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { PolyforgeDetectStatus } from "@/lib/polyforge-detect";
import type { PolyforgeConfigHistoryEntry } from "@/lib/polyforge-config-history";
import type { PolyforgeConfigItem, PolyforgeConfigRead } from "@/lib/polyforge-config";
import { configValueError, stepValueError, stepWriteKey } from "@/lib/polyforge-config-schema";
import type { PolyforgeWorkflowsRead } from "@/lib/polyforge-workflows";
import {
  addCandidate,
  buildWorkflowRows,
  defaultProject,
  moveCandidate,
  removeCandidate,
  type WorkflowRow,
} from "@/lib/polyforge-workflows-pure";
import type { PluginPackageInfo } from "@/lib/api-types";
import { shortenPath } from "@/lib/display-path";
import {
  POLYFORGE_POLL_INTERVAL,
  POLYFORGE_TITLE_LENGTH,
  writePolyforgePreference,
  type PolyforgePreferenceSpec,
} from "@/lib/polyforge-panel-preferences";
import { usePolyforgePanelPreferences } from "@/hooks/usePolyforgePanelPreferences";
import { usePolyforgeDisclosure } from "@/hooks/usePolyforgeDisclosure";
import type { PolyforgeDisclosureRegion } from "@/lib/polyforge-disclosure";
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

type RowFeedback = { message: string; tone: "default" | "error" };

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

/** The rendered cards: the summarize items join the
 *  workspace mapping in the one 工作区 card, so no summarize card exists. */
type ConfigCardId = Exclude<ConfigGroupId, "summarize">;

/** Each source card's title and one-line hint. */
const GROUP_TITLE: Record<ConfigCardId, string> = {
  flat: "polyforge.settings.configGroupFlat",
  daemon: "polyforge.settings.configGroupDaemon",
  workspace: "polyforge.settings.workspaceTitle",
};
/** The disclosure region that folds each card's read-only rows. */
const GROUP_REGION: Record<ConfigCardId, PolyforgeDisclosureRegion> = {
  flat: "cliToml",
  daemon: "daemon",
  workspace: "workspace",
};
const GROUP_HINT: Record<ConfigCardId, string> = {
  flat: "polyforge.settings.configGroupFlatHint",
  daemon: "polyforge.settings.configGroupDaemonHint",
  workspace: "polyforge.settings.configGroupWorkspaceHint",
};

/** one 工作区 card carries the cli.toml `[workspace]` mapping
 *  rows and the workspace yaml's summarize rows (its memory_policy rows are
 *  added at render); every other card is unchanged, in pf's order. */
function configCards<T extends { key: string; section?: boolean }>(groups: { id: ConfigGroupId; items: T[] }[]): { id: ConfigCardId; items: T[] }[] {
  const summarize = groups.find((group) => group.id === "summarize")?.items ?? [];
  const cards = groups.filter((group): group is { id: ConfigCardId; items: T[] } => group.id !== "summarize");
  const workspace = cards.find((group) => group.id === "workspace");
  if (workspace) return cards.map((group) => (group === workspace ? { id: group.id, items: [...group.items, ...summarize] } : group));
  return summarize.length > 0 ? [...cards, { id: "workspace", items: summarize }] : cards;
}

/** The file a workspace-card row lives in (its visible source tag). */
function workspaceRowFile(item: { key: string; section?: boolean }): string {
  return item.section ? "cli.toml" : ".polyforge.yaml";
}

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

/** One region's open/closed toggle: a real button carrying
 *  aria-expanded/aria-controls; the chevron is CSS, the label is the children. */
function DisclosureToggle({ open, controls, onToggle, marker, children }: {
  open: boolean;
  controls: string;
  onToggle: () => void;
  /** Visible runtime note (an unsaved draft or an error keeps the region open). */
  marker?: string | null;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="polyforge-disclosure-toggle"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      {children}
      {marker ? <span className="polyforge-disclosure-marker">{marker}</span> : null}
    </button>
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
  // per-key save/validation results keyed by item.key, a
  // rollback's by entry.id, rendered under that row; the footer keeps only
  // page-level status (detection, package switch, Reload).
  const [rowFeedback, setRowFeedback] = useState<Record<string, RowFeedback>>({});
  const [installMessage, setInstallMessage] = useState<string | null>(null);
  const [config, setConfig] = useState<PolyforgeConfigRead | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [history, setHistory] = useState<PolyforgeConfigHistoryEntry[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [modelEdits, setModelEdits] = useState<Record<string, string[]>>({});
  const [modelAdds, setModelAdds] = useState<Record<string, string>>({});
  const [writeBusy, setWriteBusy] = useState<string | null>(null);
  const detectRanForActive = useRef(false);
  const { titleLength, pollIntervalSec } = usePolyforgePanelPreferences();
  // each region's open/closed state, this browser only.
  const { disclosure, setRegion } = usePolyforgeDisclosure();
  const regionId = useId();

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
    setRowFeedback({});
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
      setRowFeedback({ [item.key]: { message: invalid, tone: "error" } });
      return;
    }
    setWriteBusy(item.key);
    setRowFeedback({});
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
      setRowFeedback({ [item.key]: { message: data.message ?? t("polyforge.settings.configSaved"), tone: "default" } });
      setDrafts((current) => ({ ...current, [item.key]: item.key === "api_key" ? "" : current[item.key] ?? "" }));
      if (isModelListKey(item)) {
        setModelEdits((current) => { const next = { ...current }; delete next[item.key]; return next; });
        setModelAdds((current) => ({ ...current, [item.key]: "" }));
      }
      await runConfigRead();
      await runHistory();
    } catch (error) {
      setRowFeedback({ [item.key]: { message: error instanceof Error ? error.message : String(error), tone: "error" } });
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
    setRowFeedback({});
    try {
      const response = await fetch("/api/polyforge/config/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, key: entry.key, old: entry.old, entry, cwd: cwd ?? "" }),
      });
      const data = await response.json() as { error?: string; message?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setRowFeedback({ [entry.id]: { message: data.message ?? t("polyforge.settings.configRolledBack"), tone: "default" } });
      await runConfigRead();
      await runHistory();
    } catch (error) {
      setRowFeedback({ [entry.id]: { message: error instanceof Error ? error.message : String(error), tone: "error" } });
    } finally {
      setWriteBusy(null);
    }
  }, [cwd, runConfigRead, runHistory, t]);

  // A workflow-card write is a config write: the panel re-reads the config
  // and its history (the card re-reads its own facts).
  const onWorkflowWritten = useCallback(() => {
    void runConfigRead();
    void runHistory();
  }, [runConfigRead, runHistory]);

  const installCommand = t("polyforge.settings.installCommand");
  const copyInstallCommand = useCallback(async () => {
    setInstallMessage(null);
    try {
      await navigator.clipboard.writeText(installCommand);
      setInstallMessage(t("polyforge.settings.installCopied"));
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
  const daemonState = !detect || detect.daemon === null
    ? t("polyforge.settings.daemonNotApplicable")
    : detect.daemon.reachable
      ? t("polyforge.settings.daemonReachable")
      : `${t("polyforge.settings.daemonUnreachable")}${detect.daemon.error ? `: ${detect.daemon.error}` : ""}`;
  // The one visible detection line: abnormal states are named
  // here as text, so a collapsed region never hides them.
  const detectSummary = !detect
    ? null
    : detect.pfPresent === false
      ? t("polyforge.settings.notInstalled")
      : `${t("polyforge.settings.configSummary", {
        version: detect.pfVersion ?? t("polyforge.settings.line.unknown"),
        line: lineLabel,
        daemon: daemonState,
      })}${detect.pfVersionBelowMinimum ? ` · ${t("polyforge.settings.belowMinimum")}` : ""}`;
  // Until detection proves pf present and new enough, the install remedy
  // stays open whatever the stored state; the forced state is never stored.
  const installForced = !detect || detect.pfPresent === false || detect.pfVersionBelowMinimum === true;
  const detectAbnormal = Boolean(detect && (
    detect.pfPresent === false || detect.pfVersionBelowMinimum || (detect.daemon !== null && !detect.daemon.reachable)
  ));
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

  const renderFeedback = (id: string) => {
    const feedback = rowFeedback[id];
    if (!feedback) return null;
    return (
      <p
        className={`polyforge-config-row-feedback${feedback.tone === "error" ? " is-error" : ""}`}
        role={feedback.tone === "error" ? "alert" : undefined}
      >
        {feedback.message}
      </p>
    );
  };

  // A region holding an unsaved draft or a row error stays open and says so
  //; the lock is runtime state, never written to storage.
  const lockMarker = (ids: string[]): string | null => {
    if (ids.some((id) => rowFeedback[id]?.tone === "error")) return t("polyforge.settings.configErrorMarker");
    if (ids.some((id) => drafts[id] !== undefined || modelEdits[id] !== undefined || Boolean(modelAdds[id]?.trim()))) {
      return t("polyforge.settings.configDraftMarker");
    }
    return null;
  };
  const regionToggle = (region: PolyforgeDisclosureRegion, marker: string | null) => ({
    open: marker !== null || disclosure[region],
    marker,
    // While locked a toggle attempt keeps the region open and writes nothing.
    onToggle: () => { if (marker === null) setRegion(region, !disclosure[region]); },
  });

  const historyRegion = regionToggle("history", lockMarker(history.map((entry) => entry.id)));

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

        {detect && (
          <section className="polyforge-config-card polyforge-config-status" aria-label={t("polyforge.settings.configStatusTitle")}>
            <p className="polyforge-config-card-title">{t("polyforge.settings.configStatusTitle")}</p>
            <DisclosureToggle
              open={disclosure.detect}
              controls={`${regionId}-detect`}
              onToggle={() => setRegion("detect", !disclosure.detect)}
            >
              <span className={`polyforge-config-summary${detectAbnormal ? " is-warning" : ""}`}>{detectSummary}</span>
            </DisclosureToggle>
            <div id={`${regionId}-detect`} className="polyforge-disclosure-body" hidden={!disclosure.detect}>
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
                  {daemonState}
                </ConfigDetailGridRow>
              </ConfigDetailGrid>
            </div>
          </section>
        )}

        <div className="polyforge-config-panel">
          <ConfigSectionTitle>{t("polyforge.settings.configTitle")}</ConfigSectionTitle>
          <p className="config-scope-switch-reason">{t("polyforge.settings.configMachineScope")}</p>
          {configError && <p role="alert" className="config-add-source-error">{configError}</p>}
          {configReason && <p className="config-scope-switch-reason">{configReason}</p>}
          {config && (
            <>
              {config.capable && configCards(groupConfigItems(config.items ?? [])).map((group) => {
                const hasDaemon = group.id === "daemon";
                const region = GROUP_REGION[group.id];
                const isWorkspace = group.id === "workspace";
                // the 工作区 card's read-only memory_policy rows
                // (the default entry, then each mapped project's own lists).
                const policy = isWorkspace ? config.memoryPolicy ?? null : null;
                const memoryRows = policy
                  ? [
                      { key: "memory_policy.default", entry: policy.default },
                      ...Object.entries(policy.projects).map(([project, entry]) => ({ key: `memory_policy.${project}`, entry })),
                    ]
                  : [];
                const classes = [...new Set([...group.items.map((item) => item.class), ...(policy && memoryRows.length > 0 ? [policy.class] : [])]
                  .filter((value): value is string => Boolean(value)))];
                // the common rows are the seven writable keys, decided
                // by key definition (never by whether the cwd is mapped), in pf's
                // order; every other item folds under the card's counted disclosure.
                // in the 工作区 card the summarize keys are its
                // common rows; the mapping and memory_policy rows fold.
                const common = group.items.filter((item) => WRITABLE.has(item.key) && !item.section);
                const folded = group.items.filter((item) => !common.includes(item));
                const foldCount = folded.length + memoryRows.length;
                const fold = regionToggle(region, lockMarker(folded.map((item) => item.key)));
                const legend = classes.length > 0 && (
                  <p className="polyforge-config-legend">
                    <span>{t("polyforge.settings.configLegend")}</span>
                    {classes.map((reloadClass) => (
                      <span key={reloadClass} className="polyforge-config-badge" title={reloadClass}>
                        {reloadClassLabel(reloadClass)}
                      </span>
                    ))}
                  </p>
                );
                const gridHeader = (
                  <div className="polyforge-config-grid-header" aria-hidden="true">
                    <span>{t("polyforge.settings.configColKey")}</span>
                    <span>{t("polyforge.settings.configColClass")}</span>
                    <span>{t("polyforge.settings.configColFile")}</span>
                    {hasDaemon && <span>{t("polyforge.settings.configColDaemon")}</span>}
                  </div>
                );
                const renderRow = (item: PolyforgeConfigItem) => {
                  const writable = WRITABLE.has(item.key) && !item.section && (!item.key.startsWith("summarize.") || config.mapped);
                  const workspacePath = item.section ? workspaceSectionPath(item.key) : null;
                  const daemonCell = hasDaemon && isDaemonColumnKey(item.key);
                  return (
                    <div key={item.key} className={`polyforge-config-row${writable ? "" : " is-readonly"}${daemonCell ? "" : hasDaemon ? " no-daemon" : ""}`}>
                      <span className="polyforge-config-key">
                        {workspacePath !== null
                          ? <span className="polyforge-config-workspace-path">{shortenPath(workspacePath)}</span>
                          : isWorkspace ? <span className="polyforge-config-key-name">{item.key}</span> : item.key}
                        {isWorkspace
                          ? <span className="polyforge-config-file-tag" title={t("polyforge.settings.workspaceSourceFile")}>{workspaceRowFile(item)}</span>
                          : null}
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
                      {renderFeedback(item.key)}
                    </div>
                  );
                };
                // A memory_policy row: read-only, no write control, the yaml tag.
                const renderMemoryRow = ({ key, entry }: (typeof memoryRows)[number]) => (
                  <div key={key} className="polyforge-config-row is-readonly">
                    <span className="polyforge-config-key">
                      <span className="polyforge-config-key-name">{key}</span>
                      <span className="polyforge-config-file-tag" title={t("polyforge.settings.workspaceSourceFile")}>.polyforge.yaml</span>
                    </span>
                    <span className="polyforge-config-class">
                      {policy?.class ? <span className="polyforge-config-badge" title={policy.class}>{reloadClassLabel(policy.class)}</span> : null}
                    </span>
                    <span className="polyforge-config-file">
                      {entry.record.length === 0 && entry.skip.length === 0
                        ? <span className="polyforge-config-empty">{unset}</span>
                        : (["record", "skip"] as const).map((list) => entry[list].length > 0 && (
                          <span key={list} className="polyforge-config-chips" aria-label={list}>
                            <span className="polyforge-config-empty">{list}:</span>
                            {entry[list].map((value, index) => <span key={`${index}:${value}`} className="polyforge-config-chip">{value}</span>)}
                          </span>
                        ))}
                    </span>
                  </div>
                );
                // the legend and the column header sit above the
                // whole-card fold in every card, so collapsing a card hides rows only.
                return (
                  <section key={group.id} className="polyforge-config-card" aria-label={t(GROUP_TITLE[group.id])}>
                    <p className="polyforge-config-card-title">{t(GROUP_TITLE[group.id])}</p>
                    <p className="polyforge-config-card-hint">{t(GROUP_HINT[group.id])}</p>
                    {legend}
                    {(common.length > 0 || foldCount > 0) && (
                      <div className={`polyforge-config-grid${hasDaemon ? " has-daemon" : ""}`}>
                        {gridHeader}
                        {common.map(renderRow)}
                      </div>
                    )}
                    {foldCount > 0 && (
                      <>
                        <DisclosureToggle
                          open={fold.open}
                          controls={`${regionId}-${region}`}
                          onToggle={fold.onToggle}
                          marker={fold.marker}
                        >
                          {isWorkspace
                            ? t("polyforge.settings.configRowCount", { count: foldCount })
                            : t("polyforge.settings.configReadOnlyCount", { count: foldCount })}
                        </DisclosureToggle>
                        <div id={`${regionId}-${region}`} className="polyforge-disclosure-body polyforge-config-fold" hidden={!fold.open}>
                          {folded.length > 0 && (
                            <div className={`polyforge-config-grid${hasDaemon ? " has-daemon" : ""}`}>
                              {folded.map(renderRow)}
                            </div>
                          )}
                          {memoryRows.length > 0 && (
                            <>
                              <p className="polyforge-config-subtitle">{t("polyforge.settings.memoryPolicyTitle")}</p>
                              {policy?.appendToDefault && <p className="config-scope-switch-reason">{t("polyforge.settings.memoryPolicyAppendNote")}</p>}
                              <div className="polyforge-config-grid">
                                {memoryRows.map(renderMemoryRow)}
                              </div>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </section>
                );
              })}
              <div>
                <ConfigButton size="small" disabled={writeBusy !== null || !config.capable} onClick={() => void reload()}>
                  {t("polyforge.settings.configReload")}
                </ConfigButton>
              </div>
            </>
          )}
        </div>

        {/* the workflow card, right after the configuration
            cards: the step chains and attrs per project. */}
        <WorkflowCard
          cwd={cwd}
          active={active}
          regionId={regionId}
          reloadClassLabel={reloadClassLabel}
          onWritten={onWorkflowWritten}
        />

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

        {/* the read-outs come after the settings, each
            collapsed by default with its count in the title.:
            the read-only declared-candidates card is gone — the workflow
            card carries those step facts. */}
        {history.length > 0 && (
          <section className="polyforge-config-card" aria-label={t("polyforge.settings.configHistory")}>
            <p className="polyforge-config-card-title">
              <DisclosureToggle
                open={historyRegion.open}
                controls={`${regionId}-history`}
                onToggle={historyRegion.onToggle}
                marker={historyRegion.marker}
              >
                {t("polyforge.settings.configHistory")}{" "}
                <span className="polyforge-config-candidate-count">{t("polyforge.settings.configHistoryCount", { count: history.length })}</span>
              </DisclosureToggle>
            </p>
            <div id={`${regionId}-history`} className="polyforge-disclosure-body polyforge-config-history" hidden={!historyRegion.open}>
              {history.map((entry) => (
                <div key={entry.id} className="polyforge-config-history-row">
                  <span>{entry.key}</span>
                  <span>{JSON.stringify(entry.old)} → {JSON.stringify(entry.new)}</span>
                  {entry.rollbackable && entry.key !== "api_key" && (
                    <ConfigButton size="small" disabled={writeBusy !== null} onClick={() => void rollback(entry)}>
                      {t("polyforge.settings.configRollback")}
                    </ConfigButton>
                  )}
                  {renderFeedback(entry.id)}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* The install remedy is forced open, with no extra disclosure, until
            detection proves pf present and new enough. */}
        <section className="polyforge-config-card polyforge-config-install" aria-label={t("polyforge.settings.installCommandTitle")}>
          {/* The copy control sits on the title line, reachable without
              expanding; opening the region reveals only the command text. */}
          <div className="polyforge-config-install-head">
            {installForced ? (
              <p className="polyforge-config-card-title">{t("polyforge.settings.installCommandTitle")}</p>
            ) : (
              <p className="polyforge-config-card-title">
                <DisclosureToggle
                  open={disclosure.install}
                  controls={`${regionId}-install`}
                  onToggle={() => setRegion("install", !disclosure.install)}
                >
                  {t("polyforge.settings.installCommandTitle")}
                </DisclosureToggle>
              </p>
            )}
            <ConfigButton size="small" onClick={() => void copyInstallCommand()}>
              {t("polyforge.settings.copyInstall")}
            </ConfigButton>
            {installMessage && <span className="config-scope-switch-reason">{installMessage}</span>}
          </div>
          <div id={`${regionId}-install`} className="polyforge-disclosure-body polyforge-config-fold" hidden={!installForced && !disclosure.install}>
            <p style={{ fontFamily: "var(--font-mono)", fontSize: 12, margin: 0, wordBreak: "break-all", color: "var(--text-muted)" }}>
              {installCommand}
            </p>
          </div>
        </section>

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

/** One workflow-card row's pending edit state. */
type WorkflowRowFeedback = { message: string; tone: "default" | "error" };

/**
 * The workflow card: the installed bundles' steps for one
 * mapped project — `default` first, one row per step id across bundles, then
 * `task` — each with its declared chain (or Inherited), the effective chain
 * and its source level, the bundles it appears in, its declared attrs and
 * the live badge with the next-dispatch note. Reads `GET
 * /api/polyforge/workflows` (fresh per ↻ click, no cache: only the newest read
 * may write the card, a failed one keeps the last good list plus an error);
 * writes go through `POST /api/polyforge/config` with the yaml sha as the
 * CAS. Write controls fold under the `workflow` disclosure region and are
 * disabled, with the floor as visible text, while the running daemon does not
 * accept step attrs. `pf submit --models` is only noted, never edited.
 */
function WorkflowCard({ cwd, active, regionId, reloadClassLabel, onWritten }: {
  cwd: string | null;
  active: boolean;
  regionId: string;
  reloadClassLabel: (reloadClass: string) => string;
  onWritten: () => void;
}) {
  const { t } = useI18n();
  const { disclosure, setRegion } = usePolyforgeDisclosure();
  // The last good read: a failed refresh never clears it.
  const [read, setRead] = useState<PolyforgeWorkflowsRead | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  //'s ↻ pattern: busy while the newest read is in flight, and
  // only that newest read may write the card or end the spin.
  const [refreshing, setRefreshing] = useState(false);
  const readSeqRef = useRef(0);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [chainEdits, setChainEdits] = useState<Record<string, string[]>>({});
  const [chainAdds, setChainAdds] = useState<Record<string, string>>({});
  const [attrDrafts, setAttrDrafts] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, WorkflowRowFeedback>>({});
  const [writing, setWriting] = useState<string | null>(null);

  const runRead = useCallback(() => {
    const seq = ++readSeqRef.current;
    setRefreshing(true);
    fetch(`/api/polyforge/workflows?cwd=${encodeURIComponent(cwd ?? "")}`)
      .then(async (response) => {
        const body = await response.json() as PolyforgeWorkflowsRead & { error?: string };
        if (seq !== readSeqRef.current) return;
        setRefreshing(false);
        const good = response.ok && body.capable && body.workflows !== null && body.workflows.daemon_reachable;
        if (!good) {
          // Keep the list on screen; the error sits above it.
          setReadError(body.reason ?? body.error ?? `HTTP ${response.status}`);
          return;
        }
        setRead(body);
        setReadError(body.reason ?? null);
      })
      .catch((error: unknown) => {
        if (seq !== readSeqRef.current) return;
        setRefreshing(false);
        setReadError(error instanceof Error ? error.message : String(error));
      });
  }, [cwd]);

  useEffect(() => {
    if (!active) return;
    setChainEdits({});
    setChainAdds({});
    setAttrDrafts({});
    setFeedback({});
    runRead();
  }, [active, runRead]);

  const workflows = read?.workflows ?? null;
  const projects = workflows?.projects ?? [];
  const project = selectedProject !== null && projects.includes(selectedProject) ? selectedProject : defaultProject(projects);
  const rows = buildWorkflowRows(workflows, read?.workspace ?? null, project);
  const writeCapable = workflows?.write_capable === true && read?.workspace !== null && project !== null;
  const editorId = `${regionId}-workflow`;

  const draftIds = [
    ...Object.keys(chainEdits),
    ...Object.keys(attrDrafts),
    ...Object.entries(chainAdds).filter(([, value]) => value.trim() !== "").map(([id]) => id),
  ];
  const marker = Object.values(feedback).some((entry) => entry.tone === "error")
    ? t("polyforge.settings.configErrorMarker")
    : draftIds.length > 0 ? t("polyforge.settings.configDraftMarker") : null;
  const foldOpen = marker !== null || disclosure.workflow;

  const write = useCallback(async (rowId: string, key: string, action: "set" | "unset", value?: unknown) => {
    if (!project) return;
    setWriting(key);
    setFeedback({});
    try {
      const response = await fetch("/api/polyforge/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          key,
          ...(action === "set" ? { value } : {}),
          cwd: cwd ?? "",
          expect_state: { file_sha256: read?.workspace?.yaml.sha256 ?? null, values: {} },
        }),
      });
      const data = await response.json() as { error?: string; message?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setFeedback({ [rowId]: { message: data.message ?? t("polyforge.settings.configSaved"), tone: "default" } });
      setChainEdits((current) => { const next = { ...current }; delete next[rowId]; return next; });
      setChainAdds((current) => { const next = { ...current }; delete next[rowId]; return next; });
      setAttrDrafts((current) => {
        const next = { ...current };
        for (const id of Object.keys(next)) if (id.startsWith(`${rowId}.`)) delete next[id];
        return next;
      });
      runRead();
      onWritten();
    } catch (error) {
      setFeedback({ [rowId]: { message: error instanceof Error ? error.message : String(error), tone: "error" } });
    } finally {
      setWriting(null);
    }
  }, [cwd, onWritten, project, read, runRead, t]);

  const chainOf = (row: WorkflowRow) => chainEdits[row.id] ?? row.declaredModels ?? [];
  const editChain = (row: WorkflowRow, next: string[]) => setChainEdits((current) => ({ ...current, [row.id]: next }));
  const disabled = !writeCapable || writing !== null;

  const renderChips = (models: string[]) => models.length > 0 ? (
    <span className="polyforge-config-chips">
      {models.map((model, index) => <span key={`${index}:${model}`} className="polyforge-config-chip">{model}</span>)}
    </span>
  ) : <span className="polyforge-config-empty">{t("polyforge.settings.configUnset")}</span>;

  const renderEditor = (row: WorkflowRow) => {
    const chain = chainOf(row);
    const key = stepWriteKey(project ?? "", row.id);
    const save = () => {
      const pending = (chainAdds[row.id] ?? "").trim();
      const value = pending ? addCandidate(chain, pending) : chain;
      const invalid = stepValueError(key, value);
      if (invalid) { setFeedback({ [row.id]: { message: invalid, tone: "error" } }); return; }
      void write(row.id, key, "set", value);
    };
    return (
      <div className="polyforge-workflow-editor" hidden={!foldOpen}>
        <span className="polyforge-config-chips">
          {chain.map((model, index) => (
            <span key={`${index}:${model}`} className="polyforge-config-chip">
              <span className="polyforge-config-chip-label">{model}</span>
              <button type="button" className="polyforge-config-chip-remove" disabled={disabled || index === 0}
                aria-label={`↑ ${model}`} onClick={() => editChain(row, moveCandidate(chain, index, -1))}>↑</button>
              <button type="button" className="polyforge-config-chip-remove" disabled={disabled || index === chain.length - 1}
                aria-label={`↓ ${model}`} onClick={() => editChain(row, moveCandidate(chain, index, 1))}>↓</button>
              <button type="button" className="polyforge-config-chip-remove" disabled={disabled}
                aria-label={`${t("polyforge.settings.configRemoveModel")} ${model}`} onClick={() => editChain(row, removeCandidate(chain, index))}>×</button>
            </span>
          ))}
        </span>
        <span className="polyforge-config-write">
          <input
            type="text"
            aria-label={`${t("polyforge.settings.workflowChainAdd")} · ${row.id}`}
            placeholder={t("polyforge.settings.workflowChainAdd")}
            disabled={disabled}
            value={chainAdds[row.id] ?? ""}
            onChange={(event) => setChainAdds((current) => ({ ...current, [row.id]: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                editChain(row, addCandidate(chain, chainAdds[row.id] ?? ""));
                setChainAdds((current) => ({ ...current, [row.id]: "" }));
              }
            }}
          />
          <ConfigButton size="small" disabled={disabled} onClick={save}>{t("polyforge.settings.configSave")}</ConfigButton>
          <ConfigButton size="small" disabled={disabled || !row.declared} onClick={() => void write(row.id, key, "unset")}>
            {t("polyforge.settings.workflowChainClear")}
          </ConfigButton>
        </span>
        {row.attrs.map((attr) => {
          const attrKey = stepWriteKey(project ?? "", row.id, attr.name);
          const draftId = `${row.id}.${attr.name}`;
          const label = attr.name === "question_batch_size" ? t("polyforge.settings.workflowAttrBatch") : attr.name;
          if (attr.type !== "int") return null;
          return (
            <span key={attr.name} className="polyforge-config-write">
              <span className="polyforge-workflow-label">{label}</span>
              <input
                type="number"
                min={0}
                step={1}
                aria-label={label}
                disabled={disabled}
                value={attrDrafts[draftId] ?? String(attr.value)}
                onChange={(event) => setAttrDrafts((current) => ({ ...current, [draftId]: event.target.value }))}
              />
              <ConfigButton size="small" disabled={disabled} onClick={() => {
                const value = attrDrafts[draftId] ?? String(attr.value);
                const invalid = stepValueError(attrKey, value);
                if (invalid) { setFeedback({ [row.id]: { message: invalid, tone: "error" } }); return; }
                void write(row.id, attrKey, "set", Number(value));
              }}>{t("polyforge.settings.configSave")}</ConfigButton>
              <ConfigButton size="small" disabled={disabled || !attr.declared} onClick={() => void write(row.id, attrKey, "unset")}>
                {t("polyforge.settings.workflowChainClear")}
              </ConfigButton>
            </span>
          );
        })}
      </div>
    );
  };

  return (
    <section className="polyforge-config-card polyforge-workflow-card" aria-label={t("polyforge.settings.workflowTitle")}>
      <div className="polyforge-workflow-head">
        <p className="polyforge-config-card-title">{t("polyforge.settings.workflowTitle")}</p>
        {/*'s ↻: one fresh read per click; disabled, aria-busy
            and spinning while the newest read is in flight. */}
        <button
          type="button"
          className={`polyforge-workflow-refresh${refreshing ? " animate-spin" : ""}`}
          onClick={() => { runRead(); }}
          disabled={refreshing}
          aria-busy={refreshing}
          title={refreshing ? t("polyforge.refreshing") : t("polyforge.refresh")}
          aria-label={refreshing ? t("polyforge.refreshing") : t("polyforge.refresh")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </button>
      </div>
      <p className="polyforge-config-card-hint">{t("polyforge.settings.workflowHint")}</p>
      {readError && <p role="alert" className="config-add-source-error">{readError}</p>}
      {workflows && !workflows.write_capable && (
        <p className="config-scope-switch-reason">
          {t("polyforge.settings.workflowCapabilityHint")}{workflows.write_reason ? ` (${workflows.write_reason})` : ""}
        </p>
      )}
      {workflows && (
        <>
          <label className="polyforge-workflow-project">
            <span>{t("polyforge.settings.workflowProject")}</span>
            <select value={project ?? ""} onChange={(event) => setSelectedProject(event.target.value)} disabled={projects.length === 0}>
              {projects.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <p className="config-scope-switch-reason">{t("polyforge.settings.workflowSubmitNote")}</p>
          {workflows.bundle_errors.map((entry) => (
            <p key={entry.bundle} className="config-scope-switch-reason is-error">
              {t("polyforge.settings.workflowBundleError")}: {entry.bundle} — {entry.reason}
            </p>
          ))}
          <DisclosureToggle
            open={foldOpen}
            controls={editorId}
            onToggle={() => { if (marker === null) setRegion("workflow", !disclosure.workflow); }}
            marker={marker}
          >
            {t("polyforge.settings.workflowEditToggle")}
          </DisclosureToggle>
          <ul id={editorId} className="polyforge-workflow-list">
            {rows.map((row) => (
              <li key={row.id} className="polyforge-workflow-row">
                <div className="polyforge-workflow-head">
                  <span className="polyforge-workflow-id">{row.id}</span>
                  {row.kind === "default" && <span className="polyforge-workflow-kind">{t("polyforge.settings.workflowDefaultRow")}</span>}
                  {row.kind === "task" && <span className="polyforge-workflow-kind">{t("polyforge.settings.workflowTaskRow")}</span>}
                  <span className="polyforge-config-badge" title="live">{reloadClassLabel("live")}</span>
                </div>
                <p className="polyforge-workflow-note">{t("polyforge.settings.classLiveNote")}</p>
                {row.bundles.length > 0 && (
                  <p className="polyforge-workflow-line">
                    <span className="polyforge-workflow-label">{t("polyforge.settings.workflowBundleLabel")}</span>
                    {row.bundles.map((ref) => (
                      <span key={ref.bundle} className="polyforge-workflow-bundle">
                        <span className="polyforge-workflow-bundle-name">{ref.bundle}</span>
                        {ref.candidates && ref.candidates.length > 0 && <> {renderChips(ref.candidates)}</>}
                      </span>
                    ))}
                  </p>
                )}
                <p className="polyforge-workflow-line">
                  {row.declared ? (
                    <>
                      <span className="polyforge-workflow-label">{t("polyforge.settings.workflowDeclared")}</span>
                      {renderChips(row.declaredModels ?? [])}
                    </>
                  ) : (
                    <span className="polyforge-workflow-inherit">{t("polyforge.settings.workflowInherit")}</span>
                  )}
                </p>
                <div className="polyforge-workflow-effective">
                  <span className="polyforge-workflow-label">{t("polyforge.settings.workflowEffective")}</span>
                  {row.effective.length === 0 && <span className="polyforge-config-empty">{t("polyforge.settings.configUnset")}</span>}
                  {row.effective.map((view) => (
                    <span key={view.bundle ?? ""} className="polyforge-workflow-chain">
                      {view.bundle && <span className="polyforge-workflow-bundle-name">{view.bundle}</span>}
                      {renderChips(view.models)}
                      <span className="polyforge-workflow-from">{t("polyforge.settings.workflowSourceLabel")}: {view.from}</span>
                    </span>
                  ))}
                </div>
                {row.attrs.map((attr) => (
                  <p key={attr.name} className="polyforge-workflow-line">
                    <span className="polyforge-workflow-label">{attr.name === "question_batch_size" ? t("polyforge.settings.workflowAttrBatch") : attr.name}</span>
                    <span className="polyforge-config-value">{String(attr.value)}</span>
                    {!attr.declared && <span className="polyforge-workflow-inherit">{t("polyforge.settings.workflowInherit")}</span>}
                  </p>
                ))}
                {renderEditor(row)}
                {feedback[row.id] && (
                  <p className={`polyforge-config-row-feedback${feedback[row.id].tone === "error" ? " is-error" : ""}`} role={feedback[row.id].tone === "error" ? "alert" : undefined}>
                    {feedback[row.id].message}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
