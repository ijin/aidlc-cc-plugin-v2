# Changelog

All notable changes to the AI-DLC v2 Claude Code plugin are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

This plugin packages the **v2** rewrite of [awslabs/aidlc-workflows](https://github.com/awslabs/aidlc-workflows)
as a Claude Code plugin. v2 lives only on an upstream development *branch* (`v2-evaluator`) with no
upstream tags, so releases here are independent `2.0.0-alpha.N` builds. Each release records the exact
upstream commit it was built from in `UPSTREAM.lock` and in the release tag (`vX.Y.Z+up.<short-sha>`).

## [Unreleased]

Initial (unreleased) port of AI-DLC v2 to a Claude Code plugin. Not yet published. Once the first
public release is cut, the entries below become its `## [2.0.0-alpha.1]` section, and this file
switches to tracking changes *between* released versions (primarily: which upstream snapshot was
adopted, and any change to the Claude adapter).

### Plugin (what installs as `aidlc-v2`)
- An orchestrator-driven AI-DLC v2 workflow: the `aidlc-orchestrator` skill composes and runs an
  adaptive workflow from a catalogue of 14 skills (requirements analysis, user stories, application
  design, units generation, functional/NFR/infrastructure design, code generation, reverse
  engineering, wireframes, workflow composition, intent bootstrap), coordinating builder and
  validator subagents.
- Installs alongside the stable v1 plugin (`ijin/aidlc-cc-plugin`) under a separate namespace —
  skills surface as `/aidlc-v2:<name>`.
- A `SubagentStop` hook (the Claude analog of upstream's Kiro process-check hook) reminds the
  orchestrator to run the deterministic `process_checker` after each builder/validator subagent.
- Built from upstream `src/` by `targets/claude/build.mjs`, which adapts Kiro conventions to Claude
  Code: anchors install-root-relative paths to `${CLAUDE_PLUGIN_ROOT}`, converts agent JSON to Claude
  subagent markdown, and rewrites Kiro execution primitives (`invokeSubAgent` → the Agent tool). Only
  the built `dist/claude/` ships; `src/`, tooling, and tests are not part of the installed plugin.

### Maintenance tooling (repo-only, not shipped)
- `UPSTREAM.lock` pins the exact upstream repo/branch/commit + `src` tree hash the vendored `src/`
  came from.
- `targets/claude/sync-upstream.sh` refreshes `src/` from an explicit upstream commit, rebuilds, and
  rewrites the lock only on a clean build — never auto-committing (a human reviews every snapshot).
- `targets/claude/sync-triage.mjs` (T1) classifies an upstream diff (auto / contract-gated / escalate)
  so only genuinely-novel changes need human review. It also emits a deterministic **`t2b.advised`**
  signal — true only when the change touches the runtime behavioral surface (agent defs, control-flow
  protocols, process-checker, state-machine/workflow conventions, orchestrator/workflow-composition
  skills, or an interaction-flag value flip) — so the expensive behavioral smoke is run only when a
  change could plausibly break workflow wiring.
- `targets/claude/smoke.mjs` (T2) headlessly runs the built plugin to confirm it loads and (opt-in)
  drives an autonomous workflow end-to-end. **OFF by default** (billable Bedrock calls; no plugin
  defects found in practice) — sync runs it only with `RUN_SMOKE=1`; the release skill prompts to run
  the workflow smoke only when `t2b.advised` fires.
- `targets/claude/score.mjs` (T3) deterministically scores a run's artifacts against a golden master
  (a dependency-free port of upstream's heuristic scorer; release-only).
- `targets/claude/tag-release.sh` mints an annotated `vX.Y.Z+up.<short-sha>` release tag.
- The build enforces an upstream-shape contract (fails loudly on drift); `npm test` runs the
  contract/triage/scorer meta-tests plus a `dist/`-freshness guard (committed `dist/` must equal a
  fresh build), enforced locally via `.githooks/pre-commit` and in CI (`.github/workflows/ci.yml`).

### Known gaps
- No golden master committed yet (T3 can score but can't gate a release until a full, reviewed run
  is captured — see `test/golden/README.md`).
- Not yet tested against a real development intent inside an interactive Claude Code session (the
  autonomous smoke covers the non-interactive path; the chat-approval path is not yet covered).
