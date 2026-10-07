---
name: aidlc
description: Set up or update AI-DLC (AI-Driven Development Lifecycle, from awslabs/aidlc-workflows) in the current project at the version this plugin pins — installs upstream's `aidlc` CLI if missing, pins the project, and runs `aidlc config --harness claude`. Run once per project, and again after upgrading the plugin. Pass --check to preview without changing anything.
argument-hint: "[--check] [--mcp defaults|none]"
disable-model-invocation: true
---

# AI-DLC — set up or update this project

This plugin does not ship AI-DLC itself. It drives upstream's own installer and
`aidlc config`, pinned to a release this plugin has verified, and handles the
cases upstream's tools refuse: projects set up by this plugin's 2.1.4 release,
and projects with existing Claude Code configuration.

Follow these steps exactly. Never improvise around a failed step, and never
edit the project's `.claude/` or `aidlc/` by hand to make a step pass.

## 1. Preview

Run the read-only plan:

```
sh "${CLAUDE_PLUGIN_ROOT}/scripts/aidlc-v2.sh" plan --project "${CLAUDE_PROJECT_DIR:-$PWD}" $ARGUMENTS
```

Show the user the plan output verbatim, then act on its exit code:

- **0** — if `$ARGUMENTS` contains `--check`, stop here. Otherwise continue to step 2.
- **3 — conflicts.** Handle exactly as described for exit 3 in step 3, then stop.
- **5 — action needed** (for example: the project is already on a newer AI-DLC
  than this plugin pins, the `aidlc` CLI is too old, or the directory is your
  home directory). Relay it and stop.
- **Anything else** — relay the output and stop.

## 2. Confirm

Ask the user to confirm before changing anything (one question). Name in the
question exactly what the plan says will happen — for example: installing the
`aidlc` CLI into their home directory, pinning the project (a committed
`.aidlc-version` file), and, for a project set up by the 2.1.4 plugin, the
number of unmodified old framework files that will be removed. If they decline,
stop.

## 3. Apply

Run apply with the same arguments, except **drop `--check`** (apply rejects it):

```
sh "${CLAUDE_PLUGIN_ROOT}/scripts/aidlc-v2.sh" apply --project "${CLAUDE_PROJECT_DIR:-$PWD}" --yes <arguments without --check>
```

Show the output verbatim, then act on the exit code:

- **0 — done.** Tell the user to **restart the Claude Code session** (the new
  `.claude/settings.json` hooks load at session start), then run `/aidlc` with a
  description of what to build. Remind them to commit `.aidlc-version`,
  `.claude/`, and `aidlc/`.
- **3 — conflicts.** Upstream refused because files it needs to own already
  exist with different content (usually the user's own `.claude/settings.json`
  or `.claude/CLAUDE.md`). Relay the conflict list verbatim, including whether
  the project was changed and any restore command it prints. The user resolves
  them: move each named file aside (then re-run this skill, and copy back
  anything they still need), or keep it and skip AI-DLC for this project.
  **Never run `aidlc config --force` and never move, edit, or delete those
  files yourself** — `--force` silently replaces the user's `.claude/CLAUDE.md`
  and drops their own `permissions` entries from `settings.json`, with no backup.
- **4 — integrity refusal.** The downloaded installer did not match the hash this
  plugin pins. Stop and report it; do not retry with another source or bypass
  the check.
- **5 — action needed.** Relay the output verbatim, then stop. If it is the
  `PATH` instruction, setup itself finished: tell the user to add the line,
  restart the Claude Code session, then run `/aidlc` — the project's hooks
  cannot find `aidlc` until it is on `PATH`. If it is a refusal from upstream
  (for example, a workflow still in progress), tell the user what upstream asks
  for.
- **Anything else — error.** Relay the output verbatim, including any restore
  instructions, and stop.

The project's slash commands (`/aidlc`, `/aidlc-<stage>`, …) come from upstream
and work exactly as upstream documents them. This plugin's own command,
`/aidlc-v2:aidlc`, only sets up and updates.
