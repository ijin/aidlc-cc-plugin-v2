# Infrastructure Design — Validation Spec

## Inputs

- Artifacts: `infrastructure-design.md`, `deployment-architecture.md`
- Answered question file: `infrastructure-design-questions.md`
- Upstream: `nfr-requirements.md`, `tech-stack-decisions.md`, `components.md`, `component-dependencies.md`, `services.md`, `cross-cutting.md`, `units-of-work.md`, `units-of-work-dependency.md`
- Upstream (if present): `nfr-design-patterns.md`, `logical-components.md`, `business-logic-model.md`, `domain-entities.md`

## Rules

1. Both artifacts (`infrastructure-design.md`, `deployment-architecture.md`) must be present and non-empty.
2. Every logical component that requires infrastructure (from `logical-components.md` or `components.md` scoped to this unit) must have an entry in `infrastructure-design.md`. No component left unmapped.
3. Every infrastructure service chosen must be consistent with `tech-stack-decisions.md`. If a decision says "PostgreSQL," the infrastructure must not map to a different database engine.
4. Every NFR requirement in `nfr-requirements.md` that has infrastructure implications (performance targets, availability, scalability) must be addressed by a concrete mechanism in `infrastructure-design.md` or `deployment-architecture.md`. Unaddressed NFRs must be flagged.
5. Scaling strategy in `deployment-architecture.md` must reference the scalability requirements from `nfr-requirements.md` — specific triggers, thresholds, and capacity limits.
6. Failover and recovery mechanisms must map to the RTO/RPO targets defined in `nfr-requirements.md`. If the mechanism cannot meet the target, the gap must be documented.
7. Security infrastructure (encryption, IAM, secrets) must be consistent with security requirements in `nfr-requirements.md` and patterns in `cross-cutting.md`.
8. Inter-unit connectivity must be consistent with `units-of-work-dependency.md` — every dependency between this unit and others must have a corresponding infrastructure-level connection mechanism.
9. Platform assumptions must be explicitly stated. No implicit dependencies on infrastructure that isn't documented.
10. All infrastructure choices must be concrete and deployable — no abstract placeholders like "a database" or "some queue." Specific service names, versions, and configurations are required.
11. Cost estimates must be present for each infrastructure service. Estimates may be approximate but must reference the expected load from `nfr-requirements.md`.
12. Infrastructure-as-code notes in `deployment-architecture.md` must recommend a specific IaC tool and describe module/stack boundaries. The recommendation must be consistent with `tech-stack-decisions.md`.
