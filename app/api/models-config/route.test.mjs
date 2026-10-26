import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-models-config-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");
const modelsPath = join(testAgentDir, "models.json");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function put(body, headers = { "Content-Type": "application/json", Host: "localhost" }) {
  return new Request("http://localhost/api/models-config", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

test("a models.json with a syntax error is reported instead of read as empty, and a save cannot replace it", async () => {
  const original = '{ "providers": { "acme": { "models": [ } } }';
  await writeFile(modelsPath, original);

  let response = await GET();
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /models\.json/);

  response = await PUT(put({ providers: {} }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /models\.json/);
  assert.equal(await readFile(modelsPath, "utf8"), original);
});

test("a commented models.json loads with its providers", async () => {
  await writeFile(modelsPath, '{\n  // local models\n  "providers": { "acme": { "models": [{ "id": "a" },] } },\n}\n');

  const response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { providers: { acme: { models: [{ id: "a" }] } } });
});

test("PUT refuses a non-JSON content type (audit S8)", async () => {
  const response = await PUT(put({ providers: {} }, { "Content-Type": "text/plain", Host: "localhost" }));
  assert.equal(response.status, 415);
});

test("PUT refuses payloads outside the models.json spine with the typed code (audit S8)", async () => {
  await writeFile(modelsPath, JSON.stringify({ providers: {} }));
  for (const body of [
    null,
    "string",
    { providers: "not-a-record" },
    { providers: [] },
    { providers: { acme: "not-a-record" } },
    { providers: { acme: { models: "not-an-array" } } },
    { providers: { acme: { models: ["not-a-record"] } } },
  ]) {
    const response = await PUT(put(body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error: "invalidBody" }, JSON.stringify(body));
  }
  // nothing was written
  assert.deepEqual(JSON.parse(await readFile(modelsPath, "utf8")), { providers: {} });
});

test("PUT type-checks provider/model fields like the SDK's own loader (review r1: real schema)", async () => {
  await writeFile(modelsPath, JSON.stringify({ providers: {} }));
  for (const body of [
    // The review's demonstrated exfiltration of the old spine check.
    { providers: { acme: { baseUrl: 17, apiKey: 42, models: [{ id: 0 }] } } },
    // A payload without providers at all.
    { other: true },
    // Mistyped SDK-supported fields.
    { providers: { acme: { name: 7 } } },
    { providers: { acme: { authHeader: "yes" } } },
    { providers: { acme: { oauth: "not-radius" } } },
    { providers: { acme: { headers: { "x-a": 1 } } } },
    { providers: { acme: { models: [{ id: "m", reasoning: "yes" }] } } },
    { providers: { acme: { models: [{ id: "m", contextWindow: "big" }] } } },
    { providers: { acme: { models: [{ id: "m", input: ["video"] }] } } },
    { providers: { acme: { models: [{ id: "m", cost: { input: "free" } }] } } },
    { providers: { acme: { modelOverrides: { m: "nope" } } } },
    { providers: { acme: { modelOverrides: { m: { maxTokens: "lots" } } } } },
  ]) {
    const response = await PUT(put(body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error: "invalidBody" }, JSON.stringify(body));
  }
  // An invalid payload never replaces the file on disk.
  assert.deepEqual(JSON.parse(await readFile(modelsPath, "utf8")), { providers: {} });
});

test("PUT accepts a provider shaped like the SDK's supported configuration (review r1)", async () => {
  const body = {
    providers: {
      acme: {
        name: "Acme",
        baseUrl: "https://acme.example/v1",
        apiKey: "$ACME_KEY", // expressions are legitimate in the operator's own file
        authHeader: true,
        headers: { "x-custom": "yes" },
        compat: { supportsStore: true },
        models: [{
          id: "m1",
          reasoning: false,
          contextWindow: 128000,
          maxTokens: 16384,
          cost: { input: 1 }, // partial cost: the write path completes rates with zero
          promptCache: { short: 300 },
          headers: { "x-model": "v" },
        }],
        modelOverrides: { m1: { name: "M One", headers: { "x-o": "v" } } },
      },
    },
  };
  const response = await PUT(put(body));
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  const written = JSON.parse(await readFile(modelsPath, "utf8"));
  assert.equal(written.providers.acme.name, "Acme");
  assert.equal(written.providers.acme.authHeader, true);
  assert.equal(written.providers.acme.apiKey, "$ACME_KEY");
  // Unknown keys survive, like the SDK's own loader.
  assert.equal(written.providers.acme.compat.supportsStore, true);
  // Cost normalization completed the missing rates with zero.
  assert.deepEqual(written.providers.acme.models[0].cost, {
    input: 1, output: 0, cacheRead: 0, cacheWrite: 0,
  });
});

test("PUT refuses a request from a host the proxy does not trust (audit S8)", async () => {
  await writeFile(modelsPath, JSON.stringify({ providers: {} }));
  const response = await PUT(new Request("http://evil.example/api/models-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providers: { evil: { baseUrl: "https://evil.example" } } }),
  }));
  assert.equal(response.status, 403);
  assert.equal(await readFile(modelsPath, "utf8"), JSON.stringify({ providers: {} }));
});
