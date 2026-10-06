# AI-DLC Claude Code Plugin — v2

A [Claude Code](https://claude.com/claude-code) plugin that sets up the
[AWS AI-DLC Workflows](https://github.com/awslabs/aidlc-workflows) methodology — a structured,
adaptive, agent-orchestrated software development lifecycle — in your projects, with one command.

> **What this plugin is.** Upstream ships AI-DLC v2 with its own installer and an `aidlc` CLI that
> configures each project (`aidlc config --harness claude`). This plugin drives those official
> tools from inside Claude Code, **pinned to an upstream release this repo has verified**, and
> handles the cases upstream's tools refuse or get wrong:
>
> - **Existing Claude Code configuration.** Upstream refuses to configure a project whose
>   `.claude/settings.json` or `.claude/CLAUDE.md` differ from its own — and its `--force`
>   silently replaces your `CLAUDE.md` and drops your own `permissions`. The plugin shows the
>   conflicts and never forces.
> - **Projects set up by this plugin's 2.1.4 release.** Upstream's `aidlc config` cannot upgrade
>   them. The plugin removes exactly the old framework files you never modified, keeps your
>   `aidlc/` workspace and anything you changed, then hands the project to upstream.
> - **Version pinning without side effects.** Each project is pinned to the plugin's version with
>   upstream's own per-project pin; your machine-wide `aidlc` CLI is never re-pointed.
>
> The plugin ships no AI-DLC code itself. If you're happy running upstream's installer and
> `aidlc config` by hand, you don't need it — see upstream's
> [Getting Started](https://github.com/awslabs/aidlc-workflows/blob/main/docs/guide/01-getting-started.md).

## Install & use

Add the marketplace, then install the plugin — adding a marketplace only lists its plugins, it
doesn't install them:

```
/plugin marketplace add ijin/aidlc-cc-plugin-v2
/plugin install aidlc-v2@aidlc-cc-plugin-v2
```

When the install dialog asks for a scope, choose **user** (all your projects) or **local** (you,
in this repo only). Don't choose **project** scope: it writes `.claude/settings.json`, which
`aidlc config` also manages, so setup stops with a conflict on that file. Teammates don't need the
plugin to use a project you've set up — they need the `aidlc` CLI on their `PATH`, and the
committed `.aidlc-version` keeps everyone on the same version.

Then, **in the project where you want AI-DLC**:

```
/aidlc-v2:aidlc              # preview, confirm, then set up (or update) this project
/aidlc-v2:aidlc --check      # preview only — changes nothing
/aidlc-v2:aidlc --mcp none   # set up without upstream's optional MCP servers
```

The command always shows a read-only plan first and asks before changing anything. When it
finishes, **restart the Claude Code session** (the project's hooks load at session start) and use
AI-DLC exactly as upstream documents it:

```
/aidlc Build a URL shortener service    # scope auto-detected
/aidlc --doctor                         # validate the setup
```

Commit `.aidlc-version`, `.claude/`, and `aidlc/` — they are designed to be shared with your team.

### What it does, and where things go

1. **The `aidlc` CLI.** If you don't have it, the plugin downloads the pinned release's official
   installer, checks it against the SHA-256 recorded in this plugin, and runs it. The CLI lands
   where upstream puts it — `~/.local/bin/aidlc` (macOS/Linux) or `%LOCALAPPDATA%\aidlc\bin`
   (Windows) — because the project's hooks call `aidlc` from your `PATH`. Your shell startup files
   are never edited; if that directory isn't on your `PATH`, the plugin tells you the line to add.
   If you already have the CLI (2.8.0 or newer), it is used as-is and never updated or replaced.
2. **The pin.** The project is pinned to the plugin's version (`aidlc config --pin`), which writes
   `.aidlc-version` and installs that version alongside any others. Other projects, and your
   machine-wide default, are unaffected. To follow `aidlc update` instead, run
   `aidlc config --unpin`.
3. **The configuration.** Upstream's `aidlc config --harness claude` writes `.claude/`, the
   `aidlc/` workspace shell, and its managed `.gitignore` block, after a dry run the plugin checks
   for conflicts first.

### Conflicts

If upstream reports conflicts — typically your own `.claude/settings.json` or `.claude/CLAUDE.md`
— the plugin stops before changing your project's files (it checks with a dry run first, and for
2.1.4 projects rehearses the whole migration on a scratch copy), and puts back the project's
previous pin. Move the named files aside, run `/aidlc-v2:aidlc` again, and copy back anything you
still need (for example, your own `permissions` entries into the new `settings.json`). The plugin
never uses `aidlc config --force`.

### Updating and removing

- **Update a project:** upgrade the plugin, then run `/aidlc-v2:aidlc` in the project again.
  Upstream refuses to refresh a project while a workflow is in progress — finish or park it first.
- **Remove:** use upstream's `aidlc uninstall`, then uninstall the plugin. Uninstalling the plugin
  alone leaves your projects and CLI untouched.

### Requirements

- macOS, Linux, or Windows (Claude Code's Git Bash).
- `curl` or `wget`, and `sha256sum` or `shasum` (present on standard systems).
- A model provider for Claude Code. Upstream's config keeps whatever provider Claude Code already
  uses; see upstream's guide for Amazon Bedrock options.
- Optional: the MCP servers added by default include AWS servers launched with `uvx` and your AWS
  credentials. Servers you lack credentials for are simply unavailable; pass `--mcp none` to skip
  them entirely.

## How this relates to v1

Upstream's v1 now lives on its `v1` branch; the separate
[`ijin/aidlc-cc-plugin`](https://github.com/ijin/aidlc-cc-plugin) plugin packages it. Both plugins
can be installed at once.

## Architecture of this repo

```
UPSTREAM.lock             # the pinned upstream release: tag, commit, installer + checksums hashes
targets/claude/
  build.mjs               # builds dist/claude/ from the lock + authored files; enforces the contract
  plugin/
    skills/aidlc/SKILL.md #   the entry skill (/aidlc-v2:aidlc)
    scripts/aidlc-v2.sh   #   the helper: plan/apply (POSIX sh)
    data/                 #   hash manifest of the 2.1.4 framework files + the .gitignore block 2.1.4 appended
  sync-upstream.sh        # adopt a release tag: verify checksums + signed provenance, rewrite the lock
  tag-release.sh          # annotated release tag v<version>+up.<upstream-short-sha>
  smoke.mjs               # T2a load smoke (billable, opt-in)
test/
  drift-injection.mjs     # each build-contract gate fails on its target drift
  shim.test.mjs           # helper behavior against a fake release + stub CLI (free, deterministic)
  release-gate.mjs        # the real pinned release in a sandbox: fresh + legacy projects → doctor (network)
  dist-fresh.mjs          # committed dist/claude == a fresh build
dist/claude/              # the built, committed plugin — what the marketplace installs
.claude-plugin/marketplace.json
```

The plugin's version mirrors the pinned upstream release (`2.10.0`; plugin-only fixes are
`2.10.0-pN`). Release tags add provenance (`v2.10.0+up.<short-sha>`), with the full commit and the
installer hashes in the tag message and in `UPSTREAM.lock`.

## Adopting a new upstream release

```bash
./targets/claude/sync-upstream.sh v2.11.0     # stable tags only, unless --allow-preview
```

The script downloads the release's installers, `checksums.txt`, `version.json`, and its signed
provenance bundle; verifies the installers against the checksums, the release metadata against
the tag and its commit, and the installers' Sigstore attestations against upstream's release
workflow; then rewrites `UPSTREAM.lock` and rebuilds. It **does not commit** — a human reviews
every adoption. Then: set the version to mirror, run `npm test` (free) and `npm run gate` (the
real release, sandboxed), and tag. The guided `release-upstream` skill (repo-only) drives the
whole flow and stops before pushing. Details: **[MAINTAINERS.md](MAINTAINERS.md)**.

## License & attribution

This project is **MIT-0** (MIT No Attribution); see [LICENSE](LICENSE).

The plugin downloads and runs [AWS AI-DLC Workflows](https://github.com/awslabs/aidlc-workflows)
releases (MIT-0, Copyright Amazon.com, Inc.) from upstream's GitHub releases, verified against the
hashes in [`UPSTREAM.lock`](UPSTREAM.lock). `targets/claude/plugin/data/` contains hashes of the
files upstream's v2.1.4 release shipped and a verbatim excerpt of its `.gitignore`, used only to
migrate projects set up by this plugin's 2.1.4 release. **This is an independent community
project, not affiliated with or endorsed by Amazon / AWS.**
