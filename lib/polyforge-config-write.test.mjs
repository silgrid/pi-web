import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

/** A tiny stub `pf` first on PATH: it answers `--version`, `config list`,
 *  `config workspace --cwd`, `ops status` and records every set/unset
 *  argv/stdin, so the write lib's real-old-value and CAS-hash behavior can be
 *  asserted without a machine pf. */
function stubTree({ workspaceYaml = true } = {}) {
  const work = mkdtempSync(join(tmpdir(), "pf-write-"));
  const bin = join(work, "bin");
  const agent = join(work, "agent");
  const ws = join(work, "ws");
  mkdirSync(bin, { recursive: true });
  mkdirSync(agent, { recursive: true });
  mkdirSync(ws, { recursive: true });
  const cliToml = join(work, "cli.toml");
  const yaml = join(ws, ".polyforge.yaml");
  writeFileSync(cliToml, "server = \"x\"\napi_key = \"current\"\n[daemon]\nmax_concurrent_jobs = 6\n");
  if (workspaceYaml) writeFileSync(yaml, "summarize:\n  models: [\"pi:a\"]\n  interval_sec: 30\n");
  const argvLog = join(bin, "argv.log");
  writeFileSync(argvLog, "");
  writeFileSync(join(bin, "state.json"), JSON.stringify({ cliMax: 6, yamlInterval: 30 }));
  const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  writeFileSync(join(bin, "pf"), `#!${process.execPath}
const fs = require("fs"); const path = require("path"); const crypto = require("crypto");
const dir = __dirname;
const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
const args = process.argv.slice(2);
let stdin = ""; try { stdin = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(path.join(dir, "argv.log"), JSON.stringify({ args, stdin }) + "\\n");
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const rest = args.filter((a) => a !== "--json");
if (args.includes("--version")) { process.stdout.write("v2.20.6\\n"); process.exit(0); }
if (rest[0] === "config" && rest[1] === "list") {
  process.stdout.write(JSON.stringify({ file: { path: ${JSON.stringify(cliToml)}, sha256: sha(${JSON.stringify(cliToml)}), exists: true }, items: [
    { key: "max_concurrent_jobs", value: String(state.cliMax), source: "file", class: "live", schema: { kind: "int", min: 1 } },
    { key: "api_key", set: true, source: "file", class: "restart-only" },
  ] }) + "\\n"); process.exit(0);
}
if (rest[0] === "config" && rest[1] === "workspace") {
  const yamlExists = fs.existsSync(${JSON.stringify(yaml)});
  process.stdout.write(JSON.stringify({ mapped: true, workspace: ${JSON.stringify(ws)}, yaml: { path: ${JSON.stringify(yaml)}, sha256: yamlExists ? sha(${JSON.stringify(yaml)}) : null, exists: yamlExists }, summarize: {
    models: { value: ["pi:a"], source: yamlExists ? "file" : "default", class: "live" },
    language: { value: "中文", source: "default", class: "live" },
    interval_sec: { value: yamlExists ? state.yamlInterval : 120, source: yamlExists ? "file" : "default", class: "live" },
  }, steps: {}, steps_complete: true }) + "\\n"); process.exit(0);
}
if (rest[0] === "ops" && rest[1] === "status") { process.stdout.write(JSON.stringify({ queue: { max_concurrent: state.cliMax } }) + "\\n"); process.exit(0); }
if (rest[0] === "config" && (rest[1] === "set" || rest[1] === "unset")) {
  if (rest[2] === "max_concurrent_jobs") { state.cliMax = Number(rest[3]); fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state)); }
  process.stdout.write(JSON.stringify({ outcome: "applied" }) + "\\n"); process.exit(0);
}
process.stderr.write("pf: unknown command\\n"); process.exit(2);
`);
  chmodSync(join(bin, "pf"), 0o755);
  return { work, bin, agent, cliToml, ws, yaml, argvLog, sha };
}

function withPath(tree, t) {
  const oldPath = process.env.PATH;
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PATH = `${tree.bin}${delimiter}${oldPath}`;
  process.env.PI_CODING_AGENT_DIR = tree.agent;
  t.after(() => {
    process.env.PATH = oldPath;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    rmSync(tree.work, { recursive: true, force: true });
  });
}

const calls = (tree) => readFileSync(tree.argvLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const reset = (tree) => writeFileSync(tree.argvLog, "");

test("a cli write records the file's real old value, not the previous history value", async (t) => {
  const tree = stubTree();
  withPath(tree, t);
  const lib = await jiti.import("./polyforge-config-write.ts");

  const result = await lib.writePolyforgeConfig({
    action: "set",
    key: "max_concurrent_jobs",
    value: 7,
    cwd: tree.ws,
    expect_state: { file_sha256: tree.sha(tree.cliToml), values: { max_concurrent_jobs: "6", api_key: { set: true } } },
  });
  assert.equal(result.entry.old, "6", "old must be the file's real value");
  assert.equal(result.entry.new, 7);
  assert.equal(result.entry.cwd, "", "cli entries are machine-scoped");
  const setCall = calls(tree).find((call) => call.args.includes("set"));
  assert.ok(setCall, "the write reached pf");
  assert.ok(setCall.args.includes("--expect-state"), "the read snapshot reaches pf");
});

test("a workspace write keys by the resolved workspace and rolls back to its own workspace/unset", async (t) => {
  const tree = stubTree();
  withPath(tree, t);
  const lib = await jiti.import("./polyforge-config-write.ts");

  const write = await lib.writePolyforgeConfig({
    action: "set",
    key: "summarize.interval_sec",
    value: 40,
    cwd: tree.ws,
    expect_state: { file_sha256: tree.sha(tree.yaml), values: { "summarize.interval_sec": 30 } },
  });
  assert.equal(write.entry.cwd, tree.ws, "workspace entries key by the resolved workspace");
  assert.equal(write.entry.old, 30, "the yaml's real old value");

  // A rollback sends the yaml hash and the ENTRY's workspace, not body.cwd.
  reset(tree);
  const rollback = await lib.rollbackPolyforgeConfig({
    key: "summarize.interval_sec",
    old: 30,
    cwd: "/some/other/place",
    entry: write.entry,
  });
  assert.equal(rollback.entry.cwd, tree.ws);
  const rollbackCall = calls(tree).find((call) => call.args.includes("set") && call.args.includes("--cwd"));
  assert.ok(rollbackCall, "the rollback issued a workspace set");
  const cwd = rollbackCall.args[rollbackCall.args.indexOf("--cwd") + 1];
  assert.equal(cwd, tree.ws, "the rollback used the entry's workspace, not the panel cwd");

  // An entry with no old value rolls back to `unset`, not an error.
  reset(tree);
  await lib.rollbackPolyforgeConfig({
    key: "summarize.interval_sec",
    old: null,
    entry: { ...write.entry, old: null },
  });
  assert.ok(calls(tree).some((call) => call.args.includes("unset")), "a null old value rolls back to unset");
});

test("a write to a mapped workspace with no yaml reaches pf with an absent expectation", async (t) => {
  const tree = stubTree({ workspaceYaml: false });
  withPath(tree, t);
  const lib = await jiti.import("./polyforge-config-write.ts");

  // The panel computes `file_sha256: hash ?? null`; with no yaml there is no
  // hash, so the expectation is an explicit JSON null meaning "absent" — not
  // an omitted field (which pf reads as "no hash check").
  await lib.writePolyforgeConfig({
    action: "set",
    key: "summarize.models",
    value: ["pi:a", "pi:b"],
    cwd: tree.ws,
    expect_state: { file_sha256: null, values: {} },
  });
  const setCall = calls(tree).find((call) => call.args.includes("set"));
  assert.ok(setCall, "the write reached pf");
  const idx = setCall.args.indexOf("--expect-state");
  assert.ok(idx >= 0, "the absent expectation reaches pf");
  const state = JSON.parse(setCall.args[idx + 1]);
  assert.ok(Object.prototype.hasOwnProperty.call(state, "file_sha256"), "file_sha256 must be present, not omitted");
  assert.equal(state.file_sha256, null, "a yaml-less workspace sends an explicit-null (absent) expectation");

  // A rollback on a still-absent yaml computes the same absent expectation.
  reset(tree);
  await lib.rollbackPolyforgeConfig({
    key: "summarize.interval_sec",
    old: 30,
    entry: { id: "w22-absent", at: new Date().toISOString(), scope: "workspace", cwd: tree.ws, key: "summarize.interval_sec", old: null, new: 30, secret: false, rollbackable: true },
  });
  const rollbackCall = calls(tree).find((call) => call.args.includes("set"));
  assert.ok(rollbackCall, "the rollback reached pf");
  const rollbackState = JSON.parse(rollbackCall.args[rollbackCall.args.indexOf("--expect-state") + 1]);
  assert.equal(rollbackState.file_sha256, null, "the rollback of a yaml-less workspace is absent, not unchecked");
});
