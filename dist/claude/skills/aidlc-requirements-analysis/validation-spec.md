# Requirements Analysis — Validation Spec

## Inputs

- Artifact: `requirements.md`
- Answered question file: `requirements-analysis-questions.md`
- Upstream: `intent.md`

## Rules

1. All 5 sections defined in the skill's Output must be present. If a section has no content, state "None identified."
2. Every capability stated in the human intent must be traceable to at least one functional or non-functional requirement. Analyse for complete coverage — no capability left unaddressed.
3. Functional requirements must be numbered and verifiable as pass/fail — no vague statements. Use the `FR-<n>` pattern (e.g., FR-1, FR-2).
4. Non-functional requirements must include measurable criteria where possible — no qualitative-only statements without quantification.
5. Assumptions must be explicitly flagged as assumptions, not stated as facts.

## Deterministic post-conditions

Rules 1 and 3 have a deterministic post-condition in `scripts/verify-structure.sh`.
