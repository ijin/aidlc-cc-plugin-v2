# Maintaining aidlc-cc-plugin-v2

Reference for maintainers adopting upstream releases and cutting plugin releases. The README
covers what the plugin is and how to use it; this covers **how it's built, verified, and
released**. `CLAUDE.md` is the terse agent-facing rule list; the authoritative description of the
design is `.design/upstream-installer-shim.md`, and each script's header comment is authoritative
for its behavior.

## The model

Since 2.10.0 the plugin ships **no upstream code**. It is a shim over upstream's own lifecycle
tools, pinned to one upstream release:

- `UPSTREAM.lock` pins the release: tag, peeled commit, release date, signer workflow, and the
  SHA-256 of `install.sh`, `install.ps1`, and `checksums.txt`.
- `targets/claude/build.mjs` turns the lock + authored files into `dist/claude/`:
  the entry skill, the helper `scripts/aidlc-v2.sh`, `data/pins.env` (generated from the lock),
  and the legacy-migration data.
- At run time the helper installs upstream's `aidlc` CLI only if it is missing (verifying the
  installer against the pinned hash), pins the project with `aidlc config --pin`, migrates
  projects set up by our 2.1.x releases, and runs `aidlc config --harness claude` after a
  conflict-checking dry run.

`dist/` is committed and must always equal a fresh build — enforced by `test/dist-fresh.mjs`, the
pre-commit hook (`git config core.hooksPath .githooks`), and CI. **Never hand-edit `dist/`.**

## Adopting an upstream release

```bash
./targets/claude/sync-upstream.sh v2.11.0
```

Upstream cuts stable releases (`vX.Y.Z`) and previews (`vX.Y.Z-preview.YYYYMMDD.N`) from `main`.
Adopt stable releases; previews require `--allow-preview` and are signed by a different workflow.

The script verifies, in order, and stops at the first failure:

1. `install.sh`, `install.ps1`, and `version.json` match the release's `checksums.txt`;
2. `version.json` names this exact version and `refs/tags/<tag>`;
3. the tag's peeled commit (`git ls-remote`) equals `version.json`'s `sourceDigest`;
4. both installers carry a valid Sigstore attestation from upstream's release workflow
   (`gh attestation verify`, using `gh`'s own login; `SKIP_ATTESTATION=1` bypasses with a warning
   that is recorded in the lock's `SYNCED_NOTE`, and `tag-release.sh` then refuses to tag).

Then it rewrites `UPSTREAM.lock`, sets the plugin version in `package.json` and
`.claude-plugin/marketplace.json` to mirror the adopted release, and rebuilds. It never commits.
`--reverify` re-runs every check for the currently pinned tag (and fails if upstream's
`checksums.txt` changed since it was pinned) without changing the pin. Next:

1. Add a `CHANGELOG.md` entry.
2. Read upstream's changelog for the range. Anything that touches `aidlc config` flags, exit
   codes, the hook command shape, the stamp file, or install locations can break the helper —
   that's what the release gate below exercises.
3. `npm test`, then `npm run gate`. Commit, then `npm run tag`.

## Verification

### `npm test` — free and deterministic (every change, CI)

1. **`test/drift-injection.mjs`** — every build-contract gate provably fails on the drift it
   guards (bad lock field, version not mirroring, malformed legacy manifest, skill not invoking the
   helper, helper failing `sh -n`, …), a rejecting `claude plugin validate` fails the build, and
   two builds are byte-identical.
2. **`test/shim.test.mjs`** — the helper against a fake release (`file://`) and a stub `aidlc`
   that logs every call: the installer is hash-checked before it runs and never gets `--profile`;
   an existing CLI is used, an old one is refused; legacy migration removes exactly the pristine
   2.1.4 files, keeps modified files, never follows symlinks, never touches `aidlc/`, and undoes
   the `.gitignore` append exactly; conflicts exit 3 and `--force` never appears; the call order is
   pin → dry run → config → doctor; the Windows path runs `install.ps1` through PowerShell.
3. **`test/dist-fresh.mjs`** — committed `dist/claude/` equals a fresh build.

### `npm run gate` — the real pinned release (before every release; needs network)

Installs the pinned release into throwaway `AIDLC_INSTALL_ROOT`/`AIDLC_BIN_DIR` directories (your
own `aidlc` install is never touched) and runs the helper end to end:

- a fresh project → upstream's `aidlc doctor` reports 0 failed, and `.aidlc-version` is the pin;
- a project exactly as our 2.1.4 release left it (rebuilt from the `v2.1.4+up.b61e0ed` tag) →
  migrated and configured → doctor 0 failed, workspace memory unchanged;
- the machine-active CLI version is the same before and after pinning.

This is the test that catches upstream changing behavior the helper depends on.

### T2a — load smoke (billable; opt-in)

`npm run smoke` loads the built plugin under `claude -p` (one call) and asserts it loads without
errors and exposes exactly `aidlc-v2:aidlc`. Run before a release. Skips without the `claude` CLI
(`AIDLC_REQUIRE_SMOKE=1` to require).

### What is not covered automatically

- **Windows** runs only against stubs in `shim.test.mjs`. A real Windows run (Claude Code's Git
  Bash, `install.ps1`, `aidlc.cmd`) has to be checked by hand on a Windows machine.

### Support notes

- **Stale rehearsal pin.** The 2.1.4 rehearsal pins a scratch copy and unpins it on exit. If the
  helper is killed outright (e.g. `SIGKILL`), the user's `aidlc` pin registry keeps an entry for a
  deleted temp path. It is harmless; remove it with `aidlc config --unpin --project-dir <that
  path>` (the path is printed when the rehearsal starts).

## Build-contract failures

Each message names what's wrong; the fix is always in `targets/claude/` or the lock, never in
`dist/`:

| Failure | Fix |
|---|---|
| a lock field is missing or malformed | re-run `sync-upstream.sh` (never hand-edit the lock) |
| plugin version does not mirror the upstream version | set `package.json` + `marketplace.json` to it (or `-pN`) |
| marketplace version != package.json | bump both together |
| legacy manifest line malformed / unsafe path / duplicate | regenerate it from the `v2.1.4+up.b61e0ed` tag (it should never change) |
| entry skill missing `name: aidlc` or not invoking the helper | fix `targets/claude/plugin/skills/aidlc/SKILL.md` |
| helper fails `sh -n` | fix `targets/claude/plugin/scripts/aidlc-v2.sh` |
| dist file set or `pins.env` disagrees with the lock | a build bug — fix `build.mjs` |
| `claude plugin validate` rejected | read its output; usually the manifest or skill frontmatter |

## Release tags

`npm run tag` mints an annotated `v<version>+up.<upstream-short-sha>` tag (e.g.
`v2.10.0+up.2a88385`). `+up.<short>` is SemVer build metadata — a provenance label, not identity:
never publish two releases that differ only after the `+`. The tag message carries the upstream
tag, full commit, and installer hashes. Protect tags on the remote. The `release-upstream` skill
(`.claude/skills/`, repo-only) drives sync → review → version → gates → commit → tag and stops
before pushing.

## History

- **2.0.0-alpha.1** — transformed upstream's Kiro-shaped `src/` into a self-contained plugin.
- **2.1.4** — vendored upstream's built `dist/claude` verbatim and installed it with our own
  installer (upstream had no installer then).
- **2.10.0** — upstream shipped its own installer, CLI, and lifecycle at GA; the plugin became a
  shim over them. The earlier verification tiers (diff triage, vendored-payload contract, our own
  installer's end-to-end test) went with the vendored payload; see git history.
