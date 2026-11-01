import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { claudeConfigDir, claudeSettingsPath, ensureClaudeConfigDir, claudeTranscriptFile, removeClaudeTranscript } = await jiti.import("./claude-config-dir.ts");

function agentDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-claude-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the config dir is <agent dir>/claude and follows PI_CODING_AGENT_DIR", (t) => {
  const dir = agentDir(t);
  assert.equal(claudeConfigDir(dir), path.join(dir, "claude"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  assert.equal(claudeConfigDir(), path.join(dir, "claude"));
  assert.equal(claudeSettingsPath(), path.join(dir, "claude", "settings.json"));
});

test("the first ensure creates a credential-free settings.json with private modes", (t) => {
  const dir = agentDir(t);
  const created = ensureClaudeConfigDir(dir);
  assert.equal(created, path.join(dir, "claude"));
  const settings = path.join(created, "settings.json");
  assert.equal(fs.readFileSync(settings, "utf8"), "{}\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")), {});
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(settings).mode & 0o777, 0o600);
    assert.equal(fs.statSync(created).mode & 0o777, 0o700);
  }
  assert.deepEqual(fs.readdirSync(created), ["settings.json"]);
});

test("an existing settings.json keeps every byte", (t) => {
  const dir = agentDir(t);
  const settings = path.join(dir, "claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const extended = '{\n  "env": { "SOME_SETTING": "user value" },\n  "permissions": { "allow": ["Bash(ls:*)"] }\n}';
  fs.writeFileSync(settings, extended);
  const before = fs.statSync(settings).mtimeMs;
  ensureClaudeConfigDir(dir);
  ensureClaudeConfigDir(dir);
  assert.equal(fs.readFileSync(settings, "utf8"), extended);
  assert.equal(fs.statSync(settings).mtimeMs, before);
});

test("a transcript is found by id under any projects subdirectory and removed alone", (t) => {
  const dir = agentDir(t);
  const projects = path.join(dir, "claude", "projects");
  fs.mkdirSync(path.join(projects, "-tmp-a"), { recursive: true });
  fs.mkdirSync(path.join(projects, "-tmp-b"), { recursive: true });
  const mine = path.join(projects, "-tmp-b", "11111111-2222-3333-4444-555555555555.jsonl");
  const other = path.join(projects, "-tmp-a", "99999999-2222-3333-4444-555555555555.jsonl");
  fs.writeFileSync(mine, "{}\n");
  fs.writeFileSync(other, "{}\n");
  assert.equal(claudeTranscriptFile("11111111-2222-3333-4444-555555555555", dir), mine);
  assert.equal(claudeTranscriptFile("00000000-0000-0000-0000-000000000000", dir), null);
  assert.equal(claudeTranscriptFile("../-tmp-a/x", dir), null);
  assert.equal(removeClaudeTranscript("11111111-2222-3333-4444-555555555555", dir), true);
  assert.ok(!fs.existsSync(mine));
  assert.ok(fs.existsSync(other));
  assert.equal(removeClaudeTranscript("11111111-2222-3333-4444-555555555555", dir), false);
});

test("no projects dir reads as no transcript", (t) => {
  assert.equal(claudeTranscriptFile("abc", agentDir(t)), null);
});
