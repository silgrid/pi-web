"use client";

import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useI18n } from "@/hooks/useI18n";
import { createTerminalWriter, terminalRequest } from "@/lib/terminal-client";
import { createTerminalPanelInput, type TerminalPanelInput } from "./terminal-panel-input";
import { createTerminalPanelStream, type TerminalPanelStream } from "./terminal-panel-stream";
import type { TerminalTab } from "./terminal-tab-state";

interface Props {
  tab: TerminalTab;
  active: boolean;
  onRestart: () => void;
  onClosed: () => void;
  onCloseError: () => void;
}

export function TerminalPanel({ tab, active, onRestart, onClosed, onCloseError }: Props) {
  const { t } = useI18n();
  const { id, cwd, restored } = tab;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const startRef = useRef<Promise<void>>(Promise.resolve());
  const writerRef = useRef<ReturnType<typeof createTerminalWriter> | null>(null);
  const callbacksRef = useRef({ onClosed, onCloseError });
  callbacksRef.current = { onClosed, onCloseError };
  const [status, setStatus] = useState<"connecting" | "ready" | "exited" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const inputRef = useRef<TerminalPanelInput | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    setStatus("connecting");
    setError(null);
    setExitCode(null);

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: getComputedStyle(container).getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 8000,
      screenReaderMode: true,
      // Input stays enabled from the start so keystrokes typed while the
      // panel settles are captured (and flushed once the shell exists)
      // instead of being silently swallowed; error/exit/offline paths below
      // still disable it.
      disableStdin: false,
      theme: {
        background: "#111318", foreground: "#d7dce5", cursor: "#60a5fa",
        selectionBackground: "#365b8a",
        black: "#1d222b", red: "#f87171", green: "#4ade80", yellow: "#facc15",
        blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#e5e7eb",
        brightBlack: "#6b7280", brightRed: "#fca5a5", brightGreen: "#86efac",
        brightYellow: "#fde047", brightBlue: "#93c5fd", brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9", brightWhite: "#ffffff",
      },
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "v") return false;
      if ((event.ctrlKey || event.metaKey) && key === "c" && terminal.hasSelection()) return false;
      return true;
    });

    const fitAndResize = () => {
      if (!container.offsetWidth || !container.offsetHeight) return;
      fit.fit();
    };

    let stream: TerminalPanelStream | null = null;
    const writer = createTerminalWriter(id, (reason) => {
      if (disposed) return;
      stream?.markInputFailed(reason.message);
    });
    writerRef.current = writer;
    // All terminal-input handling (early buffering, bare-input forwarding with
    // lifecycle-scoped dedup, and the disableStdin policy) lives in the
    // bridge; the SSE output stream, page-lifecycle suspension and the
    // failed-start input policy live in the stream controller — both so the
    // races between them are testable (pi#84).
    const inputBridge = createTerminalPanelInput(terminal, (data) => writer.write(data));
    inputRef.current = inputBridge;
    const onResize = terminal.onResize(({ cols, rows }) => {
      if (stream?.canResize()) writer.resize(cols, rows);
    });
    const resizeObserver = new ResizeObserver(fitAndResize);
    resizeObserver.observe(container);

    const createServerTerminal = () => terminalRequest("/api/terminal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, cwd, cols: terminal.cols, rows: terminal.rows }),
    });
    stream = createTerminalPanelStream({
      start: async () => {
        fitAndResize();
        if (reconnectKey > 0) {
          try {
            await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`);
          } catch (reason) {
            // An explicit Reconnect on a tab whose server terminal is gone
            // (server restart, lease expiry) revives the tab in place: same
            // id, fresh shell, so the panel is never a dead end.
            if (!navigator.onLine) throw reason;
            await createServerTerminal();
          }
        } else if (restored) {
          // Restoring a tab must never silently launch a replacement shell.
          await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`);
        } else {
          await createServerTerminal();
        }
      },
      openStream: (after) => new EventSource(
        `/api/terminal/${encodeURIComponent(id)}/events${after === undefined ? "" : `?after=${after}`}`,
      ),
      input: inputBridge,
      isOnline: () => navigator.onLine,
      addWindowListener: (type, handler) => window.addEventListener(type, handler),
      removeWindowListener: (type, handler) => window.removeEventListener(type, handler),
      onOutput: (data) => terminal.write(data),
      onReset: () => terminal.reset(),
      onStreamReady: () => {
        fitAndResize();
        writer.resize(terminal.cols, terminal.rows);
        if (container.offsetWidth && container.offsetHeight) terminal.focus();
      },
      onStatus: setStatus,
      onError: setError,
      onExited: (exitCode) => {
        setExitCode(exitCode);
        setStatus("exited");
      },
    });
    startRef.current = stream.started();

    return () => {
      disposed = true;
      stream?.dispose();
      void writer.stop();
      inputRef.current = null;
      resizeObserver.disconnect();
      inputBridge.dispose();
      onResize.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [id, cwd, restored, reconnectKey]);

  useEffect(() => {
    if (active) terminalRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (!tab.closing) return;
    let cancelled = false;
    inputRef.current?.suspendStdin();
    void (async () => {
      await startRef.current;
      await writerRef.current?.stop();
      await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true });
      if (!cancelled) callbacksRef.current.onClosed();
    })().catch((reason: Error) => {
      if (cancelled) return;
      setError(reason.message);
      setStatus("error");
      callbacksRef.current.onCloseError();
    });
    return () => { cancelled = true; };
  }, [id, tab.closing]);

  return (
    <section className="terminal-panel" aria-label={t("terminal.title")}>
      <header className="terminal-panel-header">
        <div className="terminal-panel-path">
          <span className={`terminal-status-dot is-${status}`} title={t(`terminal.${status}`)} />
          <span title={cwd}>{cwd}</span>
        </div>
        {status === "error" && (
          <button type="button" onClick={() => setReconnectKey((key) => key + 1)} disabled={Boolean(tab.closing)} title={t("terminal.reconnect")} aria-label={t("terminal.reconnect")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2" />
            </svg>
          </button>
        )}
        <button type="button" onClick={onRestart} disabled={Boolean(tab.closing)} title={t("terminal.restart")} aria-label={t("terminal.restart")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.34 5.66" /><polyline points="20 4 20 11 13 11" />
          </svg>
        </button>
      </header>
      <div>
        {error && <div className="terminal-panel-error" role="alert">{error}</div>}
        {status === "exited" && <div className="terminal-panel-exit" role="status">{exitCode === null ? t("terminal.exited") : t("terminal.exitCode", { code: exitCode })}</div>}
      </div>
      <div className="terminal-xterm"><div ref={containerRef} className="terminal-xterm-host" /></div>
    </section>
  );
}
