# NFR Design — Validation Spec

## Inputs

- Artifacts: `nfr-design-patterns.md`, `logical-components.md`
- Answered question file: `nfr-design-questions.md`
- Upstream: `nfr-requirements.md`, `tech-stack-decisions.md`, `business-logic-model.md`, `domain-entities.md`, `components.md`, `component-methods.md`, `component-dependencies.md`, `cross-cutting.md`
- Upstream (if present): `api-contracts.md`, `event-catalog.md`, `external-dependencies.md`

## Rules

1. Both artifacts (`nfr-design-patterns.md`, `logical-components.md`) must be present and non-empty.
2. Every NFR requirement in `nfr-requirements.md` that implies a design pattern or logical component must be addressed by at least one pattern in `nfr-design-patterns.md` or one component in `logical-components.md`. Unaddressed NFRs must be flagged with a reason.
3. Every pattern must reference a specific NFR requirement ID from `nfr-requirements.md`. No patterns without traceability.
4. Every pattern must be applied to a specific component, service, or integration touchpoint that exists in the upstream `components.md` or `business-logic-model.md`. No invented application points.
5. Patterns applied to the same component must document their interaction and ordering (e.g. retry before circuit breaker, or after?). Conflicting patterns on the same component without a resolution strategy are a failure.
6. Every logical component in `logical-components.md` must have a clear position in the component topology referencing upstream `components.md` or `component-dependencies.md`.
7. Every logical component must specify a failure mode. Components without failure mode documentation are a failure.
8. Configuration parameters in patterns must include recommended defaults derived from NFR targets (e.g. "timeout: 3s based on p95 target of 5s"). Parameters without rationale are a failure.
9. All artifacts describe logical design only — no vendor-specific service names, no cloud provider references, no infrastructure-tier details. Those belong to infrastructure-design.
10. Patterns and components must not contradict the standards defined in upstream `cross-cutting.md`. Extensions are acceptable; contradictions are not.
11. The design must not introduce patterns or components beyond what is traceable to `nfr-requirements.md`. Over-engineering without NFR justification is a failure.
