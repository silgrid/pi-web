// Page-load ceilings shared by the browser e2e suites.
//
// A suite imports these instead of spelling its own number, so the bound for
// a `page.goto`/`page.reload` and the first-text wait that follows it is one
// fact in one place. Both stay bounded waits; only the ceiling is chosen here.
//
//   COLD_MS  the warm-up load that compiles the route cold (default 480 s)
//   NAV_MS   every later load and first-text wait        (default 180 s)
//
// Override with E2E_COLD_MS / E2E_NAV_MS (milliseconds). A blank or unset
// variable keeps the default; any other value that is not a positive number
// is refused at load time rather than silently replaced (e2e/README.md).
const DEFAULTS = { E2E_COLD_MS: 480_000, E2E_NAV_MS: 180_000 };

export function msFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number of milliseconds, got ${JSON.stringify(raw)}`);
  }
  return Math.floor(value);
}

export const COLD_MS = msFromEnv("E2E_COLD_MS", DEFAULTS.E2E_COLD_MS);
export const NAV_MS = msFromEnv("E2E_NAV_MS", DEFAULTS.E2E_NAV_MS);
