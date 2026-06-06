.PHONY: build build-claude clean test triage smoke smoke-workflow score sync tag

build: build-claude

build-claude:
	node targets/claude/build.mjs build

clean:
	node targets/claude/build.mjs clean

# Meta-verification: contract-gate drift tests, the T1 triage classifier, and the
# T3 deterministic scorer (parity-locked to upstream's Python heuristic scorer).
test:
	node test/drift-injection.mjs
	node test/triage.test.mjs
	node test/score.test.mjs

# T1 diff-triage: classify what upstream changed (AUTO/CONTRACT/ESCALATE) before
# adopting a snapshot. Pass the target SHA: make triage SHA=<sha>
triage:
	node targets/claude/sync-triage.mjs $(SHA)

# T2a headless load smoke: run dist/claude under `claude -p` and assert it loads &
# wires up (plugin/skills/agents present, run completes). Needs the claude CLI.
smoke:
	node targets/claude/smoke.mjs

# T2b autonomous workflow smoke (EXPENSIVE: real Bedrock time/$). Runs the
# orchestrator end-to-end with interaction gates flipped off.
smoke-workflow:
	node targets/claude/smoke.mjs --workflow

# T3 deterministic quality score: a candidate aidlc-docs/ tree vs a committed
# golden master. Report-only, or pass MIN to gate:
#   make score CAND=<dir> GOLD=<dir> [MIN=0.8]
score:
	node targets/claude/score.mjs $(CAND) $(GOLD) $(if $(MIN),--min $(MIN),)

# Refresh vendored src/ from upstream at a SHA (or branch tip), then build.
# Pass a SHA via: make sync SHA=<sha>
sync:
	bash targets/claude/sync-upstream.sh $(SHA)

# Mint an annotated release tag v<version>+up.<upstream-short-sha>.
tag:
	bash targets/claude/tag-release.sh
