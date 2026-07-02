---
name: aidlc
description: Install or update the AI-DLC v2 framework (AI-Driven Development Lifecycle, from awslabs/aidlc-workflows) in the current project, then hand off to the installed /aidlc workflow. Run this once per project, and again after upgrading the plugin. Pass --check to preview changes without writing.
argument-hint: "[--check]"
---

# AI-DLC v2 — install / update

This plugin ships upstream's Claude Code framework tree verbatim and installs it
into the current project (the engine requires living at `<project>/.claude/` —
its hooks and tools resolve paths under the project root). After installation,
every upstream command works exactly as documented: `/aidlc`, `/aidlc-<stage>`,
`/aidlc --doctor`, etc.

Follow these steps exactly. Do not improvise around a failed step.

## 1. Check the prerequisite

Run `bun --version`. If it fails, STOP and tell the user: AI-DLC's tools and
hooks are TypeScript run via bun. Install it with
`curl -fsSL https://bun.sh/install | bash` (Windows: `npm install -g bun`), make
sure `bun` is on the PATH of non-interactive shells (`~/.zshenv` for zsh,
`~/.bashrc` for bash), then re-run this skill.

## 2. Run the installer

From the project root, run:

```
bun "${CLAUDE_PLUGIN_ROOT}/installer/aidlc-install.ts" $ARGUMENTS
```

The installer is idempotent and never overwrites user data silently: on a
FRESH install, any existing file that differs from the framework's is a
CONFLICT (left untouched and reported, exit code 3); on an UPDATE of an
existing install, framework files are refreshed and every differing overwrite
is listed. `settings.json` is additively merged (nothing the user wrote is
changed), `.mcp.json` only gains missing servers, `.gitignore` only gains the
AI-DLC block, the `aidlc/` workspace is seeded only where files are absent,
`.claude/settings.local.json` is never touched, and it refuses to write
through symlinks. `--check` previews without writing.

## 3. Relay the result

Show the installer's report verbatim, then follow ITS guidance:

- On a fresh install or when it says settings changed: tell the user to
  **restart the Claude Code session** (settings.json hooks/permissions load at
  session start) and then run `/aidlc` with a description of what to build.
- When everything is up to date: point the user straight at `/aidlc` (the
  installed orchestrator — not this plugin skill).
- **On exit code 3 (CONFLICTS)**: show the conflict list verbatim and tell the
  user the install is INCOMPLETE until each listed file is moved aside (or
  knowingly kept) and the skill re-run. Do NOT delete, move, or overwrite any
  of those files yourself — resolving them is the user's decision.

If the installer fails, show its error verbatim and stop — do not hand-edit the
project's `.claude/` to work around it.
