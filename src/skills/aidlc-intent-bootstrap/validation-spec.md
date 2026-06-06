# Intent Bootstrap — Validation Spec

## Inputs

- Artifacts: `intent.md` (at intent root), `bootstrap-context.md` (in `bootstrap/intent-bootstrap/`)
- Skeleton files: `intent-prompt.md`, `state/intent-state.md`, `audit/intent-audit.md`, `workflow.md` (all at intent root)
- Answered question file: `intent-bootstrap-questions.md` (in `bootstrap/intent-bootstrap/`)
- Upstream: none — this skill receives the intent statement directly from the orchestrator and produces everything else

## Rules

1. The intent directory exists under `org-ai-kb/aidlc-docs/` and follows the pattern `intent-<nnn>-<slug>/` where `<nnn>` is a zero-padded 3-digit number and `<slug>` is kebab-case.
2. `intent-prompt.md` exists at the intent root and contains the verbatim user prompt.
3. `state/intent-state.md` exists and matches the header format defined in `aidlc-common/conventions/aidlc-state-schema.md` (intent name, created/updated timestamps, Workflow Progress table header).
4. `audit/intent-audit.md` exists at the intent root.
5. `workflow.md` exists at the intent root and contains exactly one non-comment, non-empty line: the `workflow-composition` line invoking `--phase bootstrap`. It must NOT contain an `intent-bootstrap` line.
6. `intent.md` exists at the intent root and contains: the verbatim user prompt, a summary, a slug, and a type.
7. `bootstrap-context.md` exists in `bootstrap/intent-bootstrap/` and states: classification (greenfield, brownfield, or mixed), repos in scope (or "none"), codekb status, and a reverse-engineering decision.
8. The slug in `intent.md` matches the slug in the intent directory name.
9. The classification, repos, and reverse-engineering decision in `bootstrap-context.md` are consistent with the answers in `intent-bootstrap-questions.md`.
