# AI-DLC Claude Code Plugin — v2 (alpha)

A [Claude Code](https://claude.com/claude-code) plugin packaging the **v2** rewrite of the
[AWS AI-DLC Workflows](https://github.com/awslabs/aidlc-workflows) methodology — a structured,
adaptive, agent-orchestrated software development lifecycle.

> **Status: alpha / experimental.** This tracks an *active development branch* of upstream
> (`v2-evaluator`), which upstream itself flags as breaking-change-prone. It is published under a
> separate namespace (`aidlc-v2`) so it can be installed **alongside** the stable v1 plugin
> ([`ijin/aidlc-cc-plugin`](https://github.com/ijin/aidlc-cc-plugin)) for testing.

## Architecture of this repo

```
src/                      # vendored snapshot of awslabs/aidlc-workflows:<sha>/src (pristine mirror)
  agents/                 #   builder + validator agent definitions (Kiro JSON)
  aidlc-common/           #   protocols, conventions, scripts shared across skills
  skills/                 #   the AI-DLC skills (orchestrator, requirements-analysis, ...)
UPSTREAM.lock             # exact upstream repo/branch/SHA + src tree hash that src/ was vendored from
targets/claude/
  build.mjs               # transforms src/ -> dist/claude/; enforces the upstream-shape contract
  sync-upstream.sh        # refreshes src/ from an explicit upstream SHA, rebuilds, rewrites UPSTREAM.lock
  sync-triage.mjs         # T1: classifies an upstream diff (AUTO / CONTRACT / ESCALATE) before adoption
  smoke.mjs               # T2: headless behavioral smoke — runs dist/claude under `claude -p`
  score.mjs               # T3: deterministic quality scorer (candidate aidlc-docs/ vs golden master)
  tag-release.sh          # mints an annotated release tag v<version>+up.<upstream-short-sha>
  hooks/                  # Claude-specific SubagentStop hook (process-check reminder); no upstream equivalent
test/
  drift-injection.mjs     # meta-test: each contract gate fails on its target drift + idempotency
  triage.test.mjs         # meta-test: T1 triage buckets every change kind correctly
  score.test.mjs          # meta-test: T3 scorer is parity-locked to upstream's Python scorer
  golden/                 # golden masters for T3 (capture procedure in golden/README.md)
dist/claude/              # built, committed plugin — what the marketplace installs
  .claude-plugin/plugin.json
  skills/  agents/  aidlc-common/  hooks/
.claude-plugin/marketplace.json   # marketplace manifest (points at ./dist/claude)
```

`src/` is kept pristine (a pure mirror of upstream at the pinned SHA); every Claude-specific change lives in the build.

## Installation (testing)

```
/plugin marketplace add ijin/aidlc-cc-plugin-v2
/plugin install aidlc-v2@aidlc-cc-plugin-v2
```

Then start a workflow with a development intent, or invoke the orchestrator explicitly:

```
/aidlc-v2:aidlc-orchestrator Build a URL shortener service
```

## How this relates to v1

| | v1 (`aidlc`) | v2 (`aidlc-v2`, this repo) |
|---|---|---|
| Upstream source | `aidlc-rules/*.md`, by tag | `src/{agents,aidlc-common,skills}`, by branch |
| Runtime shape | one `/aidlc:start` skill | orchestrator + ~15 composable skills + builder/validator agents |
| Entry point | `/aidlc:start` | `/aidlc-v2:aidlc-orchestrator` (or a free-form dev intent) |

Both can be installed at once — Claude Code namespaces skills by plugin `name`.

## Syncing from upstream

Upstream v2 is an **unstable, tagless dev branch** (`v2-evaluator`), force-pushable and
breaking-change-prone. So this repo does **not** auto-track it. Instead it vendors a *pinned
snapshot* of upstream's `src/` (recorded in [`UPSTREAM.lock`](UPSTREAM.lock)) and refreshes it
on demand, with a human reviewing every snapshot. The mechanics are automated; the decision to
adopt a new snapshot is not.

> **Guided release:** the `release-upstream` skill (`.claude/skills/`, repo-only — not shipped)
> drives the whole pipeline below — sync → review triage escalations (asking you at each decision) →
> bump the version → build → run the gates → commit + tag locally → summary report — and **stops
> before pushing**. It orchestrates the same scripts documented here; use it for a guided release,
> or run the steps by hand.

To pull a newer snapshot:

```bash
# Pin a specific upstream commit (recommended) ...
./targets/claude/sync-upstream.sh <upstream-sha>
# ... or take the current v2-evaluator tip:
./targets/claude/sync-upstream.sh
```

The script sparse-checkouts upstream's `src/` at that commit, runs a **diff-triage** pass + rebuilds
`dist/` + runs the build contract, and — only if it all passes — rewrites `UPSTREAM.lock`. It **does
not commit**: review, bump the version, then commit/tag by hand (or use the guided skill above).

> [!WARNING]
> **Do not run `git subtree pull` to sync.** `src/` was originally imported via `git subtree`,
> so that command will appear to work — but it maps upstream's *repo root* into our `src/`
> and corrupts the tree. Always sync with `sync-upstream.sh`.

The build/sync/verify/release mechanics — diff triage, the upstream-shape contract and its
failure-mode table, versioning & release tags, and the behavioral/quality test tiers — are
documented for maintainers in **[MAINTAINERS.md](MAINTAINERS.md)** (and `CLAUDE.md` for the terse
rule list). In brief: the free, deterministic gates (`make test`) run on every change; the behavioral
smoke (T2, which makes billable model calls) and the quality scorer (T3, deterministic but needs a
full run to produce something to score) are off by default and run only when warranted.

## License & attribution

This project is **MIT-0** (MIT No Attribution); see [LICENSE](LICENSE).

The contents of `src/` are **vendored** (copied verbatim) from
[AWS AI-DLC Workflows](https://github.com/awslabs/aidlc-workflows), branch `v2-evaluator`, at the
exact commit pinned in [`UPSTREAM.lock`](UPSTREAM.lock) (and recorded in each release tag,
`vX.Y.Z+up.<short-sha>`). Upstream is also MIT-0, Copyright Amazon.com, Inc. — attribution is not
required, but is given here for provenance. The Claude Code adaptation (`targets/claude/`,
`dist/claude/`) is original to this repo. **This is an independent community port, not affiliated
with or endorsed by Amazon / AWS.**
