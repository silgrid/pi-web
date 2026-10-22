"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { PolyforgeDetectStatus } from "@/lib/polyforge-detect";
import {
  ConfigButton,
  ConfigDetailGrid,
  ConfigDetailGridRow,
  ConfigDetailStack,
  ConfigFooter,
  ConfigFooterStatus,
  ConfigSectionTitle,
} from "./SettingsUi";

/**
 * Settings › Polyforge (pi#122): machine-level detection display + the
 * copyable install command, built from the shared `SettingsUi.tsx` blocks
 * (every word a prop). Detection runs once each time the section becomes
 * active (`active` re-runs it on every open) and again on 「重新检测」
 * (`?force=1`, bypassing the 60s presence cache) — never on a poll: no timer
 * exists in this section, and the dock's polling hook
 * (`hooks/usePolyforge.ts`) is deliberately NOT reused.
 *
 * Nothing here edits `cli.toml`, touches Claude Code config, or executes any
 * install — the install command is copyable text only.
 */

interface Props {
  /** True while the section is the settings dialog's active section. */
  active: boolean;
}

export function PolyforgeConfig({ active }: Props) {
  const { t } = useI18n();
  const [detect, setDetect] = useState<PolyforgeDetectStatus | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  // One detect per activation: React StrictMode remounts effects once in dev
  // (setup → cleanup → setup), and the guard keeps that simulated remount
  // from issuing a second request — the cadence is once per open, never a
  // poll. Deactivation resets it so the next open detects again.
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

  const installCommand = t("polyforge.settings.installCommand");
  const copyInstallCommand = useCallback(async () => {
    setActionError(null);
    try {
      await navigator.clipboard.writeText(installCommand);
      setActionMessage(t("polyforge.settings.installCopied"));
    } catch {
      // Clipboard unavailable (permission refused): no error surface — the
      // command text stays selectable, copyable by hand, never executed.
    }
  }, [installCommand, t]);

  const lineLabel = detect?.line === "internal"
    ? t("polyforge.settings.line.internal")
    : detect?.line === "public"
      ? t("polyforge.settings.line.public")
      : t("polyforge.settings.line.unknown");
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