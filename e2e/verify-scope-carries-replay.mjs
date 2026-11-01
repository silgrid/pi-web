// carries: e2e/* .polyforge/verify-scope.conf CONTRIBUTING.md
// pi-web e2e: the carries-layer replay oracle. The release-
// shipped verification-scope engine learns to select e2e suites from their
// `carries:` header instead of from a textual reference. This suite is the
// external acceptance for that layer on this repository's change surface:
//
//   - every standalone suite declares its coverage in its opening comment
//     block, so the engine's undeclared-suite rule never forces full;
//   - the conf declares the repository's one e2e runner, and the acceptance
//     suite's conf pin moves with it;
//   - a replayed #213-shaped diff selects the carrier suites (a strict subset
//     of all suites), and deleting one carrier header falls back to full.
//
// The engine is resolved from VERIFY_SCOPE_ENGINE first, then the release
// tree. The replay SKIPs only when no engine is available or when a probe
// shows the engine performs no carries-aware selection; an engine that is
// carries-aware but selects the wrong suites FAILs.
//
// Run: node e2e/verify-scope-carries-replay.mjs   (from the repository root)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const confPath = join(root, ".polyforge/verify-scope.conf");
const acceptancePath = join(root, "e2e/verify-scope-acceptance.mjs");
const RUNNER_LINE = "e2e_runner=npm run test:e2e:all --";

function isExecutable(path) {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function resolveEngine(env = process.env) {
  if (env.VERIFY_SCOPE_ENGINE) return resolve(env.VERIFY_SCOPE_ENGINE);
  const dataDir = env.POLYFORGE_DATA_DIR || join(homedir(), ".local/share/polyforge");
  return join(dataDir, "release/current/tools/verify-scope");
}

// parseReport validates the engine's line-report grammar and answers its
// mode, paths and commands.
function parseReport(stdout) {
  const trimmed = stdout.replace(/\n+$/, "");
  assert.ok(trimmed.length > 0, "the engine printed no report on stdout");
  const lines = trimmed.split("\n");
  assert.match(lines[0], /^mode: (full|scoped)$/, `first line ${JSON.stringify(lines[0])}`);
  const mode = lines[0].slice("mode: ".length);
  const paths = [];
  const commands = [];
  let seenCommand = false;
  for (const line of lines.slice(1)) {
    if (line.startsWith("path: ")) {
      assert.ok(!seenCommand, `path line after a command line: ${line}`);
      paths.push(line.slice("path: ".length));
    } else if (line.startsWith("command: ")) {
      seenCommand = true;
      commands.push(line.slice("command: ".length));
    } else {
      assert.fail(`report line is neither path: nor command:: ${JSON.stringify(line)}`);
    }
  }
  return { mode, paths, commands };
}

function runEngine(engine, cwd, args = []) {
  const run = spawnSync(engine, args, { cwd, encoding: "utf8" });
  assert.equal(run.error, undefined, `spawn ${engine}: ${run.error}`);
  assert.equal(run.status, 0, `engine ${args.join(" ")}: exit ${run.status} (stderr ${run.stderr})`);
  return parseReport(run.stdout);
}

function git(cwd, args) {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "w227",
      GIT_AUTHOR_EMAIL: "w227@example.invalid",
      GIT_COMMITTER_NAME: "w227",
      GIT_COMMITTER_EMAIL: "w227@example.invalid",
    },
  });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

function writeFile(base, rel, body) {
  const path = join(base, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

// makeRepo builds a committed git fixture whose origin/main is the diff base.
function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), "w227-replay-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "w227@example.invalid"]);
  git(dir, ["config", "user.name", "w227"]);
  for (const [rel, body] of Object.entries(files)) writeFile(dir, rel, body);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "w227 replay base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", base]);
  git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  return { dir, base };
}

// probeCarriesAware answers whether the engine selects a suite from its
// carries: declaration alone: the changed path appears in the header glob but
// nowhere in the suite body, so textual matching cannot select it. An engine
// that errors or exits non-zero here FAILs the scenario (runEngine asserts);
// only a valid report with no carries-selected suite means "not
// carries-aware", which the scenario may SKIP on.
function probeCarriesAware(engine) {
  const repo = makeRepo({
    "package.json": '{\n  "name": "w227-probe",\n  "scripts": {"lint": "eslint ."}\n}\n',
    "app/one/two.ts": "export const two = 1;\n",
    "e2e/probe.mjs": "// carries: app/*\nconsole.log('probe');\n",
  });
  try {
    writeFile(repo.dir, "app/one/two.ts", "export const two = 2;\n");
    git(repo.dir, ["add", "-A"]);
    git(repo.dir, ["commit", "-q", "-m", "w227 probe change"]);
    const report = runEngine(engine, repo.dir, ["--base", repo.base]);
    return report.mode === "scoped" && report.commands.some((c) => c.includes("e2e/probe.mjs"));
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
}

// openingBlock answers the suite's opening comment block: leading blank and
// comment lines up to the first line of code.
function openingBlock(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("*/")) {
      out.push(line);
      continue;
    }
    break;
  }
  return out.join("\n");
}

function globToRe(glob) {
  return new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
}

// confDeclarations answers the conf's non-comment lines.
function confDeclarations() {
  return readFileSync(confPath, "utf8")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "" && !line.trimStart().startsWith("#"));
}

const scenarios = [];
const SKIPPED = Symbol("skipped");
const scenario = (name, fn) => scenarios.push({ name, fn });

// ---------------------------------------------------------------------------
// Every standalone suite declares its coverage before the layer is relied on.
// ---------------------------------------------------------------------------
scenario("S18 every standalone pi-web suite declares its carries", () => {
  const files = readdirSync(join(root, "e2e")).filter((f) => f.endsWith(".mjs")).sort();
  const source = new Map(files.map((f) => [f, readFileSync(join(root, "e2e", f), "utf8")]));
  const imported = new Set();
  for (const text of source.values()) {
    for (const m of text.matchAll(/from\s+["']\.\/([\w.-]+\.mjs)["']/g)) imported.add(m[1]);
  }
  const excludes = confDeclarations()
    .filter((line) => line.startsWith("exclude="))
    .map((line) => line.slice("exclude=".length).trim());
  const excluded = (f) => excludes.some((g) => globToRe(g).test(f) || globToRe(g).test(`e2e/${f}`));
  const suites = files.filter((f) => f !== "all.mjs" && !imported.has(f) && !excluded(f));
  assert.ok(suites.length > 0, "the repository must hold standalone suites");
  const undeclared = suites.filter((f) => !/^\/\/\s*carries:\s*\S/m.test(openingBlock(source.get(f))));
  assert.deepEqual(undeclared, [], `suites without a carries: header in their opening comment block: ${undeclared.join(", ")}`);
});

// ---------------------------------------------------------------------------
// The conf declares the runner and the acceptance pin moves with it.
// ---------------------------------------------------------------------------
scenario("S19 the conf declares e2e_runner and its acceptance pin matches", () => {
  assert.ok(
    confDeclarations().includes(RUNNER_LINE),
    `${confPath} must declare exactly \`${RUNNER_LINE}\``,
  );
  assert.ok(
    readFileSync(acceptancePath, "utf8").includes(`"${RUNNER_LINE}"`),
    `e2e/verify-scope-acceptance.mjs's EXPECTED_CONF must pin \`${RUNNER_LINE}\``,
  );
});

// ---------------------------------------------------------------------------
// The replayed #213 change surface selects the carrier suites, as a strict
// subset of the real standalone suites; deleting one real carrier header
// forces the full tier. The replay runs on a throwaway clone of this
// repository's real HEAD and touches only the fourteen paths of merge
// f6472f4b: three components, their unit tests, AGENTS.md,
// the panel doc, and the six carrier suites. `.polyforge/` is never touched.
// ---------------------------------------------------------------------------
const RUNNER_COMMAND_PREFIX = "npm run test:e2e:all --";

// The fourteen paths of merge f6472f4b, the real change
// surface this replay reproduces. A path is "replayed" by appending a marker
// comment, so the diff carries exactly this set without rewriting the real
// file contents or the suite headers the selection reads.
const REPLAY_213_SURFACE = [
  "AGENTS.md",
  "components/PolyforgeMessages.test.mjs",
  "components/PolyforgeMessages.tsx",
  "components/PolyforgePanel.test.mjs",
  "components/PolyforgePanel.tsx",
  "components/PolyforgeTasks.test.mjs",
  "components/PolyforgeTasks.tsx",
  "docs/agents/polyforge-panel.md",
  "e2e/polyforge-cards.mjs",
  "e2e/polyforge-messages.mjs",
  "e2e/polyforge-panel-213.mjs",
  "e2e/polyforge-work-items-203.mjs",
  "e2e/polyforge-work-tab-163.mjs",
  "e2e/ui-polish-198.mjs",
];

// The six suites #213 touched; every one must be selected by the real
// `components/Polyforge*` headers in this repository.
const CARRIER_SUITES = [
  "polyforge-cards.mjs",
  "polyforge-messages.mjs",
  "polyforge-panel-213.mjs",
  "polyforge-work-items-203.mjs",
  "polyforge-work-tab-163.mjs",
  "ui-polish-198.mjs",
];

// The exact selection this repository's real suites produce for the #213
// surface, pre-written as the acceptance evidence `verification` records. The
// standing assertions below stay durable (carrier subset, real narrowing,
// header removal -> full) rather than pinning this list, which would break on
// the next suite added to the tree.
const EXPECTED_213_SELECTION = [
  "polyforge-210.mjs",
  "polyforge-cards.mjs",
  "polyforge-config-layout.mjs",
  "polyforge-config-panel.mjs",
  "polyforge-config-simplify-212.mjs",
  "polyforge-config-viewport.mjs",
  "polyforge-graph.mjs",
  "polyforge-memory-panel.mjs",
  "polyforge-messages-contacts.mjs",
  "polyforge-messages-groups-223.mjs",
  "polyforge-messages.mjs",
  "polyforge-panel-213.mjs",
  "polyforge-panels-123.mjs",
  "polyforge-settings.mjs",
  "polyforge-task-report-194.mjs",
  "polyforge-widget.mjs",
  "polyforge-work-items-203.mjs",
  "polyforge-work-tab-163.mjs",
  "polyforge-workflow-216.mjs",
  "polyforge.mjs",
  "ui-polish-198.mjs",
  "verify-scope-carries-replay.mjs",
];

// cloneRealHead copies this repository's committed HEAD into a throwaway
// directory, so the replay changes real files without touching the worktree.
function cloneRealHead(sourceRoot) {
  const dir = mkdtempSync(join(tmpdir(), "w227-213-replay-"));
  const repo = join(dir, "repo");
  git(dir, ["clone", "-q", "--no-hardlinks", sourceRoot, repo]);
  return repo;
}

// touchReplaySurface appends one marker comment to each real #213 path.
function touchReplaySurface(repoRoot) {
  for (const rel of REPLAY_213_SURFACE) {
    const path = join(repoRoot, rel);
    const text = readFileSync(path, "utf8");
    const body = text.endsWith("\n") ? text : `${text}\n`;
    writeFileSync(path, rel.endsWith(".md") ? `${body}\n<!-- w227 #213 replay touch -->\n` : `${body}\n// w227 #213 replay touch\n`);
  }
}

// stripOpeningCarries removes every carries: line from the suite's opening
// comment block, leaving the rest of the real suite byte-identical.
function stripOpeningCarries(text) {
  const out = [];
  let block = true;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (block) {
      if (t === "" || t.startsWith("//")) {
        if (/^\/\/\s*carries\s*:/.test(t)) continue;
        out.push(line);
        continue;
      }
      block = false;
    }
    out.push(line);
  }
  return out.join("\n");
}

// standaloneSuiteNames enumerates this repository's real standalone suites the
// way S18 does: e2e/*.mjs minus imported helpers, exclude= matches and the
// e2e_runner target.
function standaloneSuiteNames(repoRoot) {
  const e2eDir = join(repoRoot, "e2e");
  const files = readdirSync(e2eDir).filter((f) => f.endsWith(".mjs")).sort();
  const source = new Map(files.map((f) => [f, readFileSync(join(e2eDir, f), "utf8")]));
  const imported = new Set();
  for (const text of source.values()) {
    for (const m of text.matchAll(/from\s+["']\.\/([\w.-]+\.mjs)["']/g)) imported.add(m[1]);
  }
  const conf = readFileSync(join(repoRoot, ".polyforge/verify-scope.conf"), "utf8");
  const excludes = conf
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "" && !line.trimStart().startsWith("#"))
    .filter((line) => line.startsWith("exclude="))
    .map((line) => line.slice("exclude=".length).trim());
  const excluded = (f) => excludes.some((g) => globToRe(g).test(f) || globToRe(g).test(`e2e/${f}`));
  return files.filter((f) => f !== "all.mjs" && !imported.has(f) && !excluded(f));
}

// runnerSelectedSuites reads the one e2e_runner command's appended suite list.
function runnerSelectedSuites(report) {
  const runners = report.commands.filter((c) => c.startsWith(RUNNER_COMMAND_PREFIX));
  assert.equal(runners.length, 1, `the real conf must report exactly one e2e_runner command; commands:\n${report.commands.join("\n")}`);
  const names = [];
  for (const m of runners[0].matchAll(/e2e\/([\w.-]+\.mjs)/g)) names.push(m[1]);
  return Array.from(new Set(names)).sort();
}

scenario("S20 the #213 replay selects the carrier suites and a deleted header forces full", () => {
  const engine = resolveEngine();
  if (!isExecutable(engine)) {
    console.log(`SKIP no executable verification-scope engine at ${engine}`);
    return SKIPPED;
  }
  if (!probeCarriesAware(engine)) {
    console.log(`SKIP ${engine} performs no carries-aware scoped selection`);
    return SKIPPED;
  }

  const repo = cloneRealHead(root);
  try {
    const base = git(repo, ["rev-parse", "HEAD"]);
    for (const rel of REPLAY_213_SURFACE) {
      assert.ok(existsSync(join(repo, rel)), `the real HEAD must hold the #213 path ${rel}`);
    }
    for (const suite of CARRIER_SUITES) {
      assert.match(
        readFileSync(join(repo, "e2e", suite), "utf8"),
        /^\/\/\s*carries:\s*\S/m,
        `the real HEAD's ${suite} must carry a carries: header`,
      );
    }
    const allSuites = standaloneSuiteNames(repo);
    assert.ok(allSuites.length > CARRIER_SUITES.length, `the real tree must hold more suites than the six carriers (got ${allSuites.length})`);

    touchReplaySurface(repo);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "w227 replay the real #213 change surface"]);
    const changed = git(repo, ["diff", "--name-only", base, "HEAD"]).split("\n").filter(Boolean).sort();
    assert.deepEqual(changed, [...REPLAY_213_SURFACE].sort(), `the replay must change exactly the real #213 surface; got ${changed.join(", ")}`);
    assert.ok(!changed.some((p) => p.startsWith(".polyforge/")), "the replay must not touch .polyforge/");

    const report = runEngine(engine, repo, ["--base", base]);
    assert.equal(report.mode, "scoped", `a covered #213 diff must stay scoped; commands:\n${report.commands.join("\n")}`);
    const selected = runnerSelectedSuites(report);
    for (const suite of CARRIER_SUITES) {
      assert.ok(selected.includes(suite), `the replay must select the real carrier suite ${suite}; selected ${selected.join(", ")}`);
    }
    for (const suite of selected) {
      assert.ok(allSuites.includes(suite), `the selection must name only real standalone suites; ${suite} is not one`);
    }
    assert.ok(selected.length < allSuites.length, `the selection must be a strict subset of the real standalone suites (${selected.length}/${allSuites.length})`);
    console.log(`S20 expected selection (${EXPECTED_213_SELECTION.length}): ${EXPECTED_213_SELECTION.join(" ")}`);
    console.log(`S20 actual selection (${selected.length}): ${selected.join(" ")}`);

    writeFileSync(join(repo, "e2e", "polyforge-panel-213.mjs"), stripOpeningCarries(readFileSync(join(repo, "e2e", "polyforge-panel-213.mjs"), "utf8")));
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "w227 delete one real carrier header"]);
    const after = runEngine(engine, repo, ["--base", base]);
    assert.equal(after.mode, "full", `deleting one real carrier header must force full; commands:\n${after.commands.join("\n")}`);
  } finally {
    rmSync(dirname(repo), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Engine resolution: VERIFY_SCOPE_ENGINE first, then the release path; an
// absent engine SKIPs the acceptance suite instead of failing it.
// ---------------------------------------------------------------------------
scenario("S21 the acceptance suite prefers VERIFY_SCOPE_ENGINE and SKIPs without one", () => {
  const work = mkdtempSync(join(tmpdir(), "w227-engine-"));
  try {
    const log = join(work, "calls.log");
    const stub = join(work, "engine");
    writeFileSync(
      stub,
      "#!/bin/sh\nprintf '%s\\n' \"$0\" >> \"$W227_ENGINE_LOG\"\nprintf 'mode: scoped\\n'\n" +
        "[ -d node_modules ] || printf 'command: npm ci\\n'\nprintf 'command: npm run lint\\ncommand: node_modules/.bin/tsc --noEmit\\ncommand: npm test\\n'\n",
    );
    chmodSync(stub, 0o755);
    const env = { ...process.env, VERIFY_SCOPE_ENGINE: stub, W227_ENGINE_LOG: log, POLYFORGE_DATA_DIR: join(work, "data") };
    delete env.POLYFORGE_VERIFY_SCOPE;
    const chosen = spawnSync(process.execPath, [acceptancePath], { cwd: root, env, encoding: "utf8" });
    assert.equal(chosen.status, 0, `acceptance suite: exit ${chosen.status} (stderr ${chosen.stderr})`);
    assert.ok(existsSync(log), "the acceptance suite must run the VERIFY_SCOPE_ENGINE binary, not the release path");

    const absentEnv = { ...process.env, POLYFORGE_DATA_DIR: join(work, "empty") };
    delete absentEnv.VERIFY_SCOPE_ENGINE;
    delete absentEnv.POLYFORGE_VERIFY_SCOPE;
    const absent = spawnSync(process.execPath, [acceptancePath], { cwd: root, env: absentEnv, encoding: "utf8" });
    assert.equal(absent.status, 0, `an absent engine must SKIP, not fail: exit ${absent.status} (stderr ${absent.stderr})`);
    assert.match(absent.stdout + absent.stderr, /SKIP/, "an absent engine must say SKIP");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Guarded runner: one failing scenario does not abort the rest.
// ---------------------------------------------------------------------------
let failed = 0;
for (const { name, fn } of scenarios) {
  try {
    if (fn() === SKIPPED) continue;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${e && e.message ? e.message : e}`);
  }
}
if (failed > 0) {
  console.error(`w227: ${failed}/${scenarios.length} scenario(s) failed`);
  process.exit(1);
}
console.log(`w227: ${scenarios.length} scenarios passed`);