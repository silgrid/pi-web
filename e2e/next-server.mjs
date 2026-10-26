// Shared `next dev`/`next start` lifecycle for the e2e suites.
//
// The suites used to copy the same probe/spawn/ready/stop code. Under the
// parallel runner that copy has a real race: the port is free when the probe
// closes, but another suite can take it before `next` binds it. This helper
// re-probes and retries a bounded number of times when the child exits before
// it is ready or reports EADDRINUSE.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ATTEMPTS = 3;
const READY_TIMEOUT_MS = 120_000;

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

/**
 * Start a Next server for one suite and wait for the same readiness signal the
 * suites used (a successful `GET /api/sessions`). Returns `{ base, server, stop }`.
 *
 * `env` is passed to the child as-is, so each suite keeps its own process-global
 * server environment. `logFile` receives stdout and stderr.
 */
export async function startNextServer({ name, mode = "dev", env = process.env, logFile }) {
  if (mode !== "dev" && mode !== "start") throw new Error(`next-server: invalid mode ${mode}`);
  const log = createWriteStream(logFile);
  const distDir = env.PI_WEB_DIST_DIR || ".next";
  let lastError;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const server = spawn(
      process.execPath,
      [join(root, "node_modules/next/dist/bin/next"), mode, "-H", "127.0.0.1", "-p", String(port)],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const exited = new Promise((resolve) => {
      server.once("exit", (code, signal) => resolve({ code, signal }));
      server.once("error", (error) => resolve({ code: null, signal: null, error }));
    });
    let exitInfo = null;
    void exited.then((info) => { exitInfo = info; });
    const collect = (chunk) => {
      output += chunk;
      log.write(chunk);
    };
    server.stdout.on("data", collect);
    server.stderr.on("data", collect);

    const stop = async ({ endLog = false } = {}) => {
      if (server.exitCode === null && server.signalCode === null) {
        const forceKill = setTimeout(() => { try { server.kill("SIGKILL"); } catch { /* already gone */ } }, 10_000);
        try { server.kill("SIGTERM"); } catch { /* already gone */ }
        await exited;
        clearTimeout(forceKill);
      }
      // A SIGTERM'd `next dev` can leave its lock behind; drop it only if it is this server's.
      const lock = join(root, distDir, "dev/lock");
      try {
        if (JSON.parse(readFileSync(lock, "utf8")).pid === server.pid) rmSync(lock, { force: true });
      } catch { /* no lock, or another server's */ }
      if (endLog) await new Promise((resolve) => log.end(resolve));
    };

    const deadline = Date.now() + READY_TIMEOUT_MS;
    let failure = null;
    while (true) {
      if (exitInfo || server.exitCode !== null || server.signalCode !== null) {
        failure = exitInfo?.error
          ? `failed to spawn: ${exitInfo.error.message}`
          : `exited before readiness (code ${server.exitCode}, signal ${server.signalCode})`;
        break;
      }
      if (output.includes("EADDRINUSE")) {
        failure = `port ${port} was taken before Next bound it`;
        break;
      }
      const response = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (response?.ok) {
        let stopped = false;
        return {
          base,
          server,
          stop: async () => {
            if (stopped) return;
            stopped = true;
            await stop({ endLog: true });
          },
        };
      }
      if (Date.now() >= deadline) {
        failure = "readiness timed out";
        break;
      }
      await delay(250);
    }

    await stop();
    const tail = output.trim().split("\n").slice(-20).join("\n");
    lastError = new Error(`${name ?? "next"}: ${failure} (attempt ${attempt}/${ATTEMPTS}); see ${logFile}${tail ? `\n${tail}` : ""}`);
  }

  await new Promise((resolve) => log.end(resolve));
  throw lastError;
}
