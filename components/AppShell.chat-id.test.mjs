import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// pi#121: the display-only ` · <id>` polyforge chat-id suffix on session
// tab labels. Source-assert suite (the repo's UI-test style): the
// behaviors that must hold shape-wise, each failing on the pre-pi#121
// code.

const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const splitPane = await readFile(new URL("./SplitPaneLayout.tsx", import.meta.url), "utf8");
const paneHeader = await readFile(new URL("./PaneHeader.tsx", import.meta.url), "utf8");
const hook = await readFile(new URL("../hooks/useSessionChatIds.ts", import.meta.url), "utf8");
const paneState = await readFile(new URL("../lib/pane-state.ts", import.meta.url), "utf8");
const paneTabState = await readFile(new URL("../lib/pane-tab-state.ts", import.meta.url), "utf8");

test("desktop pane headers carry the suffix: shortened id in the text, full id on the title", () => {
  // The id renders exactly as the panel renders a chat id: the panel's own
  // shortenCandidate (full id at ~21 chars), the FULL id on the hover title.
  assert.match(splitPane, /import \{ shortenCandidate \} from "\.\/PolyforgePanel"/);
  assert.match(splitPane, /`\$\{base\} · \$\{shortenCandidate\(chatId\)\}`/);
  assert.match(splitPane, /`\$\{base\} · \$\{chatId\}`/, "the hover title carries the FULL id");
  // Both render sites: the pane header AND the overflow menu entry.
  assert.equal(splitPane.split(/shortenCandidate\(chatId\)/).length - 1, 2, "header + overflow entry");
  // PaneHeader's title defaults to the label but accepts the full-id title.
  assert.match(paneHeader, /title=\{title \?\? label\}/);
});

test("the suffix is display-only: never persisted into tab.label or the pane-tab record", () => {
  // The persisted pane state (lib/pane-tab-state.ts) and the PaneTab shape
  // (lib/pane-state.ts) carry no chat id — the suffix is appended at
  // render time in SplitPaneLayout only.
  assert.doesNotMatch(paneState, /chatId/i);
  assert.doesNotMatch(paneTabState, /chatId/i);
  // AppShell's label sites (open/restore/create) stay suffix-free; the
  // chatIds map is only READ for rendering.
  assert.doesNotMatch(appShell, /label[^\n]*sessionChatIds/);
  assert.doesNotMatch(appShell, /sessionChatIds[^\n]*label/);
});

test("the labels resolve lazily, presence-gated, once per surface", () => {
  // AppShell feeds the hook pfPresent (usePolyforge's mount probe) and the
  // per-surface id set: pane tabs on desktop, the current session on mobile.
  assert.match(appShell, /useSessionChatIds\(pfPresent, chatIdSessionIds\)/);
  assert.match(appShell, /if \(isMobile\) \{\s*\n\s*return selectedSession && !selectedSession\.transient \? \[selectedSession\.id\] : \[\]/);
  assert.match(appShell, /\.filter\(\(tab\) => !isNewSessionTab\(tab\.sessionId\)\)/);
  assert.match(appShell, /chatIds=\{sessionChatIds\}/, "the resolved ids reach the pane layout");
  // A pf-less install issues NO request at all.
  assert.match(hook, /if \(!pfPresent\) return;/);
  // The request set is consumed once per id (no per-render refetch).
  assert.match(hook, /if \(requested\.has\(id\)\) continue;/);
});

test("absent answers render no suffix and raise no error surface", () => {
  // The server answers 200 {chatId: null} for every absent case; the client
  // accepts only a non-empty string and never throws.
  assert.match(hook, /if \(!response\.ok\) return;/);
  assert.match(hook, /typeof body\.chatId === "string" && body\.chatId/);
  assert.match(hook, /catch \{\s*\n\s*\/\/ Network blip: absent, no suffix, no error surface\.\s*\n\s*\}/);
});

test("the mobile current-session element shows the same suffix", () => {
  // The mobile layout carries no session-name header; the mobile toolbar's
  // session-stats button (data-mobile-toolbar-stats, aria "Session info")
  // is its current-session element, so the id rides there: shortened in the
  // text, the FULL id on the title.
  assert.match(appShell, /const currentChatId = mobile && selectedSession && !selectedSession\.transient/);
  assert.match(appShell, /title=\{currentChatId\}/);
  assert.match(appShell, /`\{`· \$\{shortenCandidate\(currentChatId\)\}`\`|\{`· \$\{shortenCandidate\(currentChatId\)\}`\}/);
});