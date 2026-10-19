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

test("event tail exposes only the per-kind whitelisted body fields", async () => {
  const { tailPolyforgeEvents } = await loadSubject();
  const tail = tailPolyforgeEvents([
    { at: "2026-10-18T10:00:00Z", kind: "step_started", body: { step: "grill", model: "sub2api-glm/glm-5.3", spawn_n: 1, effort: "high" } },
    { at: "2026-10-18T10:00:01Z", kind: "candidate_switched", body: { step: "grill", from: "pi:old", to: "claude:new", cause: "E2E-SECRET-EVENT-BODY" } },
    { at: "2026-10-18T10:00:02Z", kind: "step_failed", body: { step: "grill", cause: "agent-exit-1", detail: "E2E-SECRET-EVENT-BODY", from_model: "E2E-SECRET-EVENT-BODY", to_model: "E2E-SECRET-EVENT-BODY" } },
    { at: "2026-10-18T10:00:03Z", kind: "step_dead", body: { step: "grill", cause: "timeout", evidence: "E2E-SECRET-EVENT-BODY" } },
    { at: "2026-10-18T10:00:04Z", kind: "rewind", body: { gate: "spec-review", target: "code", archived: ["E2E-SECRET-EVENT-BODY"], spawn_n: 3 } },
    { at: "2026-10-18T10:00:05Z", kind: "terminal", body: { status: "completed", reason: "E2E-SECRET-EVENT-BODY", spawn_n: 3 } },
    { at: "2026-10-18T10:00:06Z", kind: "job_started", body: { spawn_n: 3, detail: "E2E-SECRET-EVENT-BODY" } },
    { at: "2026-10-18T10:00:07Z", kind: "needs_input", body: { question: "E2E-PENDING-QUESTION-TEXT which colour?", question_id: "q1", step: "grill" } },
    { at: "2026-10-18T10:00:08Z", kind: "push_failed", body: { error: "E2E-SECRET-EVENT-BODY" } },
    { at: "2026-10-18T10:00:09Z", kind: "some_future_kind", body: { step: "grill", detail: "E2E-SECRET-EVENT-BODY" } },
  ]);
  const byKind = Object.fromEntries(tail.map((event) => [event.kind, event]));
  assert.equal(byKind.step_started.step, "grill");
  assert.equal(byKind.step_started.model, "sub2api-glm/glm-5.3", "harness prefix kept, model verbatim");
  assert.equal(byKind.candidate_switched.step, "grill", "step passes through for candidate_switched");
  assert.equal(byKind.candidate_switched.from, "pi:old");
  assert.equal(byKind.candidate_switched.to, "claude:new");
  assert.equal(byKind.candidate_switched.cause, undefined, "cause is not whitelisted for candidate_switched");
  assert.equal(byKind.step_failed.cause, "agent-exit-1");
  assert.equal(byKind.step_dead.cause, "timeout");
  assert.equal(byKind.rewind.gate, "spec-review");
  assert.equal(byKind.rewind.target, "code");
  assert.equal(byKind.terminal.status, "completed");
  assert.equal(byKind.job_started.step, undefined, "body.spawn_n no longer renders as step");
  assert.equal(byKind.needs_input.step, "grill", "known kinds without a field table pass step only");
  assert.equal(byKind.push_failed.step, undefined, "push_failed body has no step field");
  assert.equal(byKind.some_future_kind.step, "grill", "unknown kinds stay step-only");
  const text = JSON.stringify(tail);
  for (const secret of ["E2E-SECRET-EVENT-BODY", "E2E-PENDING-QUESTION-TEXT", "m1", "q1", "spawn 3", "high"]) {
    assert.ok(!text.includes(secret), `non-whitelisted body value reached the shape: ${secret}`);
  }
});

test("event tail stays clean when optional whitelisted fields are absent", async () => {
  const { tailPolyforgeEvents } = await loadSubject();
  const tail = tailPolyforgeEvents([
    { at: "2026-10-18T10:00:00Z", kind: "step_started", body: { step: "grill" } },
    { at: "2026-10-18T10:00:01Z", kind: "terminal", body: { reason: "E2E-SECRET-EVENT-BODY" } },
  ]);
  assert.deepEqual(tail[0], { at: "2026-10-18T10:00:00Z", kind: "step_started", step: "grill" });
  assert.deepEqual(tail[1], { at: "2026-10-18T10:00:01Z", kind: "terminal" });
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
