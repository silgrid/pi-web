// Parallel runner for every standalone e2e suite.
//
//   npm run test:e2e:all                 # every suite
//   npm run test:e2e:all -- a.mjs b.mjs  # only those suites
//   E2E_JOBS=2 E2E_SUITE_TIMEOUT_MS=300000 npm run test:e2e:all
//
// Suites are discovered like the release verify-scope engine does: every
// e2e/*.mjs except files other e2e files import (helpers), the conf's
// `exclude=` globs, and this file. Browser suites each start their own
// `next dev`; the runner gives each one its own Next distDir
// (PI_WEB_DIST_DIR=.next/e2e/<stem>) so they can share one checkout, one
// node_modules and one Chromium install, and keep a warm Turbopack cache for
// the next run. Suites that touch host-global resources (tmux, pgrep, ...) are
// not browser suites and run one at a time in a separate serial lane.
// Output is buffered and printed in sorted suite order; the exit code is
// non-zero when any suite fails. A hung suite is killed after the timeout.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const self = "all.mjs";
const jobs = Math.max(1, Number(process.env.E2E_JOBS) || Math.min(2, Math.floor(cpus().length / 2)));
const timeoutMs = Number(process.env.E2E_SUITE_TIMEOUT_MS) || 10 * 60_000;

const files = readdirSync(join(root, "e2e")).filter((f) => f.endsWith(".mjs")).sort();
const source = new Map(files.map((f) => [f, readFileSync(join(root, "e2e", f), "utf8")]));
const imported = new Set();
for (const text of source.values()) {
  for (const m of text.matchAll(/from\s+["']\.\/([\w.-]+\.mjs)["']/g)) imported.add(m[1]);
}
const confPath = join(root, ".polyforge/verify-scope.conf");
const excludes = existsSync(confPath)
  ? readFileSync(confPath, "utf8").split("\n").filter((l) => l.startsWith("exclude=")).map((l) => l.slice(8).trim())
  : [];
const globToRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
const excluded = (f) => excludes.some((g) => globToRe(g).test(f) || globToRe(g).test(`e2e/${f}`));
const all = files.filter((f) => f !== self && !imported.has(f) && !excluded(f));

const requested = process.argv.slice(2).map((a) => a.replace(/^e2e\//, ""));
const unknown = requested.filter((r) => !all.includes(r));
if (unknown.length) {
  console.error(`Unknown suite(s): ${unknown.join(", ")}\nKnown: ${all.join(" ")}`);
  process.exit(2);
}
const suites = requested.length ? all.filter((f) => requested.includes(f)) : all;

// Same command as the package.json script that names the suite (e.g. the
// strip-types flag), else plain `node e2e/<suite>`.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
function argsFor(suite) {
  for (const cmd of Object.values(pkg.scripts ?? {})) {
    if (!cmd.startsWith("node ") || !cmd.endsWith(`e2e/${suite}`)) continue;
    return cmd.split(/\s+/).slice(1);
  }
  return [`e2e/${suite}`];
}
const browserMarker = "chromium" + ".launch";
const isBrowser = (suite) => source.get(suite).includes(browserMarker);

// One preflight instead of per-suite installs: dependencies and the browser.
if (!existsSync(join(root, "node_modules"))) {
  console.error("node_modules/ is missing: run `npm ci` once, then re-run.");
  process.exit(2);
}
if (suites.some(isBrowser)) {
  const { chromium } = await import("playwright");
  if (!existsSync(chromium.executablePath())) {
    console.error("Playwright Chromium is missing: run `npx playwright install chromium` once, then re-run.");
    process.exit(2);
  }
}

const running = new Set();
let interrupted = false;
function killGroup(child, signal) {
  try { process.kill(-child.pid, signal); } catch { /* already gone */ }
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, () => {
    interrupted = true;
    for (const child of running) killGroup(child, "SIGTERM");
    setTimeout(() => process.exit(130), 11_000).unref();
  });
}

function runSuite(suite) {
  return new Promise((resolve) => {
    const started = Date.now();
    const stem = suite.replace(/\.mjs$/, "");
    // The runner owns this distDir and nothing runs in it yet, so a lock left by
    // an earlier killed run is stale and would trip the suite's no-dev-server check.
    rmSync(join(root, ".next/e2e", stem, "dev/lock"), { force: true });
    const child = spawn(process.execPath, argsFor(suite), {
      cwd: root,
      env: { ...process.env, PI_WEB_DIST_DIR: `.next/e2e/${stem}` },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    running.add(child);
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 10_000).unref();
    }, timeoutMs);
    const finish = (code, signal) => {
      clearTimeout(timer);
      running.delete(child);
      const ok = code === 0 && !timedOut;
      if (timedOut) output += `\n[all.mjs] killed after ${timeoutMs}ms timeout\n`;
      else if (!ok && signal) output += `\n[all.mjs] terminated by ${signal}\n`;
      resolve({ suite, ok, seconds: Math.round((Date.now() - started) / 1000), output });
    };
    child.once("error", (error) => { output += `\n[all.mjs] spawn error: ${error.message}\n`; finish(1, null); });
    child.once("close", finish);
  });
}

async function lane(queue, width) {
  const results = [];
  const work = async () => {
    while (queue.length && !interrupted) results.push(await runSuite(queue.shift()));
  };
  await Promise.all(Array.from({ length: Math.min(width, queue.length) }, work));
  return results;
}

const started = Date.now();
console.log(`e2e/all: ${suites.length} suite(s), browser pool ${jobs}, serial lane 1`);
const settled = (await Promise.all([
  lane(suites.filter(isBrowser), jobs),
  lane(suites.filter((s) => !isBrowser(s)), 1),
])).flat().sort((a, b) => a.suite.localeCompare(b.suite));

for (const r of settled) {
  console.log(`\n===== ${r.ok ? "PASS" : "FAIL"} ${r.suite} (${r.seconds}s) =====`);
  console.log(r.ok ? r.output.split("\n").filter((l) => /^(PASS|FAIL)/.test(l)).join("\n") : r.output);
}
console.log("\n===== summary =====");
for (const r of settled) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.suite} ${r.seconds}s`);
const failed = settled.filter((r) => !r.ok);
console.log(`${settled.length - failed.length}/${settled.length} passed in ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(failed.length || interrupted ? 1 : 0);
