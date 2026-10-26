import { stat } from "fs/promises";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getProjectTrustStatus, trustProject } from "@/lib/project-trust";
import { destroyRpcSessionsForCwd, hasBusyRpcSessionForCwd } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

async function resolveCwd(value: unknown): Promise<
  { cwd: string } | { response: NextResponse }
> {
  if (typeof value !== "string" || !value.trim()) {
    return { response: NextResponse.json({ error: "cwd required" }, { status: 400 }) };
  }

  const cwd = resolve(value);
  try {
    if (!(await stat(cwd)).isDirectory()) {
      return { response: NextResponse.json({ error: "cwd must be a directory" }, { status: 400 }) };
    }
  } catch {
    return { response: NextResponse.json({ error: "Directory does not exist" }, { status: 400 }) };
  }
  return { cwd };
}

/**
 * The trust ACTION is a registration step: it must stay inside the allowed
 * roots, the same policy that governs every other write the operator makes
 * about a project (cwd/validate, files, worktrees). A directory reaches the
 * allowed roots exactly by being selected through those flows.
 */
async function validateCwdForTrust(value: unknown): Promise<
  { cwd: string } | { response: NextResponse }
> {
  const result = await resolveCwd(value);
  if ("response" in result) return result;

  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(result.cwd, allowedRoots)) {
    return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }
  return { cwd: result.cwd };
}

export async function GET(req: Request) {
  // The GET is a status query, not an action: AppShell asks it for the cwd a
  // new session will compose in — including one the operator has not yet
  // selected through cwd/validate (the entry flow's default directory).
  // Answering 403 there made the browser log an error on every fresh entry
  // before any session registered the directory. The status itself carries
  // no capability: it only reports whether the directory holds trust-requiring
  // resources and whether a trust decision is recorded — it executes nothing
  // and writes nothing. The POST below still refuses unregistered paths.
  const result = await resolveCwd(new URL(req.url).searchParams.get("cwd"));
  if ("response" in result) return result.response;
  return NextResponse.json(getProjectTrustStatus(result.cwd, getAgentDir()));
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    const result = await validateCwdForTrust(body.cwd);
    if ("response" in result) return result.response;

    const agentDir = getAgentDir();
    const current = getProjectTrustStatus(result.cwd, agentDir);
    if (!current.requiresTrust) {
      return NextResponse.json({ error: "This project has no resources that require trust" }, { status: 409 });
    }
    if (hasBusyRpcSessionForCwd(result.cwd)) {
      return NextResponse.json({ error: "Wait for the active session to finish before trusting this project" }, { status: 409 });
    }

    const status = trustProject(result.cwd, agentDir);
    invalidateModelsCache();
    await destroyRpcSessionsForCwd(result.cwd);
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
