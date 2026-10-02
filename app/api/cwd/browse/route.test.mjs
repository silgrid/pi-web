import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// ---------------------------------------------------------------------------
// Route tests for POST /api/cwd/browse (pi#86 review blocker: the picker's
// mkdir endpoint had no filesystem authorization). Scopes are injected via
// __setRegistrationScopesForTesting so the registration policy is exercised
// over TMP FIXTURES ONLY, never the operator's real home or prefixes.
// ---------------------------------------------------------------------------

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-cwd-browse-")));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");
const { __setRegistrationScopesForTesting: setRegistrationScopes } = await jiti.import(
  "../../../../lib/root-registration-policy.ts",
);

test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(base, { recursive: true, force: true });
});

// The registration prefixes for this process: a fixture home and the scratch
// base. Anything outside both must be refused by the picker's mkdir.
const homeFixture = path.join(base, "home-fixture");
fs.mkdirSync(homeFixture, { recursive: true });
setRegistrationScopes(homeFixture, base);

function createDirectory(pathValue, name) {
  return POST(new Request("http://localhost/api/cwd/browse", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ path: pathValue, name }),
  }));
}

test("creates a directory inside the registration prefixes", async () => {
  const project = path.join(base, "project");
  fs.mkdirSync(project, { recursive: true });

  const response = await createDirectory(project, "new-child");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, path: path.join(project, "new-child") });
  assert.ok(fs.existsSync(path.join(project, "new-child")));
});

test("refuses mkdir outside the registration prefixes without filesystem changes", async (t) => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-cwd-outside-")));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  const response = await createDirectory(outside, "nope");
  assert.equal(response.status, 403);
  assert.equal(fs.readdirSync(outside).length, 0, "no directory may be created outside the prefixes");
});

test("refuses mkdir through a symlink that escapes the registration prefixes", async (t) => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-cwd-escape-")));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const link = path.join(base, "escape-link");
  const dirType = process.platform === "win32" ? "junction" : "dir";
  try {
    fs.symlinkSync(outside, link, dirType);
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  // The link itself sits inside the prefixes; the canonical parent does not.
  const response = await createDirectory(link, "nope");
  assert.equal(response.status, 403);
  assert.equal(fs.readdirSync(outside).length, 0, "the symlink target must stay untouched");
});
