# Changelog

All notable changes to the AI-DLC v2 Claude Code plugin are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

This plugin sets up the **v2** release of [awslabs/aidlc-workflows](https://github.com/awslabs/aidlc-workflows)
in Claude Code projects. The plugin version **mirrors the pinned upstream release** (plugin-only
fixes append `-pN`). Each release records the exact upstream release it pins in `UPSTREAM.lock` and
in the release tag (`vX.Y.Z+up.<short-sha>`).

## [2.10.0-p1] - 2026-10-07

Plugin-only release; still pins upstream v2.10.0.

### Changed
- The `/aidlc-v2:aidlc` command description no longer mentions the 2.1.4 release. Projects set up
  by plugin 2.1.4 are still migrated automatically.
- README: separate the install step, explain plugin install scopes, and move the 2.1.4 upgrade
  note to an appendix.

## [2.10.0] - 2026-10-02

Upstream made AI-DLC v2 generally available on `main`, with its own installer, `aidlc` CLI, and
project lifecycle (`aidlc config`, per-project pins, updates, uninstall). This release rebuilds the
plugin on top of those official tools instead of shipping its own copy of the framework.

### Changed
- **Pins upstream v2.10.0** (commit `2a88385`), released 2026-09-24. The plugin no longer
  bundles any upstream files.
- `/aidlc-v2:aidlc` now previews, asks, then: installs upstream's `aidlc` CLI only if it is
  missing (the official installer, checked against a SHA-256 pinned in the plugin; shell startup
  files are never edited), pins the project with `aidlc config --pin` (your machine-wide CLI is
  left alone), and configures it with `aidlc config --harness claude`. `--check` previews only;
  `--mcp none` skips upstream's optional MCP servers.
- Projects with existing Claude Code configuration that upstream refuses are reported as
  conflicts with clear next steps; the plugin never uses `aidlc config --force`, which would
  replace your `CLAUDE.md` and drop your own `permissions`.
- Windows is supported through Claude Code's Git Bash and upstream's PowerShell installer
  (covered by automated tests with stubs; not yet run on a real Windows machine).

### Migrating from 2.1.4
- Run `/aidlc-v2:aidlc` in each project 2.1.4 set up. It removes exactly the 2.1.4 framework
  files you never modified, keeps your `aidlc/` workspace (method and memory files) and any file
  you changed, undoes the `.gitignore` block 2.1.4 appended, and hands the project to upstream.
  It first rehearses the whole migration on a scratch copy: if upstream would refuse the result
  (for example, because 2.1.4 merged its hooks into your own `settings.json`), it stops before
  changing anything and names the files to move aside. Old framework files you modified are kept
  and listed. Upstream's own `aidlc config` cannot upgrade a 2.1.4 project without this step.
- Finish or park any in-progress workflow first, and commit before migrating.

### Removed
- The bundled framework (`dist/claude/framework/`) and the plugin's own installer — upstream's
  installer and `aidlc config` replace them. `bun` is no longer required by the plugin itself.

## [2.1.4] - 2026-07-02

Re-targets the plugin from the frozen `v2-evaluator` branch to upstream's release line, adopting
**upstream v2.1.4** (commit `b61e0ed`, tagged upstream 2026-06-29 — full provenance in
`UPSTREAM.lock`). Upstream restructured v2 from the ground up between our previous snapshot and
this one; this release changes what the plugin *is* accordingly.

### Changed — the plugin is now an installer
- Upstream now builds its **own Claude Code target** (`dist/claude`: a `.claude/` framework tree of
  38 skills, 13 agents, TypeScript tools/hooks run via bun, a compiled stage graph, `settings.json`,
  `.mcp.json`, and a seed `aidlc/` workspace) and its engine requires living at
  `<project>/.claude/`. The plugin therefore ships that tree **verbatim** (`framework/`,
  byte-identity enforced by the build) plus one skill and one installer:
  - `/aidlc-v2:aidlc` installs or updates the framework into the current project — additively
    merging any pre-existing `.claude/settings.json`, `.mcp.json`, and `.gitignore` (user values are
    never changed), seeding the `aidlc/` workspace only where absent, and never touching
    `.claude/settings.local.json`. On a fresh install, pre-existing files that differ from the
    framework's are surfaced as conflicts (exit 3) rather than overwritten; updates list every
    refreshed file; symlinks are never written through. Idempotent; `--check` previews.
  - After installation, every upstream command works exactly as upstream documents it, unnamespaced
    (`/aidlc`, `/aidlc-<stage>`, `/aidlc --doctor`, …).
- The old adapted surface (namespaced `/aidlc-v2:aidlc-orchestrator` + 14 transformed skills +
  builder/validator agents + the process-check hook) is gone — upstream replaced that architecture
  itself (compiled stage-graph engine, 32 stages, 9 scopes, 13 domain agents).
- **New prerequisite: bun** (upstream's tools/hooks are TypeScript). AWS Bedrock remains upstream's
  shipped model default; `uv/uvx` + AWS credentials are optional (MCP servers degrade gracefully).
- Versioning now mirrors upstream (this release: `2.1.4`).

### Maintenance tooling (repo-only, not shipped)
- The sync pipeline now vendors upstream's `dist/claude` at **release-tag commits** and the build
  contract asserts everything the installer depends on (exact tree layout, settings/hook shapes,
  MCP server set, the `.gitignore` block marker, version constant, compiled-data parseability) plus
  payload byte-identity.
- T1 triage re-keyed to the installer model (ESCALATE = installer-coupled files; `smoke.advised`
  signals engine-control-surface changes).
- New free end-to-end gate: `test/installer.test.mjs` installs the payload into a scratch project
  and requires **upstream's own `doctor` to pass (0 failures)**, plus idempotency/merge/no-write
  guarantees.
- Retired: the T2b autonomous workflow smoke and the T3 golden-master scorer (built for the old
  layout; upstream now tests its own engine — see MAINTAINERS.md).

## [2.0.0-alpha.1] - 2026-06-07

First public alpha — the initial port of AI-DLC v2 to a Claude Code plugin, built from upstream
`awslabs/aidlc-workflows@392d576` (branch `v2-evaluator`). Future entries track changes *between*
released versions (primarily: which upstream snapshot was adopted, and any change to the Claude
adapter).

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
