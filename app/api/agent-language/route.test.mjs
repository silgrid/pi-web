import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-agent-language-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { GET, PUT } = await jiti.import("./route.ts");
const file = path.join(agentDir, "pi-web-settings.json");

function put(body, headers = {}) {
  return new NextRequest("http://localhost/api/agent-language", {
    method: "PUT",
    headers: { Host: "localhost", Origin: "http://localhost", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function read() {
  const response = await GET();
  assert.equal(response.status, 200);
  return (await response.json()).language;
}

test("GET reads English by default and after a corrupted file", async () => {
  fs.rmSync(file, { force: true });
  assert.equal(await read(), "en");
  fs.writeFileSync(file, "{ broken");
  assert.equal(await read(), "en");
  fs.rmSync(file, { force: true });
});

test("PUT saves and returns the language", async () => {
  const response = await PUT(put({ language: "zh-CN" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { language: "zh-CN" });
  assert.equal(await read(), "zh-CN");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).agentLanguage, "zh-CN");
});

test("PUT refuses untrusted requests, wrong content types and invalid bodies without writing", async () => {
  fs.writeFileSync(file, JSON.stringify({ version: 1, agentLanguage: "zh-CN" }));
  const before = fs.readFileSync(file, "utf8");
  const cases = [
    [put({ language: "en" }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }), 403],
    [put({ language: "en" }, { Host: "evil.example" }), 403],
    [put({ language: "en" }, { "Content-Type": "text/plain" }), 415],
    [put("{ nope"), 400],
    [put(["en"]), 400],
    [put({ language: "klingon" }), 400],
    [put({ language: "en", extra: 1 }), 400],
    [put({}), 400],
  ];
  for (const [request, status] of cases) {
    const response = await PUT(request);
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json()).error, "string");
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("PUT reports a refused write of a malformed file as 500 and keeps the file", async () => {
  fs.writeFileSync(file, "{ broken");
  const response = await PUT(put({ language: "zh-CN" }));
  assert.equal(response.status, 500);
  assert.equal(fs.readFileSync(file, "utf8"), "{ broken");
  fs.rmSync(file, { force: true });
});
