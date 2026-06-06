# Units Generation — Validation Spec

## Inputs

- Artifacts: `units-of-work.md`, `units-of-work-dependency.md`, `units-of-work-story-map.md`
- Answered question file: `units-generation-questions.md`
- Upstream: `requirements.md`, `stories.md`, `components.md`, `component-methods.md`, `component-dependencies.md`, `services.md`, `cross-cutting.md`
- Upstream (if present): `screen-structure.md`

## Rules

1. All three artifacts (`units-of-work.md`, `units-of-work-dependency.md`, `units-of-work-story-map.md`) must be present and non-empty.
2. Every component in `components.md` must be assigned to exactly one unit in `units-of-work.md`. No component may be unassigned or assigned to multiple units.
3. Every story in `stories.md` must appear in `units-of-work-story-map.md` with exactly one primary unit. No story may be unassigned or have multiple primary units.
4. Every unit in `units-of-work.md` must have at least one component and at least one story (as primary owner) assigned.
5. Every dependency in `units-of-work-dependency.md` must reference units defined in `units-of-work.md`. No references to undefined units.
6. Circular dependencies between units must be listed with explicit justification. Unjustified circular dependencies are a failure.
7. The decomposition must not introduce units beyond what is traceable to `components.md`, `services.md`, and `stories.md`. Gaps are raised as findings, not silently added.
8. Each unit must have a clear type designation (service or module) consistent with the deployment model discussed in the question answers.
9. Story assignments in `units-of-work-story-map.md` must be consistent with the Stories field in `units-of-work.md`. Every story listed under a unit in `units-of-work.md` must have that unit as either primary or contributing in `units-of-work-story-map.md`, and vice versa.
10. Every story with contributing units must have a rationale explaining why it spans multiple units. Multi-unit assignment without rationale is a failure.
11. Cross-cutting components (from `cross-cutting.md`) must be assigned to a unit. If a dedicated cross-cutting/platform unit exists, it should have no upstream unit dependencies (other units depend on it, not the reverse).
