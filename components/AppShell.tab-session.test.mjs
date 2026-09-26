import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("first paint does not read tab sessionStorage", () => {
  assert.match(
    source,
    /const \[initialNavigation, setInitialNavigation\] = useState\(\(\) => getInitialNavigation\(searchParams\)\);/,
  );
  assert.doesNotMatch(
    source,
    /useState\(\(\) => getInitialNavigation\(searchParams,\s*getTabOpen/,
  );
});

test("applies tab session memory after mount instead of suppressing hydration", () => {
  assert.match(
    source,
    /useLayoutEffect\(\(\) => \{\s+const next = withTabOpen\(initialNavigation, getTabOpen\(\)\);[\s\S]*?setInitialNavigation\(next\);[\s\S]*?if \(next\.sessionId\) setInitialSessionRestored\(false\);[\s\S]*?\}, \[initialNavigation\]\);/,
  );
  assert.doesNotMatch(source, /suppressHydrationWarning/);
});

test("writes the session URL when tab memory restores onto an empty address bar", () => {
  assert.match(
    source,
    /if \(!isRestore \|\| new URLSearchParams\(window\.location\.search\)\.get\("session"\) !== session\.id\) \{\s+router\.replace\(`\?session=\$\{encodeURIComponent\(session\.id\)\}`/,
  );
});

test("New session is remembered as this tab's selection", () => {
  // Fork adaptation (pi#56 merge): the tab-memory calls live in the
  // selection-tracking callback — setTabOpenSession for sessions and
  // setTabOpenNewSession for the new-session composer cwd. Our pi#21
  // handleNewSession flow deliberately does not rewrite the URL to
  // `?cwd=` (upstream's assertion targeted that detail).
  assert.match(source, /setTabOpenSession\(selectedSession\.id\);/);
  assert.match(source, /if \(newSessionCwd\) setTabOpenNewSession\(newSessionCwd\);/);
});

test("deleting the current session forgets its tab memory", () => {
  const start = source.indexOf("  const handleSessionDeleted = useCallback");
  const end = source.indexOf("  const handleOpenFile = useCallback", start);
  const body = source.slice(start, end);
  assert.match(body, /clearTabOpenSession\(sessionId\);/);
  assert.ok(body.indexOf("clearTabOpenSession(sessionId)") < body.indexOf("setSelectedSession(null)"));
});
