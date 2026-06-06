---
name: aidlc-nfr-design
description: |
  AI-DLC nfr-design skill. Incorporates NFR requirements into unit design by selecting design patterns (resilience, scalability, performance, security) and defining logical components (caches, queues, circuit breakers, load balancers) that satisfy the NFR targets. Bridges the gap between nfr-assessment (what quality attributes are needed) and infrastructure-design (where they run).

  Invoke explicitly via `/skill aidlc-nfr-design --unit <unit>` when all upstream artifacts exist and only this step is needed. For fresh development intents, activate `aidlc-orchestrator` instead.
metadata:
  phase: construction
  stage: nfr-design
  per-unit: "true"
  human-clarification: "true"
  plan-creation: "true"
  plan-verification: "true"
  artefact-verification: "true"
---

# NFR Design

Incorporate NFR requirements into unit design using patterns and logical components. This skill takes the NFR targets and tech stack decisions from nfr-assessment and produces the design patterns and logical infrastructure components that will satisfy those targets.

Where nfr-assessment answered "how well must it perform, and with what technologies," NFR design answers "what patterns and components achieve those targets." The output feeds directly into infrastructure-design (which maps logical components to concrete services) and code-generation (which implements the patterns).

## Prerequisites

- NFR assessment must be complete for this unit — `nfr-requirements.md`, `tech-stack-decisions.md` must be approved
- Functional design must be complete — `business-logic-model.md`, `domain-entities.md`, `business-rules.md`
- Application design artifacts must be available — `components.md`, `component-methods.md`, `component-dependencies.md`, `services.md`, `cross-cutting.md`

## Input

- `nfr-requirements.md`, `tech-stack-decisions.md` (from nfr-assessment)
- `business-logic-model.md`, `domain-entities.md`, `business-rules.md` (from functional-design)
- `components.md`, `component-methods.md`, `component-dependencies.md`, `services.md`, `cross-cutting.md` (from application-design)
- Conditional application design artifacts if present: `data-models.md`, `api-contracts.md`, `event-catalog.md`, `external-dependencies.md`

## Question Guidance

Analyse the NFR requirements and tech stack decisions first. Derive what you can; ask only where genuine ambiguity remains that would materially affect pattern or component selection. Focus on:

- **Resilience patterns** — circuit breakers, retries, bulkheads, timeouts, fallbacks. Which integration touchpoints need which patterns? What are the failure budgets?
- **Scalability patterns** — horizontal scaling, sharding, partitioning, CQRS, event sourcing. Which components need which scaling approach? What are the scaling triggers and limits?
- **Performance patterns** — caching strategy (read-through, write-behind, TTL), connection pooling, batching, async processing, lazy loading. Which operations are latency-sensitive?
- **Security patterns** — authentication flow, token management, encryption boundaries, rate limiting, input sanitisation. Which boundaries need which security controls?
- **Data patterns** — replication strategy, consistency model (eventual vs strong), backup approach, data partitioning scheme.
- **Observability patterns** — health check design, metric collection points, distributed tracing propagation, log correlation strategy.
- **Logical components** — caches, message queues, load balancers, API gateways, service meshes, CDNs, secret stores. Which are needed and where do they sit in the component topology?

Do not ask about specific infrastructure services (AWS SQS vs RabbitMQ, Redis vs Memcached) — those belong to infrastructure-design. NFR design works at the logical level: "a message queue here," "a cache in front of this," "a circuit breaker on this call."

## Output

Two artifacts:

### nfr-design-patterns.md

Design patterns selected for this unit, organised by NFR category:

- **Pattern name**
- **Category** — resilience, scalability, performance, security, data, or observability
- **NFR addressed** — which requirement from `nfr-requirements.md` this pattern satisfies (with ID reference)
- **Applied to** — which component, service, or integration touchpoint (referencing `components.md` or `business-logic-model.md`)
- **Behaviour** — how the pattern works in this context (trigger conditions, thresholds, fallback behaviour)
- **Configuration parameters** — tuneable values (timeout duration, retry count, cache TTL, pool size, etc.) with recommended defaults derived from NFR targets
- **Trade-offs** — what this pattern costs (latency overhead, complexity, eventual consistency, etc.)
- **Interaction with other patterns** — how this pattern composes with others applied to the same component (e.g. retry + circuit breaker ordering)

### logical-components.md

Logical infrastructure components introduced by the NFR design. Each includes:

- **Component name** — descriptive logical name (e.g. "order-cache", "payment-circuit-breaker", "event-queue")
- **Type** — cache, queue, load balancer, circuit breaker, rate limiter, secret store, CDN, service mesh, health checker, or other
- **Purpose** — what NFR requirement it serves
- **Position** — where it sits in the component topology (between which components, in front of which service)
- **Inputs/Outputs** — what flows through it
- **Configuration** — logical configuration (capacity, TTL, thresholds, policies) — not vendor-specific
- **Failure mode** — what happens when this component itself fails (graceful degradation, bypass, alert)
- **Downstream consumers** — which skills/artifacts need to know about this component (infrastructure-design maps it to a service, code-generation implements the integration)

## Validation

Validation rules for this skill's output live in `validation-spec.md` at the skill root. See `aidlc-common/protocols/aidlc-validator-protocol.md` for how they are applied.
