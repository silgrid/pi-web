"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";

import { stripAnsi } from "@/lib/ansi";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
import { AnsiText } from "./AnsiText";
import { ExtensionWidgets } from "./ExtensionWidgets";

/**
 * `ctx.ui.setStatus("command:/mode toggle", "Build")` shows "Build" as a button
 * that sends `/mode toggle`. The command lives in the key because setStatus has
 * no room for it, and Pi's own footer prints only the text, so the same status
 * is still plain text there.
 */
export const EXTENSION_STATUS_COMMAND_PREFIX = "command:";

/** The slash command a status key asks for, or null for an ordinary status. */
export function extensionStatusCommand(key: string): string | null {
  if (!key.startsWith(EXTENSION_STATUS_COMMAND_PREFIX)) return null;
  const command = key.slice(EXTENSION_STATUS_COMMAND_PREFIX.length).trim();
  return command.length > 1 && command.startsWith("/") ? command : null;
}

export function sanitizeExtensionStatusText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").replace(/ +/g, " ").trim())
    .join("\n")
    .trim();
}

function sortedStatuses(statuses: ExtensionStatusItem[]): ExtensionStatusItem[] {
  return [...statuses].sort((a, b) => a.key.localeCompare(b.key));
}

export function formatExtensionStatusLine(statuses: ExtensionStatusItem[]): string {
  return sortedStatuses(statuses)
    .map(({ text }) => sanitizeExtensionStatusText(text))
    .join(" ");
}

type StatusCell =
  | { kind: "text"; text: string }
  | { kind: "command"; command: string; label: string };

/** One cell per status, in key order. A status with nothing visible to show has no cell. */
export function buildExtensionStatusCells(statuses: ExtensionStatusItem[]): StatusCell[] {
  const cells: StatusCell[] = [];
  for (const item of sortedStatuses(statuses)) {
    const text = sanitizeExtensionStatusText(item.text);
    const command = extensionStatusCommand(item.key);
    if (command) {
      const label = stripAnsi(text).replace(/\s+/g, " ").trim();
      cells.push({ kind: "command", command, label: label || command });
    } else if (stripAnsi(text).trim()) {
      cells.push({ kind: "text", text });
    }
  }
  return cells;
}

/**
 * pf-chat (the polyforge skill) refreshes a `polyforge` statusline widget on
 * every poll, but the Polyforge dock panel and topbar badge (pi#108) already
 * carry that progress, so that line would only repeat itself in every chat
 * pane. The exact key is dropped here, at the shelf's render boundary: no
 * trigger chip, no expanded panel, no update pulse — and the shelf is not
 * rendered when this widget was its only content. Every other key and all
 * statuses render unchanged (pi#111; no setting, exact match only).
 */
const POLYFORGE_WIDGET_KEY = "polyforge";

/**
 * The status line. Phones render it as a compact 28px ellipsized line; tapping
 * (or Enter/Space) expands it in place. The expand state lives here, so
 * ExtensionStatusBar itself stays hook-free.
 */
function ExtensionStatusLine({ label, children }: { label: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = () => setExpanded((value) => !value);
  const handleStatusKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleExpanded();
  };
  return (
    <div
      role="status"
      className={`extension-status-line${expanded ? " extension-status-expanded" : ""}`}
      aria-label={label}
      title={label}
      tabIndex={0}
      onClick={toggleExpanded}
      onKeyDown={handleStatusKeyDown}
    >
      <span className="extension-status-text">{children}</span>
    </div>
  );
}

export function ExtensionStatusBar({
  statuses,
  widgets = [],
  onCommand,
  commandsDisabled = false,
}: {
  statuses: ExtensionStatusItem[];
  widgets?: ExtensionWidgetItem[];
  /** Sends the command of a `command:` status; without it those buttons stay disabled. */
  onCommand?: (command: string) => void;
  commandsDisabled?: boolean;
}) {
  // The full text stays available through title/aria-label either way, and
  // the shelf is never hidden while it carries anything but a filtered
  // `polyforge` widget, because MCP disconnect diagnostics live here (pi#1).
  const visibleWidgets = widgets.filter(
    (widget) => widget.key !== POLYFORGE_WIDGET_KEY,
  );
  const cells = buildExtensionStatusCells(statuses);
  if (cells.length === 0 && visibleWidgets.length === 0) return null;

  const hasCommands = cells.some((cell) => cell.kind === "command");
  const plainStatusLine = cells
    .map((cell) => (cell.kind === "text" ? stripAnsi(cell.text) : cell.label))
    .join(" ");

  const statusLine = cells.length > 0 ? (
    <ExtensionStatusLine label={plainStatusLine}>
      {cells.map((cell, index) => cell.kind === "text" ? (
        <span key={index} className="extension-status-item">
          <AnsiText text={cell.text} />
        </span>
      ) : (
        <button
          key={index}
          type="button"
          className="extension-status-item extension-status-command"
          disabled={!onCommand || commandsDisabled}
          title={`${cell.label} · ${cell.command}`}
          aria-label={`${cell.label} (${cell.command})`}
          onClick={() => onCommand?.(cell.command)}
        >
          {cell.label}
        </button>
      ))}
    </ExtensionStatusLine>
  ) : null;

  return (
    <div
      className={`extension-status-shelf${visibleWidgets.length > 0 ? " has-widgets" : ""}${cells.length > 0 ? " has-status" : ""}${hasCommands ? " has-commands" : ""}`}
    >
      {visibleWidgets.length > 0 ? <ExtensionWidgets widgets={visibleWidgets}>{statusLine}</ExtensionWidgets> : statusLine}
    </div>
  );
}
