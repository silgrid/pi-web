"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { PolyforgeDetectStatus } from "@/lib/polyforge-detect";
import type { PolyforgeConfigHistoryEntry } from "@/lib/polyforge-config-history";
import type { PolyforgeConfigItem, PolyforgeConfigRead } from "@/lib/polyforge-config";
import { configValueError } from "@/lib/polyforge-config-schema";
import type { PluginPackageInfo } from "@/lib/api-types";
import {
  ConfigButton,
  ConfigDetailGrid,
  ConfigDetailGridRow,
  ConfigDetailStack,
  ConfigFooter,
  ConfigFooterStatus,
  ConfigSectionTitle,
  ConfigSwitch,
} from "./SettingsUi";

/**
 * Settings › Polyforge: machine-level detection (pi#122) plus the
 * configuration panel. Every read and write goes through
 * `/api/polyforge/**`, which in turn calls `pf`; this component never reads
 * or writes cli.toml / `.polyforge.yaml`. Why a control is unavailable is
 * visible text, never only a tooltip, and an api_key value is write-only.
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

/** The three keys the spec gives a daemon column (claude_bin does not). */
function isDaemonColumnKey(key: string): boolean {
  return key === "max_concurrent_jobs" || key === "step_timeout" || key === "stall_window";
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
  const [writeBusy, setWriteBusy] = useState<string | null>(null);
  const detectRanForActive = useRef(false);

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
    const raw = drafts[item.key] ?? String(itemValue(item));
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
      await runConfigRead();
      await runHistory();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setWriteBusy(null);
    }
  }, [config, cwd, drafts, runConfigRead, runHistory, t]);

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
  const configReason = !cwd
    ? t("polyforge.settings.configNeedsProject")
    : config?.capable === false
      ? config.reason ?? t("polyforge.settings.configUnavailable")
      : config && !config.mapped
        ? t("polyforge.settings.configUnmapped")
        : null;

  return (
    <ConfigDetailStack className="settings-polyforge">
      <ConfigSectionTitle>{t("polyforge.title")}</ConfigSectionTitle>

      {detectError && (
        <p role="alert" className="config-add-source-error">{detectError}</p>
      )}

      {detect?.pfPresent === false && (
        <p className="config-empty-state">{t("polyforge.settings.notInstalled")}</p>
      )}

      {detect && (
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
      )}

      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span>{t("polyforge.settings.packageSwitch")}</span>
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
        </div>
        {switchReason && detect?.piSkillInstalled && (
          <span id={switchReasonId} className="config-scope-switch-reason">{switchReason}</span>
        )}
      </div>

      <div className="polyforge-config-panel">
        <ConfigSectionTitle>{t("polyforge.settings.configTitle")}</ConfigSectionTitle>
        <p className="config-scope-switch-reason">{t("polyforge.settings.configMachineScope")}</p>
        {configError && <p role="alert" className="config-add-source-error">{configError}</p>}
        {configReason && <p className="config-scope-switch-reason">{configReason}</p>}
        {config && (
          <>
            {config.capable && (config.items ?? []).map((item) => {
              const writable = WRITABLE.has(item.key) && !item.section && (!item.key.startsWith("summarize.") || config.mapped);
              return (
                <div key={item.key} className="polyforge-config-row">
                  <span className="polyforge-config-key">{item.key}</span>
                  <span className="polyforge-config-class">{item.class}</span>
                  {writable ? (
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
                  ) : (
                    <span className="polyforge-config-value">{item.key === "api_key" ? (item.set ? "<set>" : "<unset>") : JSON.stringify(item.value ?? null)}</span>
                  )}
                  {isDaemonColumnKey(item.key) && (
                    <span className="polyforge-config-daemon">
                      {config.daemonReachable === false
                        ? t("polyforge.settings.configDaemonDown")
                        : item.daemon
                          ? <>{t("polyforge.settings.configDaemonValue")}: {String(item.daemon.value)}{item.stale_reason ? ` (${item.stale_reason})` : ""}</>
                          : null}
                    </span>
                  )}
                  {writable && (
                    <ConfigButton size="small" disabled={writeBusy !== null} onClick={() => void save(item)}>
                      {t("polyforge.settings.configSave")}
                    </ConfigButton>
                  )}
                </div>
              );
            })}
            {config.steps && config.steps.length > 0 && (
              <div className="polyforge-config-steps">
                <p className="config-add-source-examples-label">{t("polyforge.settings.configCandidates")}</p>
                {config.steps.map((step) => (
                  <div key={`${step.project ?? ""}:${step.step}`} className="polyforge-config-step">
                    <span>{step.project ? `${step.project}/${step.step}` : step.step}</span>
                    <span>{step.declared ? (step.models ?? []).join(", ") : t("polyforge.settings.configBundleDefault")}</span>
                  </div>
                ))}
                {config.steps_complete === false && <p className="config-scope-switch-reason">{t("polyforge.settings.configStepsIncomplete")}</p>}
              </div>
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
  );
}
