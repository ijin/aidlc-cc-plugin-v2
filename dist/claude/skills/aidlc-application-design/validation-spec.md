# Application Design — Validation Spec

## Inputs

- Artifacts (always-on): `components.md`, `component-methods.md`, `component-dependencies.md`, `services.md`, `cross-cutting.md`
- Artifacts (conditional, if present): `data-models.md`, `api-contracts.md`, `event-catalog.md`, `external-dependencies.md`
- Answered question file: `application-design-questions.md`
- Upstream: `requirements.md`, `stories.md`, `personas.md`

## Rules

1. All four always-on artifacts (`components.md`, `component-methods.md`, `component-dependencies.md`, `services.md`) and `cross-cutting.md` must be present and non-empty.
2. Conditional artifacts must be present when applicable: `data-models.md` if persistence exists, `api-contracts.md` if the system exposes APIs, `event-catalog.md` if the system is event-driven, `external-dependencies.md` if external integrations exist. If a conditional artifact is omitted, the reason must be stated in `components.md`.
3. Every component in `components.md` must appear in `component-methods.md` with at least one method and in `component-dependencies.md`.
4. Every service in `services.md` must reference at least one component from `components.md`.
5. Every story in `stories.md` must be addressable by at least one service, component, API, or event. Any unmapped story must be flagged with a reason.
6. Every entity in `data-models.md` must have exactly one owning component listed in `components.md`. No two components may own the same entity.
7. Every API in `api-contracts.md` must use the error format defined in `cross-cutting.md`.
8. Every event in `event-catalog.md` must have at least one producer and at least one consumer mapped to components, services, or external systems.
9. Every external dependency in `external-dependencies.md` must have at least one consumer mapped to a component or service.
10. All artifacts describe logical behaviour — no language, framework, database, protocol, broker, or vendor specifics.
11. Circular dependencies between components must be listed in `component-dependencies.md` with explicit justification.
