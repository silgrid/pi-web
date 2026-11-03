import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-claude-route-"));
const agentDir = path.join(scratch, "agent");
const binDir = path.join(scratch, "bin");
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
process.env.PI_CODING_AGENT_DIR = agentDir;
const originalPath = process.env.PATH;
test.after(() => {
  process.env.PATH = originalPath;
  fs.rmSync(scratch, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { GET } = await jiti.import("./route.ts");

test("claude on PATH: available, with the config dir path and the fixed choices; nothing is created", async () => {
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  const body = await (await GET()).json();
  assert.deepEqual(body, {
    available: true,
    configDir: path.join(agentDir, "claude"),
    modelAliases: ["sonnet", "opus", "haiku", "claude-default"],
    presets: ["read-only", "writable"],
    defaultPreset: "read-only",
  });
  assert.equal(fs.existsSync(agentDir), false, "reading availability creates no directory");
});

test("no claude on PATH: unavailable with its reason, still no side effect", async () => {
  process.env.PATH = path.join(scratch, "empty");
  const body = await (await GET()).json();
  assert.equal(body.available, false);
  assert.equal(body.reason, "not-on-path");
  assert.equal(body.configDir, path.join(agentDir, "claude"));
  assert.equal(fs.existsSync(agentDir), false);
});
