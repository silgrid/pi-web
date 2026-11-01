import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const schema = await jiti.import("./polyforge-config-schema.ts");

test("the form value guard enforces int bounds and duration nonzero/min_exclusive", () => {
  assert.equal(schema.configValueError("summarize.interval_sec", 9, { kind: "int", min: 10, max: 3600 }), "must be at least 10");
  assert.equal(schema.configValueError("summarize.interval_sec", 0, { kind: "int", min: 10, max: 3600 }), "must be at least 10");
  assert.equal(schema.configValueError("summarize.interval_sec", 4000, { kind: "int", min: 10, max: 3600 }), "must be at most 3600");
  assert.equal(schema.configValueError("summarize.interval_sec", 10, { kind: "int", min: 10, max: 3600 }), null);
  assert.equal(schema.configValueError("max_concurrent_jobs", 0, { kind: "int", min: 1 }), "must be at least 1");
  assert.equal(schema.configValueError("step_timeout", "0", { kind: "duration", min_exclusive: 0 }), "must be greater than zero");
  assert.equal(schema.configValueError("stall_window", "0s", { kind: "duration", nonzero: true }), "must be non-zero");
  assert.equal(schema.configValueError("stall_window", "-1m", { kind: "duration", nonzero: true }), null);
  assert.equal(schema.configValueError("step_timeout", "45m", { kind: "duration", min_exclusive: 0 }), null);
  assert.equal(schema.parseGoDurationMs("1h30m"), 5400000);
});

test("the schema module is browser-safe: it imports nothing at runtime", async () => {
  // The client form imports this module, so it must never gain a runtime
  // import of a server-only module (the regression this file guards).
  const source = await readFile(new URL("./polyforge-config-schema.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\s+(?!type\b)/m, "no runtime import");
  assert.doesNotMatch(source, /from\s+"node:/, "no node built-in");
  assert.doesNotMatch(source, /\brequire\(/, "no require");
});

// the step keys' parse and form guard (one fact for the
// client form and the write route); no candidate validator here.
test("step write keys parse and the guard checks only the shape", () => {
  assert.deepEqual(schema.parseStepWriteKey("steps.alpha.grill.models"), { project: "alpha", step: "grill" });
  assert.deepEqual(schema.parseStepWriteKey("steps.alpha.grill.attrs.question_batch_size"), { project: "alpha", step: "grill", attr: "question_batch_size" });
  for (const bad of ["steps.alpha.models", "steps.alpha.grill.budget", "steps..grill.models", "summarize.models", "steps.a.b.attrs"]) {
    assert.equal(schema.parseStepWriteKey(bad), null, bad);
  }
  assert.equal(schema.stepWriteKey("alpha", "grill"), "steps.alpha.grill.models");
  assert.equal(schema.stepWriteKey("alpha", "grill", "question_batch_size"), "steps.alpha.grill.attrs.question_batch_size");
  assert.equal(schema.stepValueError("steps.alpha.grill.models", ["not-a-candidate"]), null, "the candidate format is pf's judgment");
  assert.equal(schema.stepValueError("steps.alpha.grill.models", []), "at least one model candidate is required");
  assert.equal(schema.stepValueError("steps.alpha.grill.attrs.question_batch_size", 2), null);
  assert.equal(schema.stepValueError("steps.alpha.grill.attrs.question_batch_size", "2"), null);
  assert.equal(schema.stepValueError("steps.alpha.grill.attrs.question_batch_size", 1.5), "an integer is required");
  assert.equal(schema.stepValueError("steps.alpha.grill.attrs.question_batch_size", -1), "must be at least 0");
  assert.equal(schema.stepValueError("steps.alpha.grill.attrs.question_batch_size", ""), "an integer is required");
});
