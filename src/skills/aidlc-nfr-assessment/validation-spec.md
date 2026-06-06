# NFR Assessment — Validation Spec

## Inputs

- Artifacts: `nfr-requirements.md`, `tech-stack-decisions.md`
- Answered question file: `nfr-assessment-questions.md`
- Upstream: `requirements.md`, `business-logic-model.md`, `domain-entities.md`, `business-rules.md`, `components.md`, `component-methods.md`, `component-dependencies.md`, `cross-cutting.md`, `units-of-work.md`, `units-of-work-story-map.md`

## Rules

1. Both artifacts must be present and non-empty.
2. `nfr-requirements.md` must declare the unit scope — unit name, owning components, and a summary of functional complexity.
3. Every NFR in `requirements.md` that is relevant to this unit must be addressed in `nfr-requirements.md`. Any NFR not addressed must be flagged with a reason (e.g., not applicable to this unit).
4. Performance requirements must reference specific business workflows from the upstream `business-logic-model.md`. No invented operations.
5. Reliability requirements must address dependency failure handling for every integration touchpoint declared in the upstream `business-logic-model.md`.
6. Security requirements must address data classification for every entity in the upstream `domain-entities.md`.
7. Observability requirements must extend (not contradict) the logging taxonomy defined in the upstream `cross-cutting.md`.
8. Every NFR requirement must include an NFR traceability reference back to the identifiers in `requirements.md`.
9. Every tech stack decision must have a unique `TSD-<n>` ID, a category, a choice, alternatives considered, a rationale referencing specific NFR requirements, and documented trade-offs.
10. Tech stack decisions must not contradict each other. If two decisions create tension (e.g., a database choice that conflicts with a latency requirement), the tension must be documented with a resolution.
11. Tech stack decisions must not contradict constraints or standards defined in the upstream `cross-cutting.md`.
