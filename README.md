# AI-DLC Claude Code Plugin — v2

A [Claude Code](https://claude.com/claude-code) **installer plugin** for the **v2** rewrite of the
[AWS AI-DLC Workflows](https://github.com/awslabs/aidlc-workflows) methodology — a structured,
adaptive, agent-orchestrated software development lifecycle.

> **What this plugin is.** Upstream v2 builds its own Claude Code target (`dist/claude`: a
> `.claude/` framework tree + `.mcp.json` + a committed `aidlc/` workspace) and releases it via
> `v2.x` git tags — but offers no marketplace presence, no install command, and no update story
> beyond "copy the tree into your repo". This plugin is the **distribution, verification, and
> upgrade layer**: it ships upstream's tree **verbatim** at a pinned, reviewed release, and its one
> skill installs/updates it into your project safely (merging your existing `settings.json`,
> `.mcp.json`, `.gitignore`; pre-existing files that differ are surfaced as conflicts, never
> silently replaced; symlinks are never written through). If upstream ever ships its own plugin,
> this repo's job is done.

## Install & use

```
/plugin marketplace add ijin/aidlc-cc-plugin-v2
/plugin install aidlc-v2@aidlc-cc-plugin-v2
```

Then, **in the project where you want AI-DLC**:

```
/aidlc-v2:aidlc            # installs (or updates) the framework into the project
```

Restart the Claude Code session (the installed `.claude/settings.json` — hooks, permissions,
model defaults — loads at session start), then use AI-DLC exactly as upstream documents it:

```
/aidlc Build a URL shortener service    # scope auto-detected
/aidlc --doctor                         # validate the install
```

After installation every upstream command (`/aidlc`, `/aidlc-<stage>`, `/aidlc-feature`, …) works
as documented, **unnamespaced** — they are project skills, not plugin skills. Re-run
`/aidlc-v2:aidlc` after upgrading the plugin to refresh the framework (`--check` previews).

### Prerequisites

- **bun** (required) — the framework's tools and hooks are TypeScript run via bun:
  `curl -fsSL https://bun.sh/install | bash` (must be on PATH for non-interactive shells).
- **AWS Bedrock access** (upstream's shipped default) — the installed `settings.json` defaults to
  Opus via Bedrock. Not on Bedrock? Override in `.claude/settings.local.json` (copy the shipped
  `.example`); the installer never overrides model/env values you already set.
- **uv/uvx + AWS credentials** (optional) — four of the five shipped MCP servers launch via `uvx`
  and use your AWS credential chain. Servers you lack credentials for are simply unavailable and
  never block a workflow.

### Why an installer (not a self-contained plugin)?

Upstream's engine requires living at `<project>/.claude/` — its hooks and tools resolve framework
paths under the project root, its method rules import from the project's `aidlc/` workspace, and
its own `doctor` prescribes exactly that layout. Running it from a plugin directory would mean
forking upstream code on every sync. Installing it verbatim means zero patches and full fidelity;
the plugin's own footprint stays one skill + one installer script.

## How this relates to v1

| | v1 (`aidlc`) | v2 (`aidlc-v2`, this repo) |
|---|---|---|
| Upstream source | `aidlc-rules/*.md`, by tag (main line) | upstream's built `dist/claude`, by `v2.x` release tag |
| Delivery | self-contained plugin | installer — framework lives in your project after `/aidlc-v2:aidlc` |
| Entry point | `/aidlc:start` | `/aidlc` (installed; `/aidlc-v2:aidlc` only installs/updates) |

Both can be installed at once.

## Architecture of this repo

```
src/                      # vendored snapshot of awslabs/aidlc-workflows:<sha>/dist/claude (pristine mirror)
  .claude/                #   the framework: skills, agents, tools (TS/bun), hooks, knowledge, settings.json
  .mcp.json  .gitignore   #   project-root files upstream ships
  aidlc/                  #   seed workspace (memory/method files)
UPSTREAM.lock             # exact upstream repo/branch/SHA + tree hash that src/ was vendored from
targets/claude/
  build.mjs               # builds dist/claude/: verbatim framework/ payload + authored surface; enforces the upstream-shape contract
  plugin/                 # authored plugin surface: skills/aidlc/SKILL.md (entry skill) + installer/aidlc-install.ts
  sync-upstream.sh        # refreshes src/ from an explicit upstream SHA, rebuilds, rewrites UPSTREAM.lock
  sync-triage.mjs         # T1: classifies an upstream diff (AUTO / CONTRACT / ESCALATE) before adoption
  smoke.mjs               # T2a: headless load smoke — plugin loads & exposes exactly the installer surface (billable, opt-in)
  tag-release.sh          # mints an annotated release tag v<version>+up.<upstream-short-sha>
test/
  drift-injection.mjs     # meta-test: each contract gate fails on its target drift + idempotency
  triage.test.mjs         # meta-test: T1 triage buckets every change kind correctly
  installer.test.mjs      # end-to-end: install into a scratch project → upstream's own doctor passes (free, deterministic)
  dist-fresh.mjs          # guard: committed dist/claude == a fresh build of src/
dist/claude/              # built, committed plugin — what the marketplace installs
  .claude-plugin/plugin.json
  skills/aidlc/           #   the entry skill (/aidlc-v2:aidlc)
  installer/              #   aidlc-install.ts (bun)
  framework/              #   upstream's dist/claude, byte-identical to src/
.claude-plugin/marketplace.json   # marketplace manifest (points at ./dist/claude)
```

`src/` is kept pristine (a pure mirror of upstream at the pinned SHA); everything Claude-plugin-
specific lives in `targets/claude/`.

### The upstream-shape contract

The build asserts, loudly, everything the installer and docs depend on — before producing output
(preconditions on `src/`) and after (postconditions on `dist/`):

- exact top-level set (`.claude`, `.mcp.json`, `.gitignore`, `aidlc`) and exact `.claude` children;
- `settings.json` key allowlist + strict hook-command shapes + hook-file set == referenced set;
- `.mcp.json` server allowlist (a new server = a new credentials story to document);
- the `.gitignore` AI-DLC block marker the installer appends by;
- the framework version constant (plugin version must mirror it: `2.1.4` or `2.1.4-pN`);
- entry-skill presence, per-skill `SKILL.md`, catalogue count floors, compiled stage-graph parses;
- `framework/` in dist is **byte-identical** to `src/`; the authored surface exists and invokes the
  installer; `claude plugin validate` passes.

Versioning **mirrors upstream**: plugin `2.1.4` ships upstream `v2.1.4`; release tags append
provenance (`v2.1.4+up.<short-sha>`), with the full SHA + tree hash in the tag message and in
`UPSTREAM.lock`.

## Syncing from upstream

Upstream cuts `v2.x` release tags from its `v2` dev branch (`main` is the v1 line). This repo
vendors a *pinned snapshot* of upstream's `dist/claude` at a **tag commit** (recorded in
[`UPSTREAM.lock`](UPSTREAM.lock)) and refreshes it on demand, with a human reviewing every
snapshot. The mechanics are automated; the decision to adopt is not.

> **Guided release:** the `release-upstream` skill (`.claude/skills/`, repo-only — not shipped)
> drives the pipeline — sync → review triage escalations → set the version to upstream's → build →
> run the gates → commit + tag locally — and **stops before pushing**.

```bash
# Pin an upstream release-tag commit (recommended):
git ls-remote https://github.com/awslabs/aidlc-workflows.git 'refs/tags/v2.*'
./targets/claude/sync-upstream.sh <peeled-tag-commit-sha>
```

The script sparse-checkouts upstream's `dist/claude` at that commit, runs the T1 diff-triage,
rebuilds `dist/` under the contract, and — only if it all passes — rewrites `UPSTREAM.lock`. It
**does not commit**: review, then commit by hand (stage with `git add --force -A src` — the
vendored `src/.gitignore` matches files upstream ships force-added).

The verification tiers: the free deterministic gates (`npm test`: contract drift-injection, T1
triage meta-tests, the installer→doctor end-to-end, dist-freshness) run on every change. The T2a
load smoke (`npm run smoke`, one billable model call) runs when T1 advises it or before a release.
Full mechanics and the contract failure-mode table: **[MAINTAINERS.md](MAINTAINERS.md)**.

## License & attribution

This project is **MIT-0** (MIT No Attribution); see [LICENSE](LICENSE).

The contents of `src/` (shipped verbatim as `dist/claude/framework/`) are **vendored** from
[AWS AI-DLC Workflows](https://github.com/awslabs/aidlc-workflows) — the `dist/claude` directory
of the `v2` branch at the exact release-tag commit pinned in [`UPSTREAM.lock`](UPSTREAM.lock) (and
recorded in each release tag, `vX.Y.Z+up.<short-sha>`). Upstream is also MIT-0, Copyright
Amazon.com, Inc. — attribution is not required, but is given here for provenance. The installer and
plugin packaging (`targets/claude/`) are original to this repo. **This is an independent community
port, not affiliated with or endorsed by Amazon / AWS.**
