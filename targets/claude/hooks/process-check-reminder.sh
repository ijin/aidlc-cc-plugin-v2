#!/usr/bin/env bash
# process-check-reminder.sh — Claude Code SubagentStop hook.
#
# Claude analog of upstream's Kiro process-check hook. It is wired in hooks.json
# to the SubagentStop event with matcher `aidlc-builder-agent|aidlc-validator-agent`,
# so it fires exactly when an AI-DLC builder/validator subagent finishes — the
# event matcher does the gating, so this script does not inspect the payload.
#
# It injects a system reminder telling the orchestrator to run process_checker and
# read the checkpoint before advancing, so the deterministic process gate is not
# silently skipped.
#
# Output contract: emit ONLY a JSON object on stdout with
# hookSpecificOutput.additionalContext, then exit 0. Claude inserts
# additionalContext into context VERBATIM — env vars are NOT re-interpolated —
# so ${CLAUDE_PLUGIN_ROOT} is expanded here into a concrete path before emitting.

set -euo pipefail

# Consume stdin (the SubagentStop payload) so the producer never blocks on a full
# pipe; the matcher already gated us, so we don't need the contents.
cat >/dev/null 2>&1 || true

# Concrete path to the process-checker. CLAUDE_PLUGIN_ROOT is exported into this
# hook process by Claude Code; fall back to a path derived from this script's
# location if it is somehow unset.
plugin_root="${CLAUDE_PLUGIN_ROOT:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"}"
checker="${plugin_root}/aidlc-common/scripts/aidlc-process-checker.js"

reminder="MANDATORY: An AI-DLC sub-agent just completed. Before doing anything else, run process_checker and read the checkpoint:
1. Run: node ${checker} --from-state <intent-dir>/state/process-checkpoint.json
2. Read the checkpoint file.
3. If 'error' is not null, follow the 'action' instruction to fix the issue, then re-run process_checker.
4. If 'error' is null, proceed with the step indicated in 'next'.
Do NOT skip this. Do NOT advance to the next step without a PASS from process_checker."

# Prefer jq for safe JSON encoding; fall back to a Node one-liner if jq is absent.
if command -v jq >/dev/null 2>&1; then
  jq -n --arg ctx "$reminder" '{
    hookSpecificOutput: {
      hookEventName: "SubagentStop",
      additionalContext: $ctx
    }
  }'
else
  REMINDER="$reminder" node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SubagentStop",additionalContext:process.env.REMINDER}}))'
fi
exit 0
