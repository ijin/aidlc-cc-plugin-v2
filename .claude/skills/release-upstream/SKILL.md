---
name: release-upstream
description: Drive an aidlc-v2 plugin release that adopts a newer upstream AI-DLC release — pick the tag, verify and pin it, set the mirrored version, run the gates, commit and tag locally, and report. Stops before pushing/publishing.
argument-hint: "[<upstream-tag>]  (e.g. v2.11.0; omit to discover the newest stable release)"
disable-model-invocation: true
---

# Release the plugin against a newer upstream release

You are a **maintainer assistant** for this repo (`aidlc-cc-plugin-v2`). Take a new upstream
release through the pipeline and **stop before anything outward-facing** (push / GitHub release).
You **orchestrate the existing scripts** — never reimplement their logic, and never hand-edit
`UPSTREAM.lock` or `dist/`.

This skill is repo-only tooling; it is not part of the shipped plugin.

## Hard rules

- **Never push, never `gh release`.** Prepare a local commit + tag and STOP; the final report gives
  the exact publish commands.
- **Never bypass verification.** Do not set `SKIP_ATTESTATION=1` unless the human explicitly
  asks; if they do, say in the report that the release must not be published as verified.
- **Ask** (`AskUserQuestion`) at the decision gates below: which release to adopt, and whether a
  behavior change upstream needs helper work first.
- **Run commands with the Bash tool and show their output.** On any failure, stop and report.

## Preconditions

1. At the repo root (`UPSTREAM.lock`, `targets/claude/`, `.claude-plugin/marketplace.json`).
2. Clean working tree (`git status --porcelain` empty), else stop.
3. Tools: `gh` (authenticated; needed for provenance verification), network access to github.com.
   Note whether the `claude` CLI is available (for the optional load smoke).

## Steps

### 1. Pick the release
If no tag was given, list stable releases newer than the pinned one:

```
grep '^UPSTREAM_TAG=' UPSTREAM.lock
gh release list --repo awslabs/aidlc-workflows --exclude-pre-releases --limit 10
```

Present the candidates with each release's notes (`gh release view <tag> --repo
awslabs/aidlc-workflows`) and ask which to adopt. Previews (`-preview.` tags) only if the human
explicitly wants one (then pass `--allow-preview` in step 3).

### 2. Read what changed upstream
Read upstream's `CHANGELOG.md` for the range between the pinned tag and the target (fetch it at
the target tag). Flag anything that could break the helper: `aidlc config` flags or exit codes,
install locations, the installer's options, hook command shape, the project stamp file
(`.claude/tools/data/aidlc-stamp.json`), `--pin` semantics. If something does, ask whether helper
work is needed first; if yes, STOP and report what needs changing.

### 3. Sync

```
./targets/claude/sync-upstream.sh <tag>
```

It verifies the installers against `checksums.txt`, the release metadata against the tag and its
commit, and the installers' signed provenance; then rewrites `UPSTREAM.lock` and rebuilds. It does
not commit. "Nothing to sync" → stop: there is nothing to release. Any verification failure → stop
and report it verbatim; never retry around it.

### 4. Check the mirrored version
Sync already set `package.json` and `.claude-plugin/marketplace.json` to the adopted upstream
version. Confirm both equal `UPSTREAM_VERSION` in the lock (`git diff package.json
.claude-plugin/marketplace.json`). For a plugin-only re-release on the same upstream version, set
both to `<version>-pN` instead and rebuild (`node targets/claude/build.mjs build`).

### 5. Changelog
Add a `CHANGELOG.md` entry: which upstream release is now pinned (tag, commit, date), the upstream
changes users will notice, and any plugin-side change. Reader-facing.

### 6. Gates
- `npm test` — free, deterministic. Must pass.
- `npm run gate` — the real release in a sandbox (fresh + legacy projects → upstream `doctor`).
  Must pass; this is what catches upstream behavior changes.
- Offer `npm run smoke` (one billable call) if the `claude` CLI is available.
Any failure → stop and report.

### 7. Commit + tag (no push)
- Check `git status` shows only release changes, then `git add -A && git commit` with an outside-reader message: which upstream release the plugin now
  pins and what users get.
- `./targets/claude/tag-release.sh` (no `--push`).

### 8. Report
Upstream tag adopted (old → new, commit, date); notable upstream changes and any helper risk you
flagged; version; gate results (and anything skipped, e.g. no `claude` CLI); the local commit and
tag. **Publish commands for the human:** `git push`, then `git push origin <tag>`; remind them to
protect the tag on the remote.

## On failure
Stop, show the failing command's output, and state the repo's state (e.g. "`UPSTREAM.lock` and
`dist/` rewritten but not committed — `git checkout -- UPSTREAM.lock dist` to abort").
