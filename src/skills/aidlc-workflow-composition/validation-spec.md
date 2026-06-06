# Workflow Composition — Validation Spec

## Inputs

- Artifacts: `workflow.md` (at intent root), `workflow-rationale.md`
- Answered question file: `workflow-composition-questions.md`
- Upstream: `intent.md`, `bootstrap-context.md`, `skills/aidlc-orchestrator/CATALOGUE.md`

## Rules

1. `workflow.md` must exist at the intent root and contain at least one non-comment, non-empty line.
2. `workflow.md` must NOT contain any `intent-bootstrap` or `workflow-composition` lines — by the time this skill writes the file, both bootstrap skills have completed. Every line must be a downstream skill.
3. Every skill name in `workflow.md` must exist in `CATALOGUE.md`.
4. Every line must follow `aidlc-workflow-format.md` syntax — skill name first, optional `--phase`/`--unit` flags, then input file paths.
5. Construction-phase skills in `workflow.md` must include either `--phase construction` (single-pass) or `--unit <unit-name>` (per-unit fan-out, which implies construction). Operations-phase skills must include `--phase operations`. Inception-phase skills must omit both flags. This routes artifacts to the correct subtree per the folder-structure convention.
6. `workflow-rationale.md` must include a bullet for each downstream skill explaining inclusion or skip.
