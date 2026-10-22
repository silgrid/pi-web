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
  // Started steps carry their machine statuses AND startedAt (pi#117);
  // unstarted steps carry pending and no startedAt.
  assert.deepEqual(orderPolyforgeSteps(machineSteps), [
    { name: "zulu-grill", status: "done", startedAt: "2026-10-18T08:00:00Z" },
    { name: "mike-spec", status: "done", startedAt: "2026-10-18T08:05:00Z" },
    { name: "alpha-plan", status: "done", startedAt: "2026-10-18T08:10:00Z" },
    { name: "kilo-author", status: "in_progress", startedAt: "2026-10-18T08:15:00Z" },
    { name: "bravo-code", status: "pending" },
  ]);
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
    // Non-chat origin (no kind): the whole origin degrades to absent (pi#117).
    job: { status: "running", origin: { owner: "u_alice" } },
    execution: {
      workflow_status: "running",
      current_step: "kilo-author",
      updated_at: "2026-10-18T11:00:00Z",
      steps: machineSteps,
    },
    // pi#117: progress.command leaves only masked (the fixture command carries
    // a credential pattern so the sentinel value can never survive).
    progress: { command: "worker run --token=E2E-SECRET-WORKER-COMMAND-0123456789 --flag", tool_calls: 9 },
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
  assert.equal(snapshot.origin, undefined, "a non-chat origin never leaves");
  const text = JSON.stringify(snapshot);
  for (const secret of ["E2E-SECRET-EVENT-BODY", "E2E-SECRET-WORKER-COMMAND", "u_alice"]) {
    assert.ok(!text.includes(secret), `machine passthrough leaked: ${secret}`);
  }
});

test("redaction masks every credential pattern and truncates to ~120 chars", async () => {
  const { redactPolyforgeCommand } = await loadSubject();
  const command = [
    "run",
    "sk-E2ESECRETKEY0123456789",
    "ghp_E2ESECRETKEY0123456789abc",
    "npm_E2ESECRET0123456789",
    "FOO_API_KEY=E2E-SECRET-VALUE",
    "token=E2E-SECRET-TOKEN",
    "password=E2E-SECRET-PW1",
    "passwd=E2E-SECRET-PW2",
    "--password",
    "E2E-SECRET-PW3",
    "plain",
  ].join(" ");
  const redacted = redactPolyforgeCommand(command);
  for (const secret of ["E2ESECRETKEY0123456789", "E2E-SECRET-VALUE", "E2E-SECRET-TOKEN", "E2E-SECRET-PW"]) {
    assert.ok(!redacted.includes(secret), `secret value survived redaction: ${secret}`);
  }
  assert.equal(
    redacted,
    "run sk-*** ghp_*** npm_*** FOO_API_KEY=*** token=*** password=*** passwd=*** --password *** plain",
  );
  // The flag (=) form masks through the assignment rule; a clean command
  // passes verbatim (the program+args shape is the point, not obfuscation).
  assert.equal(redactPolyforgeCommand("--token=abc --password=def"), "--token=*** --password=***");
  assert.equal(redactPolyforgeCommand("npm install --no-save"), "npm install --no-save");
  // Truncation to ~120 chars applies after masking.
  assert.equal(redactPolyforgeCommand("x".repeat(200)).length, 120);
  assert.equal(redactPolyforgeCommand(`sk-${"y".repeat(300)}`), "sk-***");
});

test("progress passes only the whitelisted fields; malformed fields degrade to absent", async () => {
  const { sanitizeWatch } = await loadSubject();
  const base = {
    work_item: "wi_E2Eaaaa0001",
    slug: "pi#108",
    known: true,
    execution: { workflow_status: "running", steps: machineSteps },
    events: [],
  };
  const withProgress = (progress) => sanitizeWatch({ ...base, progress });
  const full = withProgress({
    command: "cmd --token=E2E-SECRET-PROGRESS-TOKEN",
    command_age_sec: 12,
    tool_calls: 3,
    recent_files: ["artifacts/plan.md", "repos/pi-web/lib/x.ts"],
    extra_field: "E2E-SECRET-PROGRESS",
  });
  assert.deepEqual(full?.progress, {
    command: "cmd --token=***",
    command_age_sec: 12,
    tool_calls: 3,
    recent_files: ["artifacts/plan.md", "repos/pi-web/lib/x.ts"],
  }, "only the whitelisted progress fields leave, command masked");
  assert.ok(!JSON.stringify(full).includes("E2E-SECRET-PROGRESS"), "non-whitelisted progress field leaked");
  // Every field is absent when missing or malformed on the wire.
  assert.equal(withProgress(undefined)?.progress, undefined, "absent progress → absent");
  assert.equal(withProgress("banana")?.progress, undefined, "non-object progress → absent");
  assert.equal(withProgress({})?.progress, undefined, "no valid field → the whole field degrades to absent");
  assert.deepEqual(withProgress({ command: 42 })?.progress, undefined, "non-string command → absent");
  assert.deepEqual(
    withProgress({ command: "ok", command_age_sec: "12", tool_calls: "3", recent_files: "nope" })?.progress,
    { command: "ok" },
    "malformed numerics/files degrade field-by-field, never an error",
  );
  assert.deepEqual(
    withProgress({ recent_files: ["a.md", 42] })?.progress,
    undefined,
    "recent_files that is not an array of strings degrades to absent",
  );
  assert.deepEqual(
    withProgress({ tool_calls: 7, recent_files: ["a.md", null] })?.progress,
    { tool_calls: 7 },
    "a non-string file entry drops recent_files only",
  );
});

test("origin exposes chat kind only; other kinds and fields never leave", async () => {
  const { sanitizeWatch } = await loadSubject();
  const base = {
    work_item: "wi_E2Eaaaa0001",
    slug: "pi#108",
    known: true,
    execution: { workflow_status: "running", steps: machineSteps },
    events: [],
  };
  const withOrigin = (origin) => sanitizeWatch({ ...base, job: { status: "running", origin } });
  assert.deepEqual(
    withOrigin({ kind: "chat", chat_id: "chat-e2e-0001", owner: "u_alice", extra: "E2E-SECRET-ORIGIN" })?.origin,
    { kind: "chat", chat_id: "chat-e2e-0001", owner: "u_alice" },
    "chat origins expose kind/chat_id/owner only",
  );
  assert.ok(!JSON.stringify(withOrigin({ kind: "chat", chat_id: "c", owner: "o", extra: "E2E-SECRET-ORIGIN" })).includes("E2E-SECRET-ORIGIN"));
  // Every other origin field (and any other kind) degrades the whole origin to absent.
  for (const origin of [
    { kind: "manual", chat_id: "chat-e2e-0001", owner: "u_alice" },
    { chat_id: "chat-e2e-0001", owner: "u_alice" },
    "banana",
    null,
  ]) {
    assert.equal(withOrigin(origin)?.origin, undefined, `origin ${JSON.stringify(origin)} must degrade to absent`);
    assert.ok(!JSON.stringify(withOrigin(origin)).includes("u_alice"), `origin ${JSON.stringify(origin)} leaked a field`);
  }
  // kind chat with neither id nor owner still exposes kind (field-level absence).
  assert.deepEqual(withOrigin({ kind: "chat" })?.origin, { kind: "chat" });
  // kind chat with a malformed chat_id keeps owner (field-level degradation).
  assert.deepEqual(
    withOrigin({ kind: "chat", chat_id: 42, owner: "u_alice" })?.origin,
    { kind: "chat", owner: "u_alice" },
    "a malformed chat_id degrades field-by-field, never an error",
  );
  // A missing job or origin is absent too, and the snapshot survives.
  assert.equal(sanitizeWatch({ ...base })?.origin, undefined, "no job → no origin");
  assert.equal(sanitizeWatch({ ...base, job: { status: "running" } })?.origin, undefined, "no origin → no origin");
});

test("summary fields pass verbatim through the whitelist; malformed fields degrade to absent (pi#119)", async () => {
  const { sanitizeWatch } = await loadSubject();
  const base = {
    work_item: "wi_E2Eaaaa0001",
    slug: "pi#108",
    known: true,
    execution: { workflow_status: "running", steps: machineSteps },
    events: [],
  };
  const withSummary = (fields) => sanitizeWatch({ ...base, ...fields });
  // Full pass: the line verbatim (trimmed), its age, the raw error verbatim
  // (no masking), the cap marker true — and nothing else.
  const full = withSummary({
    summary: "  The plan step finished; tests pass.  ",
    summary_age_sec: 61,
    summary_error: "summarize call failed: provider 429",
    summary_capped: true,
    summary_extra: "E2E-SECRET-SUMMARY",
  });
  assert.ok(full);
  assert.equal(full.summary, "The plan step finished; tests pass.", "summary passes verbatim, trimmed");
  assert.equal(full.summary_age_sec, 61, "age kept together with summary");
  assert.equal(full.summary_error, "summarize call failed: provider 429", "summary_error passes verbatim, no masking");
  assert.equal(full.summary_capped, true, "capped kept only as true");
  assert.ok(!JSON.stringify(full).includes("E2E-SECRET-SUMMARY"), "a non-whitelisted summary-adjacent field leaked");
  // summary_error caps at 512 chars server-side; summary has NO server-side
  // cap (the lane's own bound is 200) — a longer line passes verbatim.
  assert.equal(withSummary({ summary_error: "x".repeat(600) }).summary_error.length, 512, "summary_error must cap at 512");
  assert.equal(withSummary({ summary: "s".repeat(250) }).summary.length, 250, "summary passes verbatim with no server-side cap");
  // summary_age_sec is kept only together with summary.
  assert.equal(withSummary({ summary_age_sec: 61 }).summary_age_sec, undefined, "age without summary is dropped");
  assert.equal(withSummary({ summary: "ok", summary_age_sec: "61" }).summary_age_sec, undefined, "malformed age degrades to absent, never an error");
  // Each field is absent when missing or malformed.
  assert.equal(withSummary({}).summary, undefined, "no summary on the wire → absent");
  assert.equal(withSummary({ summary: "   " }).summary, undefined, "blank summary → absent");
  assert.equal(withSummary({ summary: 42 }).summary, undefined, "non-string summary → absent");
  assert.equal(withSummary({ summary_error: "" }).summary_error, undefined, "blank error → absent");
  assert.equal(withSummary({ summary_error: 42 }).summary_error, undefined, "non-string error → absent");
  // summary_capped survives only when the wire value is exactly true.
  for (const value of [false, "true", 1, null]) {
    assert.equal(withSummary({ summary_capped: value }).summary_capped, undefined, `summary_capped ${JSON.stringify(value)} must degrade to absent`);
  }
  // An error may ride together with an older summary (both kept — the
  // error line may show next to an older summary).
  const both = withSummary({ summary: "older line", summary_age_sec: 5, summary_error: "boom" });
  assert.equal(both.summary, "older line");
  assert.equal(both.summary_age_sec, 5);
  assert.equal(both.summary_error, "boom");
  // The four fields disturb nothing else in the snapshot.
  assert.deepEqual(both.steps.map((step) => step.name), STEP_ORDER, "steps unaffected by the summary fields");
});

test("declared_steps sanitize to ordered ids only; on_fail and extras never leak", async () => {
  const { sanitizeDeclaredSteps } = await loadSubject();
  const raw = [
    { id: " grill ", on_fail: "spec", path: "/srv/e2e-secret-workspace" },
    { id: "spec", on_fail: null },
    { id: "code" },
  ];
  assert.deepEqual(sanitizeDeclaredSteps(raw), [{ id: "grill" }, { id: "spec" }, { id: "code" }], "order preserved, ids trimmed");
  const text = JSON.stringify(sanitizeDeclaredSteps(raw));
  for (const leak of ["on_fail", "path", "/srv/e2e-secret-workspace"]) {
    assert.ok(!text.includes(leak), `declared step leaked ${leak}`);
  }
  // Absent / null / non-array / empty / entries without ids → null.
  assert.equal(sanitizeDeclaredSteps(undefined), null);
  assert.equal(sanitizeDeclaredSteps(null), null);
  assert.equal(sanitizeDeclaredSteps({ grill: "x" }), null);
  assert.equal(sanitizeDeclaredSteps("nope"), null);
  assert.equal(sanitizeDeclaredSteps([]), null);
  assert.equal(sanitizeDeclaredSteps([{ on_fail: "spec" }, { name: "plan" }]), null, "entries without ids → null");
  assert.equal(sanitizeDeclaredSteps([{ id: "grill" }, { id: "  " }]), null, "blank id → null");
  assert.equal(sanitizeDeclaredSteps([{ id: 42 }]), null, "non-string id → null");
  assert.equal(sanitizeDeclaredSteps([null]), null, "null entry → null");
});

test("malformed declared_steps degrades to null without disturbing steps/events", async () => {
  const { sanitizeWatch } = await loadSubject();
  const base = {
    work_item: "wi_E2Eaaaa0001",
    slug: "pi#108",
    known: true,
    execution: {
      workflow_status: "running",
      steps: machineSteps,
    },
    events: [{ at: "2026-10-18T10:00:00Z", kind: "step_started", body: { step: "grill" } }],
  };
  for (const declared of [undefined, null, { grill: "x" }, [], [{ on_fail: "spec" }]]) {
    const snapshot = sanitizeWatch({ ...base, execution: { ...base.execution, declared_steps: declared } });
    assert.ok(snapshot, `declared_steps ${JSON.stringify(declared)} must not nuke the snapshot`);
    assert.equal(snapshot.declared_steps, null, `declared_steps ${JSON.stringify(declared)} → null`);
    assert.deepEqual(snapshot.steps.map((step) => step.name), STEP_ORDER, "steps unaffected by malformed declared_steps");
    assert.deepEqual(snapshot.events, [{ at: "2026-10-18T10:00:00Z", kind: "step_started", step: "grill" }], "events unaffected");
  }
  const ok = sanitizeWatch({ ...base, execution: { ...base.execution, declared_steps: [{ id: "grill" }, { id: "code", on_fail: "plan" }] } });
  assert.deepEqual(ok?.declared_steps, [{ id: "grill" }, { id: "code" }], "well-formed declared_steps pass with ids only");
});

test("watch snapshot reads null for daemon-unknown refs and unusable shapes", async () => {
  const { sanitizeWatch } = await loadSubject();
  assert.equal(sanitizeWatch({ known: false, work_item: "wi_x", events: [], last_seq: 0 }), null);
  assert.equal(sanitizeWatch(null), null);
  assert.equal(sanitizeWatch("garbage"), null);
  assert.equal(sanitizeWatch({ known: true, execution: null }), null);
  assert.equal(sanitizeWatch({ known: true, execution: { steps: {} } }), null, "no wi/slug");
});

test("watch transport validates the ref before argv and builds the once/demand/40 argv", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./polyforge-status.ts", import.meta.url), "utf8");
  assert.match(source, /isPolyforgeWiRef\(wiRef\)/, "the ref is validated before any spawn");
  assert.match(source, /"--once"/, "the resident watcher must never be started: --once is mandatory");
  // pi#119: every watch read arms the summarize lane — --demand on every
  // call, always, with no client parameter (the open panel's 3s poll is the
  // route's only in-app caller) and no fallback for a pf without the flag.
  assert.match(source, /"--once", "--demand", "--events", String\(EVENT_TAIL\)/, "the watch argv must arm the summarize lane (--demand) on every read");
  assert.match(source, /timeout: PRESENCE_PROBE_TIMEOUT_MS/, "the presence probe outlives its own 3s timeout");
  assert.match(source, /timeout: READ_TIMEOUT_MS/, "reads outlive their own 10s timeout");
});

// ---------------------------------------------------------------------------
// pi#122: the presence cache carries the version; probePolyforgeVersion
// shares the one `pf --version` spawn + 60s cache, force bypasses the read.
// ---------------------------------------------------------------------------

test("version parse keeps a semver-ish line verbatim and reads anything else as absent", async () => {
  const { parsePolyforgeVersion } = await loadSubject();
  assert.equal(parsePolyforgeVersion("v2.19.1\n"), "v2.19.1", "the reported version passes verbatim");
  assert.equal(parsePolyforgeVersion("2.19.1"), "2.19.1", "the leading v is optional");
  assert.equal(parsePolyforgeVersion("v2.17.0-e2e\n"), "v2.17.0-e2e", "a prerelease suffix passes verbatim");
  assert.equal(parsePolyforgeVersion("v2.19.1+build.7"), "v2.19.1+build.7");
  for (const stdout of ["", "   \n", "not a version", "2.19", "polyforge 2.19.1", "v2.19.1\nsecond line", "42"]) {
    assert.equal(parsePolyforgeVersion(stdout), null, `unparseable stdout ${JSON.stringify(stdout)} → version absent`);
  }
});

test("the presence cache carries the version and force bypasses the cache read", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./polyforge-status.ts", import.meta.url), "utf8");
  // One cache, one spawn: probePolyforgePresent keeps its boolean contract by
  // delegating to probePolyforgeVersion (no second detection implementation).
  assert.match(source, /let presenceCache: \{ present: boolean; version: string \| null; expiresAt: number \}/);
  assert.match(source, /export async function probePolyforgeVersion\(force = false\)/);
  assert.match(source, /if \(!force && presenceCache && now < presenceCache\.expiresAt\)/, "force bypasses the cache read");
  assert.match(source, /return \(await probePolyforgeVersion\(\)\)\.present;/, "probePolyforgePresent delegates to the same spawn");
  assert.match(source, /version = parsePolyforgeVersion\(stdout\)/, "the probe parses the version out of the same stdout");
  assert.ok(
    source.indexOf("export async function probePolyforgePresent") < source.indexOf("export async function probePolyforgeVersion"),
    "probePolyforgePresent delegates; it does not re-implement the spawn",
  );
});
