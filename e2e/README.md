# CI and browser regression tests

Adapted from @Nuctori's CI/E2E proposal in #617 and #599. The performance
scanner, reverse reader, sidebar changes, and timing benchmarks are not included.

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The script starts and stops its own Turbopack dev server on an available
loopback port. Run it in a checkout without an active dev server; Next.js
shares `.next/dev/lock` within a checkout. All fixtures are created before
startup in a temporary `PI_CODING_AGENT_DIR` and removed on completion.
No model credentials or existing Pi sessions are needed. Git is required for
the linked-worktree fixture.

CI runs lint, type checking, and unit tests in one job. A separate job builds
the application in a clean checkout and runs the same browser tests with
`E2E_SERVER_MODE=start` against `next start`. Do not build in a checkout used
for development.

Coverage:

- A 5,000-message session opens with exactly the last 50 entries, bounded
  detail/context responses, and no browser errors.
- Desktop and mobile scrolling load two consecutive older pages. Each response
  has the expected IDs, no gaps or duplicates, and the messages appear once in
  the chat. A small session checks pagination through the root.
- Branch context follows the selected leaf and excludes the other branch.
- Markdown, code blocks, and real tool-call/tool-result blocks render.
- Chat width and font size persist, existing drafts resize, and short settings
  panels keep every language option reachable on desktop and mobile.
- Interface/chat and monospace font lists and weights apply live, survive
  refresh, sync between tabs and reset independently without changing width or
  font size. Headings and Markdown emphasis retain their weights.
- Unknown sessions and paths outside the fixture project are rejected.
- Settings › Models context windows (`model-context.mjs`, desktop and mobile,
  stubbed config/auth/model routes): a managed model's field shows the
  resolved window as its placeholder on the row's own line, edits wait for
  the shared Save, a saved override reopens, invalid text is refused without
  a write, a failed save keeps the draft, and clearing it restores the file
  with other providers' settings intact.
- The model picker (`model-selector.mjs`), with a synthetic catalog: on a phone, a simulated keyboard
  (visual viewport shrink, pan, a late height with no event) keeps the same
  filter focused and the list in the visible viewport. Native phone keyboards
  still need real-device verification.
- A local extension checks dialog keyboard navigation, Esc cancellation,
  collapse/expand draft preservation, countdown display, and server-side expiry.
- The sidebar archive pass (wi_tN1cVXKf1VIr / wi_uyIF45t806CP) drives the
  client-side archive contract through the real UI: row-menu archive from
  a pre-selected project (grill Batch 1 Q2 ruling b — the two-project
  alpha/beta fixture is kept, one project is pre-selected at test start via
  the global session search, and each main-list disappearance assertion
  targets only the selected project's session; the other project's
  archived session is asserted via search and the archive view),
  localStorage persistence across reload, `已归档 N` entry visibility,
  count, and stability across project switches, replacement-mode archive
  view with back button and project grouping, view-only open, unarchive,
  search badge, external-delete pruning, and zero server mutations.
  Desktop viewport only.

Model prompts, live model streaming, and agent execution are outside this suite.
Failures save a screenshot, Playwright trace, and server log under
`test-results/e2e/`; CI uploads that directory. Open a trace with
`npx playwright show-trace test-results/e2e/trace.zip`.

## Running every suite in parallel

`npm run test:e2e:all` (`e2e/all.mjs`) runs every standalone `e2e/*.mjs` suite
(same discovery as the release verify-scope engine: no helper modules, no
`exclude=` entries from `.polyforge/verify-scope.conf`) and is the conf's
`full_command`.

- Install once: `npm ci` and `npx playwright install chromium`. The runner
  never installs; it only checks both exist and shares them across suites.
- Each browser suite starts its own `next dev` with `PI_WEB_DIST_DIR=.next/e2e/<suite>`
  (`next.config.ts` `distDir`), so suites do not fight over `.next/dev/lock` and
  each one's compiled output lives in its own dir. Once every suite has
  settled, the runner removes the dist dir of each suite that passed (about
  360 MB each); a failed suite's dir is kept so its re-run
  (`npm run test:e2e:all -- <suite>`) starts warm, and the final green run
  clears it. An interrupted run (SIGINT/SIGTERM) removes nothing, and only
  `.next/e2e/<suite>` is ever removed: `.next/dev` and `.next` are left alone
. Without the variable every suite uses `.next` as
  before. With it, `next.config.ts` points Next at `tsconfig.e2e.json` (it
  extends the repo config), so `next dev` never rewrites the checkout's
  `tsconfig.json`.
- Browser suites run `E2E_JOBS` at a time (default `min(6, max(2, floor(cpus/4)))`,
  `e2e/runner/jobs.mjs`: 6 on a 32-core host, 2 on 4–8 cores; the floor stays at 2
  because 4 made suites hit their page-load timeouts on a 12-core box); all other
  suites (tmux, `pgrep`, scratch HOME) run one at a time in a separate lane.
  The first run after a clean checkout compiles cold and is slower and more
  sensitive to the suites' page-load timeouts; lower `E2E_JOBS` if a loaded
  machine times out.
- Page-load and action ceilings live in one place, `e2e/timeouts.mjs`; a
  suite imports them instead of spelling its own number. The two page-load
  ceilings bound a single await (`page.goto`/`page.reload` or the first-text
  wait after it); all three stay bounded waits:
  - `COLD_MS` (env `E2E_COLD_MS`, default `480000`, 8 min): the warm-up load
    that compiles the route cold.
  - `NAV_MS` (env `E2E_NAV_MS`, default `180000`, 3 min): every other page
    load and first-text wait (the former 90 s and 60 s ceilings).
  - `ACTION_MS` (env `E2E_ACTION_MS`, default `30000`, 30 s): a suite's
    `page.setDefaultTimeout`, the window in which Playwright retries an
    action's actionability (a click waiting for its control to become visible,
    stable and enabled). It bounds no assertion and no wait that spells its
    own timeout; it is the load-sensitive bound
    because a busy host delays rendering, not correctness: the former 8 s of
    `polyforge-work-tab-163.mjs` timed out `locator.click` in the parallel bar
    (/#227/#235); `polyforge-panel-213.mjs` (former 10 s) takes it
    as a precaution, since it shares that suite's dock click path, the shared
    `openPolyforgeDock()` in `e2e/polyforge-dock.mjs` (#247). Other suites still spell their own default.

  Override in milliseconds, e.g.
  `E2E_COLD_MS=540000 E2E_NAV_MS=240000 E2E_ACTION_MS=45000 npm run test:e2e:all`.
  A blank or unset variable keeps the default; `0`, a negative or a non-numeric value is
  refused: the suite fails at start with an error naming the variable instead
  of running with a different ceiling. Keep `E2E_COLD_MS` below
  `E2E_SUITE_TIMEOUT_MS`, which still kills a hung suite. On a busy machine
  raise the ceilings before lowering `E2E_JOBS`; on a shared host already under
  someone else's load, lower `E2E_JOBS` first, since a longer ceiling does not
  reduce the load.
- A suite that asserts a wall-clock responsiveness bound, or whose scenarios
  are proven load-sensitive on a shared host, opts in with the
  `e2e/all: isolated` marker in its source: `session-stall-recovery.mjs` (its
  10s bound is the acceptance), `polyforge-work-tab-163.mjs`
  (8 s click timeouts in the parallel bar,/#227/#235) and
  `polyforge-panel-213.mjs` (a precaution: named by and sharing
  work-tab-163's dock click path, `openPolyforgeDock()` in
  `e2e/polyforge-dock.mjs`; its S213-12 failures were a
  context-read race, fixed in the suite, not a load bound), and
  `claude-composer-272.mjs` (S272-12's launch count) and `run.mjs` (the
  minimap jump's scroll wait), each red in both full bars and
  green on every isolated re-run. The
  runner starts those suites only after both lanes have drained, one at a
  time, so another `next dev` + Chromium cannot push the bound over while the
  suite passes alone.
- Output is buffered and printed in sorted suite order with a summary; a
  failing suite does not stop the others. `E2E_SUITE_TIMEOUT_MS` (default
  10 min) kills a hung suite and reports it as a FAIL.
- When anything failed, a `===== failures =====` section before the summary
  names every failing unit in one line:
  - `FAIL e2e/<suite>: <scenario> — <first message line>` for each scenario
    marker in the suite's output (`FAIL: <id>` with its message indented below,
    or `FAIL <id>: <message>` on one line);
  - `FAIL e2e/<suite>: no scenario marker — <line>` for a failing suite that
    printed no marker (a crash, a timeout kill or a spawn error), quoting the
    runner's own `[all.mjs]` trailer, else the suite's last output line;
  - a suite's own tally of red scenarios (`FAIL <suite>: <n> scenario(s)
    failed`, any `FAIL` line counting `<n> … scenario(s)`) is a count, not a
    scenario, and is not listed;
  - `host loadavg 1m/5m/15m: <x> / <y> / <z>` once per failing suite: the host's
    load average when that suite settled, two decimals each, the evidence a
    load-sensitive flake classification needs;
  - `re-run: npm run test:e2e:all -- <suite>` once per failing suite: the
    targeted re-run of exactly that suite, to copy as is (also on a base commit).
- Re-run only some suites: `npm run test:e2e:all -- polyforge.mjs run.mjs`.
  To reproduce failures on a base commit, re-run just the failing suites there,
  and reuse an installed `node_modules` when `package-lock.json` is unchanged
  rather than running `npm ci` per reproduction (`cp -al` the directory; a
  symlinked `node_modules` is rejected by Turbopack).
