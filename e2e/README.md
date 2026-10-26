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
No model credentials or existing Pi sessions are needed.

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
  (`next.config.ts` `distDir`), so suites do not fight over `.next/dev/lock`
  and each keeps a warm Turbopack cache for the next run. The per-suite caches
  take about 4.8 GB per checkout; remove them with `rm -rf .next/e2e` when they
  are no longer useful. Without the variable every suite uses `.next` as
  before. With it, `next.config.ts` points Next at `tsconfig.e2e.json` (it
  extends the repo config), so `next dev` never rewrites the checkout's
  `tsconfig.json`.
- Browser suites run `E2E_JOBS` at a time (default `min(2, cpus/2)`; 4 made suites hit their page-load timeouts on a 12-core box); all other
  suites (tmux, `pgrep`, scratch HOME) run one at a time in a separate lane.
  The first run after a clean checkout compiles cold and is slower and more
  sensitive to the suites' page-load timeouts; lower `E2E_JOBS` if a loaded
  machine times out.
- Output is buffered and printed in sorted suite order with a summary; a
  failing suite does not stop the others. `E2E_SUITE_TIMEOUT_MS` (default
  10 min) kills a hung suite and reports it as a FAIL.
- Re-run only some suites: `npm run test:e2e:all -- polyforge.mjs run.mjs`.
  To reproduce failures on a base commit, re-run just the failing suites there,
  and reuse an installed `node_modules` when `package-lock.json` is unchanged
  rather than running `npm ci` per reproduction (`cp -al` the directory; a
  symlinked `node_modules` is rejected by Turbopack).
