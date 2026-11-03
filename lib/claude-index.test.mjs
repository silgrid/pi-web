import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const index = await jiti.import("./claude-index.ts");
const { getSessionListVersion } = await jiti.import("./session-reader.ts");

function agentDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-claude-index-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function record(id, extra = {}) {
  return {
    id,
    cwd: "/work",
    modelAlias: "sonnet",
    preset: "read-only",
    created: "2026-11-01T00:00:00.000Z",
    modified: "2026-11-01T00:00:00.000Z",
    firstMessage: `hello ${id}`,
    usage: { ...index.EMPTY_CLAUDE_USAGE },
    ...extra,
  };
}

test("a missing or corrupt index reads as empty", (t) => {
  const dir = agentDir(t);
  assert.deepEqual(index.readClaudeIndex(dir), []);
  fs.writeFileSync(index.claudeIndexPath(dir), "{not json");
  assert.deepEqual(index.readClaudeIndex(dir), []);
  fs.writeFileSync(index.claudeIndexPath(dir), JSON.stringify({ sessions: [{ id: "x" }, record("ok")] }));
  assert.deepEqual(index.readClaudeIndex(dir).map((entry) => entry.id), ["ok"]);
});

test("upsert, rename, archive and remove persist, each bumping the list version", async (t) => {
  const dir = agentDir(t);
  let version = getSessionListVersion();
  await index.upsertClaudeSessionRecord(record("a"), dir);
  assert.ok(getSessionListVersion() > version);
  await index.upsertClaudeSessionRecord(record("b"), dir);
  assert.deepEqual(index.readClaudeIndex(dir).map((entry) => entry.id), ["a", "b"]);

  version = getSessionListVersion();
  await index.updateClaudeSessionRecord("a", (entry) => ({ ...entry, name: "Renamed", archived: true }), dir);
  assert.ok(getSessionListVersion() > version);
  assert.equal(index.getClaudeSessionRecord("a", dir).name, "Renamed");
  assert.equal(index.getClaudeSessionRecord("a", dir).archived, true);
  assert.equal(await index.updateClaudeSessionRecord("missing", (entry) => entry, dir), undefined);

  assert.equal(await index.removeClaudeSessionRecord("a", dir), true);
  assert.equal(await index.removeClaudeSessionRecord("a", dir), false);
  assert.deepEqual(index.readClaudeIndex(dir).map((entry) => entry.id), ["b"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(index.claudeIndexPath(dir)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ["claude-sessions.json"]);
});

test("concurrent writes are serialized: none is lost", async (t) => {
  const dir = agentDir(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => index.upsertClaudeSessionRecord(record(`s${i}`), dir)));
  assert.equal(index.readClaudeIndex(dir).length, 20);
});

test("usage totals add each turn's result aggregate", async (t) => {
  const dir = agentDir(t);
  await index.upsertClaudeSessionRecord(record("u"), dir);
  await index.recordClaudeUsage("u", { input: 10, output: 5, cacheRead: 100, cacheWrite: 7, cost: 0.5 }, dir);
  await index.recordClaudeUsage("u", { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.25 }, dir);
  assert.deepEqual(index.getClaudeSessionRecord("u", dir).usage, { input: 11, output: 7, cacheRead: 103, cacheWrite: 11, cost: 0.75 });
});
