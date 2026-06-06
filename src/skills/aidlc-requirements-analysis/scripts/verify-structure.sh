#!/bin/bash
# verify-structure.sh — Deterministic post-condition for requirements-analysis.
# Checks validation-spec rules that can be verified structurally:
#   Rule 1: All 5 required sections present
#   Rule 3: Functional requirements are numbered (FR-<n> pattern)
#
# Usage: verify-structure.sh <stage-output-dir>
# Exit 0 on pass, 1 on fail.
set -euo pipefail

STAGE_OUTPUT_DIR="$1"
REQUIREMENTS="$STAGE_OUTPUT_DIR/requirements.md"
FAILURES=""

if [ ! -f "$REQUIREMENTS" ]; then
  echo "FAIL: requirements.md not found in $STAGE_OUTPUT_DIR"
  exit 1
fi

CONTENT=$(cat "$REQUIREMENTS")

# --- Rule 1: All 5 sections must be present ---
# Sections: Intent summary, Functional requirements, Non-functional requirements, Assumptions, Out of scope

check_section() {
  local pattern="$1"
  local name="$2"
  if ! echo "$CONTENT" | grep -qi "$pattern"; then
    FAILURES+="Rule 1: Missing section '$name'\n"
  fi
}

check_section "intent summary" "Intent summary"
check_section "functional requirements" "Functional requirements"
check_section "non-functional requirements" "Non-functional requirements"
check_section "assumptions" "Assumptions"
check_section "out of scope" "Out of scope"

# --- Rule 3: Functional requirements must be numbered (FR-<n> pattern) ---
# Extract the functional requirements section and check for FR- numbering

FR_SECTION=$(echo "$CONTENT" | sed -n '/[Ff]unctional [Rr]equirements/,/^##/p' | sed '$d')

# Skip check if section says "None identified"
if echo "$FR_SECTION" | grep -qi "none identified"; then
  : # No FRs to check
else
  # Check that at least one FR-<n> pattern exists
  if ! echo "$FR_SECTION" | grep -qE "FR-[0-9]+"; then
    FAILURES+="Rule 3: Functional requirements not numbered with FR-<n> pattern\n"
  fi

  # Check for lines that look like requirements but lack FR- prefix
  # (lines starting with - or * or a number that don't contain FR-)
  UNNUMBERED=$(echo "$FR_SECTION" | grep -E "^\s*- |^\s*[0-9]+\." | grep -v "FR-" | grep -v "^##" | grep -v "None identified" || true)
  if [ -n "$UNNUMBERED" ]; then
    FAILURES+="Rule 3: Some functional requirements appear unnumbered:\n$UNNUMBERED\n"
  fi
fi

# --- Report ---

if [ -n "$FAILURES" ]; then
  echo "STRUCTURAL VALIDATION FAILED"
  echo ""
  echo -e "$FAILURES"
  exit 1
fi

echo "STRUCTURAL VALIDATION PASSED"
echo "- All 5 required sections present"
echo "- Functional requirements use FR-<n> numbering"
exit 0
