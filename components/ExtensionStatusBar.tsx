"use client";

import { useState, type KeyboardEvent } from "react";

import { stripAnsi } from "@/lib/ansi";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
import { AnsiText } from "./AnsiText";
import { ExtensionWidgets } from "./ExtensionWidgets";

export function sanitizeExtensionStatusText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").replace(/ +/g, " ").trim())
    .join("\n")
    .trim();
}

export function formatExtensionStatusLine(statuses: ExtensionStatusItem[]): string {
  return [...statuses]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ text }) => sanitizeExtensionStatusText(text))
    .join(" ");
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

export function ExtensionStatusBar({
  statuses,
  widgets = [],
}: {
  statuses: ExtensionStatusItem[];
  widgets?: ExtensionWidgetItem[];
}) {
  // Phones render the shelf as a compact 28px ellipsized line; tapping (or
  // Enter/Space) expands it in place. The full text stays available through
  // title/aria-label either way, and the shelf is never hidden while it
  // carries anything but a filtered `polyforge` widget, because MCP
  // disconnect diagnostics live here (pi#1).
  const visibleWidgets = widgets.filter(
    (widget) => widget.key !== POLYFORGE_WIDGET_KEY,
  );
  const [expanded, setExpanded] = useState(false);
  if (statuses.length === 0 && visibleWidgets.length === 0) return null;

  const statusLine = formatExtensionStatusLine(statuses);
  const plainStatusLine = stripAnsi(statusLine);

  const toggleExpanded = () => setExpanded((value) => !value);
  const handleStatusKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleExpanded();
  };

  return (
    <div
      className={`extension-status-shelf${visibleWidgets.length > 0 ? " has-widgets" : ""}${statuses.length > 0 ? " has-status" : ""}`}
    >
      {visibleWidgets.length > 0 && <ExtensionWidgets widgets={visibleWidgets} />}
      {statuses.length > 0 && (
        <div
          role="status"
          className={`extension-status-line${expanded ? " extension-status-expanded" : ""}`}
          aria-label={plainStatusLine}
          title={plainStatusLine}
          tabIndex={0}
          onClick={toggleExpanded}
          onKeyDown={handleStatusKeyDown}
        >
          <span className="extension-status-text">
            <AnsiText text={statusLine} />
          </span>
        </div>
      )}
    </div>
  );
}
