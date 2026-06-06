---
name: release-upstream
description: Drive an AI-DLC v2 plugin release — sync from upstream, review the diff, bump the version, build, run the verification gates, commit and tag locally, and write a summary report. Stops before pushing/publishing.
argument-hint: "[<upstream-sha>]  (omit for the v2-evaluator branch tip)"
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
  substitute your judgment for the human's on: adopting a snapshot, handling a novel upstream
  concept, or the version bump.
- **Run commands with the Bash tool and show their output.** If a step fails, stop and report — do
  not paper over it.

## Preconditions

1. Confirm you are at the repo root (contains `.claude-plugin/marketplace.json`, `targets/claude/`,
   `UPSTREAM.lock`). If not, stop.
2. Confirm the working tree is clean (`git status --porcelain`). If dirty, stop and tell the human to
   commit/stash first — a release must start from a clean tree.
3. Detect prerequisites (record which are present for the report; **skip dependent steps if absent**,
   do not fail):
   - **Upstream clone** — `sync-upstream.sh` needs it (default `../aidlc-workflows`). Check it exists
     and is a git repo. If absent, you cannot sync; ask the human for the path or stop.
   - **`claude` CLI** (authenticated to a model provider) — needed for T2 smoke and T3 score. If absent, note it and
     skip T2/T3 (the report must say they were skipped).

## Steps

### 1. Sync the upstream snapshot (T0 + T1)
Run the sync script with the requested SHA (or bare for the branch tip):

```
./targets/claude/sync-upstream.sh <upstream-sha>
```

This runs **T1 triage** (classifies the upstream diff), swaps `src/`, **rebuilds `dist/`**, runs the
**T0 build contract**, and rewrites `UPSTREAM.lock` — but only on a clean build, and it does NOT
commit. Capture its full output.

- If it reports **"Already at <sha> — nothing to sync"**, stop: there is nothing to release.
- If the build/contract check **fails**, stop and report the failure verbatim (it names what upstream
  changed and which part of `build.mjs` to update). Do not proceed.
- The script pauses interactively on T1 escalations. Since you drive it non-interactively, run it with
  `SKIP_TRIAGE=1` set **only after** you have run triage yourself and presented the result (next
  step) — or run triage first, then sync with `SKIP_TRIAGE=1`. Prefer: run `sync-triage.mjs` first
  (read-only), present escalations, get the human's decision, THEN sync.

### 2. Review the triage escalations (the human-judgment gate)
Run the triage standalone (read-only) against the target SHA to get the structured classification:

```
node targets/claude/sync-triage.mjs <upstream-sha> --json
```

Summarize the **ESCALATE** items in plain language. For each genuinely-novel item (a new interaction
flag, a new skill/agent, a reworded protocol step the adapter may not handle), use `AskUserQuestion`
to ask the human how to proceed: *adopt as-is / needs an adapter change first / defer (don't release
this snapshot)*. If the human says an adapter change is needed, STOP — that is hand work on
`build.mjs`/`targets/`, outside this skill's scope; report what's needed.

**Read the `t2b` field of the triage JSON** — it deterministically says whether the expensive
behavioral smoke (T2b) is warranted. `t2b.advised` is `true` only when the change touches the
runtime "behavioral surface" (agent defs, the orchestrator/builder/validator protocols, the
process-checker, the state-machine/workflow conventions, the orchestrator/workflow-composition
skills, or an interaction-flag *value* flip) — the only things T2b can verify that the free gates
can't. Remember this verdict for step 5; do NOT run T2b on a content-only snapshot.

### 3. Bump the version (the release-counter gate)
The version lives in `package.json` AND `.claude-plugin/marketplace.json` (the build asserts they
match). Read the current version, then use `AskUserQuestion` to confirm the next one (default: bump
the `alpha.N` counter — `2.0.0-alpha.N` → `2.0.0-alpha.N+1`). Edit **both** files to the chosen
version. Build metadata (`+up.<sha>`) is NOT part of the version — it's added by the tag, so do not
put it in these files.

### 4. Update the changelog
Add/refresh the top entry in `CHANGELOG.md` for the new version: focus on **what upstream snapshot
was adopted** (old → new SHA, dates) and any notable upstream changes from the triage, plus any
Claude-adapter change. Keep it reader-facing (what changed in the release), not a build diary.

### 5. Rebuild + run the gates
- Rebuild so `dist/` reflects the new version: `node targets/claude/build.mjs build`
- Run the meta-test suite (incl. the `dist/`-freshness guard): `npm test`. These are free + always run.
- **T2 is OFF by default** (it makes billable LLM/API calls and found no plugin defects in practice).
  Decide whether to run it from the **`t2b.advised` signal** captured in step 2, and ask the human:
  - If `t2b.advised` is **true** (behavioral surface changed) AND the `claude` CLI is present: use
    `AskUserQuestion` to offer running the autonomous workflow smoke — *run T2b now (≈minutes, real $) /
    skip (I'll run it before publishing) / skip entirely*. If yes, run
    `AIDLC_SMOKE_TRUST=1 node targets/claude/smoke.mjs --workflow` (in a disposable env) and fold the
    result into the report.
    - As the cheap middle option you may also offer just the **T2a load smoke**
      (`node targets/claude/smoke.mjs`, ~1 turn) to at least confirm the rebuilt plugin still loads.
  - If `t2b.advised` is **false** (content-only snapshot): do NOT prompt to run T2b. But since this is
    a **release** (not a routine sync), still offer the cheap **T2a load smoke**
    (`node targets/claude/smoke.mjs`, ~1 turn, ~$0.20) as the real-CLI "does the rebuilt plugin still
    load?" check — recommended for every release candidate. Note the outcome (or that it was declined).
  - If the `claude` CLI is absent: skip both, note it.
- Never auto-run T3 score (release-candidate only; needs a golden master); mention it in the report.
- Any failure in a gate you DID run → stop and report.

### 6. Commit + tag locally (NO push)
- `git add -A && git commit` with a message summarizing the snapshot adoption + version bump.
- Mint the annotated release tag **without** pushing: `./targets/claude/tag-release.sh`
  (no `--push`). It encodes `vX.Y.Z+up.<short-sha>` with the full SHA in the tag message.

### 7. Summary report
Write a concise report (to chat, and offer to save it as `RELEASE-NOTES-<version>.md`) covering:
- Upstream: old SHA → new SHA (+ dates), branch.
- Triage outcome: counts of auto / contract / escalate; each escalation and the human's decision.
- Version: old → new; changelog entry summary.
- Gates: T0 build ✓/✗, `npm test` result, T2 smoke result (or "skipped — no claude CLI"), and that
  T2b-workflow / T3-score were not auto-run.
- Local state: the commit SHA and tag created (not pushed).
- **Next steps to publish** (the human runs these): `git push --follow-tags`, then
  `./targets/claude/tag-release.sh --push` is unnecessary if already tagged — instead
  `git push origin <tag>`; and (first time) create the GitHub repo / marketplace. Remind them to
  protect the tag on the remote.

## On failure at any step
Stop immediately, report the failing command's output, and state the repo's current state (e.g.
"`src/`/`dist/` swapped but `UPSTREAM.lock` unchanged and not committed — `git checkout -- src dist`
to abort"). Never leave the human guessing.
