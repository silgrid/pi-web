// e2e/all.mjs's browser-pool default is
// min(6, max(2, floor(cpus / 4))) — 32 cores run 6 browser suites at a time,
// 4–8 cores keep 2 — and an explicit E2E_JOBS keeps its precedence. A larger
// pool must never move an `e2e/all: isolated` suite into it: isolated suites
// still run one at a time after both regular lanes drain.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { defaultJobs, resolveJobs } from "../e2e/runner/jobs.mjs";

const runnerSource = readFileSync(new URL("../e2e/all.mjs", import.meta.url), "utf8");
const jobsSource = readFileSync(new URL("../e2e/runner/jobs.mjs", import.meta.url), "utf8");

test("the default pool grows with the host and never drops below 2", () => {
  const table = { 1: 2, 2: 2, 4: 2, 8: 2, 12: 3, 16: 4, 24: 6, 32: 6, 64: 6 };
  for (const [cpuCount, expected] of Object.entries(table)) {
    assert.equal(defaultJobs(Number(cpuCount)), expected, `${cpuCount} cores`);
  }
});

test("an explicit E2E_JOBS wins; blank, 0 and non-numeric fall back to the default", () => {
  assert.equal(resolveJobs("1", 32), 1);
  assert.equal(resolveJobs("8", 4), 8);
  assert.equal(resolveJobs(undefined, 32), 6);
  assert.equal(resolveJobs(undefined, 4), 2);
  for (const value of ["", "0", "abc"]) assert.equal(resolveJobs(value, 32), 6, JSON.stringify(value));
});

test("isolated suites stay out of the browser pool and run one at a time after it", () => {
  const work = mkdtempSync(join(tmpdir(), "e2e-all-jobs-"));
  const log = join(work, "events.log");
  try {
    mkdirSync(join(work, "e2e/runner"), { recursive: true });
    mkdirSync(join(work, "node_modules"));
    writeFileSync(join(work, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(join(work, "e2e/all.mjs"), runnerSource);
    writeFileSync(join(work, "e2e/runner/jobs.mjs"), jobsSource);
    // Each fixture appends `start <name>` / `end <name>` around a short pause.
    const suite = (name, marker = "") => `${marker}import { appendFileSync } from "node:fs";\n`
      + `appendFileSync(${JSON.stringify(log)}, "start ${name}\\n");\n`
      + `setTimeout(() => { appendFileSync(${JSON.stringify(log)}, "end ${name}\\n"); console.log("PASS: ${name}"); }, 200);\n`;
    writeFileSync(join(work, "e2e/regular.mjs"), suite("regular"));
    writeFileSync(join(work, "e2e/solo-a.mjs"), suite("solo-a", "// e2e/all: isolated\n"));
    writeFileSync(join(work, "e2e/solo-b.mjs"), suite("solo-b", "// e2e/all: isolated\n"));

    const run = spawnSync(process.execPath, ["e2e/all.mjs"], {
      cwd: work,
      encoding: "utf8",
      timeout: 50_000,
      env: { ...process.env, E2E_JOBS: "3" },
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^e2e\/all: 3 suite\(s\), browser pool 3, serial lane 1, 2 isolated$/m);

    const events = readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(events, [
      "start regular", "end regular",
      "start solo-a", "end solo-a",
      "start solo-b", "end solo-b",
    ]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
