# Reverse Engineering — Validation Spec

## Inputs

- Artifacts (always-on): `components.md`, `component-methods.md`, `component-dependencies.md`, `services.md`, `cross-cutting.md`
- Artifacts (conditional, if present): `data-models.md`, `api-contracts.md`, `event-catalog.md`, `external-dependencies.md`
- Artifacts (RE-specific): `technology-stack.md`, `code-structure.md`, `code-quality-assessment.md`
- Artifacts (per-chunk, if applicable): `chunks/<chunk-name>.md`
- Answered question file: `reverse-engineering-questions.md`
- Upstream: `requirements.md` (if available), the target codebase (file system access)

## Rules

1. All forward-flow equivalent artifacts (`components.md`, `component-methods.md`, `component-dependencies.md`, `services.md`, `cross-cutting.md`) must be present and non-empty.
2. Conditional artifacts must be present when applicable: `data-models.md` if persistence exists, `api-contracts.md` if APIs exist, `event-catalog.md` if event-driven, `external-dependencies.md` if external integrations exist.
3. RE-specific artifacts (`technology-stack.md`, `code-structure.md`, `code-quality-assessment.md`) must be present and non-empty.
4. Every component in `components.md` must be traceable to actual source file paths. No hallucinated components.
5. Every dependency in `component-dependencies.md` must reference components that exist in `components.md`.
6. Every entity in `data-models.md` must have exactly one owning component from `components.md`.
7. For medium/large codebases, per-chunk artifacts must exist in `chunks/` and the unified artifacts must be consistent with them.
8. RE artifacts describe what exists — no design recommendations, no future-state proposals, no refactoring suggestions.
9. `technology-stack.md` must list actual versions discoverable from build files (package.json, pom.xml, go.mod, etc.), not guessed versions.
10. No source code may be modified. RE is read-only analysis.
