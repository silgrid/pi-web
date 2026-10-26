import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./worktree.ts");
}

async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

test("main and linked worktrees share one canonical project root", { timeout: 30_000 }, async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const linked = path.join(tempRoot, "linked");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/test", linked]);

  const { findCurrentWorktreePath, listWorktrees, resolveProject } = await loadSubject();
  const mainProject = await resolveProject(`${repo}${path.sep}`);
  const linkedProject = await resolveProject(linked);

  assert.equal(mainProject.isTopLevel, true);
  assert.equal(mainProject.isWorktree, false);
  assert.equal(linkedProject.isTopLevel, true);
  assert.equal(linkedProject.isWorktree, true);
  assert.equal(linkedProject.branch, "feature/test");
  assert.equal(mainProject.projectRoot, linkedProject.projectRoot);

  const worktrees = await listWorktrees(linked);
  const listedLinked = worktrees.find((worktree) => worktree.branch === "feature/test");
  assert.ok(listedLinked);
  assert.equal(findCurrentWorktreePath(worktrees, `${linked}${path.sep}`), listedLinked.path);
});

test("removed worktree cwd resolves back to the main repo", { timeout: 30_000 }, async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);

  // pi-web's addWorktree() layout: <repoRoot>-worktrees/<branch>
  const worktreePath = path.join(`${repo}-worktrees`, "feature-test");
  await git(repo, ["worktree", "add", "-b", "feature/test", worktreePath]);

  const { invalidateProjectCache, resolveProject } = await loadSubject();
  const live = await resolveProject(worktreePath);
  assert.equal(live.projectRoot, repo);
  assert.equal(live.isWorktree, true);

  // Remove the worktree directory from disk (not via git), like a crashed or
  // externally deleted checkout. Sessions in it must still group under repo.
  await rm(worktreePath, { recursive: true, force: true });
  invalidateProjectCache();

  const removed = await resolveProject(worktreePath);
  assert.equal(removed.projectRoot, repo);
  assert.equal(removed.isWorktree, true);
  assert.equal(removed.branch, "feature-test");
  assert.equal(removed.pseudoProject, undefined);
});

test("rev-parse fallback resolves a removed worktree when the derived sibling has no .git", { timeout: 30_000 }, async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  // A monorepo layout: the -worktrees container sits next to a directory that
  // is not itself a checkout top level but lives inside the outer repository.
  const outer = path.join(tempRoot, "outer");
  const inner = path.join(outer, "packages", "sub");
  await execFileAsync("git", ["init", outer]);
  await git(outer, ["config", "user.name", "Pi Web Test"]);
  await git(outer, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(outer, ["config", "commit.gpgsign", "false"]);
  await mkdir(inner, { recursive: true });
  await writeFile(path.join(inner, "README.md"), "# sub\n");
  await git(outer, ["add", "."]);
  await git(outer, ["commit", "-m", "initial"]);
  const subWorktree = path.join(`${inner}-worktrees`, "feature-x");
  await git(outer, ["worktree", "add", "-b", "feature/x", subWorktree]);

  const { invalidateProjectCache, resolveProject } = await loadSubject();
  const live = await resolveProject(subWorktree);
  assert.ok(live.isWorktree);

  await rm(subWorktree, { recursive: true, force: true });
  invalidateProjectCache();

  const removed = await resolveProject(subWorktree);
  assert.equal(removed.projectRoot, outer);
  assert.equal(removed.isWorktree, true);
  assert.equal(removed.pseudoProject, undefined);
});

test("unresolvable removed path is flagged as a pseudo-project", { timeout: 30_000 }, async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const { resolveProject } = await loadSubject();
  // No -worktrees sibling layout, no discoverable parent repo.
  const dangling = path.join(tempRoot, "plain-removed-branch");
  const info = await resolveProject(dangling);
  assert.equal(info.projectRoot, dangling);
  assert.equal(info.pseudoProject, true);
  assert.equal(info.isWorktree, false);
});

test("a removed worktree resolves back to the repo it branched from", { timeout: 30_000 }, async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-removed-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  await execFileAsync("git", ["init", repo]);

  const { inferRemovedWorktree } = await loadSubject();

  // addWorktree() places worktrees in `<repoRoot>-worktrees/<branch>`, and a finished
  // subagent run removes that directory while its session file still records it as the cwd.
  // (The fork keeps the inference async: its rev-parse fallback runs git.)
  const removed = await inferRemovedWorktree(path.join(`${repo}-worktrees`, "pi-web-agent-abc"));
  assert.equal(removed?.projectRoot, realpathSync(repo));

  // A cwd that is gone for any other reason has no repo to fall back to.
  assert.equal(await inferRemovedWorktree(path.join(tempRoot, "not-a-worktree-dir")), null);
  assert.equal(await inferRemovedWorktree(path.join(`${tempRoot}-worktrees`, "orphan")), null);
});

test("recognizes submodule and dirty-worktree removal errors as forceable", async () => {
  const { worktreeRemovalRequiresForce } = await loadSubject();

  assert.equal(worktreeRemovalRequiresForce("fatal: working trees containing submodules cannot be moved or removed"), true);
  assert.equal(worktreeRemovalRequiresForce("fatal: '/tmp/linked' contains modified or untracked files, use --force to delete it"), true);
  assert.equal(worktreeRemovalRequiresForce("fatal: worktree is dirty"), true);
  // A locked worktree needs `remove -f -f`; a single force would still fail.
  assert.equal(worktreeRemovalRequiresForce("fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first"), false);
  assert.equal(worktreeRemovalRequiresForce("fatal: unrelated git failure"), false);
});

test("forced worktree removal passes Git's force flag", { timeout: 30_000 }, async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-force-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const linked = path.join(tempRoot, "linked");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/force", linked]);
  await writeFile(path.join(linked, "untracked.txt"), "discard me\n");

  const { removeWorktree } = await loadSubject();
  await removeWorktree(repo, linked, true);
  assert.equal(existsSync(linked), false);
});

test("worktree removal accepts a path that runs through a link", { timeout: 30_000 }, async (t) => {
  // Git lists worktrees by their real path; macOS's tmpdir is a link to /private/var.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-link-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const alias = path.join(tempRoot, "alias");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/link", path.join(tempRoot, "linked")]);
  await symlink(tempRoot, alias, "dir");

  const { removeWorktree } = await loadSubject();
  await removeWorktree(repo, path.join(alias, "linked"));
  assert.equal(existsSync(path.join(tempRoot, "linked")), false);
});

test("worktrees of bare clones group under their clone, not the folder holding them (#1049)", { timeout: 30_000 }, async (t) => {
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-bare-")));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const source = path.join(tempRoot, "source");
  await execFileAsync("git", ["init", source]);
  await git(source, ["config", "user.name", "Pi Web Test"]);
  await git(source, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(source, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(source, "README.md"), "# test\n");
  await git(source, ["add", "README.md"]);
  await git(source, ["commit", "-m", "initial"]);

  // parent/repo1.git/worktree1 and parent/repo2.git/worktree1
  const parent = path.join(tempRoot, "parent");
  for (const name of ["repo1.git", "repo2.git"]) {
    await git(tempRoot, ["clone", "--bare", source, path.join(parent, name)]);
    await git(path.join(parent, name), ["worktree", "add", "-b", "worktree1", path.join(parent, name, "worktree1")]);
  }
  // The `.bare` layout: project/.git is a file pointing at project/.bare.
  const project = path.join(tempRoot, "project");
  await git(tempRoot, ["clone", "--bare", source, path.join(project, ".bare")]);
  await writeFile(path.join(project, ".git"), "gitdir: ./.bare\n");
  await git(project, ["worktree", "add", "-b", "feature", path.join(project, "feature")]);

  const { addWorktree, invalidateProjectCache, resolveProject } = await loadSubject();
  for (const name of ["repo1.git", "repo2.git"]) {
    const clone = path.join(parent, name);
    const linked = await resolveProject(path.join(clone, "worktree1"));
    assert.equal(linked.isWorktree, true);
    assert.equal(linked.projectRoot, clone);
    assert.equal((await resolveProject(clone)).projectRoot, clone);
  }
  assert.equal((await resolveProject(path.join(project, "feature"))).projectRoot, project);

  // A new worktree goes to that clone, beside it.
  const created = await addWorktree(path.join(parent, "repo1.git"), "created");
  assert.equal(created.path, path.join(parent, "repo1.git-worktrees", "created"));
  assert.equal((await resolveProject(created.path)).projectRoot, path.join(parent, "repo1.git"));

  // Its sessions stay in that project once the folder is gone.
  await rm(created.path, { recursive: true, force: true });
  invalidateProjectCache();
  assert.equal((await resolveProject(created.path)).projectRoot, path.join(parent, "repo1.git"));
});
