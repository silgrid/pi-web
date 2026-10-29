import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import {
  PolyforgeMemoryError,
  readPolyforgeMemoryCapability,
  readPolyforgeMemoryProjects,
  searchPolyforgeMemory,
  validateMemorySearch,
} from "@/lib/polyforge-memory";

export const dynamic = "force-dynamic";

/**
 * GET /api/polyforge/memory?cwd=… — the Memory tab's scope-vs-search split
 * (D2): without `q` it is the SCOPE read (capability plus the
 * cwd's workspace projects, no memory verb); with `q` (and `project`, `type`,
 * optional `tags`, optional `any=1`) it is the SEARCH: exactly one
 * `pf recall`. Degradation-first: pf absent, below the 2.20.9 floor, an
 * unmapped cwd, an off-list project's config read and a failed spawn all
 * answer 200 with fields, never 5xx; the only non-2xx answers are the gate's
 * 403 and the shape-validation 400s, which run before any pf process.
 */
function failureText(error: unknown): string {
  return error instanceof PolyforgeMemoryError ? error.message : "polyforge is unavailable";
}

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd");
  const q = url.searchParams.get("q");

  // The scope read: the dropdown's own source. It spawns no memory verb, so
  // opening the tab reads nothing (Requirement 2).
  if (q === null) {
    if (!cwd) {
      return NextResponse.json({ error: "cwd must be a directory path" }, { status: 400 });
    }
    const capability = await readPolyforgeMemoryCapability();
    if (!capability.capable) {
      return NextResponse.json({ ...capability, mapped: false, projects: [], hits: [] });
    }
    try {
      const scope = await readPolyforgeMemoryProjects(cwd);
      return NextResponse.json({ ...capability, ...scope, hits: [] });
    } catch (error) {
      return NextResponse.json({ ...capability, mapped: false, projects: [], hits: [], error: failureText(error) });
    }
  }

  // The search face. Shape validation first (D4): a refusal answers 400 with
  // no pf process, the version probe included.
  const validated = validateMemorySearch({
    cwd,
    q,
    project: url.searchParams.get("project"),
    type: url.searchParams.get("type"),
    tags: url.searchParams.get("tags") ?? undefined,
    any: url.searchParams.get("any") ?? undefined,
  });
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const capability = await readPolyforgeMemoryCapability();
  if (!capability.capable) {
    return NextResponse.json({ ...capability, mapped: false, projects: [], hits: [] });
  }
  let scope: { mapped: boolean; projects: string[] };
  try {
    scope = await readPolyforgeMemoryProjects(validated.value.cwd);
  } catch (error) {
    return NextResponse.json({ ...capability, mapped: false, projects: [], hits: [], error: failureText(error) });
  }
  if (!scope.mapped) {
    // An unmapped cwd runs no search (Requirement 13).
    return NextResponse.json({ ...capability, mapped: false, projects: [], hits: [] });
  }
  // Membership ("one of the projects the panel offered", D4): the same config
  // read the dropdown came from. An off-list project answers 400 with no
  // recall spawn — the config read itself is the price of "offered".
  if (!scope.projects.includes(validated.value.project)) {
    return NextResponse.json({ error: "project must be one of the workspace's projects" }, { status: 400 });
  }
  try {
    const hits = await searchPolyforgeMemory(validated.value);
    return NextResponse.json({ ...capability, mapped: true, projects: scope.projects, hits });
  } catch (error) {
    return NextResponse.json({ ...capability, mapped: true, projects: scope.projects, hits: [], error: failureText(error) });
  }
}
