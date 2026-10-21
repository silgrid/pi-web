import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const source = await readFile(new URL("./PolyforgePanel.tsx", import.meta.url), "utf8");
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

test("job rows show slug, status label, spawn number, candidate, ages, and the queue badge", () => {
  assert.match(source, /\{job\.slug\}/);
  assert.match(source, /jobStatusLabel\(job\.status\)/);
  assert.match(source, /#\{job\.spawnN\}/);
  assert.match(source, /shortenCandidate\(job\.candidate\)/);
  assert.match(source, /formatAge\(job\.stepAgeSec\)/);
  assert.match(source, /formatAge\(job\.idleAgeSec\)/);
  assert.match(source, /\{opsStatus\.queue\.running\} \/ \{opsStatus\.queue\.max\}/, "queue running/max as 2/4");
  // All jobs, no owner filter: the job list renders the sanitized jobs
  // wholesale. (pi#117: the DETAIL now shows the sanitized chat origin —
  // `owner` exists in the panel — so the no-filter guarantee is pinned on
  // the job-list block, not the whole file.)
  const jobListStart = source.indexOf("{/* Queue line + job list */}");
  const jobListEnd = source.indexOf("{/* Detail for the selected work item */}");
  assert.ok(jobListStart >= 0 && jobListEnd > jobListStart, "job list block boundaries");
  const jobList = source.slice(jobListStart, jobListEnd);
  assert.doesNotMatch(jobList, /owner/, "the job list must not filter by owner");
  assert.match(jobList, /jobs\.map\(\(job: PolyforgeJob\) =>/, "the list renders every job");
});

test("the detail shows the flow graph, event tail, and status-only blocked rendering, with no step-chip block", () => {
  // Graph nodes: the node row maps buildStepGraph(...).nodes; each node is a
  // display-only listitem carrying title+aria-label with full name + status.
  assert.match(source, /const graph = watchStatus\s*\?\s*buildStepGraph\(watchStatus\.steps, watchStatus\.declared_steps, watchStatus\.events\)/, "graph derived from the sanitized snapshot");
  assert.match(source, /graph\.nodes\.map\(\(node, index\) =>/, "node row maps the graph model");
  assert.match(source, /role="listitem"/, "nodes are display-only list items");
  assert.match(source, /aria-label=\{\`\$\{node\.id\} · \$\{stepStatusLabel\(node\.status\)\}\`\}/, "accessible label carries full name + status");
  assert.match(source, /\{shortenCandidate\(node\.id\)\}/, "visible node text is the 24-char cut");
  assert.match(source, /className=\{node\.status === "in_progress" \? "pf-step-node-pulse" : undefined\}/, "only in_progress pulses");
  // Sequence connectors between consecutive nodes; dashed rewind chips below.
  assert.match(source, /graph\.rewindEdges\.map\(\(\[gate, target\]\) =>/, "rewind chips render from the model");
  // pi#116: the pre-graph per-step name+status chip block is gone — the
  // graph nodes are the only step STATUS display in every event mode.
  // (pi#117 adds per-step TIMING rows: name + started_at + duration, never
  // a status label — see the buildStepTimings test below.)
  const timingStart = source.indexOf("watchStatus.steps.map((step) =>");
  assert.ok(timingStart >= 0, "the per-step timing rows exist (pi#117)");
  const timingBlock = source.slice(timingStart, source.indexOf("\n                              })}\n", timingStart));
  assert.doesNotMatch(timingBlock, /stepStatusLabel|STEP_STATUS_KEYS|role="listitem"/, "timing rows must not render step status labels or nodes");
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
  // The header shows the selected ref even while the snapshot loads, so the
  // stale detail is always dismissable without a reload.
  assert.match(source, /\{watchStatus\?\.slug \?\? selectedWi\}/);
  // The key is translated in all three locales (fallback would be a raw key).
  for (const [name, localeSource] of [["en", enSource], ["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    assert.match(localeSource, /"polyforge\.deselect": "\S/, `${name} must translate polyforge.deselect`);
  }
  // Accessible name must not collide with the topbar button locator, whose
  // name carries "Polyforge" (see e2e/polyforge.mjs pfButton).
  const enMatch = enSource.match(/"polyforge\.deselect": "([^"]+)"/);
  assert.ok(enMatch && !/polyforge/i.test(enMatch[1]), "deselect label must not contain Polyforge");
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
    for (const key of ["polyforge.command", "polyforge.toolCalls", "polyforge.recentFiles", "polyforge.stepTiming", "polyforge.origin"]) {
      assert.match(localeSource, new RegExp(`"${key.replace(/\./g, "\\.")}": "\\S`), `${name} must translate ${key}`);
    }
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
  assert.match(source, /maxHeight: "45%", overflowY: "auto"/, "the job list keeps its own scroller");
  // Horizontal behavior is unchanged: the graph still wraps (no horizontal
  // scroll) — the graph container keeps its overflow-hidden wrap container.
  assert.match(source, /flexWrap: "wrap", alignItems: "center", rowGap: 6/, "the graph node row still wraps");
});
