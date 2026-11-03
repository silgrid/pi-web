import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// the workflow card's read transport.
const jiti = createJiti(import.meta.url);
const lib = await jiti.import("./polyforge-workflows.ts");
const route = await readFile(new URL("../app/api/polyforge/workflows/route.ts", import.meta.url), "utf8");

const WORKFLOWS = {
  workflows_dir: "/wf", daemon_reachable: true, reason: "", workspace: "/ws", projects: ["alpha", "beta"],
  write_capable: true, write_reason: "", extra_field: "dropped",
  task: { alpha: { models: ["pi:d"], from: "steps.alpha.default.models" } },
  bundles: [{
    name: "feature-full",
    defaults: { model_candidates: ["pi:ff"], effective: { alpha: { models: ["pi:d"], from: "steps.alpha.default.models" } } },
    steps: [
      { id: "grill", model_candidates: ["pi:g"], attrs: [{ name: "question_batch_size", type: "int", default: 0 }], effective: { alpha: { models: ["pi:g"], from: "bundle feature-full step grill model_candidates" } } },
      { id: "spec" },
    ],
  }],
  bundle_errors: [{ bundle: "broken", reason: "yaml: line 2" }],
};
const WORKSPACE = {
  mapped: true, workspace: "/ws", yaml: { path: "/ws/.polyforge.yaml", sha256: "abc", exists: true },
  steps: { alpha: { grill: { declared: true, models: ["claude:x"], source: "file", class: "live", attrs: { question_batch_size: { value: 2, declared: true, source: "file", class: "live", default: 0, schema: { kind: "int" } } } } } },
};

test("the card's floor is 2.20.15, its own, the config panel's untouched", async () => {
  assert.equal(lib.POLYFORGE_WORKFLOW_CARD_MINIMUM_PF_VERSION, "2.20.15");
  const config = await jiti.import("./polyforge-config.ts");
  assert.equal(config.POLYFORGE_CONFIG_PANEL_MINIMUM_PF_VERSION, "2.20.6");
});

test("the workflows sanitizer keeps the documented fields only", () => {
  const doc = lib.sanitizeWorkflowsDoc(WORKFLOWS);
  assert.equal(doc.extra_field, undefined);
  assert.deepEqual(doc.projects, ["alpha", "beta"]);
  assert.deepEqual(doc.bundles[0].steps[0].attrs, [{ name: "question_batch_size", type: "int", default: 0 }]);
  assert.equal(doc.bundles[0].steps[1].model_candidates, undefined, "a step declaring no candidates gets none");
  assert.deepEqual(doc.bundle_errors, [{ bundle: "broken", reason: "yaml: line 2" }]);
  assert.equal(doc.task.alpha.from, "steps.alpha.default.models");
  assert.equal(lib.sanitizeWorkflowsDoc({ nope: true }), null);
});

test("the workspace sanitizer keeps declared values and attrs", () => {
  const ws = lib.sanitizeWorkflowWorkspace(WORKSPACE);
  assert.equal(ws.yaml.sha256, "abc");
  assert.deepEqual(ws.steps.alpha.grill.models, ["claude:x"]);
  assert.equal(ws.steps.alpha.grill.attrs.question_batch_size.value, 2);
  assert.equal(lib.sanitizeWorkflowWorkspace({ mapped: false }), null);
});

function fakePf(t, { version = "v2.20.16", workflows = WORKFLOWS, workspace = WORKSPACE, failWorkflows = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pf-wf-"));
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "workflows.json"), JSON.stringify(workflows));
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(workspace));
  const bin = join(dir, "pf");
  writeFileSync(bin, `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  --version) echo "${version}" ;;
  *" workflows"*) ${failWorkflows ? 'echo "pf: boom" >&2; exit 1' : `cat "${dir}/workflows.json"`} ;;
  *"config workspace"*) cat "${dir}/workspace.json" ;;
  *) exit 2 ;;
esac
`);
  chmodSync(bin, 0o755);
  const previous = process.env.PF_BIN;
  process.env.PF_BIN = bin;
  t.after(() => {
    if (previous === undefined) delete process.env.PF_BIN;
    else process.env.PF_BIN = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return () => readFileSync(log, "utf8").trim().split("\n");
}

test("every read spawns both pf reads afresh (no cache)", async (t) => {
  const calls = fakePf(t);
  const first = await lib.readPolyforgeWorkflows("/ws/sub");
  assert.equal(first.capable, true);
  assert.equal(first.reason, undefined);
  assert.equal(first.workflows.bundles[0].name, "feature-full");
  assert.equal(first.workspace.steps.alpha.grill.declared, true);
  await lib.readPolyforgeWorkflows("/ws/sub");
  const reads = calls().filter((line) => line !== "--version");
  assert.equal(reads.filter((line) => line === "--json workflows --cwd /ws/sub").length, 2, "one fresh pf workflows per call");
  assert.equal(reads.filter((line) => line === "--json config workspace --cwd /ws/sub").length, 2, "one fresh workspace read per call");
  assert.equal(reads.length, 4);
});

test("below the floor the read is a capable:false field and spawns no read verb", async (t) => {
  const calls = fakePf(t, { version: "v2.20.14" });
  const old = await lib.readPolyforgeWorkflows("/ws");
  assert.deepEqual(calls(), ["--version"]);
  assert.equal(old.capable, false);
  assert.match(old.reason, /2\.20\.15/);
  assert.equal(old.workflows, null);
});

test("a failed workflows read keeps the workspace facts and names the failure", async (t) => {
  fakePf(t, { failWorkflows: true });
  const read = await lib.readPolyforgeWorkflows("/ws");
  assert.equal(read.capable, true);
  assert.equal(read.workflows, null);
  assert.match(read.reason, /boom/);
});

test("an unreachable daemon is the document's reason", async (t) => {
  fakePf(t, { workflows: { ...WORKFLOWS, daemon_reachable: false, reason: "the daemon is not reachable", bundles: [] } });
  const read = await lib.readPolyforgeWorkflows("/ws");
  assert.equal(read.workflows.daemon_reachable, false);
  assert.match(read.reason, /not reachable/);
});

test("the route is GET-only, gated, dynamic, never 5xx and caches nothing", () => {
  const handlers = [...route.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(handlers, ["GET"], "only GET (POST is 405)");
  assert.match(route, /if \(!isApiRequestAllowed\(request\)\)/);
  assert.match(route, /export const dynamic = "force-dynamic"/);
  const statuses = [...route.matchAll(/status: (\d{3})/g)].map((m) => Number(m[1]));
  assert.deepEqual(statuses, [403]);
  assert.match(route, /readPolyforgeWorkflows\(cwd\)/);
  assert.doesNotMatch(route, /^(let|const) \w*[cC]ache/m, "no module-level cache");
});
