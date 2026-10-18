// pi#107 variants e2e: the other tunnel-idempotence acceptance cases of the
// work item that the main repro (e2e/deploy-tunnel.mjs, quick mode) does not
// cover:
//
//   1. quick tunnel, argv-preserving connector: the work item's pgrep -f
//      identity ("cloudflared tunnel --url http://127.0.0.1:<port>") must
//      recognize a running connector through its command line and reuse it;
//   2. quick tunnel, port change: changing PIWEB_PORT between deploys is a
//      stale-forwarding identity miss — the old connector is replaced (new
//      PID, new URL, old process dead);
//   3. named tunnel, consecutive deploys: the `cloudflared tunnel --config`
//      process is reused (PID unchanged).
//
// Like the main repro this runs fully offline: PATH stubs stand in for
// cloudflared/pi-web/npm, and every deploy targets a scratch tmux session
// name and scratch ports, so the live "piweb" session on this machine is
// never touched (lesson from the pi#38 verification report).
//
// The cloudflared stub here keeps its original argv (`tunnel --url ...` /
// `tunnel --config ...`) by looping instead of exec-ing sleep, the way the
// real cloudflared binary holds its command line — that is what lets the
// pgrep identity see it.
//
// Run: node e2e/deploy-tunnel-variants.mjs   (from the repository root)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const deployScript = join(root, "deploy-piweb.sh");

assert.ok(process.platform === "linux" || process.platform === "darwin", "deploy-piweb.sh targets Linux/macOS");
{
  const tmux = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  assert.equal(tmux.status, 0, "tmux must be installed for the deploy e2e");
}

const scratch = mkdtempSync(join(tmpdir(), "piweb-deploy-variants-"));
const stubbin = join(scratch, "bin");
mkdirSync(stubbin);
const session = `piweb-var-${process.pid}`;

const freePort = async () => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
};
const portA = await freePort(); // quick mode, stable across deploys
const portB = await freePort(); // quick mode, port change
const portC = await freePort(); // named mode (must equal the config's ingress port)

// ---------------------------------------------------------------------------
// Offline tool stubs (see header comment).
// ---------------------------------------------------------------------------
const cloudflaredStub = [
  "#!/bin/sh",
  "# Stub cloudflared connector (pi#107 variants e2e): records the connector",
  "# PID, prints one quick-tunnel URL unique to this process, and stays in the",
  "# foreground holding its original argv (tunnel --url/--config ...), the way",
  "# the real binary does — so the deploy script's pgrep identity sees it.",
  'dir="$(cd "$(dirname "$0")" && pwd)"',
  'echo $$ >>"$dir/cloudflared.pid"',
  'echo "INF stub connector: your quick tunnel is ready!"',
  'echo "INF stub connector: https://stub-$$-variants.trycloudflare.com"',
  "while :; do sleep 1; done",
  "",
].join("\n");

const piwebStub = [
  "#!/bin/sh",
  "# Stub pi-web server (pi#107 variants e2e): records its PID and holds the",
  "# restart-loop tmux window open without binding any port.",
  'dir="$(cd "$(dirname "$0")" && pwd)"',
  'echo $$ >>"$dir/piweb.pid"',
  "exec sleep 600",
  "",
].join("\n");

const npmStub = [
  "#!/bin/sh",
  "# Stub npm (pi#107 variants e2e): `ls -g <pkg>` -> not installed,",
  "# `install -g <pkg>` -> success, without touching the global prefix.",
  'if [ "$1" = "ls" ]; then exit 1; fi',
  "exit 0",
  "",
].join("\n");

for (const [name, body] of [["cloudflared", cloudflaredStub], ["pi-web", piwebStub], ["npm", npmStub]]) {
  writeFileSync(join(stubbin, name), body);
  chmodSync(join(stubbin, name), 0o755);
}

// Named-mode tunnel config: its ingress service port must match portC so the
// deploy script's named-tunnel identity (config port == local port) holds.
const cfConfig = join(scratch, "config.yml");
writeFileSync(
  cfConfig,
  [
    "tunnel: 00000000-0000-0000-0000-000000000000",
    "credentials-file: /nonexistent-credentials.json",
    "ingress:",
    "  - hostname: stub-variants.example.com",
    `    service: http://127.0.0.1:${portC}`,
    "  - service: http_status:404",
    "",
  ].join("\n"),
);

const lastPid = () => {
  const file = join(stubbin, "cloudflared.pid");
  const lines = readFileSync(file, "utf8").trim().split("\n");
  return Number(lines.at(-1));
};

const pidList = () => {
  const file = join(stubbin, "cloudflared.pid");
  try {
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// One deploy run. Returns { status, stdout, url, pid }.
// ---------------------------------------------------------------------------
const deploy = ({ tunnel, port }) => {
  const result = spawnSync("bash", [deployScript], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      PATH: `${stubbin}:${process.env.PATH}`,
      TMPDIR: scratch,
      PIWEB_EXPOSE: "cloudflare",
      PIWEB_TUNNEL: tunnel,
      PIWEB_TMUX_SESSION: session,
      PIWEB_PORT: String(port),
      PIWEB_HOST: "127.0.0.1",
      PIWEB_CF_CONFIG: cfConfig,
      PIWEB_CF_HOSTNAME: "stub-variants.example.com",
    },
  });
  assert.equal(result.status, 0, `deploy-piweb.sh exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return { stdout: result.stdout, pid: lastPid() };
};

try {
  // --- 1. quick, argv-preserving connector: pgrep identity reuses it -------
  const quick1 = deploy({ tunnel: "quick", port: portA });
  const quick2 = deploy({ tunnel: "quick", port: portA });
  assert.equal(
    quick2.pid,
    quick1.pid,
    `pi#107 (quick, pgrep identity): consecutive deploys must keep the connector PID unchanged; observed ${quick1.pid} -> ${quick2.pid}`,
  );
  assert.match(quick2.stdout, /Reusing healthy cloudflared quick tunnel/);
  const url1 = quick1.stdout.match(/Quick tunnel up: (https:\/\/[a-z0-9-]+\.trycloudflare\.com)/)?.[1];
  const url2 = quick2.stdout.match(/Quick tunnel up: (https:\/\/[a-z0-9-]+\.trycloudflare\.com)/)?.[1];
  assert.ok(url1 && url2, "deploy output must report the quick-tunnel URL");
  assert.equal(url2, url1, `pi#107 (quick): URL must be reused; observed ${url1} -> ${url2}`);

  // --- 2. port change: stale forwarding is an identity miss -> replace ----
  const quick3 = deploy({ tunnel: "quick", port: portB });
  assert.notEqual(quick3.pid, quick1.pid, "pi#107 (port change): the stale connector must be replaced (new PID)");
  const url3 = quick3.stdout.match(/Quick tunnel up: (https:\/\/[a-z0-9-]+\.trycloudflare\.com)/)?.[1];
  assert.ok(url3, "deploy output must report the new quick-tunnel URL");
  assert.notEqual(url3, url1, "pi#107 (port change): the quick URL must change with the connector");
  const oldAlive = spawnSync("kill", ["-0", String(quick1.pid)], { encoding: "utf8" });
  assert.notEqual(oldAlive.status, 0, `pi#107 (port change): old connector PID ${quick1.pid} must be gone after replacement`);

  // --- 3. named: consecutive deploys keep the --config connector ----------
  const named1 = deploy({ tunnel: "named", port: portC });
  const named2 = deploy({ tunnel: "named", port: portC });
  assert.equal(
    named2.pid,
    named1.pid,
    `pi#107 (named): consecutive deploys must keep the cloudflared tunnel --config process unchanged; observed ${named1.pid} -> ${named2.pid}`,
  );
  assert.match(named2.stdout, /Reusing cloudflared named tunnel/);

  console.log("PASS: quick (pgrep identity) reuse, port-change replacement, and named-tunnel reuse all held");
} finally {
  // Never leak the scratch session, stub processes, or temp files.
  spawnSync("tmux", ["kill-session", "-t", session], { encoding: "utf8" });
  for (const pid of pidList()) {
    spawnSync("kill", [String(pid)], { encoding: "utf8" });
  }
  rmSync(scratch, { recursive: true, force: true });
  // The stable quick-tunnel log lives outside TMPDIR by design; remove the
  // one this test's scratch session wrote.
  try {
    rmSync(join(process.env.HOME, ".piweb", `${session}-quick-tunnel.log`), { force: true });
  } catch {
    // best-effort only
  }
}
