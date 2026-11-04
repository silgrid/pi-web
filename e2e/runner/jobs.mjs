// Browser-pool width for e2e/all.mjs. Lives under e2e/runner/,
// outside the e2e/*.mjs suite glob, so neither the runner nor the release
// verify-scope engine counts it as a suite.
//
// Default: min(6, max(2, floor(cpus / 4))) — a 32-core host runs 6 browser
// suites at a time, 4–8 cores keep 2 (E2E_JOBS=4 on a 12-core box once pushed
// suites over their page-load timeouts,). An explicit E2E_JOBS
// wins; blank, 0 or non-numeric falls through to the default.

export function defaultJobs(cpuCount) {
  return Math.min(6, Math.max(2, Math.floor(cpuCount / 4)));
}

export function resolveJobs(envValue, cpuCount) {
  return Math.max(1, Number(envValue) || defaultJobs(cpuCount));
}
