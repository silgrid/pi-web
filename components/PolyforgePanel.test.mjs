import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const source = await readFile(new URL("./PolyforgePanel.tsx", import.meta.url), "utf8");
const panelLayoutSource = await readFile(new URL("../lib/panel-layout.ts", import.meta.url), "utf8");
const enSource = await readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");
const zhCNSource = await readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");
const zhTWSource = await readFile(new URL("../lib/i18n/messages/zh-TW.ts", import.meta.url), "utf8");

function extractPureFunction(name) {
  const start = source.indexOf(`export function ${name}`);
  assert.ok(start >= 0, `${name} must be exported`);
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, `${name} body`);
  return source.slice(start, end + 2);
}

test("candidate shortening: >24 chars become the first 24 + ellipsis, nothing else changes", () => {
  const context = vm.createContext({});
  vm.runInContext(
    "const CANDIDATE_MAX = 24;\n" + stripTypeScriptTypes(
      extractPureFunction("shortenCandidate").replace(/export /g, "")
      + "\n" + stripTypeScriptTypes(extractPureFunction("formatAge").replace(/export /g, "")),
    ),
    context,
  );
  const long = "claude:claude-opus-5-5-extended-context-e2e";
  assert.equal(context.shortenCandidate(long), `${long.slice(0, 24)}…`);
  assert.equal(context.shortenCandidate("pi:glm-e2e"), "pi:glm-e2e", "24 chars and under pass through");
  assert.equal(context.shortenCandidate("x".repeat(24)), "x".repeat(24));
  assert.equal(context.shortenCandidate("x".repeat(25)), `x`.repeat(24) + "…");
  // Ages render compactly for the job list.
  assert.equal(context.formatAge(61), "1m");
  assert.equal(context.formatAge(7325), "2h 2m");
  assert.equal(context.formatAge(-1), "—");
});

test("job rows show slug and status label; candidate and ages live in the detail; the queue badge stays", () => {
  assert.match(source, /\{job\.slug\}/);
  assert.match(source, /jobStatusLabel\(job\.status\)/);
  const cardSource0 = source.slice(source.indexOf("const PolyforgeJobCard = memo("), source.indexOf("export function PolyforgePanel("));
  assert.doesNotMatch(cardSource0, /job\.spawnN|job\.candidate|job\.stepAgeSec|job\.idleAgeSec/, "the card no longer carries #spawnN, model or ages");
  assert.match(source, /\{selectedJob\.candidate \? shortenCandidate\(selectedJob\.candidate\) : "—"\}/, "the detail shows the model, shortened as the card did");
  assert.match(source, /#\{selectedJob\.spawnN\}/, "the detail keeps the spawn number");
  assert.match(source, /formatAge\(selectedJob\.stepAgeSec\)/);
  assert.match(source, /formatAge\(selectedJob\.idleAgeSec\)/);
  assert.match(source, /\{opsStatus\.queue\.running\} \/ \{opsStatus\.queue\.max\}/, "queue running/max as 2/4");
  // All jobs, no owner filter: the job list renders the sanitized jobs
  // wholesale. (pi#117: the DETAIL now shows the sanitized chat origin —
  // `owner` exists in the panel — so the no-filter guarantee is pinned on
  // the job-list block, not the whole file.)
  const jobListStart = source.indexOf("{/* Queue line + job card stream");
  const jobListEnd = source.indexOf("{/* Detail for the selected work item */}");
  assert.ok(jobListStart >= 0 && jobListEnd > jobListStart, "job list block boundaries");
  const jobList = source.slice(jobListStart, jobListEnd);
  assert.doesNotMatch(jobList, /owner/, "the job list must not filter by owner");
  // every job is a card, rendered in the server's order.
  assert.match(jobList, /shownCards\.map\(\(card: PolyforgeCard\) =>/, "the stream renders every card");
  const cardStart = source.indexOf("const PolyforgeJobCard = memo(");
  assert.ok(cardStart >= 0, "the card component exists");
  const cardSource = source.slice(cardStart, source.indexOf("export function PolyforgePanel("));
  assert.doesNotMatch(cardSource, /owner/, "a card never filters by owner");
  assert.match(cardSource, /const baseStatusLabel = jobStatusLabel\(job\.status\);/);
  assert.match(cardSource, /runningMinutes === null \? baseStatusLabel : `\$\{baseStatusLabel\} \$\{runningMinutes\}m`/, "the running age rides the same label");
});

test("the detail shows the flow graph, event tail, and status-only blocked rendering, with no step-chip block", () => {
  // Graph nodes: the node row maps buildStepGraph(...).nodes; each node is a
  // display-only listitem carrying title+aria-label with full name + status.
  assert.match(source, /const graph = watchStatus\s*\?\s*buildStepGraph\(watchStatus\.steps, watchStatus\.declared_steps, watchStatus\.events\)/, "graph derived from the sanitized snapshot");
  assert.match(source, /graph\.nodes\.map\(\(node, index\) =>/, "node row maps the graph model");
  assert.match(source, /role="listitem"/, "nodes are display-only list items");
  assert.match(source, /aria-label=\{\`\$\{node\.id\} · \$\{stepStatusLabel\(node\.status\)\}\`\}/, "accessible label carries full name + status");
  assert.match(source, /\{shortenCandidate\(node\.id\)\}/, "visible node text is the 24-char cut");
  // owner 有意变更: the node shows the name and the
  // dot only — the localized state is in title and aria-label (both pinned),
  // never a visible span; skipped is a hollow gray ring, every other status
  // keeps the filled stepNodeColor dot (pending stays filled gray).
  // owner 有意变更 the title also carries the step's start time when it has one.
  assert.match(source, /title=\{\`\$\{node\.id\} · \$\{stepStatusLabel\(node\.status\)\}\$\{timing \? \` · \$\{formatEventTime\(timing\.startedAt\)\}\` : ""\}\`\}/, "title carries full name + status (+ start time)");
  assert.match(source, /\{shortenCandidate\(node\.id\)\}\s*<\/span>/, "the node's visible content ends with the shortened name");
  assert.doesNotMatch(source, /<span[^>]*>\{stepStatusLabel\(node\.status\)\}<\/span>/, "no visible localized state label on the node");
  assert.match(source, /style=\{node\.status === "skipped"\s*(?:\/\/[^\n]*\n\s*)?\? \{ width: 7, height: 7, borderRadius: 4, flexShrink: 0, boxSizing: "border-box", background: "transparent", border: "1\.5px solid var\(--text-dim\)" \}\s*: \{ width: 7, height: 7, borderRadius: 4, flexShrink: 0, background: stepNodeColor\(node\.status\) \}\}/, "skipped is a hollow gray ring; every other status keeps the filled stepNodeColor dot");
  assert.match(source, /pending: "var\(--text-dim\)",/, "pending stays the filled gray dot");
  assert.match(source, /className=\{node\.status === "in_progress" \? "pf-step-node-pulse" : undefined\}/, "only in_progress pulses");
  // Sequence connectors between consecutive nodes; dashed rewind chips below.
  assert.match(source, /graph\.rewindEdges\.map\(\(\[gate, target\]\) =>/, "rewind chips render from the model");
  // pi#116: the pre-graph per-step name+status chip block is gone — the
  // graph nodes are the only step STATUS display in every event mode.
  // (pi#117 per-step TIMING — owner 有意变更 now a line under
  // each node — shows duration and ×N, never a status label.)
  const timingStart = source.indexOf("data-pf-step-timing={node.id}");
  assert.ok(timingStart >= 0, "the per-step timing lines exist (pi#117, under the nodes since)");
  const timingLine = source.slice(timingStart, source.indexOf("</span>", timingStart));
  assert.doesNotMatch(timingLine, /stepStatusLabel|STEP_STATUS_KEYS|role="listitem"|title=/, "timing lines must not render step status labels, nodes or a title");
  assert.match(source, /watchStatus\.events\.map\(\(event, index\) =>/);
  assert.match(source, /eventKindLabel\(event\.kind\)/);
  assert.match(source, /workflowStatusLabel\(watchStatus\.workflowStatus\)/, "a blocked WI shows its status");
  // No question text exists anywhere in the client: the only data source is
  // the sanitized watch snapshot, and the panel never references one.
  assert.doesNotMatch(source, /question/i);
});

test("empty, loading, and unavailable states are explicit", () => {
  assert.match(source, /\{t\("polyforge\.unavailable"\)\}/);
  assert.match(source, /\{t\("polyforge\.empty"\)\}/);
  assert.match(source, /\{t\("polyforge\.loading"\)\}/);
  assert.match(source, /\{t\("polyforge\.selectJob"\)\}/);
});

test("the selected detail carries an explicit deselect control (AC6 once the job leaves the list)", () => {
  // The detail header's back button calls onSelect(null) — the only gesture
  // that survives the selected job leaving the list (its row is gone) or the
  // watch snapshot still loading (header hoisted over the watchStatus split).
  assert.match(source, /onClick=\{\(\) => onSelect\(null\)\}/, "detail must have a deselect gesture outside the job rows");
  assert.match(source, /aria-label=\{t\("polyforge\.deselect"\)\}/, "accessible name via polyforge.deselect");
  // owner 有意变更 the old detail header became the title row;
  // it still shows the selected ref while the snapshot loads (the slug falls
  // back to the selected job's, then the selection ref) and sits above the
  // watchStatus split, so the stale detail is always dismissable.
  assert.match(source, /const detailSlug = watchStatus\?\.slug \?\? selectedJob\?\.slug \?\? selectedWi;/);
  const titleRow = source.indexOf("data-pf-detail-title");
  assert.ok(titleRow >= 0 && titleRow < source.indexOf("{graph ? (", titleRow), "the title row precedes the watch-gated detail");
  const row = source.slice(titleRow, source.indexOf("\n                          </div>\n", titleRow));
  assert.match(row, /onClick=\{\(\) => onSelect\(null\)\}/, "the deselect control sits in the title row");
  assert.match(row, /\{detailSlug\}/);
  // The key is translated in all three locales (fallback would be a raw key).
  for (const [name, localeSource] of [["en", enSource], ["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    assert.match(localeSource, /"polyforge\.deselect": "\S/, `${name} must translate polyforge.deselect`);
  }
  // Accessible name must not collide with the topbar button locator, whose
  // name carries "Polyforge" (see e2e/polyforge.mjs pfButton).
  const enMatch = enSource.match(/"polyforge\.deselect": "([^"]+)"/);
  assert.ok(enMatch && !/polyforge/i.test(enMatch[1]), "deselect label must not contain Polyforge");
});

test("the title row shows deselect, slug, the short title (one ellipsized line) and the job status; the rest is on hover", () => {
  const start = source.indexOf("data-pf-detail-title");
  const row = source.slice(start, source.indexOf("\n                          </div>\n", start));
  const order = ["onSelect(null)", "{detailSlug}", "{detailShortTitle}", "{detailStatus}"].map((needle) => row.indexOf(needle));
  assert.ok(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), `one line in order: ${order}`);
  assert.match(row, /title=\{detailTitleHover \|\| undefined\}/, "the hover carries the facts");
  assert.match(row, /\{detailShortTitle && \(\s*<span style=\{\{ flex: "1 1 0", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"/, "the short title is one ellipsized line, absent without a goal");
  assert.match(source, /const detailShortTitle = shortJobTitle\(detailGoal\);/, "the pure first-clause heuristic, no model");
  assert.match(source, /const detailStatus = selectedJob\s*\? jobStatusLabel\(selectedJob\.status\)\s*: watchStatus \? workflowStatusLabel\(watchStatus\.workflowStatus\) : null;/);
  const hover = source.slice(source.indexOf("const detailTitleHover = ["), source.indexOf('].filter(Boolean).join("\\n");'));
  for (const fact of ["detailGoal", "workflowStatusLabel(watchStatus.workflowStatus)", 't("polyforge.updatedAt")', 't("polyforge.currentStep")']) {
    assert.ok(hover.includes(fact), `the hover carries ${fact}`);
  }
});

test("every user-facing string goes through i18n, with raw fallback for unknown values", () => {
  const usedKeys = [...source.matchAll(/t\("([a-zA-Z.]+)"\)/g)].map((m) => m[1]);
  assert.ok(usedKeys.length >= 4, `expected i18n keys, got ${usedKeys.length}`);
  for (const key of usedKeys) {
    assert.ok(key.startsWith("polyforge."), `unnamespaced key: ${key}`);
  }
  // Unknown statuses pass through raw instead of a missing-key warning.
  assert.match(source, /JOB_STATUS_KEYS\.has\(status\) \? t\(`polyforge\.jobStatus\.\$\{status\}`\) : status/);
  assert.match(source, /STEP_STATUS_KEYS\.has\(status\) \? t\(`polyforge\.stepStatus\.\$\{status\}`\) : status/);
  assert.match(source, /EVENT_KIND_KEYS\.has\(kind\) \? t\(`polyforge\.eventKind\.\$\{kind\}`\) : kind/);
});

test("all three locales carry the polyforge keys in parity", () => {
  const keyOf = (localeSource) => [
    ...localeSource.matchAll(/^\s*"((?:polyforge|bgTasks)\.[a-zA-Z._]+)":/gm),
  ].map((m) => m[1]).filter((key) => key.startsWith("polyforge."));
  const enKeys = keyOf(enSource);
  assert.ok(enKeys.length >= 40, `expected the full polyforge key set in en, got ${enKeys.length}`);
  for (const [name, localeSource] of [["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    const keys = keyOf(localeSource);
    assert.deepEqual(keys, enKeys, `${name} must carry the exact en key set in order`);
    assert.ok(!localeSource.includes("polyforge.queue\": \"Queue\""), `${name} must actually translate, not copy en`);
  }
});

test("pi#112: EVENT_KIND_KEYS covers exactly the 19 live kinds with raw fallback", () => {
  const match = source.match(/const EVENT_KIND_KEYS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(match, "EVENT_KIND_KEYS set literal");
  const kinds = [...match[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const expected = [
    "published", "transcript_missing", "exec_init", "step_started", "step_done",
    "step_failed", "step_dead", "candidate_switched", "needs_input", "answered",
    "gate_verdict", "rewind", "envelope_rejected", "needs_recovery", "push_failed",
    "job_started", "job_stopped", "terminal", "authored_tests_rebaselined",
  ];
  assert.equal(kinds.length, 19, `expected 19 kinds, got ${kinds.length}`);
  assert.deepEqual(kinds.slice().sort(), expected.slice().sort());
  assert.match(source, /EVENT_KIND_KEYS\.has\(kind\) \? t\(`polyforge\.eventKind\.\$\{kind\}`\) : kind/, "unknown kinds must render raw");
});

test("pi#112: collapseNoiseRuns collapses noise runs to one marker, meaningful events never collapse", () => {
  const context = vm.createContext({});
  // The helper reads the module-level noise set; inject it from source so the
  // test tracks the shipped definition rather than a copy.
  const noiseSet = source.match(/const EVENT_NOISE_KINDS = new Set\(\[[\s\S]*?\]\)/);
  assert.ok(noiseSet, "EVENT_NOISE_KINDS set literal");
  vm.runInContext(stripTypeScriptTypes(noiseSet[0]), context);
  vm.runInContext(stripTypeScriptTypes(extractPureFunction("collapseNoiseRuns").replace(/export /g, "")), context);
  const ev = (kind, i) => ({ at: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`, kind });
  // JSON round-trip normalizes cross-realm object prototypes from the vm.
  const rows = JSON.parse(JSON.stringify(context.collapseNoiseRuns([
    ev("step_started", 0),
    ev("published", 1), ev("transcript_missing", 2), ev("exec_init", 3), ev("published", 4), ev("published", 5),
    ev("step_failed", 6),
    ev("transcript_missing", 7),
    ev("terminal", 8),
  ])));
  assert.deepEqual(rows, [
    { noise: false, event: ev("step_started", 0) },
    { noise: true, count: 5 },
    { noise: false, event: ev("step_failed", 6) },
    { noise: true, count: 1 },
    { noise: false, event: ev("terminal", 8) },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.collapseNoiseRuns([]))), [], "empty tail yields no rows");
});

test("pi#112: formatEventValues renders step · from → to for candidate_switched", () => {
  const context = vm.createContext({});
  const arrowSet = source.match(/const EVENT_ARROW_KINDS = new Set\(\[[\s\S]*?\]\)/);
  assert.ok(arrowSet, "EVENT_ARROW_KINDS set literal");
  vm.runInContext("const CANDIDATE_MAX = 24;\n" + stripTypeScriptTypes(arrowSet[0]), context);
  vm.runInContext(stripTypeScriptTypes(extractPureFunction("shortenCandidate").replace(/export /g, "")), context);
  vm.runInContext(stripTypeScriptTypes(extractPureFunction("eventValueParts").replace(/export /g, "")), context);
  vm.runInContext(stripTypeScriptTypes(extractPureFunction("formatEventValues").replace(/export /g, "")), context);
  const ev = { at: "2026-01-01T00:00:00Z", kind: "candidate_switched", step: "alpha-plan", from: "pi:old", to: "claude:new" };
  assert.equal(context.formatEventValues(ev), "alpha-plan · pi:old → claude:new", "step must be rendered before from → to");
  const longStep = { at: "2026-01-01T00:00:00Z", kind: "candidate_switched", step: "s".repeat(30), from: "pi:old", to: "claude:new" };
  const rendered = context.formatEventValues(longStep);
  assert.ok(rendered.includes("…"), "long step is ellipsized");
  assert.ok(rendered.includes(" → "), "arrow pair preserved");
  // Other kinds keep the plain dot join.
  assert.equal(context.formatEventValues({ at: "2026-01-01T00:00:00Z", kind: "step_started", step: "zulu-grill", model: "m" }), "zulu-grill · m");
  assert.equal(context.formatEventValues({ at: "2026-01-01T00:00:00Z", kind: "rewind", gate: "spec-review", target: "kilo-author" }), "spec-review → kilo-author");
  // Absent optional fields never produce stray separators.
  assert.equal(context.formatEventValues({ at: "2026-01-01T00:00:00Z", kind: "candidate_switched", from: "pi:old", to: "claude:new" }), "pi:old → claude:new");
});

test("pi#112: eventSeverity map is amber/red/green/neutral including terminal statuses", () => {
  const context = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(extractPureFunction("eventSeverity").replace(/export /g, "")), context);
  assert.equal(context.eventSeverity({ kind: "needs_input" }), "amber");
  for (const kind of ["step_failed", "step_dead", "push_failed", "envelope_rejected", "needs_recovery"]) {
    assert.equal(context.eventSeverity({ kind }), "red", kind);
  }
  assert.equal(context.eventSeverity({ kind: "terminal", status: "completed" }), "green");
  assert.equal(context.eventSeverity({ kind: "terminal", status: "failed" }), "red");
  assert.equal(context.eventSeverity({ kind: "terminal", status: "cancelled" }), null, "cancelled terminal is neutral");
  assert.equal(context.eventSeverity({ kind: "terminal" }), null, "terminal without status is neutral");
  for (const kind of ["answered", "gate_verdict", "rewind"]) {
    assert.equal(context.eventSeverity({ kind }), null, `${kind} is neutral`);
  }
});

test("pi#112: event mode toggle defaults simple, persists via localStorage, issues no request", () => {
  assert.match(source, /const EVENT_MODE_STORAGE_KEY = "pi-web:polyforge-event-mode"/, "global localStorage key");
  assert.match(source, /useState<EventMode>\("simple"\)/, "defaults to simple");
  assert.match(source, /window\.localStorage\.getItem\(EVENT_MODE_STORAGE_KEY\)/, "preference read");
  assert.match(source, /window\.localStorage\.setItem\(EVENT_MODE_STORAGE_KEY, next\)/, "preference written on toggle");
  const start = source.indexOf("const toggleEventMode = useCallback");
  assert.ok(start >= 0, "toggleEventMode exists");
  const end = source.indexOf("}, [eventMode]);", start);
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /fetch|XMLHttpRequest|api\//i, "toggle click path must issue no request");
  assert.match(source, /onClick=\{toggleEventMode\}/, "toggle is wired to a control");
});

test("pi#112: mode toggle strings and eventSync word are translated in all three locales", () => {
  for (const [name, localeSource] of [["en", enSource], ["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    for (const key of ["polyforge.eventMode.simple", "polyforge.eventMode.verbose", "polyforge.eventSync"]) {
      assert.match(localeSource, new RegExp(`"${key.replace(/\./g, "\\.")}": "\\S`), `${name} must translate ${key}`);
    }
  }
});

test("pi#112: dead event-kind labels removed from all three locales", () => {
  for (const [name, localeSource] of [["en", enSource], ["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    for (const kind of ["step_blocked", "job_done", "job_blocked"]) {
      assert.ok(!localeSource.includes(`polyforge.eventKind.${kind}`), `${name} still ships the dead label ${kind}`);
    }
  }
});

test("pi#113: a manual refresh click spins the icon and disables the button for at least ~400ms", () => {
  // The click path only: guard first, then busy.
  assert.match(source, /const \[refreshBusy, setRefreshBusy\] = useState\(false\);/);
  assert.match(source, /if \(refreshBusy\) return;/, "clicks during the busy window are ignored");
  assert.match(source, /onClick=\{handleRefresh\}/, "the button is wired to the guarded handler");
  // In-flight indication: disabled (assistive tech sees it) + spinning icon.
  assert.match(source, /disabled=\{refreshBusy\}/, "busy is exposed as disabled");
  assert.match(source, /animation: "spin 0\.8s linear infinite"/, "the icon rotates while busy");
  // The window lasts until the fetch settles AND at least 400ms.
  assert.match(source, /setTimeout\(resolve, 400\)/, "~400ms minimum");
  assert.match(source, /Promise\.resolve\(onRefresh\(\)\)\.catch\(\(\) => undefined\)/, "the settle promise is awaited");
  assert.match(source, /Promise\.all\(\[settled, floor\]\)\.then\(\(\) => setRefreshBusy\(false\)\)/, "idle returns after settle+floor, failure included");
  // The busy flag is written only inside the manual click handler — the
  // hook's background polls (interval/mount) never reach it.
  const writes = [...source.matchAll(/setRefreshBusy\(/g)].map((m) => m.index);
  assert.deepEqual(writes.map((index) => source.slice(Math.max(0, source.lastIndexOf("handleRefresh", index)), index).length > 0), [true, true], "both busy writes live in the click handler");
  // The settle promise flows through the prop contract.
  assert.ok(source.includes("onRefresh: () => void | Promise<void>;"), "onRefresh may return a promise");
});

test("pi#114 buildStepGraph: declared_steps drives node order with pending placeholders and declared-only edges", () => {
  const context = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(extractPureFunction("buildStepGraph").replace(/export /g, "")), context);
  const graph = JSON.parse(JSON.stringify(context.buildStepGraph(
    [
      { name: "spec", status: "done" },
      { name: "grill", status: "done" },
      { name: "code", status: "in_progress" },
    ],
    [{ id: "grill" }, { id: "grill-review" }, { id: "spec" }, { id: "code" }],
    [],
  )));
  // Declaration order wins over started-at order; declared-but-missing id is a pending placeholder.
  assert.deepEqual(graph.nodes.map((n) => [n.id, n.status]), [
    ["grill", "done"],
    ["grill-review", "pending"],
    ["spec", "done"],
    ["code", "in_progress"],
  ]);
  // Sequence edges join consecutive declared steps only.
  assert.deepEqual(graph.sequenceEdges, [["grill", "grill-review"], ["grill-review", "spec"], ["spec", "code"]]);
  assert.deepEqual(graph.rewindEdges, []);
});

test("pi#114 buildStepGraph: on_fail can never become a node or an edge", () => {
  const context = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(extractPureFunction("buildStepGraph").replace(/export /g, "")), context);
  // Even if a raw declaration sneaks extra fields past the caller, the model
  // keeps id+status only, and non-rewind events produce no edges.
  const graph = JSON.parse(JSON.stringify(context.buildStepGraph(
    [{ name: "grill", status: "done" }],
    [{ id: "grill", on_fail: "spec" }],
    [{ kind: "step_failed", step: "grill", cause: "x" }, { kind: "gate_verdict" }],
  )));
  assert.deepEqual(graph.nodes, [{ id: "grill", status: "done" }]);
  assert.equal(JSON.stringify(graph).includes("on_fail"), false, "on_fail leaked into the graph model");
  assert.deepEqual(graph.sequenceEdges, []);
  assert.deepEqual(graph.rewindEdges, []);
});

test("pi#114 buildStepGraph: null declared_steps falls back to started-at order with started-only edges", () => {
  const context = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(extractPureFunction("buildStepGraph").replace(/export /g, "")), context);
  for (const declared of [null, []]) {
    const graph = JSON.parse(JSON.stringify(context.buildStepGraph(
      [
        { name: "zulu-grill", status: "done" },
        { name: "mike-spec", status: "done" },
        { name: "alpha-plan", status: "in_progress" },
        { name: "kilo-author", status: "pending" },
        { name: "bravo-code", status: "pending" },
      ],
      declared,
      [],
    )));
    assert.deepEqual(graph.nodes.map((n) => n.id), ["zulu-grill", "mike-spec", "alpha-plan", "kilo-author", "bravo-code"], "nodes follow steps order when declared_steps is null or empty");
    assert.deepEqual(graph.sequenceEdges, [["zulu-grill", "mike-spec"], ["mike-spec", "alpha-plan"]], "only consecutive started steps are edged");
  }
});

test("pi#114 buildStepGraph: mismatch appends extras unedged after the declaration", () => {
  const context = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(extractPureFunction("buildStepGraph").replace(/export /g, "")), context);
  const graph = JSON.parse(JSON.stringify(context.buildStepGraph(
    [
      { name: "grill", status: "done" },
      { name: "spec", status: "in_progress" },
      { name: "plan", status: "done" },
      { name: "code", status: "done" },
    ],
    [{ id: "grill" }, { id: "spec" }, { id: "ghost-step" }],
    [],
  )));
  assert.deepEqual(graph.nodes.map((n) => [n.id, n.status]), [
    ["grill", "done"],
    ["spec", "in_progress"],
    ["ghost-step", "pending"],
    ["plan", "done"],
    ["code", "done"],
  ]);
  assert.deepEqual(graph.sequenceEdges, [["grill", "spec"], ["spec", "ghost-step"]], "consecutive declared pairs are edged; declared→extra and extra→extra are not");
});

test("pi#114 buildStepGraph: one node per step after a rewind re-run, no attempt counter", () => {
  const context = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(extractPureFunction("buildStepGraph").replace(/export /g, "")), context);
  const graph = JSON.parse(JSON.stringify(context.buildStepGraph(
    [
      { name: "grill", status: "done" },
      { name: "spec", status: "in_progress" },
      { name: "grill-review", status: "failed" },
      { name: "plan", status: "pending" },
      { name: "code", status: "pending" },
    ],
    ["grill", "spec", "grill-review", "plan", "code"].map((id) => ({ id })),
    [{ kind: "rewind", gate: "grill-review", target: "spec" }],
  )));
  assert.deepEqual(graph.nodes.map((n) => n.id), ["grill", "spec", "grill-review", "plan", "code"], "exactly one node per step");
  assert.ok(graph.nodes.every((n) => Object.keys(n).sort().join(",") === "id,status"), "nodes carry no attempt counter fields");
});

test("pi#114 buildStepGraph: rewind edges need the tail, both endpoints, and dedupe", () => {
  const context = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(extractPureFunction("buildStepGraph").replace(/export /g, "")), context);
  const steps = [
    { name: "grill", status: "done" },
    { name: "spec", status: "in_progress" },
    { name: "grill-review", status: "failed" },
    { name: "plan", status: "pending" },
    { name: "code", status: "pending" },
  ];
  const declared = steps.map((s) => ({ id: s.name }));
  // Tail-window limitation: a rewind outside the passed tail (the sanitizer
  // only forwards the newest 40) produces no edge.
  const outsideTail = JSON.parse(JSON.stringify(context.buildStepGraph(steps, declared, [])));
  assert.deepEqual(outsideTail.rewindEdges, [], "no tail rewind events → no rewind edges");
  const tail = JSON.parse(JSON.stringify(context.buildStepGraph(steps, declared, [
    { kind: "rewind", gate: "code", target: "plan" },
    { kind: "published" },
    { kind: "rewind", gate: "grill-review", target: "spec" },
    { kind: "rewind", gate: "ghost-gate", target: "spec" },
    { kind: "rewind", gate: "spec", target: "ghost-target" },
    { kind: "rewind", gate: "grill-review", target: "spec" },
  ])));
  assert.deepEqual(tail.rewindEdges, [["code", "plan"], ["grill-review", "spec"]], "only tail rewinds with both endpoints as nodes, deduplicated");
});

test("pi#114 buildStepGraph: fallback edges the whole prefix up to the last non-pending step (post-rewind shape)", () => {
  const context = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(extractPureFunction("buildStepGraph").replace(/export /g, "")), context);
  // After a pf rewind, [target, gate) is reset to 'pending' while started_at is
  // kept, so pending steps sit inside the started segment. The started segment
  // is the prefix up to and including the LAST non-pending node; edges span
  // that prefix, trailing never-started steps stay unedged.
  const graph = JSON.parse(JSON.stringify(context.buildStepGraph(
    [
      { name: "grill", status: "done" },
      { name: "grill-review", status: "done" },
      { name: "spec", status: "pending" },
      { name: "code", status: "in_progress" },
      { name: "review", status: "in_progress" },
      { name: "verification", status: "pending" },
    ],
    null,
    [],
  )));
  assert.deepEqual(graph.sequenceEdges, [
    ["grill", "grill-review"],
    ["grill-review", "spec"],
    ["spec", "code"],
    ["code", "review"],
  ], "edges span the first five nodes only; the trailing pending step is unedged");
});

test("pi#114 stepNodeColor: explicit gray for pending/cancelled, unknown statuses fall back gray", () => {
  const context = vm.createContext({});
  const colorMap = source.match(/const STEP_STATUS_COLORS: Record<string, string> = \{[\s\S]*?\n\};/);
  assert.ok(colorMap, "STEP_STATUS_COLORS map literal");
  vm.runInContext(stripTypeScriptTypes(colorMap[0]), context);
  vm.runInContext(stripTypeScriptTypes(extractPureFunction("stepNodeColor").replace(/export /g, "")), context);
  assert.equal(context.stepNodeColor("done"), "#16a34a");
  assert.equal(context.stepNodeColor("failed"), "#dc2626");
  assert.equal(context.stepNodeColor("blocked"), "#d97706");
  assert.equal(context.stepNodeColor("in_progress"), "var(--accent)");
  const gray = context.stepNodeColor("pending");
  assert.equal(gray, "var(--text-dim)", "pending is explicit gray");
  assert.equal(context.stepNodeColor("cancelled"), gray, "cancelled is the same gray as pending");
  assert.equal(context.stepNodeColor("paused"), gray, "unknown status falls back to the same gray");
});

test("pi#117 buildStepTimings: done = start → next start, in_progress = live age, others = started_at only", () => {
  const context = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(extractPureFunction("buildStepTimings").replace(/export /g, "")), context);
  const now = Date.parse("2026-10-19T08:13:30Z");
  const steps = [
    { name: "grill", status: "done", startedAt: "2026-10-19T08:00:00Z" },
    { name: "spec", status: "done", startedAt: "2026-10-19T08:05:00Z" },
    { name: "plan", status: "in_progress", startedAt: "2026-10-19T08:10:00Z" },
    { name: "code", status: "pending" },
  ];
  const timings = context.buildStepTimings(steps, now);
  assert.equal(timings.get("grill").durationSec, 300, "done: own start → the next started step's start");
  assert.equal(timings.get("spec").durationSec, 300);
  assert.equal(timings.get("plan").durationSec, 210, "in_progress: live age since start");
  assert.equal(timings.get("grill").startedAt, "2026-10-19T08:00:00Z", "started_at carried for display");
  assert.equal(timings.has("code"), false, "never-started steps carry no timing");
  // The last done step with nothing started after it shows started_at only.
  const last = context.buildStepTimings([
    { name: "grill", status: "done", startedAt: "2026-10-19T08:00:00Z" },
    { name: "code", status: "pending" },
  ], now);
  assert.equal(last.get("grill").durationSec, null, "no next started step → no duration");
  // Failed/blocked started steps: started_at only (no duration rule for them).
  const failed = context.buildStepTimings([
    { name: "review", status: "failed", startedAt: "2026-10-19T08:00:00Z" },
    { name: "code", status: "done", startedAt: "2026-10-19T08:02:00Z" },
  ], now);
  assert.equal(failed.get("review").durationSec, null, "failed started steps show started_at only");
  assert.equal(failed.get("code").durationSec, null, "the trailing done step has no next start");
  // An unparseable started_at degrades that step to no timing, never throws.
  assert.equal(context.buildStepTimings([{ name: "grill", status: "done", startedAt: "not-a-date" }], now).size, 0);
  assert.equal(context.buildStepTimings([], now).size, 0);
});

test("pi#117: detail rows render command+age, tool calls, recent files, timing and chat origin; absent → nothing", () => {
  // The whole block is gated: absent data renders no section, no placeholder.
  assert.match(source, /const detailInfoVisible = Boolean\(progress\?\.command\)/, "visibility derives from the sanitized snapshot");
  assert.match(source, /\{detailInfoVisible && \(/, "the detail-info block renders only when something is present");
  // Command row: label + age from command_age_sec, mono value, title carries it.
  assert.match(source, /\{progress\?\.command && \(/, "command row renders only when present");
  assert.match(source, /\{t\("polyforge\.command"\)\}\{progress\.command_age_sec != null \? ` · \$\{formatAge\(progress\.command_age_sec\)\}` : ""\}/, "command age renders from command_age_sec");
  assert.match(source, /title=\{progress\.command\}/, "full command on hover");
  // Tool calls count.
  assert.match(source, /\{progress\?\.tool_calls != null && \(/, "tool calls row renders only when present");
  assert.match(source, /\{progress\.tool_calls\}/, "the count renders");
  // Recent files: one ellipsized mono row per file, full path on hover.
  assert.match(source, /progress\.recent_files\.map\(\(file\) =>/, "one row per recent file");
  assert.match(source, /title=\{file\}/, "full file path on hover");
  // Live age at render time (the watch poll re-renders every 3s): the clock
  // read lives in the module-level helper (the repo's clock-at-render
  // pattern, BackgroundTasksPanel.formatDuration).
  assert.match(source, /function liveStepTimings\(steps: \{ name: string; status: string; startedAt\?: string \}\[\]\): Map<string, StepTiming> \{\s*return buildStepTimings\(steps, Date\.now\(\)\);/, "the live age reads the clock");
  assert.match(source, /const stepTimings = watchStatus \? liveStepTimings\(watchStatus\.steps\) : null;/, "timing derives from the snapshot at render");
  // Origin: chat_id truncated (full value on hover) + owner as plain text;
  // the row exists only when at least one of them is present.
  assert.match(source, /const originHasText = Boolean\(origin\?\.chat_id \|\| origin\?\.owner\)/);
  assert.match(source, /title=\{origin\.chat_id\}/, "chat_id full value on hover");
  assert.match(source, /shortenCandidate\(origin\.chat_id\)/, "chat_id truncated client-side");
  assert.match(source, /\{origin\.owner && <span style=\{\{ color: "var\(--text\)" \}\}>\{origin\.owner\}<\/span>/, "owner renders as plain text");
  // Nothing in the block is clickable or issues a request: no onClick/fetch.
  const blockStart = source.indexOf("{/* pi#117 detail rows");
  const blockEnd = source.indexOf("{/* Event tail (newest last) */}", blockStart);
  assert.ok(blockStart >= 0 && blockEnd > blockStart, "detail-rows block boundaries");
  const block = source.slice(blockStart, blockEnd);
  assert.doesNotMatch(block, /onClick|fetch|href/, "the detail rows must stay display-only");
});

test("pi#117: new detail labels are translated in all three locales", () => {
  for (const [name, localeSource] of [["en", enSource], ["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    for (const key of ["polyforge.command", "polyforge.toolCalls", "polyforge.recentFiles", "polyforge.origin"]) {
      assert.match(localeSource, new RegExp(`"${key.replace(/\./g, "\\.")}": "\\S`), `${name} must translate ${key}`);
    }
    // owner 有意变更 the step-timing block left the detail rows for the DAG, so its label is dead.
    assert.ok(!localeSource.includes("polyforge.stepTiming"), `${name} drops the dead polyforge.stepTiming key`);
  }
});

test("pi#119: the detail renders a summary block — line, age, cap marker, error line; absent → nothing", () => {
  const blockStart = source.indexOf("{/* pi#119 summary block");
  const blockEnd = source.indexOf("{/* pi#117 detail rows", blockStart);
  assert.ok(blockStart >= 0 && blockEnd > blockStart, "summary block boundaries");
  const block = source.slice(blockStart, blockEnd);
  // The block is gated on the sanitized snapshot: when all four fields are
  // absent the block renders nothing at all — no heading, placeholder or
  // loading text.
  assert.match(source, /const summaryVisible = Boolean\(summary \|\| summaryError \|\| summaryCapped\)/, "visibility derives from the four sanitized fields");
  assert.match(source, /\{summaryVisible && \(/, "the summary block renders only when at least one field is present");
  // The line + its age, formatted the same way as command_age_sec
  // (`Command · 2h 2m` → `Summary · 2h 2m`).
  assert.match(block, /\{t\("polyforge\.summary"\)\}\{summaryAgeSec != null \? ` · \$\{formatAge\(summaryAgeSec\)\}` : ""\}/, "the summary age renders like command_age_sec");
  assert.match(block, />\{summary\}</, "the summary line renders verbatim");
  assert.ok(block.includes('wordBreak: "break-word"'), "the summary line wraps (no ellipsis)");
  // A cap-reached marker when summary_capped is true (amber, its own line).
  assert.match(block, /\{summaryCapped && \(/, "the cap marker renders only when capped");
  assert.match(block, /color: "#d97706"/, "the cap marker is amber");
  assert.match(block, /\{t\("polyforge\.summaryCapped"\)\}/, "the cap marker label is translated");
  // summary_error on its own error-styled line; it may show together with
  // an older summary (the rows are independent: no cross-gating).
  assert.match(block, /\{summaryError && \(/, "the error line renders only when present");
  assert.match(block, /color: "#dc2626"/, "the error line is error-styled (red)");
  assert.match(block, /fontFamily: "var\(--font-mono, monospace\)"/, "the error line is mono");
  assert.match(block, />\{summaryError\}</, "the raw error text renders");
  // Nothing in the block is clickable or issues a request.
  assert.doesNotMatch(block, /onClick|fetch|href/, "the summary block must stay display-only");
});

test("pi#119: the summary labels are translated in all three locales", () => {
  for (const [name, localeSource] of [["en", enSource], ["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    for (const key of ["polyforge.summary", "polyforge.summaryCapped"]) {
      assert.match(localeSource, new RegExp(`"${key.replace(/\./g, "\\.")}": "\\S`), `${name} must translate ${key}`);
    }
  }
});

test("pi#120: with a job selected, the whole detail is ONE vertical scroll region", () => {
  // The detail container (the block after the job list) is the single
  // scroller: header, graph, summary, detail rows, toggle and event tail
  // scroll together, so every row is reachable at any sheet height and in
  // the desktop dock. The old layout stacked the fixed blocks as
  // non-shrinking children of an overflow-hidden column, so once they
  // exceeded the leftover height the tail collapsed to zero and everything
  // below the fold was clipped with no gesture able to reach it.
  const detailStart = source.indexOf("{/* Detail for the selected work item");
  assert.ok(detailStart >= 0, "detail block exists");
  const container = source.slice(detailStart, detailStart + 1100);
  assert.match(container, /overflowY: "auto"/, "the detail container is the one scroller");
  // The event tail is a plain block inside that region — no nested vertical
  // scroller remains anywhere in the detail.
  const tailStart = source.indexOf("{/* Event tail (newest last)");
  assert.ok(tailStart > detailStart, "event tail block exists after the detail container");
  const tail = source.slice(tailStart, source.indexOf("renderEventRow(row.event, index)", tailStart));
  assert.doesNotMatch(tail, /overflowY/, "the event tail must not scroll on its own");
  assert.doesNotMatch(tail, /flex: 1, minHeight: 0/, "the tail is no longer a flex-fill scroller");
  // The panel's top header (title / refresh / close) stays outside the
  // scroll region and visible: the detail container starts inside the body.
  const bodyStart = source.indexOf("{/* Body */}");
  assert.ok(bodyStart >= 0 && bodyStart < detailStart, "the body split precedes the detail");
  // The job list keeps its own scroller above the detail (unchanged).
  assert.match(source, /maxHeight: selectedWi \? "45%" : "100%", overflowY: "auto"/, "the job list keeps its own scroller (the whole body until a selection)");
  // Horizontal behavior is unchanged: the graph still wraps (no horizontal
  // scroll) — the graph container keeps its overflow-hidden wrap container.
  assert.match(source, /flexWrap: "wrap", alignItems: "center", rowGap: 6/, "the graph node row still wraps");
});

test("the dock adds Jobs | Messages tabs with an unread dot of its own", () => {
  assert.match(source, /role="tablist"/);
  // Jobs is Work's sub-tab, its label the same key.
  assert.match(source, /role="tab" aria-selected=\{activeTab === "work"\}/);
  assert.match(source, /role="tab" aria-selected=\{activeTab === "messages"\}/);
  assert.match(source, /t\("polyforge\.messages\.jobsTab"\)/);
  assert.match(source, /t\("polyforge\.messages\.tab"\)/);
  assert.match(source, /messagesSurface\.unreadTotal > 0/);
  assert.match(source, /aria-label=\{t\("polyforge\.messages\.unread"\)\}/, "the dot is named unread");
  assert.match(source, /activeTab === "messages" \? \(\s*<PolyforgeMessages/, "the Messages tab renders the messages surface");
});

test("the Jobs content is unchanged behind the tab switch", () => {
  const jobListStart = source.indexOf("{/* Queue line + job card stream");
  const jobListEnd = source.indexOf("{/* Detail for the selected work item */}");
  assert.ok(jobListStart >= 0 && jobListEnd > jobListStart, "the Jobs body keeps its block markers");
  const jobs = source.slice(jobListStart, jobListEnd);
  assert.match(jobs, /shownCards\.map\(\(card: PolyforgeCard\) =>/);
  assert.match(jobs, /opsStatus\.queue\.running/, "the queue running/max line stays");
});

test("/#163/#173: each card has a stable key and test identity, toggles the existing selection, and is a compact key-information card", () => {
  const cardStart = source.indexOf("const PolyforgeJobCard = memo(");
  const card = source.slice(cardStart, source.indexOf("export function PolyforgePanel("));
  assert.match(source, /key=\{polyforgeCardKey\(card\)\}/, "keyed by wi (else slug), never by index");
  assert.match(card, /data-pf-card=\{pending \? undefined : ""\}/);
  assert.match(card, /data-pf-card-wi=\{pending \? undefined : polyforgeCardKey\(card\)\}/);
  assert.match(card, /role="button"/);
  assert.match(card, /tabIndex=\{0\}/);
  assert.match(card, /const toggle = \(\) => onSelect\(selected \? null : job\.slug\);/, "a second activation deselects");
  assert.match(card, /event\.key === "Enter" \|\| event\.key === " "/);
  // a pending stand-in has no select handler and takes no
  // pointer (the first card read may reorder it); a real card keeps both.
  assert.match(card, /onClick=\{pending \? undefined : toggle\}/, "a real card selects; a stand-in has no click handler");
  assert.match(card, /onKeyDown=\{pending \? undefined : \(event\) => \{/, "a real card selects by key; a stand-in has no key handler");
  assert.match(card, /aria-disabled=\{pending \|\| undefined\}/);
  assert.match(card, /cursor: pending \? "default" : "pointer", pointerEvents: pending \? "none" : undefined,/);
  assert.doesNotMatch(card, /onClick=\{toggle\}/, "no unconditional click handler remains");
  assert.match(source, /selected=\{selectedWi === card\.job\.slug \|\| selectedWi === card\.job\.wi\}/, "selection is the slug ref, or the wi id an anchor names");
  // one block style, cards side by side, never a full-width
  // row. owner 有意变更（重立于 #213）：the Jobs cards are one
  // horizontally scrolling row of fixed 150px cards — the Tasks blocks' column
  // minimum (#213), no longer a wrapping grid whose tracks stretch.
  assert.match(source, /import \{ POLYFORGE_BLOCK_STYLE \} from "@\/lib\/panel-layout";/);
  // owner 有意变更 the card's outer column gap is 4 (was 6).
  assert.match(card, /display: "flex", flexDirection: "column", gap: 4, minWidth: 0,/, "the card column gap is 4");
  assert.doesNotMatch(card, /width: "100%"/, "a card is a fixed-width item, not a full-width block");
  assert.match(source, /const JOB_CARD_WIDTH = 150;/, "the fixed card width is the 150px the Tasks tracks share (/#220)");
  assert.match(card, /flex: `0 0 \$\{JOB_CARD_WIDTH\}px`/, "the card width is a non-shrinking 150px flex basis");
  assert.match(source, /<div style=\{\{ display: "flex", flexWrap: "nowrap", gap: 8, padding: 8, overflowX: "auto", scrollbarWidth: "thin" \}\}>\s*\{shownCards\.map/,
    "the Jobs stream is one row that scrolls horizontally, gap and padding unchanged");
  assert.match(source, /scrollbarWidth: "thin"/, "the scrollbar stays visible but thin");
  assert.doesNotMatch(source, /gridTemplateColumns: "repeat\(auto-fill, minmax\(\d+px, 1fr\)\)"/, "the Jobs stream is no longer a wrapping grid");
  // Title (s14#2,): the slug (wrapping) and the status at the
  // right end of the same row, the truncated goal under them clamped to 2
  // lines (full goal on hover). The status may ellipsize (flex 0 1 auto,
  // at most 60%) but never squeezes the slug (flex 1 1 0, wraps anywhere).
  const titleRow = card.slice(card.indexOf('<div style={{ display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0 }}>'), card.indexOf("{goal && ("));
  assert.ok(titleRow.length > 0, "one title row holds slug and status");
  assert.match(titleRow, /<div style=\{\{ flex: "1 1 0", minWidth: 0, [^}]*overflowWrap: "anywhere"[^}]*\}\}>\{job\.slug\}<\/div>/);
  assert.match(titleRow, /\{needsInput \? \(\s*<div data-pf-needs-input=""/, "the needs-input marker sits on the slug's row");
  assert.match(titleRow, /\) : \(\s*<div style=\{\{ flex: "0 1 auto", minWidth: 0, maxWidth: "60%"[^}]*\}\}>\{statusLabel\}<\/div>/, "the dim status label sits on the slug's row");
  assert.match(card, /<span title=\{goal\} style=\{\{[^}]*lineHeight: "16px"[^}]*WebkitLineClamp: 2[^}]*\}\}>\{truncateCardTitle\(goal, titleLength\)\}<\/span>/);
  // the explicit 16px card lines — the slug row and the goal
  // span, so the inherited 18px (line-height 1.5 at 12px) no longer inflates
  // the card; the needs-input badge fits a 16px row (14px line + 1px border)
  // and the dim status label stays 16px.
  assert.match(titleRow, /<div style=\{\{ flex: "1 1 0", minWidth: 0, [^}]*lineHeight: "16px"[^}]*\}\}>\{job\.slug\}<\/div>/, "the slug row is a 16px line");
  assert.match(titleRow, /data-pf-needs-input="" style=\{\{[^}]*padding: "0 5px"[^}]*lineHeight: "14px"[^}]*\}\}/, "the needs-input badge is padding 0 5px / line-height 14px, so its row is 16px with the border");
  assert.match(titleRow, /\) : \(\s*<div style=\{\{ flex: "0 1 auto", minWidth: 0, maxWidth: "60%", fontSize: 11, lineHeight: "16px", color: "var\(--text-dim\)"/, "the dim status label is on a 16px line");
  assert.ok(card.indexOf("{goal && (") > card.indexOf("{statusLabel}</div>"), "the goal comes below the slug/status row");
  assert.doesNotMatch(card, /\{!needsInput && \(/, "no separate status row any more");
  assert.match(source, /const \{ titleLength \} = usePolyforgePanelPreferences\(\);/, "the length is the browser-stored preference");
  // Needs input: the status itself as an emphasized marker (amber, bold,
  // framed), replacing the dim label on the title row — from the card's
  // status, no new read.
  assert.match(card, /const needsInput = job\.status === "needs_input";/);
  assert.match(titleRow, /\) : \(\s*<div[^>]*color: "var\(--text-dim\)"[^>]*>\{statusLabel\}<\/div>/, "a running card keeps the dim label and no marker");
  assert.match(titleRow, /\{needsInput \? \(\s*<div data-pf-needs-input="" style=\{\{[^}]*color: "#d97706", fontWeight: 600[^}]*\}\}>\s*\{statusLabel\}\s*<\/div>/);
  // No step information on the card: the DAG, durations and reruns live in the detail.
  assert.doesNotMatch(card, /steps\.map|data-pf-step-phase|STEP_PHASE_STYLES|cardStepPhase|step\.runs|currentStep|formatCardDuration/, "no step segment, rerun or duration on the card");
  assert.doesNotMatch(card, /polyforge\.card\.(?:unknownDuration|notStarted|skipped)/, "no unstarted/unknown/skipped step text on the card");
  assert.doesNotMatch(source, /STEP_PHASE_STYLES|cardStepPhase/, "the segment-bar styling is gone");
  assert.doesNotMatch(card, /candidate|stepAge|idleAge/, "model and step/idle age stay off the card");
  // owner 有意变更 (reverses the 32px narration):
  // the card renders no narration at all — no fixed-height self-scrolling area,
  // no entry list, no placeholders — so it holds only the slug/status row and
  // the goal. The job detail's progress and summary blocks are untouched.
  assert.doesNotMatch(source, /CARD_PROGRESS_HEIGHT/, "the card progress-area height constant is gone");
  assert.doesNotMatch(card, /progressRef|stickToBottom|overflowY: "auto"/, "no card-owned scroll region remains");
  assert.doesNotMatch(card, /const \{ job, goal, progress \} = card;/, "the card no longer reads progress off the card");
  assert.doesNotMatch(card, /progress\.(?:entries|available)|entry\.id/, "no narration entry render on the card");
  assert.doesNotMatch(card, /polyforge\.card\.(?:noProgress|progressUnavailable)/, "the card's narration placeholders are gone");
  // the card-only compaction — vertical padding 4px (the shared
  // POLYFORGE_BLOCK_STYLE keeps 6px, so the Tasks blocks stay as they are) and
  // no gap between the slug/status row and the goal.
  assert.match(card, /padding: "4px 8px"/, "the card's own vertical padding is 4px, horizontal 8px");
  assert.match(card, /display: "flex", flexDirection: "column", gap: 0, minWidth: 0/, "the slug/goal gap is 0");
  assert.doesNotMatch(source, /POLYFORGE_BLOCK_STYLE = \{/, "the shared block style is defined elsewhere, not redefined by the card");
  assert.match(panelLayoutSource, /padding: "6px 8px"/, "the shared POLYFORGE_BLOCK_STYLE keeps its 6px 8px padding, so the Tasks blocks are unchanged");
  // a running job's dim status label carries the job's age in
  // whole minutes in the same element and colour, from the card's existing
  // earliest job_started and a local render clock (no request); a missing
  // startedAt or any other status keeps the bare label.
  assert.match(source, /import \{[\s\S]*?\bcardRunningMinutes,/, "the age comes from the pure cards helper");
  assert.match(card, /const runningMinutes = running \? cardRunningMinutes\(card\.startedAt, now\) : null;/, "only a running card reads an age, from startedAt");
  assert.match(card, /const statusLabel = runningMinutes === null \? baseStatusLabel : `\$\{baseStatusLabel\} \$\{runningMinutes\}m`;/, "the label is `<label> <n>m`, bare without a readable age");
  assert.match(card, /const \[now, setNow\] = useState\(\(\) => Date\.now\(\)\);/);
  assert.match(card, /if \(!running\) return;\s*const clock = setInterval\(\(\) => setNow\(Date\.now\(\)\), 30_000\);\s*return \(\) => clearInterval\(clock\);/, "a 30s local render clock, never a poll");
  for (const [name, localeSource] of [["en", enSource], ["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    assert.doesNotMatch(localeSource, /"polyforge\.card\.(?:noProgress|progressUnavailable)":/, `${name} drops the card-only narration placeholders`);
  }
  // Before the first good card read the status jobs render as status-only
  // stand-ins (same key, no card identity). With a known snapshot of no job
  // the empty state shows at once — never a Loading… flash.
  assert.match(source, /const shownCards = cards \?\? \(opsStatus\?\.jobs \?\? \[\]\)\.map\(\(job\) => statusOnlyCard\(job, !cardsError\)\);/);
  assert.match(source, /pending=\{cards === null\}/);
  assert.match(source, /return \{ job, steps: \[\], progress: \{ available, entries: \[\] \} \};/);
  assert.match(source, /\{shownCards\.length === 0 \? \(\s*<div[^>]*>\{t\("polyforge\.empty"\)\}<\/div>/);
  assert.doesNotMatch(source, /cardsError \? t\("polyforge\.unavailable"\) : t\("polyforge\.loading"\)/, "no Loading… while the status snapshot is known");
  for (const [name, localeSource] of [["en", enSource], ["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    assert.match(localeSource, /"polyforge\.candidate": "\S/, `${name} labels the detail's model`);
  }
  assert.match(zhCNSource, /"polyforge\.empty": "暂无在跑作业"/);
  assert.doesNotMatch(zhCNSource, /"polyforge\.(?:empty|deselect|selectJob|eventKind\.job_\w+)": "[^"]*任务/, "zh-CN no longer calls jobs 任务");
  assert.doesNotMatch(zhTWSource, /"polyforge\.(?:empty|deselect|selectJob|eventKind\.job_\w+)": "[^"]*工作[^流]/, "zh-TW no longer calls jobs 工作");
});

test("the detail carries the selected job's model and step/idle age even before its watch read", () => {
  assert.match(source, /const selectedCard = selectedWi\s*\? shownCards\.find\(\(card\) => card\.job\.slug === selectedWi \|\| card\.job\.wi === selectedWi\)/);
  assert.match(source, /const selectedJob = selectedWi\s*\? \(selectedCard\?\.job \?\? opsStatus\?\.jobs\.find/);
  // owner 有意变更 the facts row now follows the DAG and the progress
  // section, still outside the watch gate (it shows while the watch read loads).
  const factsStart = source.indexOf("{selectedJob && (");
  assert.ok(factsStart >= 0 && factsStart < source.indexOf("{watchStatus && (", factsStart), "the facts row precedes the watch-gated detail");
  const facts = source.slice(factsStart, source.indexOf("{watchStatus && (", factsStart));
  assert.match(facts, /t\("polyforge\.candidate"\)/);
  assert.match(facts, /t\("polyforge\.stepAge"\)/);
  assert.match(facts, /t\("polyforge\.idleAge"\)/);
});

test("/#210: the DAG timing line carries the live +duration and the selected card's ×N reruns, one line under each node", () => {
  // The rerun count comes from the selected card's own read — no new request.
  assert.match(source, /const stepRuns = new Map\(\(selectedCard\?\.steps \?\? \[\]\)\.map\(\(step\) => \[step\.id, step\.runs\]\)\);/);
  // owner 有意变更 the timing row moved from the detail rows to a line under its DAG node.
  const nodes = source.slice(source.indexOf("graph.nodes.map((node, index) => {"), source.indexOf("graph.rewindEdges.length > 0 &&"));
  assert.match(nodes, /const timing = stepTimings\?\.get\(node\.id\);/);
  assert.match(nodes, /const runs = stepRuns\.get\(node\.id\) \?\? 0;/);
  assert.match(nodes, /timing && timing\.durationSec != null \? `\+\$\{formatCardDuration\(timing\.durationSec\)\}` : ""/, "the live +duration in the `+3m 05s` form; no duration → nothing");
  assert.match(nodes, /runs > 1 \? `×\$\{runs\}` : ""/, "×N only for a rerun step");
  assert.match(nodes, /<span data-pf-step-timing=\{node\.id\} style=\{\{ height: 14, lineHeight: "14px"[^}]*whiteSpace: "nowrap" \}\}>\{timingText\}<\/span>/, "one fixed-height line, empty when there is no timing, so the nodes stay aligned");
  const item = nodes.indexOf('role="listitem"');
  const line = nodes.indexOf("data-pf-step-timing");
  assert.ok(item >= 0 && line > nodes.indexOf("{shortenCandidate(node.id)}", item), "the timing line is the listitem's sibling, after its name — never inside it");
  assert.doesNotMatch(source, /t\("polyforge\.stepTiming"\)/, "the old detail timing block is gone");
});

test("the tab strip gains a third Memory tab and the body renders the memory surface", () => {
  assert.match(source, /role="tab" aria-selected=\{activeTab === "memory"\}/);
  assert.match(source, /t\("polyforge\.memory\.tab"\)/);
  // The Messages branch stays pinned (the #56 assertion above); the Memory
  // branch slots between it and the Jobs fallback.
  assert.match(source, /activeTab === "messages" \? \(\s*<PolyforgeMessages[\s\S]*\) : activeTab === "memory" \? \(\s*<PolyforgeMemory cwd=\{memoryCwd\} onOpenWorkItem=\{messagesSurface\.onOpenAnchor\} \/>/);
  assert.match(source, /memoryCwd: string \| null;/, "the panel takes the session cwd as a prop");
  for (const [name, localeSource] of [["en", enSource], ["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    assert.match(localeSource, /"polyforge\.memory\.tab": "\S/, `${name} translates the tab label`);
  }
});

test("the top strip orders Work, Memory, Messages (owner 2026-10-30); Work hosts Jobs and Tasks as sub-tabs", () => {
  const strip = source.slice(source.indexOf('role="tablist" data-pf-tabstrip="top"'), source.indexOf("{/* Body */}"));
  const order = [...strip.matchAll(/aria-selected=\{activeTab === "(\w+)"\}/g)].map((m) => m[1]);
  assert.deepEqual(order, ["work", "memory", "messages"], "three top-level tabs in DOM order");
  assert.match(strip, /t\("polyforge\.work\.tab"\)/);
  assert.doesNotMatch(strip, /polyforge\.tasks\.tab|polyforge\.messages\.jobsTab/, "no Jobs/Tasks top-level tab remains");
  // The unread dot stays its own element beside the Messages label.
  const messagesTab = strip.slice(strip.indexOf('aria-selected={activeTab === "messages"}'));
  assert.match(messagesTab, /t\("polyforge\.messages\.tab"\)\}\s*\{messagesSurface\.unreadTotal > 0 && \(/, "the dot follows the Messages label");
  // Work: the main area renders only the selected sub-tab's surface.
  assert.match(source, /\) : workTab === "tasks" \? \(\s*(?:\/\/[^\n]*\n\s*)*<PolyforgeTasks/, "the Tasks sub-tab renders the tasks surface");
  // (intentional 2026-10-31 third-segment change): 工单列表 renders only the work-item surface.
  assert.match(source, /\{workTab === "items" \? \(\s*(?:\/\/[^\n]*\n\s*)*<PolyforgeWorkItems itemCountKey=\{itemCountKey\} onRunningCount=\{onWorkItemsRunningChange\} \/>/,
    "the 工单列表 sub-tab renders the work-item surface with the count key and the badge reporter");
  assert.match(source, /<PolyforgeTasks taskCountKey=\{opsStatus \? `\$\{opsStatus\.tasks\?\.running \?\? 0\}:\$\{opsStatus\.tasks\?\.completed \?\? 0\}` : null\} \/>/,
    "the Tasks surface re-reads on the status snapshot's running:completed key (null without a snapshot)");
  // The sub-tab controls: their own named tablist, after the main area.
  const work = source.slice(source.indexOf('role="tablist"\n              data-pf-tabstrip="work"'));
  assert.ok(source.indexOf('data-pf-tabstrip="work"') > source.indexOf(") : workTab === \"tasks\" ? ("), "the sub-tab controls follow the main area in the DOM");
  // (intentional 2026-10-31 third-segment change): jobs, tasks, items in that order.
  assert.match(work, /\(\["jobs", "tasks", "items"\] as const\)\.map\(\(tab\) =>/);
  assert.match(work, /role="tab" aria-selected=\{active\}\s*onClick=\{\(\) => onWorkTab\(tab\)\}/);
  assert.match(work, /const label = tab === "jobs" \? t\("polyforge\.messages\.jobsTab"\) : tab === "tasks" \? t\("polyforge\.tasks\.tab"\) : t\("polyforge\.work\.itemsTab"\);/,
    "作业 / 任务 / 工单列表 labels ( adds the third)");
  // owner 有意变更: desktop keeps the ~72px text rail;
  // ≤640px is a 40px vertical icon rail on the right (was a three-segment bar
  // above the main area). One row at every width, main area first in the DOM.
  assert.match(source, /const isMobile = useIsMobile\(\);/);
  assert.match(source, /<div style=\{\{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row" \}\}>\s*<div style=\{\{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" \}\}>\s*\{workTab === "items"/, "one row at every width: the main area first, the rail beside it on the right");
  assert.doesNotMatch(source, /column-reverse/, "no bar lifted above the main area any more");
  assert.match(work, /aria-orientation="vertical"/, "the rail is vertical at every width");
  assert.doesNotMatch(work, /aria-orientation=\{isMobile/, "no horizontal orientation on mobile");
  assert.match(work, /\? \{ flex: "0 0 40px", width: 40, display: "flex", flexDirection: "column", borderLeft: "1px solid var\(--border\)", overflowY: "auto" \}\s*: \{ flex: "0 0 72px", width: 72, display: "flex", flexDirection: "column", borderLeft: "1px solid var\(--border\)", overflowY: "auto" \}/, "mobile 40px rail, desktop 72px rail, both on the right");
  assert.doesNotMatch(work, /borderBottom: "1px solid var\(--border\)"/, "no horizontal bar border");
  // Icon-only on mobile, named by the existing tab copy; desktop keeps the visible label.
  assert.match(work, /aria-label=\{isMobile \? label : undefined\}\s*title=\{isMobile \? label : undefined\}/, "the icon-only button is named by its tab copy");
  assert.match(work, /\{isMobile \? WORK_TAB_ICONS\[tab\] : <span>\{label\}<\/span>\}/, "icon on mobile, visible label on desktop");
  assert.match(work, /\.\.\.\(isMobile \? \{ width: "100%", height: 40, padding: 0 \} : \{ padding: "10px 4px" \}\)/, "about 40×40 mobile buttons");
  assert.match(work, /display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center"/, "the badge sits under the icon/label");
  assert.match(source, /const workTabIcon = \(paths: ReactNode\) => \(\s*<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">/, "16px icons in the panel's 24-viewBox stroke style");
  for (const tab of ["jobs", "tasks", "items"]) assert.match(source, new RegExp(`\\n  ${tab}: workTabIcon\\(`), `${tab} has a rail icon`);
  assert.match(work, /background: active \? "var\(--bg-selected\)" : "none"/);
  for (const [name, localeSource] of [["en", enSource], ["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    assert.match(localeSource, /"polyforge\.tasks\.tab": "\S/, `${name} translates the Tasks label`);
    assert.match(localeSource, /"polyforge\.work\.tab": "\S/, `${name} translates the Work label`);
  }
  assert.match(enSource, /"polyforge\.work\.tab": "Work"/);
  assert.match(zhCNSource, /"polyforge\.work\.tab": "工单"/);
  assert.match(zhTWSource, /"polyforge\.work\.tab": "工單"/);
  // Jobs (workflow jobs) and Tasks (one-shot tasks) read apart from pi's own
  // background-tasks surface in Chinese.
  assert.match(zhCNSource, /"polyforge\.messages\.jobsTab": "作业"/);
  assert.match(zhTWSource, /"polyforge\.messages\.jobsTab": "作業"/);
  assert.match(enSource, /"polyforge\.tasks\.tab": "Tasks"/);
});

test("the sub-tab badges show running counts from the one status snapshot; zero greyed, none on Work", () => {
  const work = source.slice(source.indexOf('data-pf-tabstrip="work"'));
  // (intentional 2026-10-31 third-segment change): the items badge is the last list read's count.
  assert.match(work, /const count = tab === "items" \? workItemsRunning\s*: opsStatus \? \(tab === "jobs" \? opsStatus\.queue\.running : \(opsStatus\.tasks\?\.running \?\? 0\)\) : null;/,
    "queue.running on Jobs, tasks.running on Tasks, no badge without a snapshot; the items badge from the last list read (absent before it)");
  assert.match(work, /\{count !== null && \(/);
  assert.match(work, /color: count > 0 \? "var\(--accent\)" : "var\(--text-dim\)"/, "zero renders greyed, never hidden");
  assert.match(work, /aria-label=\{t\(WORK_TAB_BADGES\[tab\], \{ count \}\)\}/, "the badge has an accessible name");
  assert.match(source, /const WORK_TAB_BADGES = \{ jobs: "polyforge\.work\.jobsRunning", tasks: "polyforge\.work\.tasksRunning", items: "polyforge\.work\.itemsRunning" \} as const;/);
  const strip = source.slice(source.indexOf('role="tablist" data-pf-tabstrip="top"'), source.indexOf("{/* Body */}"));
  const workTab = strip.slice(strip.indexOf('aria-selected={activeTab === "work"}'));
  assert.doesNotMatch(workTab, /count|running/, "the top-level Work tab carries no count");
  assert.doesNotMatch(source, /fetch\(/, "the panel adds no read for the badges");
  // the panel's one timer is the card's local age clock (it
  // reads Date.now() and fetches nothing); the badge path adds none.
  assert.deepEqual(source.match(/setInterval\(/g) ?? ["x"], ["setInterval("], "the only panel timer is the card's running-age clock");
  assert.match(source, /const clock = setInterval\(\(\) => setNow\(Date\.now\(\)\), 30_000\);/, "the one timer is the card clock");
  for (const [name, localeSource] of [["en", enSource], ["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    for (const key of ["polyforge.work.jobsRunning", "polyforge.work.tasksRunning", "polyforge.work.itemsRunning"]) {
      assert.match(localeSource, new RegExp(`"${key.replaceAll(".", "\\.")}": "[^"]*\\{count\\}`), `${name} names the ${key} badge with its count`);
    }
  }
});

test("the header carries a pressed-state pin control only when showPin", () => {
  const header = source.slice(source.indexOf("{/* Header */}"), source.indexOf("{/* Work | Memory | Messages tab strip"));
  assert.match(header, /\{showPin && \(\s*<button[\s\S]*?onClick=\{onTogglePin\}\s*aria-pressed=\{pinned\}/, "the pin renders only with showPin and reports aria-pressed");
  assert.match(header, /title=\{pinned \? t\("polyforge\.dock\.unpin"\) : t\("polyforge\.dock\.pin"\)\}/);
  assert.ok(header.indexOf("onTogglePin") < header.indexOf("handleRefresh"), "the pin sits before refresh and close");
  for (const [name, localeSource] of [["en", enSource], ["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    for (const key of ["polyforge.dock.pin", "polyforge.dock.unpin"]) {
      assert.match(localeSource, new RegExp(`"${key.replace(/\./g, "\\.")}": "\\S`), `${name} translates ${key}`);
    }
  }
});

test("the 工单列表 count key is queue.running plus the terminal-job count, null without a snapshot; the panel adds no read", () => {
  const start = source.indexOf("export function workItemCountKey(");
  assert.ok(start >= 0, "one pure key helper");
  const body = source.slice(start, source.indexOf("export function PolyforgePanel(", start));
  assert.match(body, /if \(!opsStatus\) return null;/, "no snapshot, no key (no re-read)");
  assert.match(body, /job\.status === "completed" \|\| job\.status === "failed" \|\| job\.status === "cancelled"/, "terminal jobs only");
  assert.match(body, /return `\$\{opsStatus\.queue\.running\}:\$\{terminal\}`;/);
  assert.match(source, /const itemCountKey = workItemCountKey\(opsStatus\);/);
  assert.match(source, /workItemsRunning: number \| null;\s*onWorkItemsRunningChange: \(count: number\) => void;/);
  assert.doesNotMatch(source, /\/api\/polyforge\/work-items/, "the panel never reads the work-item list itself");
});

test("the detail order is title row → DAG with timing → execution progress → every existing block in its original relative order", () => {
  const detail = source.slice(source.indexOf("{/* Detail for the selected work item */}"), source.indexOf("{t(\"polyforge.selectJob\")}"));
  const marks = [
    "data-pf-detail-title",
    "{graph ? (",
    "<PolyforgeDetailProgress wi={selectedJob?.wi ?? null} running={selectedJob?.status === \"running\"} />",
    "{selectedJob && (",
    "{watchStatus && (",
    "{/* pi#119 summary block",
    "{/* pi#117 detail rows",
    "onClick={toggleEventMode}",
    "{/* Event tail (newest last): the rows are plain",
  ].map((needle) => detail.indexOf(needle));
  assert.ok(marks.every((index, i) => index >= 0 && (i === 0 || index > marks[i - 1])), `detail order: ${marks}`);
  // The progress read is keyed on the selected job's wi (a card click stores
  // the slug as the selection ref), never on selectedWi.
  assert.doesNotMatch(source, /usePolyforgeProgress\(selectedWi/);
});

test("the progress section renders each entry inline as one ellipsized line with hover text, its states localized, no nested scroller", () => {
  const start = source.indexOf("function PolyforgeDetailProgress(");
  const block = source.slice(start, source.indexOf("\n}\n", start));
  assert.match(block, /const tail = usePolyforgeProgress\(wi, running\);/);
  assert.match(block, /data-pf-progress=""/);
  assert.match(block, /t\("polyforge\.progress\.title"\)/);
  assert.match(block, /!wi \|\| tail\?\.available === false \? t\("polyforge\.progress\.unavailable"\)/, "no readable transcript: the unavailable state, no fabricated line");
  assert.match(block, /tail\.entries\.length === 0 \? t\("polyforge\.progress\.empty"\)/);
  assert.match(block, /tail\.entries\.map\(\(entry\) => \(\s*<div\s*key=\{entry\.id\}\s*data-pf-progress-kind=\{entry\.kind\}\s*title=\{entry\.text\}\s*style=\{\{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"/, "one line per entry, full text on hover");
  assert.doesNotMatch(block, /overflowY|maxHeight|scrollTop/, "no nested vertical scroller (pi#120)");
  assert.doesNotMatch(block, /error|failed/i, "no error readout");
  for (const [name, localeSource] of [["en", enSource], ["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    for (const key of ["polyforge.progress.title", "polyforge.progress.empty", "polyforge.progress.unavailable"]) {
      assert.match(localeSource, new RegExp(`"${key.replace(/\./g, "\\.")}": "\\S`), `${name} must translate ${key}`);
    }
  }
});
