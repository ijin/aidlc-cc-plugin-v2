# Code Generation — Validation Spec

## Inputs

- Artifacts: `code-generation-plan.md`, `CODE_SUMMARY.md`, generated source code and tests in the workspace
- Answered question file: `code-generation-questions.md`
- Upstream: `components.md`, `component-methods.md`, `component-dependencies.md`, `services.md`, `cross-cutting.md`, `data-models.md` (if present), `api-contracts.md` (if present), `stories.md`, `units-of-work.md`, `units-of-work-story-map.md`
- Upstream (if present): `business-logic-model.md`, `domain-entities.md`, `business-rules.md`, `nfr-requirements.md`, `tech-stack-decisions.md`

## Rules

1. No code may be generated until `code-generation-plan.md` is approved by the human.
2. Code generation must proceed layer by layer. Layer N+1 must not begin until Layer N compiles and its tests pass.
3. Each layer must contain at most 12 files. Prefer 5–8.
4. Unit tests must be generated within the same layer as the code they test — not deferred to a later layer or stage.
5. On compile failure: self-correct up to 3 attempts. On logic/test failure: stop and present to human.
6. Application code goes in the workspace root. Documentation artifacts go in the stage's aidlc-docs folder. Never mix.
7. For brownfield: coding conventions must be extracted from existing files before generating code. Generated code must follow extracted conventions.
8. For brownfield: no existing file may be modified without presenting a diff summary and receiving human approval.
9. Every generated file must be traceable to at least one component in `components.md` and at least one story in `stories.md`.
10. On re-invocation: resume from the first unchecked layer. Do not re-generate layers marked ✅ unless files are missing from disk.
11. Each layer checkpoint requires: all files exist on disk, build passes, layer-specific tests pass.
12. Generated code must implement patterns from `cross-cutting.md` (error handling, logging, validation) — not invent new patterns.
