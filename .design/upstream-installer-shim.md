# Plugin 2.10.0 — a thin shim over upstream's installer

Status: accepted design; implementation spec. Supersedes the "installer plugin" model of 2.1.4
(which vendored upstream's `dist/claude` tree and shipped its own installer).

## Why

Upstream (`awslabs/aidlc-workflows`) made v2 GA on `main` and now ships the full lifecycle itself:
a native `aidlc` CLI installed by a hash- and Sigstore-verified `install.sh` / `install.ps1`,
`aidlc config --harness claude` (transactional, ownership baselines, conflict refusal),
per-project pins (`aidlc config --pin`), release channels, and `aidlc uninstall`. It no longer
commits `dist/claude`. Vendoring and re-installing upstream's tree would now be a weaker duplicate.

What upstream does not cover, verified against v2.10.0:

1. **Projects set up by this plugin's 2.1.4 release.** `aidlc config` fails on them, even with
   `--force` (`schema validation failed: reviewer requires review_artifact` — the old stage files
   are invalid for the new engine). Removing exactly the files 2.1.4 installed *unmodified*, while
   keeping the `aidlc/` workspace, makes `aidlc config` succeed (`doctor`: 0 failed) and preserves
   the user's method/memory files.
2. **Projects with existing Claude Code configuration.** `aidlc config` refuses (exit 4, writes
   nothing) when `.claude/settings.json` or `.claude/CLAUDE.md` already exist with other content.
   Its `--force` silently replaces a user's own `.claude/CLAUDE.md` and drops the user's own
   `permissions` entries from `settings.json`, with no backup. The shim must surface conflicts
   and never pass `--force`.
3. **Version selection without hijacking the machine.** A plain `install.sh --version <older>`
   re-points the machine-wide `aidlc` launcher (verified: 2.10.0 → 2.9.0 for every project).
   `aidlc config --pin <version>` instead installs the version side by side, writes
   `.aidlc-version`, and leaves the machine-active version alone; the pinned project's engine and
   `aidlc config` then run the pinned version (verified).
4. **Discovery from inside Claude Code** — one marketplace plugin, one command.

So the plugin becomes a shim: one skill + one POSIX `sh` helper + data. It ships no framework.

## Facts the design depends on (upstream v2.10.0)

- Hooks in a configured project call bare `aidlc engine hook …` — the `aidlc` launcher must be on
  `PATH` for hooks to work, so the CLI must live at upstream's standard location:
  Unix launcher `${AIDLC_BIN_DIR:-$HOME/.local/bin}/aidlc`, versions under
  `${XDG_DATA_HOME:-$HOME/.local/share}/aidlc/versions/`; Windows `%LOCALAPPDATA%\aidlc\bin\aidlc.cmd`.
  Installers never edit shell startup files unless `--profile` is passed (we never pass it).
- Installer flags: Unix `--version <v> --yes --quiet --json`; PowerShell `-Version <v> -Yes -Quiet -Json`.
  `AIDLC_INSTALL_ROOT` / `AIDLC_BIN_DIR` relocate the install (used by tests).
- `aidlc config` flags used: `--harness claude --project-dir <p> --mcp defaults|none --dry-run --quiet --json`,
  `--pin <version>`. Non-interactive config without `--mcp` writes no `.mcp.json`.
- Exit codes: 0 ok, 1 operational failure, 2 usage, 3 network/runtime unavailable, 4 integrity or
  ownership refusal (incl. config conflicts), 5 action required. Config also refuses while any
  workflow is active (message names it).
- Upstream-managed projects contain `.claude/tools/data/aidlc-stamp.json`. The framework version
  marker is `.claude/tools/aidlc-version.ts` (`export const AIDLC_VERSION = "x.y.z"`).
- Release assets (per tag): `install.sh`, `install.ps1`, `checksums.txt` (lists both installers),
  `version.json` (`version`, `sourceRef`, `sourceDigest`), `aidlc-release.intoto.jsonl`
  (Sigstore bundle; verify with `gh attestation verify … --signer-workflow
  awslabs/aidlc-workflows/.github/workflows/release.yml --source-ref refs/tags/<tag>`).
  Preview tags (`x.y.z-preview.YYYYMMDD.N`) are signed by `preview-release.yml`.

## Pinned release (initial)

| Field | Value |
|---|---|
| tag | `v2.10.0` |
| peeled commit (= `version.json` `sourceDigest`) | `2a883858f5483bce3b48f43b8f6d3ca2c042d6ae` |
| release date | `2026-09-24` |
| `install.sh` sha256 | `ab3ce473933a3ab7163120a3c59b65d29540537f8e6e8700551e31a3a9241801` |
| `install.ps1` sha256 | `0a8e072321b2846f2b0fd913b32aadf990ffcf2fb3c3d3e8c15029e327c3ef4e` |
| `checksums.txt` sha256 | `51b0667473e0a047843c55d8229e2a0e378f711d9bf96877b34533072773bed2` |

Plugin version mirrors the pinned upstream version: **2.10.0** (plugin-only patches: `2.10.0-pN`).

## Repository layout after the change

```
UPSTREAM.lock                              # pinned release (schema below); single source of truth
targets/claude/
  build.mjs                                # lock + authored files -> dist/claude/; enforces the contract
  plugin/
    skills/aidlc/SKILL.md                  # entry skill (/aidlc-v2:aidlc) — authored, already written
    scripts/aidlc-v2.sh                    # the helper (POSIX sh)
    data/legacy-2.1.4.sha256               # sha256sum-format manifest of files 2.1.4 installed
    data/legacy-2.1.4.gitignore-block      # exact bytes 2.1.4 appended to an existing .gitignore
  sync-upstream.sh                         # adopt a release tag: verify assets, rewrite the lock
  tag-release.sh                           # annotated release tag with provenance
  smoke.mjs                                # T2a load smoke (unchanged in spirit)
test/
  drift-injection.mjs                      # each build-contract gate fails on its target drift
  shim.test.mjs                            # deterministic helper tests (stubs, no network)
  release-gate.mjs                         # real pinned release, sandboxed (network; opt-in)
  dist-fresh.mjs                           # committed dist == fresh build (unchanged)
dist/claude/                               # built, committed plugin
  .claude-plugin/plugin.json
  skills/aidlc/SKILL.md
  scripts/aidlc-v2.sh                      # mode 0755
  data/pins.env                            # generated from UPSTREAM.lock
  data/legacy-2.1.4.sha256
  data/legacy-2.1.4.gitignore-block
```

Removed: `src/` (vendored tree), `dist/claude/framework/`, `targets/claude/plugin/installer/`,
`targets/claude/sync-triage.mjs`, `test/installer.test.mjs`, `test/triage.test.mjs`. History and
the `v2.1.4+up.b61e0ed` tag keep them.

## UPSTREAM.lock schema

```
UPSTREAM_REPO=https://github.com/awslabs/aidlc-workflows.git
UPSTREAM_TAG=v2.10.0
UPSTREAM_VERSION=2.10.0
UPSTREAM_SHA=2a883858f5483bce3b48f43b8f6d3ca2c042d6ae
UPSTREAM_DATE=2026-09-24
UPSTREAM_SIGNER_WORKFLOW=awslabs/aidlc-workflows/.github/workflows/release.yml
INSTALL_SH_SHA256=ab3ce473933a3ab7163120a3c59b65d29540537f8e6e8700551e31a3a9241801
INSTALL_PS1_SHA256=0a8e072321b2846f2b0fd913b32aadf990ffcf2fb3c3d3e8c15029e327c3ef4e
CHECKSUMS_SHA256=51b0667473e0a047843c55d8229e2a0e378f711d9bf96877b34533072773bed2
SYNCED_NOTE=<free text>
```

Comment header explains each field. `sync-upstream.sh` rewrites it; never hand-edit.

## The helper: `scripts/aidlc-v2.sh`

POSIX `sh` (must pass `sh -n`; must run under macOS `/bin/sh`, Linux `dash`, and Git Bash on
Windows). No dependency beyond: `curl` or `wget`, `sha256sum` or `shasum -a 256`, `cmp`, `find`,
`mkdir`, `rm`, `head`, `tail`, `wc`, `dirname`, `cd -P`/`pwd -P`. No `jq`, `node`, `bun`, or
`python`. Locates its data at `"$(dirname "$0")/../data"`.

### Usage

```
aidlc-v2.sh plan  [--project <dir>] [--mcp defaults|none] [--check]
aidlc-v2.sh apply [--project <dir>] [--mcp defaults|none] --yes
```

`--project` defaults to `$PWD`. `--mcp` defaults to `defaults`. `--check` is accepted (and ignored) only
by `plan` (the skill passes `$ARGUMENTS` through). `apply` without `--yes` exits 2 with a message.
Unknown arguments exit 2.

### Exit codes (the skill relies on these)

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | error (relay output) |
| 2 | usage error |
| 3 | conflicts: upstream refused because existing files differ; user must resolve |
| 4 | integrity refusal: a download did not match the pinned hash |
| 5 | user action required (CLI not on PATH, CLI too old, unsupported platform) |

### Test seams (environment)

- `AIDLC_V2_PLATFORM` — override platform detection (`unix` | `windows`).
- `AIDLC_V2_RELEASE_BASE` — override `https://github.com/awslabs/aidlc-workflows/releases/download`
  (tests use a `file://` URL; the helper appends `/<tag>/<asset>`).
- `AIDLC_V2_AIDLC` — explicit path to the `aidlc` command (skips discovery).
- `AIDLC_V2_POWERSHELL` — PowerShell executable (default: `powershell.exe`, falling back to `pwsh`).
- Upstream's own `AIDLC_INSTALL_ROOT` / `AIDLC_BIN_DIR` pass through untouched to the installer.

### Platform

`uname -s` matching `MINGW*|MSYS*|CYGWIN*` → `windows`; else `unix` (unless overridden). Any other
failure to determine → exit 5 with a clear message.

### CLI discovery (`find_aidlc`)

1. `$AIDLC_V2_AIDLC` if set and executable.
2. `command -v aidlc`.
3. Windows only: `command -v aidlc.cmd`, then `$LOCALAPPDATA/aidlc/bin/aidlc.cmd` (convert with
   `cygpath -u` when available).
4. Unix: `${AIDLC_BIN_DIR:-$HOME/.local/bin}/aidlc` if executable (installed but not on PATH —
   remember `not_on_path=1`).

Version: parse `aidlc --version` output `aidlc <x.y.z…> (runtime …)`. Minimum supported existing
CLI: `MIN_CLI_VERSION=2.8.0` (pins + `--mcp` + `--json`). Compare numerically on x.y.z (ignore any
`-preview…` suffix for the comparison). Older → exit 5: "Your aidlc CLI is <v>; run `aidlc update`
and re-run." Never run `aidlc update`/`aidlc use` ourselves — the machine-active CLI belongs to
the user.

### Project classification (`classify`)

Resolve the project with `cd -P` (must be an existing directory, else exit 2). Then:

- `upstream-managed` — `.claude/tools/data/aidlc-stamp.json` exists. (Refresh; re-pin.)
- `legacy-2.1.4` — no stamp, and `.claude/tools/aidlc-version.ts` contains exactly
  `export const AIDLC_VERSION = "2.1.4"`.
- `unknown-aidlc` — no stamp, version marker present with any other version → exit 5 explaining
  that this project was set up by something other than upstream's `aidlc config` or this
  plugin's 2.1.4, and the user should move `.claude/` aside first.
- `fresh` — otherwise (may still contain the user's own `.claude/` config; upstream decides).

### Legacy migration plan (`legacy-2.1.4` only)

Data: `legacy-2.1.4.sha256` lines `<64-hex>  <relative path>` (paths under `.claude/`, plus
`.mcp.json` and `.gitignore`; never under `aidlc/`).

For each entry, with `T="$P/<path>"`:
- missing → ignore;
- `T` is a symlink, or `T`'s parent directory resolves (`cd -P`) outside the project root →
  **keep** (reason: symlink / outside project);
- regular file whose sha256 equals the manifest → **remove**;
- otherwise → **keep** (reason: locally modified).

`.gitignore` special case: if it is not removed as pristine, and the file's last N bytes equal
`legacy-2.1.4.gitignore-block` exactly (N = block size), plan **strip-suffix**: the new content is
the first (size − N) bytes with trailing newlines collapsed to exactly one `\n` (or empty file → 0
bytes). This undoes 2.1.4's append (`<user text>` + `\n\n` + block) exactly.

Never touch `aidlc/**`, `.aidlc-version`, or anything not in the manifest.

`plan` prints counts and the kept files with reasons (remove list: count + first 10 paths).
`apply` performs removals/strip (after re-checking each hash at removal time), then deletes
directories under `.claude/` that became empty (deepest first; never `.claude` itself if non-empty,
never the project root), and prints what it did. Removed files are pristine copies of a public
release; say so in the output.

### Bootstrap (no usable `aidlc` found)

1. Read pins from `data/pins.env` (`AIDLC_V2_PINNED_VERSION`, `AIDLC_V2_PINNED_TAG`,
   `AIDLC_V2_INSTALL_SH_SHA256`, `AIDLC_V2_INSTALL_PS1_SHA256`) by line parsing (`KEY=VALUE`), not
   by sourcing.
2. Download `install.sh` (unix) or `install.ps1` (windows) from
   `${AIDLC_V2_RELEASE_BASE:-https://github.com/awslabs/aidlc-workflows/releases/download}/<tag>/<asset>`
   into a `mktemp -d` dir (removed on exit via `trap`).
3. sha256 must equal the pinned hash, else exit 4 ("refusing to run an installer that does not
   match the hash this plugin pins") — print both hashes.
4. Run it: unix `sh <file> --version <v> --yes --quiet`; windows
   `<powershell> -NoProfile -ExecutionPolicy Bypass -File <winpath> -Version <v> -Yes -Quiet`
   (`<winpath>` via `cygpath -w` when available). Never pass `--profile`. Non-zero → exit 1 with
   the installer's output.
5. Re-run discovery. If the CLI exists but is not on `PATH`, continue the run using its absolute
   path, and at the end exit 5 with the exact line to add: unix
   `export PATH="<bin dir>:$PATH"` (and which startup file to put it in: `~/.zshenv` for zsh,
   `~/.bashrc` for bash — Claude Code hooks run non-interactively); windows: add
   `%LOCALAPPDATA%\aidlc\bin` to the user PATH. Hooks will not work until it is on PATH.

`plan` never downloads; it reports "will install aidlc <v> into <bin dir>" or the found CLI and
version.

### Apply sequence

*(Revised after the adversarial review; the implementation and tests are authoritative.)*

Upstream exit mapping, used for every `config` call: 0 ok; 4 with output naming
`config conflict` → **3** (conflict guidance; never `--force`); 4 otherwise → **5** (an upstream
refusal the user must act on, e.g. an active workflow); 5 → **5**; other non-zero → **1**.

1. Resolve platform and project; refuse `/`, `$HOME`, or a project whose `.claude` is Claude
   Code's own config dir (exit 5). Classify (exit early per above). Refuse a downgrade: if the
   project's `.aidlc-version` or upstream-managed `AIDLC_VERSION` is newer than the pin, exit 5.
2. Find or bootstrap the CLI (bootstrap only in `apply`).
3. `legacy-2.1.4` only — **rehearsal**: copy `.claude/`, `.mcp.json`, `.gitignore`, `aidlc/`,
   `.aidlc-version` into a temp dir (symlinks preserved, never followed), run the migration
   there, pin the copy (apply only; unpinned afterwards), and run the config dry run against it.
   Any refusal → relay, say nothing in the project changed, exit per the mapping.
4. Record the prior pin; `aidlc config --pin <pinned> --project-dir <P> --quiet`.
5. `legacy-2.1.4` only: run the migration on the real project; record every removed or stripped
   path in a temp file outside the project.
6. Config dry run, then config, against the real project.
7. `aidlc doctor --project-dir <P> --quiet`.
8. Once the real (non-dry) config succeeds, setup is complete: the pin stays and no restore advice
   is printed, whatever doctor reports (the tree was written by the pinned version). On any
   failure between step 4 and that point, restore the prior pin (`--pin <old>`, or `--unpin` when
   there was none or the file was empty; if the revert fails, say exactly what `.aidlc-version`
   should contain). If step 5 changed anything, also print the list file of migrated paths (kept
   outside the project) and, inside a git work tree, a per-file restore loop
   (`while IFS= read -r f; do git checkout HEAD -- "$f" 2>/dev/null; done < <list>`), which skips
   paths that aren't tracked and works on any git version.
9. CLI found off-PATH: exit 5 with the PATH instruction (even if doctor failed, which it may until
   `aidlc` is on PATH). Else doctor failure → exit 1; else exit 0 with: restart the Claude Code
   session, then `/aidlc`; commit `.aidlc-version`, `.claude/`, `aidlc/`.

Every `aidlc` invocation gets `< /dev/null` so no interactive prompt can hang the Bash tool.

### `plan` output (read-only, never writes, never downloads)

Platform; CLI found (path, version, on PATH?) or "will install aidlc <v>"; project classification;
for `legacy-2.1.4` the migration plan; whether the project will be pinned (current
`.aidlc-version` if any → new); and, when a usable CLI exists **and** the classification is
`fresh` or `upstream-managed`, the output of
`aidlc config --harness claude --project-dir <P> --mcp <mcp> --dry-run` (note in the output that
the preview uses the CLI's current version until the project is pinned). Exit 0 unless a
blocking condition (exit 5) is found.

## Build contract (`build.mjs`)

Preconditions (throw with a message naming the fix):
- every lock field present; formats: tag `v<semver>`, `UPSTREAM_VERSION` == tag without `v`,
  40-hex SHA, 64-hex hashes, ISO date, signer workflow path under `awslabs/aidlc-workflows/.github/workflows/`;
- `package.json` version == `UPSTREAM_VERSION` or `UPSTREAM_VERSION + "-p" + N`; marketplace
  version == package version;
- authored files exist; `SKILL.md` has `name: aidlc` and invokes
  `"${CLAUDE_PLUGIN_ROOT}/scripts/aidlc-v2.sh"` for both `plan` and `apply`;
- `legacy-2.1.4.sha256`: every line matches `^[0-9a-f]{64}  (\.claude/[^\0]+|\.mcp\.json|\.gitignore)$`,
  no `..` segment, no absolute path, no duplicates, ≥ 200 entries; gitignore block non-empty and
  starts with `# AI-DLC —`;
- `sh -n` passes on the helper (and `shellcheck -s sh` when available: WARN-only).

Outputs: `plugin.json` (from package.json; description updated for the shim), copies of the
authored files (helper chmod 0755), `data/pins.env` generated from the lock:
```
AIDLC_V2_PINNED_VERSION=2.10.0
AIDLC_V2_PINNED_TAG=v2.10.0
AIDLC_V2_INSTALL_SH_SHA256=…
AIDLC_V2_INSTALL_PS1_SHA256=…
```
Postconditions: dist file set is exactly the expected set; `pins.env` values equal the lock; all
JSON parses; `claude plugin validate` gate unchanged (WARN-skip if CLI absent;
`AIDLC_REQUIRE_CLAUDE_VALIDATE=1` makes it required).

## Sync (`sync-upstream.sh <tag>`)

Adopt a release by tag. Refuses preview tags unless `--allow-preview` (then signer workflow =
`preview-release.yml`). Steps: download `install.sh`, `install.ps1`, `checksums.txt`,
`version.json`, `aidlc-release.intoto.jsonl` for the tag; verify both installers and
`version.json` against `checksums.txt`; `version.json.version` == tag without `v`,
`sourceRef` == `refs/tags/<tag>`; `git ls-remote` peeled SHA == `sourceDigest`; `gh attestation
verify` both installers against the bundle with the signer workflow and source ref (mandatory;
`SKIP_ATTESTATION=1` bypasses with a loud warning, and the lock's `SYNCED_NOTE` records the
bypass). Then rewrite the lock, rebuild, and print next steps (set the version to mirror; run
`npm test` and `npm run gate`). Never commits. Already pinned at that tag → "nothing to sync",
exit 0.

## Release tag (`tag-release.sh`)

Unchanged scheme `v<version>+up.<short-sha>`; refuses a dirty tree, an existing tag, or a reused
version. Provenance check: the committed `UPSTREAM.lock` and `dist/claude/data/pins.env` agree;
tag message carries the upstream tag, full SHA, and installer hashes.

## Tests

- `test/shim.test.mjs` (deterministic, CI): a fake release dir served via `file://`, a fake
  `install.sh` (records its argv, creates a stub `aidlc` in `$AIDLC_BIN_DIR`), and a stub `aidlc`
  (POSIX sh) whose behavior is scripted per test via a state file (version string, per-subcommand
  exit code and output) and which logs every invocation. Cases: bootstrap verifies hash (mismatch
  → exit 4, installer never executed), runs with `--version <pinned> --yes --quiet` and never
  `--profile`; existing CLI ≥ min is used without bootstrap; CLI < min → exit 5, nothing written;
  legacy migration removes exactly the pristine manifest files, keeps a modified file with its
  reason, never follows a symlinked file or directory, never touches `aidlc/`, strips an exact
  appended `.gitignore` block and leaves a non-matching one; `plan` writes nothing anywhere;
  `apply` without `--yes` → exit 2; conflict path (stub config dry-run exit 4) → exit 3 and the
  log contains no `--force` anywhere; happy path order: `config --pin` → `config --dry-run` →
  `config` → `doctor`; off-PATH CLI → work completes, exit 5 with the PATH line; Windows path via
  `AIDLC_V2_PLATFORM=windows` + stub PowerShell executable (hash-checked `install.ps1`, argv
  `-NoProfile -ExecutionPolicy Bypass -File … -Version <v> -Yes -Quiet`); every stub `aidlc` call
  had stdin redirected (stub records whether stdin is a TTY/readable).
- `test/release-gate.mjs` (network, `npm run gate`, not in `npm test`): sandboxed
  `AIDLC_INSTALL_ROOT`/`AIDLC_BIN_DIR`/`HOME`-independent temp dirs, real pinned release.
  (1) fresh project: `apply` → exit 5 (sandbox bin not on PATH) or 0, then `aidlc doctor` reports
  0 failed, `.aidlc-version` == pinned. (2) legacy project materialized from git:
  `git archive v2.1.4+up.b61e0ed src` → copy `src/.claude`, `src/.mcp.json`, `src/.gitignore`,
  `src/aidlc` into a temp project (exactly what a fresh 2.1.4 install produced) → `apply` → doctor
  0 failed; `aidlc/spaces/default/memory/org.md` unchanged. (3) machine-active version unchanged
  by the pin (compare `aidlc --version` outside the project before/after).
- `test/drift-injection.mjs`: one case per build-contract gate above, plus clean-build-passes,
  fake rejecting `claude` CLI fails the build, and build idempotency.
- `test/dist-fresh.mjs`: unchanged.

`package.json`: `test` = drift-injection, shim.test, dist-fresh; add `gate`; remove `triage`.
CI: drop the bun setup and installer-test env; keep node; run `npm test`.
`.githooks/pre-commit`: trigger on `targets/`, `dist/`, `UPSTREAM.lock`, `package.json`.

## Formatting rules

Blank lines completely empty (no spaces/tabs). No backslash line continuations anywhere (shell,
JS, docs code blocks). Validate workflow YAML with `actionlint`.
