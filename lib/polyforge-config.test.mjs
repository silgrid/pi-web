import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const lib = await jiti.import("./polyforge-config.ts");

test("the list shape gate requires the CAS hash and a class on every item", () => {
  assert.equal(lib.hasConfigListShape({ file: { sha256: "a" }, items: [{ key: "server", class: "restart-only" }] }), true);
  assert.equal(lib.hasConfigListShape({ items: [{ key: "server", class: "restart-only" }] }), false, "no file hash");
  assert.equal(lib.hasConfigListShape({ file: { sha256: "a" }, items: [{ key: "server", value: "x" }] }), false, "no class");
  assert.equal(lib.hasConfigListShape({ file: { sha256: "a" }, items: [] }), false);
});

test("api_key sanitizes to set/source/class only and never carries a value", () => {
  const item = lib.sanitizeConfigItem({ key: "api_key", value: "SENTINEL", set: true, source: "file", class: "restart-only", schema: { kind: "secret" } });
  assert.equal(item.value, undefined);
  assert.equal(item.set, true);
  assert.equal(item.class, "restart-only");
  assert.ok(!JSON.stringify(item).includes("SENTINEL"));
});

test("stale classification names the four plan reasons", () => {
  assert.equal(lib.classifyStaleReason("max_concurrent_jobs", 7, 6, { pending: ["max_concurrent_jobs"], overridden: [] }, 6), "pending restart");
  assert.equal(lib.classifyStaleReason("max_concurrent_jobs", 7, 6, { pending: [], overridden: ["max_concurrent_jobs"] }, 6), "daemon flag override");
  assert.equal(lib.classifyStaleReason("max_concurrent_jobs", 7, 2, { pending: [], overridden: [] }, 6), "pf ops max override");
  assert.equal(lib.classifyStaleReason("step_timeout", "45m0s", "30m0s", { pending: [], overridden: [] }, 6), "not reloaded");
  assert.equal(lib.classifyStaleReason("step_timeout", "30m0s", "30m0s", undefined, undefined), undefined);
});

test("the capability floor is the panel's own, above the dock floor", async () => {
  assert.equal(lib.POLYFORGE_CONFIG_PANEL_MINIMUM_PF_VERSION, "2.20.6");
  const detect = await jiti.import("./polyforge-detect.ts");
  assert.equal(detect.isPolyforgeVersionBelowMinimum("v2.20.5", lib.POLYFORGE_CONFIG_PANEL_MINIMUM_PF_VERSION), true);
  assert.equal(detect.isPolyforgeVersionBelowMinimum("v2.20.6", lib.POLYFORGE_CONFIG_PANEL_MINIMUM_PF_VERSION), false);
});

// the workspace read's new facts ride the config read.
const WORKSPACE_216 = {
  mapped: true, workspace: "/ws", yaml: { path: "/ws/.polyforge.yaml", sha256: "abc", exists: true },
  summarize: {},
  steps: {
    alpha: {
      grill: { declared: true, models: ["claude:x"], source: "file", class: "live", attrs: { question_batch_size: { value: 2, declared: true, source: "file", class: "live", default: 0, schema: { kind: "int" } } } },
      review: { declared: true, models: [], source: "file", class: "live" },
      default: { declared: false, models: null, source: "default", class: "live" },
      task: { declared: false, models: null, source: "default", class: "live" },
    },
  },
  steps_complete: true,
  memory_policy: {
    source: "file", class: "next-claim", append_to_default: true,
    default: { record: ["base"], skip: ["s"], declared: true },
    projects: { alpha: { record: ["a"], skip: [], declared: true }, beta: { record: [], skip: [], declared: false } },
  },
};

test("step entries carry source/class/attrs and the default/task rows", () => {
  const ws = lib.sanitizeWorkspace(WORKSPACE_216);
  const byId = Object.fromEntries(ws.steps.map((step) => [step.step, step]));
  assert.deepEqual(Object.keys(byId).sort(), ["default", "grill", "review", "task"]);
  assert.equal(byId.grill.source, "file");
  assert.equal(byId.grill.class, "live");
  assert.deepEqual(byId.grill.attrs.question_batch_size, { declared: true, source: "file", class: "live", value: 2, default: 0, schema: { kind: "int" } });
  assert.deepEqual(byId.review.models, [], "declared-empty stays an empty list");
  assert.equal(byId.review.declared, true);
  assert.equal(byId.default.declared, false);
  assert.equal(byId.default.models, null);
});

test("memory_policy is read whole: the default, each project's own lists, the append fact", () => {
  const ws = lib.sanitizeWorkspace(WORKSPACE_216);
  assert.deepEqual(ws.memoryPolicy, {
    source: "file", class: "next-claim", appendToDefault: true,
    default: { record: ["base"], skip: ["s"], declared: true },
    projects: { alpha: { record: ["a"], skip: [], declared: true }, beta: { record: [], skip: [], declared: false } },
  });
  assert.equal(lib.sanitizeMemoryPolicy(undefined), null, "an older pf reports no memory_policy");
});
