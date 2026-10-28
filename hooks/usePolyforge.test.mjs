import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const source = await readFile(new URL("./usePolyforge.ts", import.meta.url), "utf8");

function extractPureFunction(name) {
  const start = source.indexOf(`export function ${name}`);
  assert.ok(start >= 0, `${name} must be exported`);
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, `${name} body`);
  return source.slice(start, end + 2);
}

test("a degraded watch response keeps the previous snapshot (selection persistence)", () => {
  const context = vm.createContext({});
  vm.runInContext(
    stripTypeScriptTypes(extractPureFunction("nextWatchSnapshot").replace(/export /g, "")),
    context,
  );
  const snapshot = { wi: "wi_x", slug: "pi#108", workflowStatus: "running", steps: [], events: [] };
  assert.equal(context.nextWatchSnapshot(snapshot, { status: null }), snapshot, "null status keeps the snapshot");
  assert.equal(context.nextWatchSnapshot(snapshot, null), snapshot, "no body keeps the snapshot");
  assert.equal(context.nextWatchSnapshot(snapshot, {}), snapshot, "missing status keeps the snapshot");
  const next = { ...snapshot, workflowStatus: "done" };
  assert.equal(context.nextWatchSnapshot(snapshot, { status: next }), next, "a real snapshot replaces it");
});

test("one fetch at mount decides presence; a pf-less install never polls again", () => {
  assert.match(source, /useEffect\(\(\) => \{\s*refreshStatus\(\);/);
  assert.match(source, /return \(\) => \{\s*\+\+statusSeq\.current;/);
  assert.match(source, /if \(!probed \|\| !pfPresent\) return;/, "the cadence effect gates on presence");
});

test("effect cleanups advance the guard counters; they never rewind to an observation + 1", () => {
  assert.match(source, /return \(\) => \{\s*\+\+watchSeq\.current;\s*clearInterval\(interval\);/);
  assert.doesNotMatch(source, /seqAt\w+ \+ 1/, "a counter reset to seqAtX + 1 rewinds after interval polls");
});

test("cadence: 3s while the panel is open, 30s while closed", () => {
  assert.match(source, /const OPEN_STATUS_POLL_MS = 3000;/);
  assert.match(source, /const CLOSED_STATUS_POLL_MS = 30000;/);
  assert.match(source, /panelOpen \? OPEN_STATUS_POLL_MS : CLOSED_STATUS_POLL_MS/);
});

test("the watch poll runs every 3s while open with a selection", () => {
  assert.match(source, /if \(!panelOpen \|\| !selectedWi\) return;/);
  assert.match(source, /const OPEN_WATCH_POLL_MS = 3000;/);
});

test("the watch URL encodes the ref and stale fetches are dropped by sequence", () => {
  assert.match(source, /\/api\/polyforge\/watch\?wi=\$\{encodeURIComponent\(wi\)\}/);
  assert.match(source, /if \(seq !== statusSeq\.current\) return;/);
  assert.match(source, /if \(seq !== watchSeq\.current\) return;/);
});

test("selecting replaces the snapshot; the running count is null while unknown", () => {
  assert.match(source, /setWatchStatus\(null\);/);
  assert.match(source, /const runningCount = opsStatus \? opsStatus\.queue\.running : null;/, "no badge while the daemon is down");
});

test("pi#113: refreshStatus returns its settle promise for the manual-refresh feedback", () => {
  assert.match(source, /return fetch\("\/api\/polyforge\/status"\)/, "the fetch chain is returned");
  // The promise resolves on both success and failure paths (the .catch arm).
  const start = source.indexOf("const refreshStatus = useCallback");
  const end = source.indexOf("}, []);", start);
  const body = source.slice(start, end);
  assert.match(body, /\.catch\(\(\) => \{/);
  assert.match(body, /return fetch\("\/api\/polyforge\/status"\)/);
});

test("messages reuse the dock cadence and add no timer of their own", () => {
  assert.match(source, /setInterval\(refreshMessages, panelOpen \? OPEN_STATUS_POLL_MS : CLOSED_STATUS_POLL_MS\)/);
  assert.equal((source.match(/const (OPEN|CLOSED)_[A-Z_]+_MS =/g) ?? []).length, 3, "only the existing three cadence constants");
  assert.match(source, /const OPEN_WATCH_POLL_MS = 3000;/, "the open conversation refresh reuses the 3 s tick");
  assert.match(source, /setInterval\(\(\) => refreshOpen\(selectedConversation\), OPEN_WATCH_POLL_MS\)/);
});

test("one acknowledge per advance, naming the newest displayed seq", () => {
  assert.match(source, /import \{[\s\S]*ackDecision,[\s\S]*\} from "@\/lib\/polyforge-messages-pure"/);
  assert.match(source, /newestDisplayedSeq/);
  assert.match(source, /if \(seq <= \(lastAcked\.current\[conversationId\] \?\? 0\)\) return Promise\.resolve\(\);/, "already-acked seq is a no-op");
  assert.match(source, /lastAcked\.current\[conversationId\] = seq;/, "the optimistic stamp prevents a duplicate ack");
  assert.match(source, /if \(!statusReady\) return;/, "the blocked state is judged on this opening's own status read");
  assert.match(source, /explicit: true/, "the explicit gesture bypasses the blocked/visibility gate");
});

test("no message content or analysis is persisted in the browser", () => {
  assert.doesNotMatch(source, /(?:window\.)?(?:localStorage|sessionStorage)\./, "the hook writes neither storage");
  assert.match(source, /if \(!panelOpen\) setAnalyses\(\{\}\);/, "closing the dock drops the transient conclusion");
});

test("paging reads backwards, refresh reads forwards", () => {
  assert.match(source, /\?before=\$\{oldest\}/);
  assert.match(source, /\?after=\$\{newest\}/);
  assert.match(source, /mergeOlderPage\(previous, older\)/);
  assert.match(source, /mergeNewestPage\(previous, newer\)/);
  assert.match(source, /setHasOlder\(body\.has_older === true\)/, "paging ends on page fullness, not seq 1");
  assert.doesNotMatch(source, /page\[0\]\.seq > 1/, "the global AUTOINCREMENT seq is not a paging bound");
  assert.match(source, /blocked,/, "the messages surface receives the blocked state");
});

test("the first settled page is exposed so the panel can position while blocked", () => {
  assert.match(source, /setInitialPageLoaded\(conversationId\)/);
  assert.match(source, /initialPageLoaded: selectedConversation !== null && initialPageLoaded === selectedConversation/);
});

test("task-42: a send's answer opens the conversation it names, not a raced list read", () => {
  const start = source.indexOf("const sendMessage = useCallback");
  const end = source.indexOf("}, [refreshMessages, refreshOpen, selectedConversation, selectConversation]);", start);
  const body = source.slice(start, end);
  assert.match(body, /await refreshMessages\(\);/);
  assert.match(body, /const openedId = sent\?\.conversation_id \?\? null;/, "the conversation id comes from the send's own answer");
  assert.match(body, /if \(openedId && openedId !== selectedConversation\) \{\s*selectConversation\(openedId\);/, "a different conversation opens; the open one refreshes");
  assert.doesNotMatch(body, /rows\.find/, "no list-read match to race the polls");
  assert.match(source, /if \(selectedConversation\) \{\s*\/\/ Await the open conversation's refresh/);
});

test("the tab gains memory; Messages refresh stays gated on messages", () => {
  assert.match(source, /export type PolyforgeTab = "jobs" \| "messages" \| "memory";/);
  const start = source.indexOf("const setActiveTab = useCallback");
  const end = source.indexOf("}, [refreshMessages]);", start);
  const body = source.slice(start, end);
  assert.match(body, /if \(tab === "messages"\) void refreshMessages\(\);/, "only the messages tab refreshes the hook's list");
  assert.doesNotMatch(body, /memory/, "activating the Memory tab triggers no hook read");
});

test("task-42: the list read accepts responses by landing order, not start order", () => {
  // The mount/dock-open/tab burst starts three reads inside one latency
  // window; a start-order guard discarded the first response and blanked
  // the list until the last one landed. Acceptance is now by landing order:
  // a response older than one that already landed is still dropped.
  assert.match(source, /const messagesLandedSeq = useRef\(0\);/);
  assert.match(source, /if \(seq <= messagesLandedSeq\.current\) return null;/);
  assert.match(source, /messagesLandedSeq\.current = seq;/);
  assert.doesNotMatch(source, /seq !== messagesSeq\.current/, "no start-order discard remains for the list read");
});

test("task-42: re-selecting a conversation always fetches its newest page (the verification finding)", () => {
  // A cached page predates whatever arrived while the user was away; the
  // newest page on open is the base behaviour. The identity guard (below)
  // is the real two-column fix.
  assert.doesNotMatch(source, /pageCache/, "no cached page renders without a fetch");
  const start = source.indexOf("const selectConversation = useCallback");
  const end = source.indexOf("}, [loadNewestPage]);", start);
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /\.get\(conversationId\)/, "no kept-page branch");
  assert.match(body, /setInitialPageLoaded\(null\);\s*void loadNewestPage\(conversationId\);/, "selection clears and fetches the newest page");
});

test("task-42: the first list read starts at mount, ungated on the presence probe", () => {
  const start = source.indexOf("Messages use the same interval");
  const end = source.indexOf("}, [probed, pfPresent, panelOpen, refreshMessages]);", start);
  const body = source.slice(start, end);
  assert.match(body, /if \(probed && !pfPresent\) return;\s*refreshMessages\(\);\s*if \(!probed \|\| !pfPresent\) return;/, "the immediate read runs before the probe answers and never after an absent answer; only the interval needs presence");
});

test("task-42: page writes guard by conversation identity, not a page-generation counter", () => {
  // Opening Y while X is open must not invalidate Y's own in-flight first
  // page (the old counter's effect-cleanup bump did exactly that); a response
  // from a previous selection still never applies.
  assert.doesNotMatch(source, /pageSeq/, "no page-generation counter remains");
  assert.match(source, /const selectedConversationRef = useRef<string \| null>\(null\);/);
  assert.match(source, /selectedConversationRef\.current = conversationId;/);
  for (const site of ["loadNewestPage", "loadOlder", "refreshOpen"]) {
    const start = source.indexOf(`const ${site} = useCallback`);
    assert.ok(start >= 0, site);
    assert.ok(source.slice(start, start + 2000).includes("selectedConversationRef.current !== conversationId"), `${site} guards by identity`);
  }
});

test("task-42: every refreshMessages call starts its own read — no in-flight slot (the verification finding)", () => {
  // Sharing one in-flight read made sendMessage's awaited refresh resolve
  // with a list read that could predate the send, so a new conversation's
  // row and header name were missing until the next 3 s poll. Read-your-
  // write needs the post-send refresh to start its own read.
  assert.doesNotMatch(source, /inflightMessagesRef/, "no in-flight slot remains");
  const start = source.indexOf("const refreshMessages = useCallback");
  const end = source.indexOf("}, []);", start);
  const body = source.slice(start, end);
  assert.match(body, /return fetch\("\/api\/polyforge\/messages"\)/, "each call fetches on its own");
  assert.doesNotMatch(body, /\.finally\(/, "no slot to clear on settle");
});
