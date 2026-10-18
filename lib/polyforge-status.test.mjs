import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

async function loadSubject() {
  return jiti.import("./polyforge-status.ts");
}

const STEP_ORDER = ["zulu-grill", "mike-spec", "alpha-plan", "kilo-author", "bravo-code"];
const machineSteps = {
  "alpha-plan": { status: "done", started_at: "2026-10-18T08:10:00Z" },
  "bravo-code": { status: "pending" },
  "kilo-author": { status: "in_progress", started_at: "2026-10-18T08:15:00Z" },
  "mike-spec": { status: "done", started_at: "2026-10-18T08:05:00Z" },
  "zulu-grill": { status: "done", started_at: "2026-10-18T08:00:00Z" },
};

test("refs validate as closed positionals before any spawn", async () => {
  const { isPolyforgeWiRef } = await loadSubject();
  assert.equal(isPolyforgeWiRef("pi#108"), true);
  assert.equal(isPolyforgeWiRef("my-project#7"), true, "dashes in slugs are accepted");
  assert.equal(isPolyforgeWiRef("wi_y3y9SMz4IXKg"), true);
  assert.equal(isPolyforgeWiRef("wi_E2Eaaaa0001"), true);
  // Injection shapes must be refused: the ref is one closed argv positional.
  assert.equal(isPolyforgeWiRef("pi#108 --chat x"), false);
  assert.equal(isPolyforgeWiRef("--help"), false);
  assert.equal(isPolyforgeWiRef("wi_x;rm -rf /"), false);
  assert.equal(isPolyforgeWiRef("not a ref"), false);
  assert.equal(isPolyforgeWiRef("pi#"), false);
  assert.equal(isPolyforgeWiRef("#108"), false);
  assert.equal(isPolyforgeWiRef("pi#1#2"), false);
  assert.equal(isPolyforgeWiRef(undefined), false);
  assert.equal(isPolyforgeWiRef(null), false);
  assert.equal(isPolyforgeWiRef(108), false);
});

test("steps order in execution order: started first, pending last, ties by name", async () => {
  const { orderPolyforgeSteps } = await loadSubject();
  assert.deepEqual(orderPolyforgeSteps(machineSteps).map((step) => step.name), STEP_ORDER);
  // Started steps carry their machine statuses; unstarted steps carry pending.
  const ordered = orderPolyforgeSteps(machineSteps);
  assert.deepEqual(ordered.map((step) => step.status), ["done", "done", "done", "in_progress", "pending"]);
});

test("unstarted steps follow started ones even when tied", async () => {
  const { orderPolyforgeSteps } = await loadSubject();
  const tied = {
    "aa-late": { status: "in_progress", started_at: "2026-10-18T09:00:00Z" },
    "zz-early": { status: "in_progress", started_at: "2026-10-18T08:00:00Z" },
    "mm-unstarted": { status: "pending" },
  };
  assert.deepEqual(orderPolyforgeSteps(tied).map((step) => step.name), ["zz-early", "aa-late", "mm-unstarted"]);
  assert.deepEqual(orderPolyforgeSteps(undefined), []);
  assert.deepEqual(orderPolyforgeSteps({}), []);
});

test("event tail clamps to the newest 40, order preserved", async () => {
  const { tailPolyforgeEvents } = await loadSubject();
  const events = Array.from({ length: 60 }, (_, i) => ({
    at: `2026-10-18T10:${String(i).padStart(4, "0")}:00Z`,
    kind: "published",
    seq: i + 1,
  }));
  const tail = tailPolyforgeEvents(events);
  assert.equal(tail.length, 40, "60 machine events clamp to the newest 40");
  assert.equal(tail[39].at, events[59].at, "newest event last");
  assert.equal(tail[0].at, events[20].at, "the 40 newest, starting at index 20");
  assert.deepEqual(tailPolyforgeEvents(events, 5).length, 5);
  assert.deepEqual(tailPolyforgeEvents(events.slice(0, 3)).length, 3, "under the cap the whole event list passes");
});

test("event summaries derive only from body.step (step kinds) or body.spawn_n", async () => {
  const { tailPolyforgeEvents } = await loadSubject();
  const tail = tailPolyforgeEvents([
    { at: "2026-10-18T10:00:00Z", kind: "step_started", body: { step: "grill", spawn_n: 1, model: "m1" } },
    { at: "2026-10-18T10:00:01Z", kind: "published", body: { detail: "E2E-SECRET-EVENT-BODY" } },
    { at: "2026-10-18T10:00:02Z", kind: "step_done", body: { step: "grill" } },
    { at: "2026-10-18T10:00:03Z", kind: "step_failed", body: { step: "grill" } },
    { at: "2026-10-18T10:00:04Z", kind: "job_started", body: { spawn_n: 3 } },
    { at: "2026-10-18T10:00:05Z", kind: "step_blocked", body: { step: "grill", question: "E2E-PENDING-QUESTION-TEXT which colour?" } },
    { at: "2026-10-18T10:00:06Z", kind: "needs_input", body: { question: "E2E-PENDING-QUESTION-TEXT which colour?", step: "grill" } },
  ]);
  const byKind = Object.fromEntries(tail.map((event) => [event.kind, event]));
  assert.equal(byKind.step_started.summary, "grill");
  assert.equal(byKind.step_done.summary, "grill");
  assert.equal(byKind.step_failed.summary, "grill");
  assert.equal(byKind.job_started.summary, "spawn 3");
  assert.equal("summary" in byKind.published, false, "unknown fields like body.detail are dropped");
  assert.equal("summary" in byKind.step_blocked, false, "step_blocked is not in the whitelisted step kinds");
  assert.equal("summary" in byKind.needs_input, false, "needs_input carries kind only, never the question text");
  assert.ok(!JSON.stringify(tail).includes("E2E-SECRET-EVENT-BODY"), "body.detail never reaches the shape");
  assert.ok(!JSON.stringify(tail).includes("E2E-PENDING-QUESTION-TEXT"), "question text never reaches the shape");
  assert.ok(!JSON.stringify(tail).includes("m1"), "unwhitelisted body fields never reach the shape");
});

test("ops snapshot keeps queue/jobs fields and drops machine passthrough", async () => {
  const { sanitizeOpsStatus } = await loadSubject();
  const machine = {
    machine_id: "m-e2e",
    workspaces: ["/srv/e2e-secret-workspace"],
    workflows_dir: "/srv/e2e-secret-workspace/wf",
    env_names: ["POLYFORGE_V1_API_KEY", "E2E_ENV_NAME_SENTINEL"],
    shutting_down: false,
    jobs: [{
      work_item_id: "wi_E2Eaaaa0001",
      slug: "pi#108",
      status: "running",
      spawn_n: 3,
      session_fingerprint: "fp-secret-session",
      step_age_sec: 7325,
      last_work_ago_sec: 4337,
      candidate: "claude:claude-opus-5-5-extended-context-e2e",
      origin: { kind: "chat", owner: "u_alice" },
    }],
    queue: { pending: 0, running: 2, max_concurrent: 4 },
  };
  const snapshot = sanitizeOpsStatus(machine);
  assert.ok(snapshot);
  assert.deepEqual(snapshot.queue, { running: 2, max: 4 });
  assert.deepEqual(snapshot.jobs, [{
    wi: "wi_E2Eaaaa0001",
    slug: "pi#108",
    status: "running",
    stepAgeSec: 7325,
    idleAgeSec: 4337,
    candidate: "claude:claude-opus-5-5-extended-context-e2e",
    spawnN: 3,
  }]);
  const text = JSON.stringify(snapshot);
  for (const secret of ["E2E_ENV_NAME_SENTINEL", "/srv/e2e-secret-workspace", "fp-secret-session", "u_alice", "m-e2e"]) {
    assert.ok(!text.includes(secret), `machine passthrough leaked: ${secret}`);
  }
});

test("ops snapshot is null on unusable machine shapes", async () => {
  const { sanitizeOpsStatus } = await loadSubject();
  assert.equal(sanitizeOpsStatus(null), null);
  assert.equal(sanitizeOpsStatus(undefined), null);
  assert.equal(sanitizeOpsStatus("pf: daemon not reachable"), null);
  assert.equal(sanitizeOpsStatus({ queue: { running: 1, max_concurrent: 2 } }), null);
  assert.equal(sanitizeOpsStatus({ queue: { running: 1, max_concurrent: 2 }, jobs: "nope" }), null);
  assert.equal(sanitizeOpsStatus({ jobs: [] }), null);
});

test("watch snapshot keeps header fields, ordered steps and tail events; unknown refs read null", async () => {
  const { sanitizeWatch } = await loadSubject();
  const machine = {
    work_item: "wi_E2Eaaaa0001",
    slug: "pi#108",
    known: true,
    job: { status: "running", origin: { owner: "u_alice" } },
    execution: {
      workflow_status: "running",
      current_step: "kilo-author",
      updated_at: "2026-10-18T11:00:00Z",
      steps: machineSteps,
    },
    progress: { command: "E2E-SECRET-WORKER-COMMAND --flag", tool_calls: 9 },
    events: Array.from({ length: 60 }, (_, i) => ({
      at: `2026-10-18T10:${String(i).padStart(4, "0")}:00Z`,
      kind: i % 2 ? "published" : "step_started",
      work_item: "wi_E2Eaaaa0001",
      body: { step: "kilo-author", spawn_n: 3, detail: `E2E-SECRET-EVENT-BODY-${i + 1}` },
      seq: i + 1,
    })),
    last_seq: 60,
  };
  const snapshot = sanitizeWatch(machine);
  assert.ok(snapshot);
  assert.equal(snapshot.wi, "wi_E2Eaaaa0001");
  assert.equal(snapshot.slug, "pi#108");
  assert.equal(snapshot.workflowStatus, "running");
  assert.equal(snapshot.currentStep, "kilo-author");
  assert.deepEqual(snapshot.steps.map((step) => step.name), STEP_ORDER, "steps in execution order");
  assert.equal(snapshot.events.length, 40, "event tail clamped to 40");
  const text = JSON.stringify(snapshot);
  for (const secret of ["E2E-SECRET-EVENT-BODY", "E2E-SECRET-WORKER-COMMAND", "u_alice"]) {
    assert.ok(!text.includes(secret), `machine passthrough leaked: ${secret}`);
  }
});

test("watch snapshot reads null for daemon-unknown refs and unusable shapes", async () => {
  const { sanitizeWatch } = await loadSubject();
  assert.equal(sanitizeWatch({ known: false, work_item: "wi_x", events: [], last_seq: 0 }), null);
  assert.equal(sanitizeWatch(null), null);
  assert.equal(sanitizeWatch("garbage"), null);
  assert.equal(sanitizeWatch({ known: true, execution: null }), null);
  assert.equal(sanitizeWatch({ known: true, execution: { steps: {} } }), null, "no wi/slug");
});

test("watch transport validates the ref before argv and builds the once/40 argv", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./polyforge-status.ts", import.meta.url), "utf8");
  assert.match(source, /isPolyforgeWiRef\(wiRef\)/, "the ref is validated before any spawn");
  assert.match(source, /"--once"/, "the resident watcher must never be started: --once is mandatory");
  assert.match(source, /"--events", String\(EVENT_TAIL\)/, "the watch argv asks for 40 events");
  assert.match(source, /timeout: PRESENCE_PROBE_TIMEOUT_MS/, "the presence probe outlives its own 3s timeout");
  assert.match(source, /timeout: READ_TIMEOUT_MS/, "reads outlive their own 10s timeout");
});
