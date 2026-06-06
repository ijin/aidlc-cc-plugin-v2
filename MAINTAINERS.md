# Maintaining aidlc-cc-plugin-v2

Reference for maintainers adopting upstream snapshots and cutting releases. The README covers what
the plugin is and how to install/use it; this covers **how it's built, verified, and released**.
`CLAUDE.md` is the terse agent-facing rule list; the authoritative source for any script's behaviour
is its header comment + `.design/`.

## The build model

`src/` is a pristine, vendored mirror of upstream's `src/` at the SHA in `UPSTREAM.lock`. The plugin
that ships is the **built** `dist/claude/`, produced by `targets/claude/build.mjs`. All Claude-specific
adaptation lives in `targets/claude/`; **never hand-edit `src/` or `dist/`** (rebuild instead).
`dist/` is committed and must always equal a fresh build of `src/` — enforced by the freshness guard
(below), a pre-commit hook (`git config core.hooksPath .githooks`), and CI.

## Syncing from upstream (the full pipeline)

The README has the short version; the steps and their guards:

```bash
./targets/claude/sync-upstream.sh <upstream-sha>   # or bare for the v2-evaluator tip
```

This runs **T1 diff-triage**, sparse-checkouts upstream `src/` at the SHA, replaces local `src/`,
rebuilds `dist/`, runs the **build contract (T0)**, and rewrites `UPSTREAM.lock` **only on a clean
build**. It does **not** commit. Then: review, bump the version, commit, tag.

> **Never `git subtree pull`.** `src/` was originally imported via subtree; that command maps
> upstream's *repo root* into `src/` and corrupts it. Always use `sync-upstream.sh`.

### T1 — diff triage

`sync-triage.mjs` classifies every changed file before adoption:

- **AUTO** — the adapter fully neutralizes it (decided by running the *actual* `transformContent` on
  old vs new — "mechanical" is never a guess).
- **CONTRACT** — structural change the build contract provably hard-fails on if unhandled (rename of
  a *required* component, etc.). The build is the gate; triage just flags it.
- **ESCALATE** — semantic/novel change that builds green but needs review (rename *with* content
  edit, non-mechanical edit, new file, deletion of a non-required path). Fail-closed: anything not
  provably mechanical escalates.

It also emits **`t2b.advised`** (see T2). `SKIP_TRIAGE=1` to bypass; `make triage SHA=<sha>` standalone.

### Versioning & release tags

`package.json` is the **source of truth** for the version: `build.mjs` generates
`dist/.../plugin.json` from it, and the build fails if `.claude-plugin/marketplace.json` disagrees —
so `marketplace.json` must be bumped to match (the build enforces this; it isn't a second source).
The version is decoupled from the upstream SHA (upstream is tagless): `UPSTREAM.lock` records *what
upstream we vendor*, `package.json` is *our* release counter. On each adopted snapshot, bump
`2.0.0-alpha.N` in `package.json` **and** `.claude-plugin/marketplace.json` (keep them equal), and
add a `CHANGELOG.md` entry.

`make tag` mints an annotated tag `v<version>+up.<upstream-short-sha>` (e.g.
`v2.0.0-alpha.1+up.392d576`). The `+up.<short>` is SemVer **build metadata** — a provenance *label*,
not version identity (so never publish two releases differing only after `+` — always bump
`alpha.N`). The full upstream SHA + `src` tree hash go in the tag *message*. Git tags aren't
inherently immutable — **protect the tag on the remote**.

The **`release-upstream` skill** (`.claude/skills/`, repo-only, not shipped) drives this whole
pipeline interactively and stops before pushing.

## Verification tiers

### T0 — build contract (free, every build)

`build.mjs` is an *adapter* assuming upstream's exact layout/formats. It **fails the build** when:

- `src/` gains an unexpected (dir *or* file), or loses a required, top-level entry;
- a Kiro agent JSON has an unknown key, non-array `tools`, no usable `name`, or a tool absent from `TOOL_MAP`;
- a known Kiro construct (`invokeSubAgent`, `askAgent`) is present in `src/` **and** survives un-rewritten into `dist/` (an upstream rewording made a regex miss);
- `marketplace.json`'s version disagrees with `package.json`.

It prints a build report and warns on Kiro markers in `src/`. A green build means the adapter
actually handled this snapshot, not merely that the output parsed.

**When a contract check fails** — each message names what changed; map it to the fix:

| Failure | What upstream did | Fix in `targets/claude/` |
|---|---|---|
| unexpected/missing top-level `src/` dir or file | added/renamed/removed content | decide whether to ship it; update `REQUIRED_SRC_DIRS` + build steps |
| agent unknown key / non-array `tools` / no `name` | changed the agent JSON schema | update `KNOWN_AGENT_KEYS` / `buildAgents()` |
| agent uses unmapped tool | introduced a new tool | add it to `TOOL_MAP` |
| `…still contains <Kiro primitive>` in `dist/` | reworded a primitive so a regex missed | update `kiroToClaude()` |
| `marketplace.json version != package.json` | versions drifted | bump both to match |

Then rebuild; if mid-sync, re-run `sync-upstream.sh` (the lock was left untouched on failure).

### `make test` — the free meta-suite (every change)

Runs four suites: contract-drift tests (each gate provably fails on its target drift), the T1 triage
classifier, the T3 scorer (parity-locked to upstream), and the **`dist/`-freshness guard**
(`dist-fresh.mjs` — committed `dist/claude/` must equal a fresh build of `src/`). The build also runs
**`claude plugin validate`** when the `claude` CLI is resolvable (`CLAUDE_BIN`/PATH; WARN-skip if
absent, hard-fail with `AIDLC_REQUIRE_CLAUDE_VALIDATE=1`).

### T2 — behavioral smoke (billable; OFF by default)

T2 runs the built plugin under `claude -p`. **Off by default** — it makes billable LLM/API calls and
has found no plugin defects in practice (every real bug was caught by the free gates).

- **`make smoke`** (cheap, ~1 turn) — confirms the plugin loads with no `plugin_errors` and every
  required skill + agent is present, namespaced `aidlc-v2:*`. `sync-upstream.sh` runs it only with
  `RUN_SMOKE=1`. Recommended for release candidates.
- **`make smoke-workflow`** (expensive, opt-in) — copies the plugin to a scratch dir with the human
  gates flipped off, runs a fixture intent, and asserts both the builder *and* validator subagents
  spawned, *our* process-check hook fired, and the specific AI-DLC artifacts appeared
  (`state/intent-state.md`, `workflow.md`, `state/process-checkpoint.json`). A turn/budget cap counts
  as clean only if the run already reached the validator + wrote that state spine.

> ⚠ `make smoke-workflow` runs freshly-synced upstream instructions under
> `--dangerously-skip-permissions`. `--add-dir` is **not** a security sandbox — run only on a
> disposable machine/container/CI with no secrets, then set `AIDLC_SMOKE_TRUST=1`.

Both skip cleanly without the `claude` CLI (`AIDLC_REQUIRE_SMOKE=1` to require). Timeouts: T2a 90s,
T2b `AIDLC_SMOKE_TIMEOUT_MS` (default 30 min).

**When is T2b worth the money?** Deterministically: `t2b.advised` is `true` only when a sync touches
the runtime *behavioral surface* — agent defs, the orchestrator/builder/validator protocols, the
process-checker, the state-machine/workflow conventions, the orchestrator/workflow-composition
skills, or an interaction-flag *value* flip (incl. deletes/renames of those). Content-only snapshots
(stage prose, convention wording, validation specs) get `false`. The release skill prompts for T2b
only when it fires.

### T3 — quality-regression scorer (release-only)

`make score CAND=<dir> GOLD=<dir> [MIN=…]` — a dependency-free, deterministic port of upstream's
heuristic scorer (term-frequency cosine for intent, Jaccard of identifiers+headings for design,
heading-coverage for completeness), **parity-locked bit-for-bit** to upstream (see
`test/score.test.mjs`). Compares a candidate `aidlc-docs/` tree against a committed golden master.
The scorer is deterministic; the *candidate* comes from a full autonomous run, so T3 is
**release-only**. It's honest lexical/structural similarity — a signal for human review, not a
semantic-quality proof (the optional LLM scorer isn't ported). See `test/golden/README.md` to
capture a golden master.
