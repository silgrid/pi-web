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
