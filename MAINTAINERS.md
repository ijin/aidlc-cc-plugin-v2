# Maintaining aidlc-cc-plugin-v2

Reference for maintainers adopting upstream snapshots and cutting releases. The README covers what
the plugin is and how to install/use it; this covers **how it's built, verified, and released**.
`CLAUDE.md` is the terse agent-facing rule list; the authoritative source for any script's behaviour
is its header comment + `.design/`.

## The build model

`src/` is a pristine, vendored mirror of **upstream's built `dist/claude`** (its own Claude Code
target: `.claude/` framework + `.mcp.json` + `.gitignore` + seed `aidlc/` workspace) at the SHA in
`UPSTREAM.lock` — normally a `v2.x` release-tag commit on upstream's `v2` branch. The plugin that
ships is the **built** `dist/claude/`, produced by `targets/claude/build.mjs`:

- `dist/claude/framework/` — `src/` **verbatim** (postcondition-asserted byte-identical);
- `dist/claude/skills/aidlc/` + `dist/claude/installer/` — the authored surface
  (`targets/claude/plugin/`): the `/aidlc-v2:aidlc` entry skill and the bun installer;
- `dist/claude/.claude-plugin/plugin.json` — generated from `package.json`.

This is the **installer model**: upstream's engine requires living at `<project>/.claude/` (its
hooks/tools join framework paths under the project dir; its `doctor` prescribes the copy), so we
ship it untouched and install it, rather than patching it to run in place. All plugin-specific
engineering lives in `targets/claude/`; **never hand-edit `src/` or `dist/`** (rebuild instead).
`dist/` is committed and must always equal a fresh build — enforced by the freshness guard, a
pre-commit hook (`git config core.hooksPath .githooks`), and CI.

## Syncing from upstream (the full pipeline)

```bash
# find the newest upstream release tag and its peeled commit:
git ls-remote https://github.com/awslabs/aidlc-workflows.git 'refs/tags/v2.*'
./targets/claude/sync-upstream.sh <peeled-tag-commit-sha>
```

This runs **T1 diff-triage**, sparse-checkouts upstream `dist/claude` at the SHA, replaces local
`src/`, rebuilds `dist/`, runs the **build contract (T0)**, and rewrites `UPSTREAM.lock` **only on
a clean build**. It does **not** commit. Then: review, set the version (mirror upstream's), commit,
tag. Stage with **`git add --force -A src`** — the vendored `src/.gitignore` matches files upstream
ships force-added (e.g. `aidlc/active-space`); a plain `git add` silently drops them on first sync
(the sync script prints the affected files; `tag-release.sh` catches the resulting skew at release).

> Pin **tag commits**, not the `v2` branch tip: the tip is unreleased and upstream has force-pushed
> the branch before. `main` is the v1 line — v2 may never merge there.

### T1 — diff triage

`sync-triage.mjs` classifies every changed file before adoption. Under the installer model the
payload ships byte-identical, so there is no transform whose coverage T1 must prove; its value is
surfacing the files OUR installer/docs are semantically coupled to:

- **AUTO** — shipped verbatim; no plugin-side obligations (upstream owns and tests the content —
  read upstream's CHANGELOG for meaning). The bulk of any release.
- **CONTRACT** — structural change T0 provably hard-fails on (root/children set, hook set, entry
  skill, version constant, compiled data). The build is the gate; triage just flags it.
- **ESCALATE** — a change on an **installer-coupled** file whose semantics T0 can't assert:
  `settings.json`, `.mcp.json`, `.gitignore`, `CLAUDE.md`, `settings.local.json.example`,
  `aidlc-version.ts`. Review the installer's merge rules and the README's claims.

It also emits **`smoke.advised`** (JSON: `smoke: {advised, reasons}`) when the engine control
surface (hooks/, tools/, protocols/, settings.json) changed — the deterministic signal to run the
billable T2a load smoke and read upstream's changelog with extra care before releasing.
`SKIP_TRIAGE=1` to bypass; `npm run triage -- <sha> --repo <clone>` standalone.

### Versioning & release tags

**The plugin version mirrors upstream's framework version** (the `AIDLC_VERSION` constant in the
payload): plugin `2.1.4` ships upstream `v2.1.4`; a plugin-only fix on the same payload is
`2.1.4-p1`. The build **fails** on any other version. `package.json` is the source of truth;
`.claude-plugin/marketplace.json` must be bumped to match (also enforced). Add a `CHANGELOG.md`
entry per release.

`npm run tag` mints an annotated tag `v<version>+up.<upstream-short-sha>` (e.g.
`v2.1.4+up.b61e0ed`). The `+up.<short>` is SemVer **build metadata** — a provenance *label*, not
version identity (never publish two releases differing only after `+`). The full upstream SHA +
tree hash go in the tag *message*; the tag script verifies the **committed** `src/` tree equals the
lock's hash before minting. Git tags aren't inherently immutable — **protect the tag on the remote**.

The **`release-upstream` skill** (`.claude/skills/`, repo-only, not shipped) drives this pipeline
interactively and stops before pushing.

## Verification tiers

### T0 — build contract (free, every build)

`build.mjs` asserts everything the installer and docs depend on. **When a contract check fails**,
the message names what changed; map it to the fix (always in `targets/claude/`, never `src/`):

| Failure | What upstream did | Fix |
|---|---|---|
| `src/ top-level … expected exactly […]` | added/renamed/removed a root entry | update `REQUIRED_SRC_ROOT` **and** the installer's placement rules |
| `src/.claude children … expected exactly […]` | changed the framework layout | update `REQUIRED_CLAUDE_CHILDREN`; review the installer |
| `settings.json has unknown top-level key(s)` | added configuration | extend `SETTINGS_KNOWN_KEYS` **and** `mergeSettings()` in the installer |
| `hook command … does not match the expected shape` | changed hook invocation | update `HOOK_CMD_RE`; re-check README permissions guidance |
| `hooks/*.ts […] != scripts referenced by settings.json` | added/removed/rewired a hook | review the wiring, then update the check if legitimate |
| `unknown MCP server(s)` | added an MCP server | document its credentials story in README, extend `MCP_KNOWN_SERVERS` |
| `.gitignore no longer contains the marker` | reworded the AI-DLC block header | update `GITIGNORE_BLOCK_MARKER` + the installer together |
| `cannot parse AIDLC_VERSION` | moved/renamed the version constant | update `frameworkVersion()` (build) + `readVersion()` (installer) |
| `entry skill …/SKILL.md missing` / `has no SKILL.md` / `catalogue shrank` | restructured the skill catalogue | verify intent, adjust `REQUIRED_FRAMEWORK_SKILLS` / floors |
| `cannot parse compiled data` | moved/broke compiled engine data | investigate — the installed engine would be dead |
| `framework/ … differs from src/` | (our bug) the build mutated the payload | fix the build; the payload must ship verbatim |
| `plugin version does not mirror framework version` | new upstream version adopted | set `package.json` + `marketplace.json` to the framework version |
| `marketplace.json version != package.json` | versions drifted | bump both to match |

Then rebuild; if mid-sync, re-run `sync-upstream.sh` (the lock was left untouched on failure).

### `npm test` — the free deterministic suite (every change)

Four suites, no network, no LLM:

1. **`test/drift-injection.mjs`** — meta-test: every T0 gate above provably fails on its target
   drift (+ a fake-`claude` check that the validate gate is wired, + build idempotency).
2. **`test/triage.test.mjs`** — meta-test: T1 buckets every change kind correctly and the smoke
   advisory fires (only) on control-surface changes.
3. **`test/installer.test.mjs`** — **the keystone**: installs the committed payload into a scratch
   project with the real installer, then runs **upstream's own `doctor`** and requires 0 failures;
   also proves idempotency, `--check` write-freedom, additive merging into pre-existing
   `settings.json`/`.mcp.json`/`.gitignore` (user values always preserved), the fresh-install
   **conflict** policy (a pre-existing differing file is never overwritten — reported, exit 3),
   update-mode refresh with every differing overwrite listed, **symlink write-refusal** (file and
   directory symlinks; nothing outside the project is touched), and the self-install guard.
   Requires `bun` (SKIPs without it; `AIDLC_REQUIRE_INSTALLER_TEST=1` to hard-require).
4. **`test/dist-fresh.mjs`** — committed `dist/claude/` == a fresh build of `src/`.

The build additionally runs **`claude plugin validate`** when the CLI is resolvable
(`CLAUDE_BIN`/PATH; WARN-skip if absent, `AIDLC_REQUIRE_CLAUDE_VALIDATE=1` to require) and a **bun
parse check** on the installer (WARN-skip; `AIDLC_REQUIRE_BUN_CHECK=1`).

### T2a — load smoke (billable; opt-in)

`npm run smoke` runs the built plugin under `claude -p` (one ~1-turn call) and asserts the plugin
loads with no `plugin_errors` and exposes **exactly** the installer surface: the `aidlc-v2:aidlc`
entry skill, **no** leaked framework skills (`aidlc-v2:aidlc-*` would mean the payload got scanned
as plugin content), and no plugin agents. Run it when T1's `smoke.advised` fires or before a
release. `sync-upstream.sh` runs it only with `RUN_SMOKE=1`. Skips cleanly without the `claude`
CLI (`AIDLC_REQUIRE_SMOKE=1` to require).

### Retired tiers (history)

The pre-installer adapter had a T2b autonomous-workflow smoke and a T3 golden-master scorer, built
for upstream's old `src/` layout (14 skills, Kiro-JSON agents, `aidlc-docs/` artifacts). The v2
restructure replaced that world (compiled stage-graph + generated runners + project-tree install)
and upstream now maintains its own engine test suite and CI — duplicating it against a verbatim
payload adds cost, not signal. Their role is covered by `installer.test.mjs` (upstream's `doctor`
as the behavioral oracle) + upstream's own tests. See git history (`targets/claude/score.mjs`,
`smoke.mjs --workflow`) if they're ever worth reviving.
