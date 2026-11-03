// carries: components/Polyforge*, components/polyforge-*, hooks/usePolyforge*, lib/polyforge*, app/api/polyforge/*
// carries: components/SettingsPanel*, components/SettingsUi*, components/settings-ui-helpers*, lib/settings-navigation*, lib/package-settings*, app/api/plugins/*, app/settings.css, lib/i18n/*
// — the workflow card + merged 工作区 card, end-to-end.
//
// Authored pre-code against artifacts/spec.md (the capsule's
// artifacts/e2e-scenarios.md mirrors its GIVEN/WHEN/THEN scenarios). The suite
// drives the new surface through the real `pf` binary built from the capsule's
// repos/pi-web with GOWORK=off, placed first on PATH, and through the
// app's real HTTP face. A tiny unix-socket daemon supplies the machine facts
// `pf` asks the daemon for (workflows_dir + capabilities) so the fixture is
// deterministic and no host daemon is required.
//
// Baseline posture: the `pf workflows` verb, the new workspace read fields,
// the writers and the cards do not exist yet, so every scenario is an
// assertion-level red (unknown verb, missing JSON field, refused write, absent
// card) — never a build or fixture error.
//
// Single-repo SKIP: the real `pf` comes from the sibling repos/pi-web
// checkout, which a pi-web-only capsule does not have. When that sibling is
// absent the suite prints one SKIP line and exits 0 before any fixture side
// effect; when it is present the build still runs and a missing `go`, a failed
// build or a missing cmd/pf still FAILS the suite.
//
//   node e2e/polyforge-workflow-216.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startNextServer } from "./next-server.mjs";
import { NAV_MS } from "./timeouts.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const acme = fileURLToPath(new URL("../../pi-web/", import.meta.url));
// Probe before any side effect: without the sibling checkout there is no real
// pf to build. A sibling that exists but is broken still fails at the build.
if (!existsSync(acme)) {
  console.log(`SKIP polyforge-workflow-216: sibling repo absent at ${acme} (single-repo capsule); real pf cannot be built`);
  process.exit(0);
}
assert.ok(!existsSync(join(root, process.env.PI_WEB_DIST_DIR || ".next", "dev/lock")), "Run in a checkout without an active dev server");

const work = mkdtempSync(join(tmpdir(), "pi-web-pf-w216-"));
const home = join(work, "home");
const agentDir = join(agentDirPath(home), "agent");
const ws = join(work, "workspace");
const binDir = join(work, "bin");
const workflowsDir = join(work, "workflows");
const configDir = join(home, ".config", "polyforge");
const sockPath = join(work, "daemon.sock");
const sessionId = "e2e-pf-workflow-216";
const sessionText = "E2E polyforge workflow 216 host session";
const ts = "2026-11-01T00:00:00.000Z";
for (const dir of [home, agentDir, ws, binDir, workflowsDir, configDir, join(agentDir, "sessions", "e2e")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(agentDir, "sessions", "e2e", `${sessionId}.jsonl`), [
  { type: "session", version: 3, id: sessionId, timestamp: ts, cwd: ws },
  { type: "message", id: "m1", parentId: null, timestamp: ts, message: { role: "user", content: sessionText } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

function agentDirPath(homeDir) {
  return join(homeDir, ".pi");
}

const cliToml = join(configDir, "cli.toml");
writeFileSync(cliToml, `server = "http://127.0.0.1:1"\nuser_id = "usr_root"\n\n[workspace."${ws}"]\nprojects = ["workbench", "other"]\n`);
const yamlPath = join(ws, ".polyforge.yaml");
function bytes(path) { return readFileSync(path); }
function text(path) { return readFileSync(path, "utf8"); }
function fileSha(path) { return createHash("sha256").update(bytes(path)).digest("hex"); }

const WORKSPACE_YAML = `# dense per-step comments must survive every write
# second header line
summarize:
  models: ["pi:summarize-one"]
  language: "English"
  # unrelated summarize comment
  interval_sec: 30
steps:
  workbench:
    # grill's declared chain
    grill:
      models: ["pi:before"]
      attrs:
        question_batch_size: 2
    # declared-but-empty list
    review:
      models: []
    fix:
      models: ["pi:ws-fix"]
    default:
      models: ["pi:ws-default"]
memory_policy:
  default:
    record: ["mem-base"]
    skip: ["skip-base"]
  workbench:
    record: ["mem-workbench"]
`;
function resetWorkspace() { writeFileSync(yamlPath, WORKSPACE_YAML); }

function bundle(file, body) {
  mkdirSync(join(workflowsDir, file), { recursive: true });
  writeFileSync(join(workflowsDir, file, "workflow.md"), `---\n${body}\n---\n# fixture\n`);
}
function resetWorkflows() {
  rmSync(join(workflowsDir, "broken"), { recursive: true, force: true });
  bundle("feature-full", `name: feature-full
defaults:
  model_candidates: [pi:bundle-default-fg]
steps:
  - id: grill
    model_candidates: [pi:fg-grill]
    attrs:
      question_batch_size:
        type: int
        default: 0
  - id: spec
  - id: plan
    model_candidates: [pi:fg-plan]
  - id: code
    model_candidates: [pi:fg-code]
  - id: review
    model_candidates: [pi:fg-review]`);
  bundle("autopilot", `name: autopilot
defaults:
  model_candidates: [pi:bundle-default-auto]
steps:
  - id: grill
    model_candidates: [pi:auto-grill]
    attrs:
      question_batch_size:
        type: int
        default: 0
  - id: code
    model_candidates: [pi:auto-code]
  - id: fix
    model_candidates: [pi:auto-fix]`);
  bundle("bug-fix", `name: bug-fix
defaults:
  model_candidates: [pi:bundle-default-bug]
steps:
  - id: root-cause
    model_candidates: [pi:bug-root]
  - id: fix
    model_candidates: [pi:bug-fix]`);
  bundle("chore", `name: chore
defaults:
  model_candidates: [pi:bundle-default-chore]
steps:
  - id: code
    model_candidates: [pi:chore-code]
  - id: review
    model_candidates: [pi:chore-review]`);
  mkdirSync(join(workflowsDir, "_shared"), { recursive: true });
  writeFileSync(join(workflowsDir, "_shared", "principles.md"), "fixture principles\n");
}

// ---- deterministic unix-socket daemon: GET /status only ----
const daemon = { capabilities: ["steps_attrs"], down: false, delayMs: 0 };
function response(status, body) {
  const payload = JSON.stringify(body);
  return `HTTP/1.1 ${status} ${status === 200 ? "OK" : "Service Unavailable"}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`;
}
const daemonServer = createServer((socket) => {
  socket.on("error", () => {});
  let raw = "";
  socket.on("data", (chunk) => {
    raw += chunk;
    if (!raw.includes("\r\n\r\n") || socket.destroyed || socket.writableEnded) return;
    socket.removeAllListeners("data");
    const head = raw.slice(0, raw.indexOf("\r\n\r\n"));
    const [method, requestPath] = head.split(" ");
    void (async () => {
      if (daemon.delayMs > 0) await delay(daemon.delayMs);
      if (socket.destroyed || socket.writableEnded) return;
      if (daemon.down) {
        socket.end(response(503, { code: "DAEMON-500", detail: "fixture daemon is down" }));
        return;
      }
      if (method === "GET" && requestPath.startsWith("/status")) {
        const status = {
          machine_id: "m-e2e-216",
          workflows_dir: workflowsDir,
          workspaces: [ws],
          jobs: [],
          queue: { pending: 0, running: 0, max_concurrent: 1 },
        };
        if (daemon.capabilities.length) status.capabilities = daemon.capabilities;
        socket.end(response(200, status));
        return;
      }
      socket.end(response(503, { code: "DAEMON-404", detail: `fixture daemon has no ${method} ${requestPath}` }));
    })();
  });
});
await new Promise((resolve, reject) => {
  daemonServer.once("error", reject);
  daemonServer.listen(sockPath, resolve);
});

const setDaemon = (patch = {}) => Object.assign(daemon, patch);

// ---- real pf: capsule tree, GOWORK=off, version at the card's floor ----
const built = spawnSync("go", [
  "build", "-o", join(binDir, "pf"),
  "-ldflags", "-X github.com/silgrid/polyforge/internal/version.Version=v2.20.16",
  "./cmd/pf",
], { cwd: acme, env: { ...process.env, GOWORK: "off" }, encoding: "utf8", timeout: 300_000 });
assert.equal(built.status, 0, `real pf build failed: ${built.stderr || built.stdout}`);
const pfPath = join(binDir, "pf");
const pfEnv = (overrides = {}) => {
  const env = { ...process.env, HOME: home, PATH: `${binDir}${delimiter}${process.env.PATH}`, PF_DAEMON_SOCKET: sockPath, ...overrides };
  delete env.PF_WI_ID;
  delete env.PF_DAEMON_ID;
  delete env.PF_BIN;
  return env;
};
function runPf(args, { env = {}, cwd = ws } = {}) {
  return new Promise((resolve) => {
    const child = spawn(pfPath, args, { cwd, env: pfEnv(env) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("error", (error) => { clearTimeout(timer); resolve({ status: null, stdout, stderr: `${stderr}${error.message}` }); });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}
async function pfJson(args, opts) {
  const result = await runPf(["--json", ...args], opts);
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* assertion below names the raw output */ }
  return { ...result, json };
}
const setChain = (value, hash) => runPf(["config", "set", "steps.workbench.grill.models", value, "--cwd", ws, "--expect-hash", hash]);
const setAttr = (name, value, hash) => runPf(["config", "set", `steps.workbench.grill.attrs.${name}`, String(value), "--cwd", ws, "--expect-hash", hash]);
const unsetChain = (step, hash) => runPf(["config", "unset", `steps.workbench.${step}.models`, "--cwd", ws, "--expect-hash", hash]);

// ---- scenario bookkeeping ----
const failures = new Map();
let checks = 0;
async function check(marker, fn) {
  checks += 1;
  try {
    await fn();
    console.log(`PASS ${marker}`);
  } catch (error) {
    const message = String(error?.message ?? error).split("\n").slice(0, 8).join(" | ");
    failures.set(marker, message);
    console.log(`FAIL ${marker}: ${message}`);
  }
}
const attrEntry = (step) => {
  const attrs = step?.attrs;
  if (Array.isArray(attrs)) return attrs.find((entry) => entry?.name === "question_batch_size");
  if (attrs && typeof attrs === "object") return { name: "question_batch_size", ...attrs.question_batch_size };
  return undefined;
};
const bundleOf = (doc, name) => (doc.bundles ?? []).find((entry) => entry?.name === name);
const stepOf = (bundle, id) => (bundle?.steps ?? []).find((entry) => entry?.id === id);
const workspaceStep = (doc, project, id) => doc?.steps?.[project]?.[id];

// ---- CLI scenarios (the read face, the workspace read, the writers) ----
await check("W216-1", async () => {
  resetWorkflows(); resetWorkspace(); setDaemon({ capabilities: ["steps_attrs"], down: false, delayMs: 0 });
  const result = await pfJson(["workflows", "--cwd", ws]);
  assert.equal(result.status, 0, `pf workflows exited ${result.status}: ${result.stderr || result.stdout}`);
  assert.ok(result.json, `pf workflows did not emit JSON: ${result.stdout}`);
  assert.equal(result.json.daemon_reachable, true, "the daemon is reachable, daemon_reachable must be true");
  const names = (result.json.bundles ?? []).map((entry) => entry.name);
  for (const name of ["feature-full", "autopilot", "bug-fix", "chore"]) assert.ok(names.includes(name), `bundle ${name} missing from ${JSON.stringify(names)}`);
  assert.ok(!names.includes("_shared"), "_shared is not a bundle and must not be reported");
  const feature = bundleOf(result.json, "feature-full");
  assert.deepEqual(feature.steps.map((entry) => entry.id), ["grill", "spec", "plan", "code", "review"], "feature-full steps are not in declared order");
  assert.deepEqual(stepOf(feature, "grill").model_candidates, ["pi:fg-grill"], "the declared step candidates are missing");
  const spec = stepOf(feature, "spec");
  assert.ok(!spec.model_candidates || spec.model_candidates.length === 0, "a step declaring no candidates must not invent one");
  const attr = attrEntry(stepOf(feature, "grill"));
  assert.ok(attr, "grill does not carry its declared question_batch_size attr");
  assert.equal(attr.type, "int", "the attr type must be int");
  assert.equal(attr.default, 0, "the attr default must be 0");
});

await check("W216-2", async () => {
  resetWorkflows();
  mkdirSync(join(workflowsDir, "broken"), { recursive: true });
  writeFileSync(join(workflowsDir, "broken", "workflow.md"), "---\nname: broken\nsteps: [\n---\n");
  const result = await pfJson(["workflows", "--cwd", ws]);
  assert.equal(result.status, 0, `a broken bundle must not fail the verb (exit ${result.status}: ${result.stderr})`);
  assert.ok(result.json, "the verb must still emit JSON");
  const broken = (result.json.bundle_errors ?? []).find((entry) => entry.bundle === "broken");
  assert.ok(broken && String(broken.reason ?? "").length > 0, `bundle_errors must name broken with a reason: ${JSON.stringify(result.json.bundle_errors)}`);
  assert.ok(bundleOf(result.json, "feature-full"), "the remaining bundles must still be returned");
  rmSync(join(workflowsDir, "broken"), { recursive: true, force: true });
});

await check("W216-3", async () => {
  resetWorkspace();
  const missing = join(work, "no-daemon.sock");
  const workflows = await pfJson(["workflows", "--cwd", ws], { env: { PF_DAEMON_SOCKET: missing } });
  assert.equal(workflows.status, 0, `an unreachable daemon must not be a CLI failure (exit ${workflows.status}: ${workflows.stderr})`);
  assert.ok(workflows.json, `an unreachable daemon must still answer one JSON document: ${workflows.stdout}`);
  assert.equal(workflows.json.daemon_reachable, false, "daemon_reachable must be false");
  assert.ok(String(workflows.json.reason ?? "").length > 0, "the unreachable answer must carry a reason");
  assert.ok(!(workflows.json.bundles ?? []).length, "no bundle facts may be invented without a workflows_dir");
  const workspace = await pfJson(["config", "workspace", "--cwd", ws], { env: { PF_DAEMON_SOCKET: missing } });
  assert.equal(workspace.status, 0, `workspace read must degrade, not fail (exit ${workspace.status}: ${workspace.stderr})`);
  assert.ok(workspace.json, "workspace read must still answer JSON");
  assert.equal(workspace.json.mapped, true, "the cwd mapping is readable without the daemon");
  assert.equal(workspace.json.steps_complete, false, "without the daemon the step list is incomplete");
  assert.ok(String(workspace.json.steps_reason ?? workspace.json.reason ?? "").length > 0, "an incomplete step list must carry a reason");
});

await check("W216-4", async () => {
  resetWorkflows(); resetWorkspace(); setDaemon({ capabilities: ["steps_attrs"], down: false, delayMs: 0 });
  const result = await pfJson(["config", "workspace", "--cwd", ws]);
  assert.equal(result.status, 0, `workspace read exited ${result.status}: ${result.stderr}`);
  assert.ok(result.json, `workspace read did not emit JSON: ${result.stdout}`);
  const grill = workspaceStep(result.json, "workbench", "grill");
  assert.equal(grill?.declared, true, "steps.workbench.grill is declared in the file");
  assert.deepEqual(grill.models, ["pi:before"], "the declared chain must be returned");
  assert.equal(grill.source, "file", "a declared chain's source is the file");
  assert.equal(grill.class, "live", "a step chain is live");
  const attr = grill.attrs?.question_batch_size;
  assert.ok(attr, `the attr override is missing: ${JSON.stringify(grill)}`);
  assert.equal(attr.value, 2, "the attr override value must be 2");
  assert.equal(attr.declared, true, "the attr override is declared");
  assert.equal(attr.source, "file", "the attr override comes from the file");
  assert.equal(attr.class, "live", "the attr override is live");
});

await check("W216-5", async () => {
  resetWorkflows(); resetWorkspace();
  const result = await pfJson(["config", "workspace", "--cwd", ws]);
  assert.equal(result.status, 0, `workspace read exited ${result.status}: ${result.stderr}`);
  const policy = result.json?.memory_policy;
  assert.ok(policy, `memory_policy is missing: ${result.stdout.slice(0, 400)}`);
  assert.equal(policy.source, "file", "memory_policy is declared in this file");
  assert.equal(policy.append_to_default, true, "the read must state that project entries append to the default");
  assert.ok((policy.default?.record ?? []).includes("mem-base"), "the default record list is not returned");
  assert.ok((policy.projects?.workbench?.record ?? []).includes("mem-workbench"), "the project's record list is not returned");
});

await check("W216-6", async () => {
  resetWorkflows(); resetWorkspace();
  const result = await pfJson(["config", "workspace", "--cwd", ws]);
  assert.equal(result.status, 0, `workspace read exited ${result.status}: ${result.stderr}`);
  const review = workspaceStep(result.json, "workbench", "review");
  assert.equal(review?.declared, true, "a declared-but-empty list is still declared");
  assert.ok(Array.isArray(review.models) && review.models.length === 0, "a declared-but-empty list must be reported as an empty list, not absent");
  const other = result.json?.steps?.other ?? {};
  const invented = Object.entries(other).filter(([, entry]) => entry?.declared === true);
  assert.deepEqual(invented, [], `a project with no declarations must not get declared values: ${JSON.stringify(invented)}`);
  assert.ok(!("invented-step" in other), "the read must not invent a step id for an undeclared project");
});

await check("W216-7", async () => {
  resetWorkflows(); resetWorkspace(); setDaemon({ capabilities: ["steps_attrs"], down: false, delayMs: 0 });
  const before = text(yamlPath);
  const result = await setChain('["claude:declared-grill","pi:alt"]', fileSha(yamlPath));
  assert.equal(result.status, 0, `chain write exited ${result.status}: ${result.stderr || result.stdout}`);
  const after = text(yamlPath);
  assert.notEqual(after, before, "the write did not change the file");
  const a = before.split("\n");
  const b = after.split("\n");
  assert.equal(a.length, b.length, "a chain edit must not add or remove unrelated lines");
  const changed = a.map((line, index) => (line === b[index] ? null : index)).filter((index) => index !== null);
  assert.equal(changed.length, 1, `only the addressed key may change, changed lines: ${JSON.stringify(changed.map((i) => [a[i], b[i]]))}`);
  assert.match(b[changed[0]], /^\s*models:\s*\[.*claude:declared-grill.*pi:alt.*\]$/, `the written chain is not the requested value: ${b[changed[0]]}`);
  for (const comment of ["# dense per-step comments must survive every write", "# second header line", "# unrelated summarize comment", "# grill's declared chain", "# declared-but-empty list"]) {
    assert.ok(after.includes(comment), `the write dropped the comment ${comment}`);
  }
  const readBack = await pfJson(["config", "workspace", "--cwd", ws]);
  assert.deepEqual(workspaceStep(readBack.json, "workbench", "grill")?.models, ["claude:declared-grill", "pi:alt"], "the read back does not carry the written chain");
});

await check("W216-8", async () => {
  resetWorkspace();
  const stale = fileSha(yamlPath);
  const mutated = WORKSPACE_YAML.replace("# second header line", "# second header line changed elsewhere");
  writeFileSync(yamlPath, mutated);
  const beforeRefusal = bytes(yamlPath);
  const result = await setChain('["pi:new"]', stale);
  assert.notEqual(result.status, 0, "a stale sha256 must be refused");
  assert.match(`${result.stdout}\n${result.stderr}`, /CORE-409|stale|expected|changed since/i, `the refusal must be typed/named: ${result.stderr || result.stdout}`);
  assert.deepEqual(bytes(yamlPath), beforeRefusal, "a refused stale write must leave the file byte-identical");
  assert.equal(fileSha(yamlPath), createHash("sha256").update(beforeRefusal).digest("hex"), "the file's sha256 changed on a refusal");
});

await check("W216-9", async () => {
  resetWorkspace();
  const result = await unsetChain("fix", fileSha(yamlPath));
  assert.equal(result.status, 0, `clearing a chain exited ${result.status}: ${result.stderr || result.stdout}`);
  const after = text(yamlPath);
  assert.ok(!/^\s*fix:\s*$/m.test(after), `clearing a chain-only step entry must delete the entry: ${after}`);
  const readBack = await pfJson(["config", "workspace", "--cwd", ws]);
  const fix = workspaceStep(readBack.json, "workbench", "fix");
  assert.notEqual(fix?.declared, true, "a cleared chain must not stay declared");
});

await check("W216-10", async () => {
  resetWorkspace();
  const before = bytes(yamlPath);
  const result = await setChain('["not-a-candidate"]', fileSha(yamlPath));
  assert.notEqual(result.status, 0, "a malformed candidate must be refused");
  assert.match(`${result.stdout}\n${result.stderr}`, /candidate|harness|<harness>|prefixed|format/i, `the refusal must name the candidate format: ${result.stderr || result.stdout}`);
  assert.deepEqual(bytes(yamlPath), before, "a refused malformed candidate must leave the file untouched");
});

await check("W216-11", async () => {
  resetWorkspace(); setDaemon({ capabilities: [], down: false, delayMs: 0 });
  const before = bytes(yamlPath);
  const result = await setAttr("question_batch_size", 3, fileSha(yamlPath));
  assert.notEqual(result.status, 0, "a daemon below the schema floor must refuse the write");
  assert.match(`${result.stdout}\n${result.stderr}`, /capab|daemon|2\.20\.15|does not accept|step attr/i, `the refusal must name the capability mismatch: ${result.stderr || result.stdout}`);
  assert.deepEqual(bytes(yamlPath), before, "the capability refusal must leave the file byte-unchanged");
  setDaemon({ capabilities: ["steps_attrs"] });
});

await check("W216-12", async () => {
  resetWorkspace(); setDaemon({ capabilities: ["steps_attrs"], down: false, delayMs: 0 });
  const result = await setAttr("question_batch_size", 3, fileSha(yamlPath));
  assert.equal(result.status, 0, `a declared attr write exited ${result.status}: ${result.stderr || result.stdout}`);
  const readBack = await pfJson(["config", "workspace", "--cwd", ws]);
  const attr = workspaceStep(readBack.json, "workbench", "grill")?.attrs?.question_batch_size;
  assert.equal(attr?.value, 3, "the strict loader/read does not resolve the written override to 3");
  assert.equal(attr?.declared, true, "the written override must be reported as declared");
});

await check("W216-13", async () => {
  resetWorkspace();
  const before = bytes(yamlPath);
  const result = await setAttr("mystery_knob", 1, fileSha(yamlPath));
  assert.notEqual(result.status, 0, "an attr name the step does not declare must be refused");
  assert.match(`${result.stdout}\n${result.stderr}`, /undeclared|does not declare|not declared|unknown attr|declares no/i, `the refusal must name the undeclared attr: ${result.stderr || result.stdout}`);
  assert.deepEqual(bytes(yamlPath), before, "the refusal must leave the file untouched");
});

await check("W216-14", async () => {
  resetWorkspace();
  const before = bytes(yamlPath);
  const result = await runPf(["config", "set", "steps.workbench.default.attrs.question_batch_size", "1", "--cwd", ws, "--expect-hash", fileSha(yamlPath)]);
  assert.notEqual(result.status, 0, "`default` takes no attrs");
  assert.match(`${result.stdout}\n${result.stderr}`, /takes no attrs|does not accept attrs|attrs under default|default.*no attrs|default.*not allowed/i, `the refusal must explain that default takes no attrs: ${result.stderr || result.stdout}`);
  assert.deepEqual(bytes(yamlPath), before, "the refusal must leave the file untouched");
});

// ---- browser scenarios (the workflow card and the merged workspace card) ----
let browser;
let base;
let stop = async () => {};
try {
  resetWorkflows(); resetWorkspace(); setDaemon({ capabilities: ["steps_attrs"], down: false, delayMs: 0 });
  assert.equal((await setChain('["claude:declared-grill"]', fileSha(yamlPath))).status, 0);
  const started = await startNextServer({
    name: "polyforge-workflow-216",
    logFile: join(work, "server.log"),
    env: {
      ...pfEnv(),
      PI_CODING_AGENT_DIR: agentDir,
      PI_WEB_PASSWORD: "",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
  base = started.base;
  stop = started.stop;
  browser = await chromium.launch();

  const health = {
    pfPresent: true, pfVersion: "v2.20.16", pfVersionBelowMinimum: false, line: "internal",
    piSkillInstalled: true, piSkillEnabled: true, claudeSkillsSymlink: true, claudeSessionStartHook: true,
    daemon: { reachable: true },
  };
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "en-US" });
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("pi-locale", "en");
      window.localStorage.setItem("pi-web:session-age-filter-days", "0");
    } catch { /* storage unavailable */ }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const reads = { workflows: 0, lastStatus: 0 };
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/polyforge/workflows") reads.workflows += 1;
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/polyforge/workflows") reads.lastStatus = response.status();
  });
  await page.route("**/api/polyforge/detect*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(health),
  }));
  await page.route("**/api/plugins?*", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ packages: [{ scope: "global", packageName: "polyforge", source: "/opt/polyforge" }] }),
  }));
  await page.route("**/api/polyforge/config/history", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ entries: [] }),
  }));
  await page.goto(`${base}/?session=${sessionId}`, { waitUntil: "domcontentloaded", timeout: NAV_MS });
  await page.getByText(sessionText).first().waitFor({ state: "attached", timeout: NAV_MS });
  const show = page.locator('button[aria-label="Show sidebar"], button[aria-label="显示侧边栏"]').first();
  if (await show.isVisible().catch(() => false)) await show.click();
  await page.locator('button[aria-label="Settings"], button[aria-label="设置"]').first().click({ timeout: NAV_MS });
  const dialog = page.locator('[role="dialog"][aria-label="Settings"], [role="dialog"][aria-label="设置"]').first();
  await dialog.waitFor({ timeout: NAV_MS });
  await dialog.getByRole("button", { name: "Polyforge", exact: true }).click({ timeout: NAV_MS });
  await dialog.locator(".polyforge-config-row").first().waitFor({ state: "visible", timeout: NAV_MS }).catch(() => {});

  const workflow = () => dialog.locator('section[aria-label="Workflow"], section[aria-label="工作流"]').first();
  const workspaceCard = () => dialog.locator('section[aria-label="Workspace"], section[aria-label="工作区"]').first();
  const rowOf = async (card, id) => {
    const nodes = card.getByText(id, { exact: true });
    for (let index = 0; index < await nodes.count(); index += 1) {
      const node = nodes.nth(index);
      const row = node.locator('xpath=ancestor::*[self::li or self::tr or @role="row" or contains(@class,"row")][1]');
      if (await row.count()) return row.first();
    }
    throw new Error(`no step row for ${id}`);
  };
  const rowText = async (card, id) => (await rowOf(card, id)).innerText();
  const refreshButton = () => workflow().getByRole("button", { name: /refresh|刷新|重新整理/i }).first();
  const waitFor = async (predicate, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate().catch(() => false)) return true;
      await delay(200);
    }
    return false;
  };

  await check("W216-0", async () => {
    const direct = await pfJson(["workflows", "--cwd", ws]);
    assert.equal(direct.status, 0, `the capsule-built pf does not answer the read face: ${direct.stderr || direct.stdout}`);
    const feature = bundleOf(direct.json, "feature-full");
    assert.ok(stepOf(feature, "grill"), "the real pf document has no feature-full grill step");
    assert.ok(reads.workflows > 0, "the panel never called the real read route");
    await workflow().waitFor({ state: "visible", timeout: 30_000 });
    const card = await workflow().innerText();
    assert.match(card, /claude:declared-grill|pi:fg-grill/, `the card does not carry the real pf's facts: ${card.slice(0, 400)}`);
  });

  await check("W216-16", async () => {
    const card = workflow();
    await card.waitFor({ state: "visible", timeout: 30_000 });
    const selector = card.locator('select, [role="combobox"]').first();
    assert.ok(await selector.count(), "the workflow card has no project selector");
    if (await selector.evaluate((node) => node.tagName).then((tag) => tag === "SELECT")) {
      assert.equal(await selector.inputValue(), "workbench", "the first project mapped to the cwd must be selected");
      const options = await selector.locator("option").allInnerTexts();
      assert.ok(options.some((value) => value.trim() === "other"), `the selector must list every mapped project: ${options}`);
    } else {
      assert.match(await card.innerText(), /workbench/, "the first mapped project is not selected");
    }
  });

  await check("W216-17", async () => {
    const card = workflow();
    const grill = await rowText(card, "grill");
    assert.match(grill, /feature-full/, `the grill row does not name feature-full: ${grill}`);
    assert.match(grill, /autopilot/, `the grill row does not name autopilot: ${grill}`);
    const uniqueRows = await card.getByText("grill", { exact: true }).evaluateAll((nodes) => new Set(nodes.map((node) =>
      node.closest('li,tr,[role="row"],[class*="row"]') ?? node.parentElement)).size);
    assert.equal(uniqueRows, 1, `grill must appear once, found ${uniqueRows} rows`);
  });

  await check("W216-18", async () => {
    const card = workflow();
    const first = await rowOf(card, "default");
    const middle = await rowOf(card, "grill");
    const last = await rowOf(card, "task");
    const box = async (row) => {
      const value = await row.boundingBox();
      assert.ok(value, "a default/task row is not visible");
      return value.y;
    };
    assert.ok(await box(first) < await box(middle), "`default` must be the first row");
    assert.ok(await box(middle) < await box(last), "`task` must be its own last row");
    assert.ok(!/feature-full|autopilot|bug-fix|chore/.test(await last.innerText()), "`task` belongs to no bundle");
  });

  await check("W216-19", async () => {
    const text = await rowText(workflow(), "grill");
    assert.match(text, /claude:declared-grill/, `the declared chain is not shown: ${text}`);
    assert.match(text, /declared/i, `the row must mark the chain as declared: ${text}`);
    assert.match(text, /live/i, `a chain row must carry its live class: ${text}`);
  });

  await check("W216-20", async () => {
    const text = await rowText(workflow(), "plan");
    assert.match(text, /inherit|继承/i, `an undeclared step must show the inherited marker: ${text}`);
    assert.match(text, /pi:fg-plan/, `the effective bundle chain is missing: ${text}`);
  });

  await check("W216-21", async () => {
    const text = await rowText(workflow(), "code");
    assert.match(text, /pi:fg-code/, `feature-full's effective chain is missing: ${text}`);
    assert.match(text, /pi:auto-code/, `autopilot's effective chain is missing: ${text}`);
    assert.match(text, /pi:chore-code/, `chore's effective chain is missing: ${text}`);
    assert.match(text, /feature-full/, "the row must name feature-full");
    assert.match(text, /autopilot/, "the row must name autopilot");
    assert.match(text, /chore/, "the row must name chore");
  });

  await check("W216-22", async () => {
    const card = workflow();
    assert.match(await card.innerText(), /pf submit --models/, "the card must note that pf submit --models outranks every configured level");
    const editable = await card.locator("input, textarea, select").evaluateAll((nodes) => nodes
      .map((node) => `${node.getAttribute("aria-label") ?? ""} ${node.getAttribute("name") ?? ""}`)
      .filter((value) => /pf submit|--models/i.test(value)));
    assert.deepEqual(editable, [], `no control may edit pf submit --models: ${editable}`);
  });

  await check("W216-29", async () => {
    const text = await rowText(workflow(), "grill");
    assert.match(text, /live/i, "a step chain row must carry the live badge");
    assert.match(text, /next step dispatch|next dispatch|下一次 step 派发/i, `a live row must state its next-dispatch latency: ${text}`);
  });

  await check("W216-30", async () => {
    const card = workflow();
    const toggle = card.locator(".polyforge-disclosure-toggle").first();
    if (await toggle.count() && (await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
    const stored = await page.evaluate(() => localStorage.getItem("pi-web:polyforge-config-disclosure"));
    assert.ok(stored, "the card must use the #212 browser-stored disclosure key");
    assert.equal(JSON.parse(stored).workflow, true, "the workflow region must be open in the #212 store");
    const selector = card.locator("select").first();
    await selector.selectOption("other");
    await waitFor(async () => /other/.test(await card.innerText()));
    const after = await page.evaluate(() => localStorage.getItem("pi-web:polyforge-config-disclosure"));
    assert.equal(JSON.parse(after).workflow, true, "switching project must not discard the card's own disclosure state");
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((key) => /polyforge.*disclos/i.test(key)));
    assert.equal(keys.length, 1, `a third collapse mechanism exists: ${keys}`);
    await selector.selectOption("workbench");
  });

  await check("W216-26", async () => {
    const card = workspaceCard();
    await card.waitFor({ state: "visible", timeout: 30_000 });
    const rows = card.locator(".polyforge-config-row");
    const texts = await rows.allInnerTexts();
    assert.ok(texts.length >= 3, `the merged workspace card has no grouped rows: ${texts.length}`);
    for (const value of texts) assert.match(value, /cli\.toml|\.polyforge\.yaml/, `a workspace row carries no source-file tag: ${value}`);
    assert.match(await card.innerText(), /memory policy|记忆策略/i, "memory_policy is not shown in the workspace card");
    const memory = rows.filter({ hasText: /memory policy|记忆策略/i }).first();
    if (await memory.count()) assert.equal(await memory.locator("input, textarea").count(), 0, "memory_policy must be read-only");
  });

  await check("W216-27", async () => {
    assert.ok(await workflow().count(), "the workflow card that must carry the step facts does not exist");
    const old = dialog.locator('section[aria-label="Declared step candidates"], section[aria-label="步骤候选"], section[aria-label="已声明的步骤候选"]');
    assert.equal(await old.count(), 0, "the read-only 步骤候选 card still exists");
    assert.equal(await dialog.getByText("Declared step candidates", { exact: true }).count(), 0, "the old candidates card title still renders");
  });

  await check("W216-28", async () => {
    const card = workspaceCard();
    const legend = card.locator(".polyforge-config-legend").first();
    const header = card.locator(".polyforge-config-grid-header").first();
    assert.ok(await legend.count(), "the workspace card has no legend element");
    assert.ok(await header.count(), "the workspace card has no column header element");
    const toggle = card.locator(".polyforge-disclosure-toggle").first();
    if (await toggle.count() && (await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
    assert.equal(await legend.isVisible(), true, "the legend is hidden inside the whole-card fold");
    assert.equal(await header.isVisible(), true, "the column header is hidden inside the whole-card fold");
  });

  await check("W216-23", async () => {
    const before = reads.workflows;
    bundle("feature-full", `name: feature-full
defaults:
  model_candidates: [pi:bundle-default-fg]
steps:
  - id: grill
    model_candidates: [pi:fg-grill]
    attrs:
      question_batch_size:
        type: int
        default: 0
  - id: new-step
    model_candidates: [pi:new-step]
  - id: spec
  - id: plan
    model_candidates: [pi:fg-plan]
  - id: code
    model_candidates: [pi:fg-code]
  - id: review
    model_candidates: [pi:fg-review]`);
    await refreshButton().click();
    assert.equal(await waitFor(async () => (await workflow().getByText("new-step", { exact: true }).count()) > 0), true,
      "refresh did not show the changed bundle's new step (a cache answered instead)");
    assert.ok(reads.workflows > before, "refresh did not issue a fresh read");
  });

  await check("W216-24", async () => {
    setDaemon({ delayMs: 4_000 });
    await refreshButton().click();
    const busy = await waitFor(async () => {
      const button = refreshButton();
      return (await button.isDisabled()) || (await button.getAttribute("aria-busy")) === "true";
    }, 3_000);
    const spinning = await refreshButton().evaluate((node) => node.className.includes("animate-spin")).catch(() => false);
    assert.ok(busy, "the refresh control is not disabled/aria-busy while the newest read is in flight");
    assert.ok(spinning, "the refresh control does not animate while the newest read is in flight");
    setDaemon({ delayMs: 0 });
    await waitFor(async () => !(await refreshButton().isDisabled()), 20_000);
  });

  await check("W216-25", async () => {
    assert.ok(await workflow().getByText("grill", { exact: true }).count(), "the last good list is missing before the failed refresh");
    setDaemon({ down: true });
    await refreshButton().click();
    assert.equal(await waitFor(async () => (await workflow().locator('[role="alert"], [class*="error"], [class*="Error"]').count()) > 0, 20_000), true,
      "a failed refresh shows no error");
    assert.ok(await workflow().getByText("new-step", { exact: true }).count(), "a failed refresh dropped the last good list");
    assert.ok(reads.lastStatus < 500, `the route answered ${reads.lastStatus}; it must stay 200 under degradation`);
    setDaemon({ down: false });
  });

  await check("W216-15", async () => {
    setDaemon({ capabilities: [], down: false, delayMs: 0 });
    await refreshButton().click();
    assert.equal(await waitFor(async () => /2\.20\.15/.test(await workflow().innerText()), 20_000), true,
      "the card does not state the required capability floor");
    assert.ok(await workflow().getByText("grill", { exact: true }).count(), "the read facts disappeared below the floor");
    const disabled = await workflow().locator("input:disabled, textarea:disabled, button:disabled, [aria-disabled=\"true\"]").count();
    assert.ok(disabled > 0, "no write control is disabled below the capability floor");
    assert.ok(reads.lastStatus < 500, `the route answered ${reads.lastStatus}; it must stay 200 under degradation`);
    setDaemon({ capabilities: ["steps_attrs"] });
  });

  await context.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  await stop();
  daemonServer.close();
  rmSync(sockPath, { force: true });
}

console.log(`\n===== polyforge-workflow-216: ${checks - failures.size}/${checks} scenarios passed =====`);
if (failures.size) {
  for (const [marker, message] of failures) console.log(`FAILED ${marker}: ${message}`);
  process.exit(1);
}