# Release Checklist

This repo publishes two artifacts for each release:

- npm package: `@silgrid/pi-web`
- GitHub Release: `silgrid/pi-web`

Pushing a tag `v*` to `origin` — one tag per push, see §4 — triggers [`.github/workflows/release.yml`](../.github/workflows/release.yml), which runs `npm ci`, `next build`, and `npm publish --access public --provenance` via **npm Trusted Publishing** (GitHub OIDC): the workflow presents a short-lived `id-token: write` token, npm exchanges it for a publish credential, and the published tarball carries a provenance attestation. No `NODE_AUTH_TOKEN` secret is used — the earlier token-secret route is dead under npm's 2025+ 2FA policy (the full E403/EOTP failure matrix is documented as comments at the top of the workflow file). This checklist covers the tag/notes side and the manual fallback.

## 0. Trusted Publishing prerequisites (one-time)

Before the first OIDC release, on npmjs.com the package `@silgrid/pi-web` must have a **Trusted Publisher** configured for:

- Repository: `silgrid/pi-web`
- Workflow filename: `release.yml`
- Environment: (optional, only if the publish job declares one)

The workflow itself upgrades npm to ≥ 11.5.1 (`npm install -g npm@11`) because Trusted Publishing and `--provenance` require it and the pinned node 22.19.0 bundles npm 10.9. Do not re-introduce `NODE_AUTH_TOKEN` or `registry-url` in the publish job: the token-secret route fails from CI under npm's 2FA enforcement (E403/EOTP — see the matrix in the workflow comments).

Use this checklist from a clean `main` checkout.

## 0.5 Actions-enabled check (fork gotcha, check EVERY release)

`silgrid/pi-web` is a **fork**, and GitHub disables Actions on forks
independently of the Settings → Actions toggle (the REST
`actions/permissions` flag can read `enabled: true` while runs still do
not trigger — measured 2026-10-13, tag v0.0.24: tag push produced no run,
dispatch answered HTTP 422 "Actions has been disabled for this
repository", and the previous 7 PRs' CI had silently not run since Oct 3).

Before cutting a release, verify a run can start:

```bash
gh workflow run release.yml --ref main   # or dispatch on the release tag
gh run list --workflow=release.yml --limit 1
```

If the dispatch answers HTTP 422 "Actions has been disabled", open the
repo's **Actions tab** in a browser and click the enable button on the
"Workflows aren't being run on this forked repository" banner, then
dispatch again. This banner click is **owner-only**: it needs the
owner's browser session, so an agent running this checklist stops here
and hands the click to the owner instead of attempting it. (PR CI
silently not running for recent PRs is the same
symptom — do not trust merged-PR checkmarks as release evidence when this
state is active.)

Not every silent "tag push produced no run" is this fork state. The
2026-10-23 v0.0.35 incident had dispatch **succeeding** and both REST
flags reading fine: its cause was a multi-tag `--tags` push (§4), not a
disabled fork. Distinguish the two by whether dispatch answers 422
(this fork state) or works while the tag-push trigger stays silent
(see §4).

## 1. Preflight

```bash
git status --short --branch
git log --oneline --decorate -5
gh auth status
npm whoami
node -e "const p=require('./package.json'); console.log(p.version)"
```

Expected:

- `git status` is clean, or only contains changes you intentionally plan to release.
- GitHub is authenticated as an account that can push and create releases.
- npm is authenticated (locally, for the fallback path) as an account that can publish `@silgrid/pi-web`.

## 2. Publish to npm

Preferred: push the tag (step 4) and let the `Release` GitHub Action publish. The workflow installs, builds, and publishes through npm Trusted Publishing — the `files` field ships the prebuilt `.next` output, so the published package is the built app, and the tarball carries a provenance attestation.

Manual fallback (only when CI cannot be used):

```bash
npm run release
```

The release script runs:

```bash
npm version patch --no-git-tag-version && npm run build && npm publish --access public
```

Notes:

- This bumps `package.json` and `package-lock.json`.
- It intentionally runs a production build. Do not run `next build` during normal development; release work is the exception.
- The fallback publishes with your local npm login and therefore **without provenance** (provenance is only issued inside GitHub Actions via OIDC). Prefer the tag-triggered workflow.
- If `npm view @silgrid/pi-web version` briefly shows the previous version, check the exact version instead:

```bash
npm view @silgrid/pi-web@<version> version --registry https://registry.npmjs.org/
npm view @silgrid/pi-web versions --json --registry https://registry.npmjs.org/
```

## 3. Commit the Version Bump

Replace `<version>` with the new package version, for example `0.7.5`.

```bash
git diff -- package.json package-lock.json
git add package.json package-lock.json
git commit -m "Release v<version>"
```

## 4. Tag and Push

```bash
git tag -a v<version> -m "v<version>"
git push origin main v<version>
```

Push **exactly** these two refs — `main` and the release tag — and never
`--tags`. GitHub creates no `push` events for tags when more than three
tags are pushed at once, so a multi-tag push silently starts no `Release`
run (measured 2026-10-23, v0.0.35: a `--tags` push from a clone holding
old upstream tags shipped 58 tags at once, and the workflow never fired;
the `| tail` on the masked output hid 56 of the `[new tag]` lines). A
clone can hold unrelated local tags — old upstream or archive tags — that
`--tags` would publish to the public origin. When `main` is already on
origin (release PR merged), `git push origin v<version>` alone is also
fine; that single-tag push is what v0.0.28–v0.0.34 used.

Confirm the tag push actually started the workflow — the `Release` run
should appear within ~1 minute (precedent: v0.0.30–v0.0.34 started within
a minute of their pushes):

```bash
gh run list --workflow=release.yml --limit 1   # expect event=push on the v<version> tag
```

If no `Release` run for the tag appears, fall back to a manual dispatch of
the same workflow (as used for v0.0.35); the `ref` input makes the run
build exactly the tagged commit instead of whatever `main` points to at
dispatch time, and §7 catches any gap:

```bash
gh workflow run release.yml --ref main -f ref=v<version>
```

If this dispatch itself answers HTTP 422 "Actions has been disabled",
that is the §0.5 fork state: hand the owner-only browser enable click to
the owner per §0.5, then re-dispatch. Every Actions state then has a
documented path — healthy: the tag push; trigger silently dead: this
dispatch; dispatch answering 422: §0.5's enable step, then re-dispatch.

Confirm the tag does not already exist before creating it when unsure:

```bash
git ls-remote --tags origin v<version>
gh release view v<version> --repo silgrid/pi-web
```

## 5. Generate Release Notes from Commits

Use the previous release tag as the base.

```bash
git log --oneline --decorate v<previous>..v<version>
git log --format='%h%x09%s%n%b' v<previous>..v<version>
git diff --stat v<previous>..v<version>
```

Write the release notes from those commits, not from memory. Include both Chinese and English sections. Keep commit hashes next to each item when useful.

Suggested structure:

```markdown
## 中文

基于 `v<previous>..v<version>` 的提交整理。

### 新增

- ...

### 修复

- ...

### 改进

- ...

### 内部调整

- 发布 npm 包 `@silgrid/pi-web@<version>`（tag 推送后由 GitHub Actions `Release` 工作流完成）。

## English

Prepared from commits in `v<previous>..v<version>`.

### Added

- ...

### Fixed

- ...

### Improved

- ...

### Internal

- Published npm package `@silgrid/pi-web@<version>` (done by the `Release` GitHub Action on tag push).
```

## 6. Create or Update the GitHub Release

Create a new release:

```bash
gh release create v<version> \
  --repo silgrid/pi-web \
  --verify-tag \
  --title "v<version>" \
  --notes-file release-notes.md
```

If the release already exists and only the notes need updating:

```bash
gh release edit v<version> \
  --repo silgrid/pi-web \
  --notes-file release-notes.md
```

You can avoid a temporary file by passing notes through stdin:

```bash
gh release edit v<version> --repo silgrid/pi-web --notes-file - <<'EOF'
## 中文

...

## English

...
EOF
```

## 7. Final Verification

```bash
gh release view v<version> --repo silgrid/pi-web
npm view @silgrid/pi-web@<version> version --registry https://registry.npmjs.org/
git status --short --branch
git log --oneline --decorate -3
```

Expected:

- GitHub Release exists and is not a draft unless intentionally published as one.
- npm exact version resolves.
- `main` is aligned with `origin/main`.
- `HEAD` points at the release commit and `v<version>` tag.
