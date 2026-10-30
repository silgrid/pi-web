// Served == installed self-check e2e: after the swap, deploy-piweb.sh must
// confirm that the pi-web the restart loop serves is the pi-web npm just
// installed.
//
// Reported failure: npm installed v0.1.6 into a global prefix whose bin dir
// was not on the service PATH, so `command -v pi-web` and the running loop
// process still pointed at the v0.1.5 package while the deploy lane reported
// state=deployed.
//
// Covered criteria:
//   - mismatch (the v0.1.6 incident shape): the new package is installed
//     outside PATH while PATH's pi-web resolves to an old package. The deploy
//     exits 0 and prints exactly one `warn: serving 0.1.5, installed 0.1.6`
//     line; the loop really runs the old package. Through the lane entry
//     (.polyforge/deploy.sh) the same shape still reports state=deployed —
//     the warning never changes the exit code or the state.
//   - aligned: PATH's pi-web resolves to the newly installed package and the
//     loop runs it. No `warn: serving` line; one `==> Served == installed`
//     line names the version and the package directory.
//
// Fully offline: PATH stubs stand in for npm (it models a real global
// install: `install -g` writes the package under a scratch prefix, `root -g`
// and `ls -g` read it back) and gh; the pi-web packages are tiny Node scripts
// that stay alive so `ps` shows their script path. HOME and TMPDIR are a
// scratch directory and every deploy uses its own scratch tmux session.
//
// Run: node e2e/deploy-served-installed.mjs   (from the repository root)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ghStubBody, writeStub } from "./lane-stubs.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const deployScript = join(root, "deploy-piweb.sh");
const laneDeploy = join(root, ".polyforge", "deploy.sh");

assert.ok(process.platform === "linux" || process.platform === "darwin", "deploy-piweb.sh targets Linux/macOS");
assert.equal(spawnSync("tmux", ["-V"], { encoding: "utf8" }).status, 0, "tmux must be installed for the deploy e2e");

const OLD = "0.1.5";
const NEW = "0.1.6";
const PKG = "@silgrid/pi-web";
const PAYLOAD = "stub pi-web release tarball payload for the served-installed e2e\n";
const HASH = createHash("sha256").update(PAYLOAD).digest("hex");

const scratch = mkdtempSync(join(tmpdir(), "piweb-served-installed-"));
const stubbin = join(scratch, "bin");
mkdirSync(stubbin);
const sessions = {
  mismatch: `piweb-served-mismatch-${process.pid}`,
  lane: `piweb-served-lane-${process.pid}`,
  aligned: `piweb-served-aligned-${process.pid}`,
};

// The pi-web package entry: records which package it runs from, then stays
// alive (no port is bound) so the loop's process keeps its script path.
const piwebBin = [
  "#!/usr/bin/env node",
  'const { appendFileSync, readFileSync } = require("node:fs");',
  'const { join } = require("node:path");',
  'const pkg = join(__dirname, "..");',
  'const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));',
  'appendFileSync(join(pkg, "run.jsonl"), `${JSON.stringify({ pid: process.pid, script: process.argv[1], version })}\\n`);',
  "setInterval(() => {}, 60_000);",
  "",
].join("\n");
const piwebBinTemplate = join(scratch, "pi-web.js.template");
writeFileSync(piwebBinTemplate, piwebBin);

const packageJson = (version) => `${JSON.stringify({ name: PKG, version, bin: { "pi-web": "bin/pi-web.js" } })}\n`;

// npm stub: a global install under NPMSTUB_PREFIX, as npm lays it out.
const npmStub = [
  "#!/bin/sh",
  "# Stub npm (served-installed e2e): `install -g` writes the package under",
  "# NPMSTUB_PREFIX; `root -g` and `ls -g` read that install back.",
  'prefix="${NPMSTUB_PREFIX:?NPMSTUB_PREFIX must name the global prefix}"',
  `pkgdir="$prefix/lib/node_modules/${PKG}"`,
  'case "$1" in',
  '  root) printf \'%s\\n\' "$prefix/lib/node_modules"; exit 0 ;;',
  "  ls)",
  `    case "$*" in *"${PKG}"*) ;; *) exit 1 ;; esac`,
  '    [ -f "$pkgdir/package.json" ] || { printf \'%s\\n└── (empty)\\n\' "$prefix/lib"; exit 1; }',
  '    v="$(sed -n \'s/.*"version":"\\([^"]*\\)".*/\\1/p\' "$pkgdir/package.json")"',
  `    printf '%s\\n└── ${PKG}@%s\\n' "$prefix/lib" "$v"; exit 0 ;;`,
  "  install)",
  '    mkdir -p "$pkgdir/bin" "$prefix/bin"',
  `    printf '{"name":"${PKG}","version":"%s","bin":{"pi-web":"bin/pi-web.js"}}\\n' "\${NPMSTUB_VERSION:?}" >"$pkgdir/package.json"`,
  '    cp "${NPMSTUB_BIN_TEMPLATE:?}" "$pkgdir/bin/pi-web.js"',
  '    chmod 755 "$pkgdir/bin/pi-web.js"',
  '    ln -sf "../lib/node_modules/' + PKG + '/bin/pi-web.js" "$prefix/bin/pi-web"',
  "    exit 0 ;;",
  "esac",
  "exit 0",
  "",
].join("\n");
writeStub(stubbin, "npm", npmStub);
writeStub(stubbin, "gh", ghStubBody);

// An old package on PATH: <dir>/lib/node_modules/@silgrid/pi-web at OLD, with
// <dir>/bin/pi-web the npm-style symlink to its entry.
const oldPackage = (dir) => {
  const pkgdir = join(dir, "lib", "node_modules", PKG);
  mkdirSync(join(pkgdir, "bin"), { recursive: true });
  writeFileSync(join(pkgdir, "package.json"), packageJson(OLD));
  writeFileSync(join(pkgdir, "bin", "pi-web.js"), piwebBin);
  chmodSync(join(pkgdir, "bin", "pi-web.js"), 0o755);
  mkdirSync(join(dir, "bin"), { recursive: true });
  symlinkSync(`../lib/node_modules/${PKG}/bin/pi-web.js`, join(dir, "bin", "pi-web"));
  return pkgdir;
};

const runs = (pkgdir) => {
  try {
    return readFileSync(join(pkgdir, "run.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

const waitForRuns = async (pkgdir, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runs(pkgdir).length > 0) return runs(pkgdir);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return runs(pkgdir);
};

// A daemon-like environment: no operator service-shape variable, a loopback
// bind with no port/password (no configured-port probe) and no allowed hosts
// (the TLS edge probe is skipped), so only the self-check is exercised.
const baseEnv = (session, pathDir, prefix, overrides = {}) => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_WEB_") || key.startsWith("PIWEB_") || key.startsWith("GHSTUB_") || key.startsWith("NPMSTUB_")) {
      delete env[key];
    }
  }
  return Object.assign(env, {
    PATH: `${stubbin}:${pathDir}:${process.env.PATH}`,
    HOME: scratch,
    TMPDIR: scratch,
    PIWEB_TMUX_SESSION: session,
    PIWEB_HOST: "127.0.0.1",
    NPMSTUB_PREFIX: prefix,
    NPMSTUB_VERSION: NEW,
    NPMSTUB_BIN_TEMPLATE: piwebBinTemplate,
    ...overrides,
  });
};

const run = (script, args, env) =>
  spawnSync("bash", [script, ...args], { cwd: root, encoding: "utf8", timeout: 120_000, env });
const output = (result) => `${result.stdout}\n${result.stderr}`;
const servedWarnings = (result) => output(result).match(/^warn: serving .*$/gm) ?? [];

const pkgdirs = [];
const failures = [];
const scenario = async (title, fn) => {
  try {
    await fn();
    console.log(`PASS: ${title}`);
  } catch (error) {
    failures.push(title);
    console.log(`FAIL: ${title}`);
    console.log(`  ${String(error.message).split("\n").join("\n  ")}`);
  }
};

try {
  await scenario(`mismatch: ${NEW} installed outside PATH while PATH serves ${OLD} warns, exit 0`, async () => {
    const base = join(scratch, "mismatch");
    const oldDir = oldPackage(join(base, "old"));
    const prefix = join(base, "new-prefix");
    pkgdirs.push(oldDir, join(prefix, "lib", "node_modules", PKG));
    const result = run(deployScript, [], baseEnv(sessions.mismatch, join(base, "old", "bin"), prefix));
    const report = output(result);
    assert.equal(result.status, 0, `the self-check is warn-only: the deploy must still exit 0\n${report}`);
    assert.deepEqual(
      servedWarnings(result),
      [`warn: serving ${OLD}, installed ${NEW}`],
      `exactly one 'warn: serving ${OLD}, installed ${NEW}' line must be printed\n${report}`,
    );
    assert.doesNotMatch(report, /^==> Served == installed/m, `a mismatch must not report alignment\n${report}`);
    const served = await waitForRuns(oldDir);
    assert.ok(served.length > 0, "fixture sanity: the loop must be running the old package");
    assert.equal(served.at(-1).version, OLD, "fixture sanity: the loop serves the old version");
    assert.equal(runs(join(prefix, "lib", "node_modules", PKG)).length, 0, "fixture sanity: the new install is not on PATH");
  });

  await scenario(`mismatch via the lane: .polyforge/deploy.sh still reports state=deployed`, async () => {
    const base = join(scratch, "lane");
    const oldDir = oldPackage(join(base, "old"));
    const prefix = join(base, "new-prefix");
    pkgdirs.push(oldDir, join(prefix, "lib", "node_modules", PKG));
    const env = baseEnv(sessions.lane, join(base, "old", "bin"), prefix, {
      GHSTUB_LOG: join(base, "gh.argv"),
      GHSTUB_LATEST_TAG: `v${NEW}`,
      GHSTUB_PAYLOAD: PAYLOAD,
      GHSTUB_HASH: HASH,
      GHSTUB_CHECKSUM_MODE: "match",
    });
    const result = run(laneDeploy, [`v${NEW}`, "--confirm", `v${NEW}`], env);
    const report = output(result);
    assert.equal(result.status, 0, `the lane must still succeed\n${report}`);
    assert.match(result.stdout, /^state=deployed$/m, `the warning must not change the lane state\n${report}`);
    assert.deepEqual(
      servedWarnings(result),
      [`warn: serving ${OLD}, installed ${NEW}`],
      `the lane run carries exactly one served-vs-installed warning\n${report}`,
    );
  });

  await scenario("aligned: PATH and the running loop resolve to the new install, no warning", async () => {
    const base = join(scratch, "aligned");
    const prefix = join(base, "prefix");
    const pkgdir = join(prefix, "lib", "node_modules", PKG);
    pkgdirs.push(pkgdir);
    // PATH holds the prefix's bin dir; npm creates its pi-web link on install.
    mkdirSync(join(prefix, "bin"), { recursive: true });
    const result = run(deployScript, [], baseEnv(sessions.aligned, join(prefix, "bin"), prefix));
    const report = output(result);
    assert.equal(result.status, 0, `an aligned deploy must succeed\n${report}`);
    assert.deepEqual(servedWarnings(result), [], `an aligned deploy must not warn\n${report}`);
    const aligned = report.match(/^==> Served == installed: pi-web (\S+) \((.*)\)$/m);
    assert.ok(aligned, `an aligned deploy prints one 'Served == installed' line\n${report}`);
    assert.equal(aligned[1], NEW, "the line names the installed version");
    const served = await waitForRuns(pkgdir);
    assert.ok(served.length > 0, "fixture sanity: the loop must be running the new package");
    assert.equal(served.at(-1).version, NEW, "fixture sanity: the loop serves the new version");
  });

  if (failures.length > 0) {
    console.error(`${failures.length} scenario(s) failed: ${failures.join("; ")}`);
    process.exitCode = 1;
  } else {
    console.log("PASS: all served-vs-installed scenarios held");
  }
} finally {
  // Never leak the scratch sessions, stub processes, or temp files.
  for (const session of Object.values(sessions)) {
    spawnSync("tmux", ["kill-session", "-t", session], { encoding: "utf8" });
  }
  for (const pkgdir of pkgdirs) {
    for (const item of runs(pkgdir)) spawnSync("kill", ["-9", String(item.pid)], { encoding: "utf8" });
  }
  rmSync(scratch, { recursive: true, force: true });
}
