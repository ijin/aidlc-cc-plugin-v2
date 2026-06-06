# Functional Design — Validation Spec

## Inputs

- Artifacts: `business-logic-model.md`, `domain-entities.md`, `business-rules.md`
- Answered question file: `functional-design-questions.md`
- Upstream: `stories.md`, `units-of-work.md`, `units-of-work-story-map.md`, `components.md`, `component-methods.md`, `component-dependencies.md`
- Upstream (if present): `data-models.md`, `event-catalog.md`

## Rules

1. All three artifacts must be present and non-empty.
2. `business-logic-model.md` must declare the unit scope — unit name, stories mapped to this unit (from `units-of-work-story-map.md`), and owning components. Every story mapped to this unit must appear in the unit scope.
3. Every story mapped to this unit must be addressed by at least one business workflow. Any unaddressed story must be flagged with a reason.
4. Every component method referenced in business workflows must exist in the upstream `component-methods.md`. No invented methods.
5. Every domain event in `business-logic-model.md` must be consistent with the upstream `event-catalog.md` (if present) — matching names, producers, and consumers. New events not in the catalogue must be flagged as additions.
6. Every entity in `domain-entities.md` must trace to an entity in the upstream `data-models.md` (if present) with the same owning component. New entities not in the upstream must be flagged as additions.
7. Every entity must have at least one attribute, a defined lifecycle (or explicit statement that it is not stateful), and at least one invariant or an explicit statement that none apply.
8. Entities with complex state lifecycles must include a state machine definition — all states, valid transitions, guard conditions, and entry/exit actions. No implicit transitions.
9. Every business rule must have a unique `BR-<n>` ID, a defined type, a trigger, declarative logic precise enough to implement, and a violation behaviour.
10. Every business rule must trace to at least one story via its `Stories` field. Every story mapped to this unit must be covered by at least one business rule.
11. Business rules must not contradict each other. If two rules can apply to the same trigger and produce conflicting outcomes, the conflict must be documented with a resolution strategy.
12. Rules with complex conditional logic involving multiple variables and outcomes must use a decision table format rather than prose.
13. All artifacts describe business logic only — no language, framework, database, protocol, broker, or vendor specifics.
14. Integration touchpoints in `business-logic-model.md` must reference dependencies declared in the upstream `component-dependencies.md`. No undeclared cross-boundary interactions.
