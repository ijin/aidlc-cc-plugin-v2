---
name: release-upstream
description: Drive an AI-DLC v2 plugin release — sync an upstream release-tag snapshot, review the diff, set the mirrored version, build, run the verification gates, commit and tag locally, and write a summary report. Stops before pushing/publishing.
argument-hint: "[<upstream-sha>]  (peeled v2.x tag commit; omit to discover the newest tag)"
disable-model-invocation: true
---

# Release the AI-DLC v2 plugin from an upstream snapshot

You are a **maintainer assistant** for this repo (`aidlc-cc-plugin-v2`). Your job is to take a new
upstream snapshot through the full release pipeline **and stop before anything outward-facing**
(push / GitHub release). You **orchestrate existing scripts** — you do NOT reimplement their logic
or hand-edit `src/`, `dist/`, or the build. All the tested, reviewed logic lives in
`targets/claude/*`; you sequence it, ask the human at the decision gates, and write a report.

This skill is repo-only maintenance tooling. It is NOT part of the shipped `aidlc-v2` plugin and must
never be copied into `dist/claude/`.

## Hard rules

- **Never push, never `gh release`, never create the remote repo.** Prepare a local commit + tag and
  STOP. The final report tells the human the exact commands to publish.
- **Never edit `src/` or `dist/` by hand.** If a change is needed there, it goes through the build.
- **Stop and ask** (use the `AskUserQuestion` tool) at every genuine decision gate below. Do not
  substitute your judgment for the human's on: adopting a snapshot or handling a novel upstream
  concept.
- **Run commands with the Bash tool and show their output.** If a step fails, stop and report — do
  not paper over it.

## Preconditions

1. Confirm you are at the repo root (contains `.claude-plugin/marketplace.json`, `targets/claude/`,
   `UPSTREAM.lock`). If not, stop.
2. Confirm the working tree is clean (`git status --porcelain`). If dirty, stop and tell the human to
   commit/stash first — a release must start from a clean tree.
3. Detect prerequisites (record which are present for the report; **skip dependent steps if absent**,
   do not fail):
   - **Upstream clone** — `sync-triage.mjs` needs one (default `../aidlc-workflows`; the sync script
     itself clones fresh). If absent, ask the human for the path or fetch one.
   - **`bun`** — needed for the installer end-to-end test inside `npm test` (it SKIPs without bun;
     note that in the report if so).
   - **`claude` CLI** (authenticated) — needed for the optional T2a load smoke and the build's
     `claude plugin validate` gate. If absent, note it.

## Steps

### 0. Pick the snapshot (release tags, not branch tips)
Upstream releases v2 via tags on its `v2` branch. If no SHA was given, discover the newest:

```
git ls-remote https://github.com/awslabs/aidlc-workflows.git 'refs/tags/v2.*'
```

Use the **peeled** commit (`vX.Y.Z^{}`). Present the candidate tag + its CHANGELOG entry (fetch
`CHANGELOG.md` at that tag) and confirm adoption with `AskUserQuestion`. Do not pin the bare `v2`
branch tip unless the human explicitly asks (it is unreleased and force-pushable).

### 1. Review the triage first (the human-judgment gate)
Run the triage standalone (read-only) against the target SHA:

```
node targets/claude/sync-triage.mjs <upstream-sha> --repo <clone> --json
```

Summarize the **ESCALATE** items in plain language — under the installer model these are the
installer-coupled files (`settings.json`, `.mcp.json`, `.gitignore`, `CLAUDE.md`,
`settings.local.json.example`, `aidlc-version.ts`): for each, check whether the installer's merge
rules and the README's claims still hold, and use `AskUserQuestion` to decide: *adopt as-is / needs
an installer-or-docs change first / defer*. If installer/docs work is needed, STOP — that is hand
work outside this skill's scope; report what's needed.

**Read the `smoke` field of the triage JSON** — `smoke.advised` is `true` when the engine control
surface (hooks/, tools/, protocols/, settings.json) changed. Remember it for step 5. CONTRACT items
need no decision (the build gates them); AUTO items are verbatim payload (point the human at
upstream's CHANGELOG for meaning).

### 2. Sync the snapshot (T0 gate)

```
SKIP_TRIAGE=1 ./targets/claude/sync-upstream.sh <upstream-sha>
```

(`SKIP_TRIAGE=1` because you already ran and reviewed triage in step 1.) This swaps `src/`,
**rebuilds `dist/`**, runs the **T0 build contract**, and rewrites `UPSTREAM.lock` — only on a
clean build; it does NOT commit. Capture the full output, including any **NOTE about
gitignore-matched files** (needed for the commit step).

- **"Already at <sha> — nothing to sync"** → stop: nothing to release.
- Build/contract **failure** → stop and report verbatim (the message names the fix; see the
  MAINTAINERS.md table). Repo state: `src/`/`dist/` swapped, lock unchanged —
  `git checkout -- src dist` to abort.

### 3. Set the mirrored version
The plugin version **mirrors the adopted framework version** (the build hard-fails otherwise).
Read it from the build report ("framework version") or `src/.claude/tools/aidlc-version.ts`, and set
**both** `package.json` and `.claude-plugin/marketplace.json` to exactly that version (or, for a
plugin-only re-release on the same payload, `<fw>-pN` — confirm with the human). Build metadata
(`+up.<sha>`) is NOT part of the version — the tag adds it.

### 4. Update the changelog
Add the top entry in `CHANGELOG.md` for the new version: **which upstream release was adopted**
(tag, old → new SHA, dates), notable upstream changes (from ITS changelog for the tag range), and
any installer/plugin-side change. Reader-facing, not a build diary.

### 5. Rebuild + run the gates
- Rebuild so `dist/` reflects the new version: `node targets/claude/build.mjs build`
- Run the free deterministic suite: `npm test` (contract drift-injection, T1 meta-tests, the
  **installer→upstream-doctor end-to-end**, dist-freshness). Always run; any failure → stop.
- **T2a load smoke** (one billable LLM call): if `smoke.advised` was true in step 1, recommend it;
  for any release candidate, offer it (`node targets/claude/smoke.mjs`). Ask with
  `AskUserQuestion`: *run now / skip*. If the `claude` CLI is absent, note the skip.
- Any failure in a gate you DID run → stop and report.

### 6. Commit + tag locally (NO push)
- Stage with **`git add --force -A src && git add -A`** (the vendored `src/.gitignore` matches
  files upstream force-added — a plain add silently drops them), then `git commit` with a
  **snapshot-focused, outside-reader** message (which upstream release was adopted and what it
  brings; no internal process framing).
- Mint the annotated release tag **without** pushing: `./targets/claude/tag-release.sh`
  (no `--push`). It encodes `vX.Y.Z+up.<short-sha>` with the full SHA + tree hash in the tag
  message, and verifies the committed `src/` tree matches the lock.

### 7. Summary report
Write a concise report (to chat, and offer to save it as `RELEASE-NOTES-<version>.md`) covering:
- Upstream: tag adopted, old SHA → new SHA (+ dates).
- Triage outcome: counts of auto / contract / escalate; each escalation and the human's decision;
  whether `smoke.advised` fired.
- Version: old → new (mirroring policy); changelog entry summary.
- Gates: T0 build ✓/✗, `npm test` result (note if the installer test SKIPped for missing bun),
  T2a smoke result (or why skipped).
- Local state: the commit SHA and tag created (not pushed).
- **Next steps to publish** (the human runs these): `git push`, `git push origin <tag>`; remind
  them to protect the tag on the remote.

## On failure at any step
Stop immediately, report the failing command's output, and state the repo's current state (e.g.
"`src/`/`dist/` swapped but `UPSTREAM.lock` unchanged and not committed — `git checkout -- src dist`
to abort"). Never leave the human guessing.
