---
name: aidlc-nfr-assessment
description: |
  AI-DLC nfr-assessment skill. Produces `nfr-requirements.md` and `tech-stack-decisions.md` for a single construction unit, given approved functional-design artifacts. This is the first construction-phase point at which technology choices are made explicit.

  Invoke explicitly via `/skill aidlc-nfr-assessment --unit <unit>` when all upstream artifacts exist and only this step is needed. For fresh development intents, activate `aidlc-orchestrator` instead.
metadata:
  phase: construction
  stage: nfr-assessment
  per-unit: "true"
  human-clarification: "true"
  plan-creation: "true"
  plan-verification: "true"
  artefact-verification: "true"
---

# NFR Assessment

Assess the non-functional requirements for a unit and make technology stack decisions. This skill bridges technology-agnostic functional design and technology-specific NFR design — it determines what quality attributes the unit must satisfy and which technologies will be used to achieve them.

Where functional design answered "what does the unit do in business terms," NFR assessment answers "how well must it do it, and with what technologies." This is the first point in the construction phase where technology choices are made explicit.

## Prerequisites

- Functional design must be complete for this unit — `business-logic-model.md`, `domain-entities.md`, `business-rules.md` must be approved
- Application design artifacts must be available
- `requirements.md` must be available (for NFR traceability)
- Units generation must be complete — `units-of-work.md` and `units-of-work-story-map.md` must be available

## Input

- Unit context: `units-of-work.md`, `units-of-work-story-map.md`
- Functional design artifacts: `business-logic-model.md`, `domain-entities.md`, `business-rules.md`
- Application design artifacts: `components.md`, `component-methods.md`, `component-dependencies.md`, `services.md`, `cross-cutting.md`
- Conditional application design artifacts if present: `data-models.md`, `api-contracts.md`, `event-catalog.md`, `external-dependencies.md`
- `requirements.md`

## Question Guidance

Analyse the functional design artifacts, the application design, and the NFRs from `requirements.md` first. Ask only where genuine ambiguity remains that would materially affect NFR or technology decisions. Focus on:

- **Performance requirements**: Response time targets, throughput, latency-sensitive paths.
- **Scalability requirements**: Load patterns (steady, bursty, seasonal), growth projections, scaling triggers, capacity ceilings.
- **Availability requirements**: Uptime, RTO, RPO. Per-operation availability tiers.
- **Security requirements**: Data classification, authentication/authorisation beyond `cross-cutting.md`, compliance obligations (GDPR, HIPAA, PCI-DSS, SOC2) specific to this unit.
- **Reliability requirements**: Fault tolerance, dependency failure behaviour, error budgets.
- **Observability requirements**: Metrics, logs, traces, alerting thresholds, SLA reporting.
- **Data requirements**: Volume estimates, retention, archival, residency.
- **Technology preferences and constraints**: Organisational mandates, existing investments, exclusions.
- **Integration constraints**: Protocol or format requirements imposed by external systems.
- **Brownfield considerations** (if applicable): Existing technology stack, what can change, migration risks.

## Output

Two artifacts.

### nfr-requirements.md

The non-functional requirements specific to this unit, derived from `requirements.md` and refined based on the functional design:

- **Unit scope** — unit name, owning components, summary of functional complexity
- **Performance requirements** — per key operation: target response time, throughput, latency constraints. Reference business workflows from `business-logic-model.md`.
- **Scalability requirements** — expected load, growth projections, scaling dimensions, scaling triggers
- **Availability requirements** — uptime target, RTO, RPO, per-operation tiers
- **Security requirements** — data classification per entity, authentication/authorisation needs beyond `cross-cutting.md`, compliance obligations, encryption (at rest, in transit)
- **Reliability requirements** — fault tolerance, dependency failure handling per integration touchpoint, error budgets
- **Observability requirements** — key metrics, logging taxonomy (extending `cross-cutting.md`), tracing, alerting
- **Data requirements** — volume estimates, retention, archival, residency
- **NFR traceability** — each requirement must reference the NFR identifiers from `requirements.md` that it refines or satisfies

### tech-stack-decisions.md

Technology choices for this unit, with rationale. Each decision includes:

- **Decision ID** — `TSD-<n>`, sequential within the unit
- **Category** — language, framework, database, messaging, API protocol, authentication, observability, or other
- **Choice** — the selected technology
- **Alternatives considered** — other options evaluated
- **Rationale** — why this choice was made, referencing specific NFR requirements from `nfr-requirements.md`
- **Trade-offs** — what is gained and what is sacrificed
- **Constraints** — any limitations or risks introduced
- **Brownfield impact** (if applicable) — how this choice interacts with the existing technology stack

## Validation

Validation rules for this skill's output live in `validation-spec.md` at the skill root. See `aidlc-common/protocols/aidlc-validator-protocol.md` for how they are applied.
