// the parallel e2e runner must name every failing unit as
// `<suite file>: <scenario>` and print that suite's targeted re-run.
//
// The full bar runs every suite through one `npm run test:e2e:all` command, so a
// load-sensitive `locator.click: Timeout` failure used to surface only inside a
// long buffered suite block. e2e/all.mjs now prints a `===== failures =====`
// section before the summary: one line per failing scenario marker, a fallback
// line for a failing suite with no marker, and one `re-run:` line per failing
// suite.
//
// The test copies the real runner into a throwaway root (the
// lib/e2e-all-interrupt.test.mjs pattern) with fixture suites: two that print
// the repo's two marker shapes and exit 1, one that dies with no marker and one
// that passes. On the pre-change runner the section does not exist.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const runnerSource = readFileSync(new URL("../e2e/all.mjs", import.meta.url), "utf8");

test("the runner's failures section names suite, scenario and the targeted re-run", { timeout: 60_000 }, () => {
  const work = mkdtempSync(join(tmpdir(), "e2e-all-failures-"));
  try {
    mkdirSync(join(work, "e2e"));
    mkdirSync(join(work, "node_modules"));
    writeFileSync(join(work, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(join(work, "e2e/all.mjs"), runnerSource);
    // `FAIL: <id>` with the message indented below it (polyforge-work-tab-163).
    writeFileSync(
      join(work, "e2e/marked.mjs"),
      `console.log("PASS: SC0");\n`
        + `console.log("FAIL: SC1\\n\\n  locator.click: Timeout 8000ms exceeded.\\n  Call log:");\n`
        + `process.exit(1);\n`,
    );
    // `FAIL <id>: <message>` on one line (polyforge-panel-213).
    writeFileSync(
      join(work, "e2e/inline.mjs"),
      `console.log("FAIL SC2: locator.click: Timeout 10000ms exceeded.");\n`
        + `console.log("\\nFAILED SC2 — 1 scenario(s) red");\n`
        + `process.exit(1);\n`,
    );
    writeFileSync(join(work, "e2e/crash.mjs"), `console.log("starting");\nthrow new Error("boom");\n`);
    writeFileSync(join(work, "e2e/passing.mjs"), `console.log("PASS: SC9");\n`);

    const run = spawnSync(process.execPath, ["e2e/all.mjs"], { cwd: work, encoding: "utf8", timeout: 50_000 });
    const output = `${run.stdout}${run.stderr}`;
    assert.notEqual(run.status, 0, `a failing suite must still fail the run:\n${output}`);

    const start = run.stdout.indexOf("\n===== failures =====\n");
    const end = run.stdout.indexOf("\n===== summary =====\n");
    assert.ok(start >= 0 && end > start, `no failures section before the summary:\n${output}`);
    const section = run.stdout.slice(start, end).split("\n").filter(Boolean).slice(1);

    const crash = section.find((l) => l.startsWith("FAIL e2e/crash.mjs: "));
    assert.match(crash ?? "", /^FAIL e2e\/crash\.mjs: no scenario marker — \S/, `crash line:\n${section.join("\n")}`);
    assert.deepEqual(section, [
      crash,
      "re-run: npm run test:e2e:all -- crash.mjs",
      "FAIL e2e/inline.mjs: SC2 — locator.click: Timeout 10000ms exceeded.",
      "re-run: npm run test:e2e:all -- inline.mjs",
      "FAIL e2e/marked.mjs: SC1 — locator.click: Timeout 8000ms exceeded.",
      "re-run: npm run test:e2e:all -- marked.mjs",
    ]);
    assert.equal(section.some((l) => l.includes("passing.mjs")), false, "a passing suite contributes nothing");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a run with no failure prints no failures section", { timeout: 60_000 }, () => {
  const work = mkdtempSync(join(tmpdir(), "e2e-all-failures-"));
  try {
    mkdirSync(join(work, "e2e"));
    mkdirSync(join(work, "node_modules"));
    writeFileSync(join(work, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(join(work, "e2e/all.mjs"), runnerSource);
    writeFileSync(join(work, "e2e/passing.mjs"), `console.log("PASS: SC9");\n`);
    const run = spawnSync(process.execPath, ["e2e/all.mjs"], { cwd: work, encoding: "utf8", timeout: 50_000 });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.equal(run.stdout.includes("===== failures ====="), false, run.stdout);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
