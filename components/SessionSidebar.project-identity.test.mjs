import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const customPathStart = source.indexOf("const commitCustomPath = useCallback");
const customPathEnd = source.indexOf("// Clicking a session moves the effective cwd", customPathStart);
assert.ok(customPathStart !== -1 && customPathEnd !== -1);
const customPathSource = source.slice(customPathStart, customPathEnd);

test("custom cwd selection installs validated identity before changing cwd", () => {
  assert.match(customPathSource, /projectRoot\?: string;[\s\S]*?projectKey\?: string;/);

  const identityUpdate = customPathSource.indexOf("setValidatedProject(");
  const cwdUpdate = customPathSource.indexOf("setSelectedCwd(");
  assert.ok(identityUpdate >= 0, "validated project identity is retained");
  assert.ok(cwdUpdate > identityUpdate, "identity is retained before cwd changes");
});

test("custom cwd selection remembers the last validated path for the picker", () => {
  assert.match(customPathSource, /saveLastCustomCwd\(data\.cwd\)/);
  assert.match(source, /initialPath=\{customPathValue\}/);
});

// Upstream carries a `handleDefaultCwd` shortcut inside the workspace
// dropdown that re-validates the directory `/api/default-cwd` returns
// through `commitCustomPath` — the same `/api/cwd/validate` identity
// pipeline a typed custom path uses, so the shortcut installs a validated
// projectRoot/projectKey exactly like a custom path pick.
//
// This fork removed the entire workspace dropdown — and the shortcut with
// it — in pi#49 R2; SessionSidebar.default-cwd.test.mjs pins that removal
// (`handleDefaultCwd` and the `/api/default-cwd` fetch must NOT reappear
// here). There is no dropdown left to host an equivalent control, so this
// merge must not resurrect the upstream handler.
//
// UPSTREAM DEVIATION (recorded, not fixed here): the fork's actual
// default-cwd entry point is AppShell's `resolveNewSessionTabCwd`, which
// backs automatic workspace selection for a brand-new session. It fetches
// `/api/default-cwd` directly and returns the bare path WITHOUT a follow-up
// `/api/cwd/validate` call, so — unlike upstream's dropdown shortcut — it
// never installs a validated projectRoot/projectKey identity. That resolver
// has its own full behavior coverage in AppShell.new-session-cwd.test.mjs;
// this test only asserts the two surfaces stay consistent with each other.
test("default cwd has no sidebar dropdown shortcut (dropped in pi#49 R2); AppShell's new-session resolver is the equivalent entry point", async () => {
  assert.doesNotMatch(source, /handleDefaultCwd/);
  assert.doesNotMatch(source, /\/api\/default-cwd/);

  const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(appShellSource, /const resolveNewSessionTabCwd = useCallback/);
  assert.match(appShellSource, /fetch\("\/api\/default-cwd", \{ method: "POST" \}\)/);
  // pi#87 closed the old deviation: the default directory now goes through
  // the same /api/cwd/validate selection as commitCustomPath above, so a
  // fresh server stops 403ing the cwd-scoped queries (project trust,
  // models) the new tab fires before any session registers the root.
  const resolverStart = appShellSource.indexOf("const resolveNewSessionTabCwd = useCallback");
  const resolverEnd = appShellSource.indexOf("}, [newSessionCwd, selectedSession, activeCwd]);", resolverStart);
  const resolverSource = appShellSource.slice(resolverStart, resolverEnd);
  assert.match(resolverSource, /api\/cwd\/validate/);
  assert.match(resolverSource, /body: JSON\.stringify\(\{ cwd: data\.cwd \}\)/);
});
