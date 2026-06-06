---
name: aidlc-application-design
description: |
  AI-DLC application-design skill. Produces the logical component structure — components, methods, dependencies, services, cross-cutting standards, and conditional artifacts for persistence, APIs, events, and external integrations — from approved requirements and stories.

  Invoke explicitly via `/skill aidlc-application-design` when requirements and stories are already written and only this step is needed. For fresh development intents, activate `aidlc-orchestrator` instead.
metadata:
  phase: inception
  stage: application-design
  per-unit: "false"
  human-clarification: "true"
  plan-creation: "true"
  plan-verification: "true"
  artefact-verification: "true"
---

# Application Design

Design the logical component structure of the system — components, their methods, their dependencies, and the services that orchestrate them. Captures what will be built at the component level, independent of technology choices.

## Prerequisites

- `requirements.md` must be approved
- `stories.md` and `personas.md` must be approved
- If wireframes ran: `screen-data-map.md` must be available (informs API surface and BFF decisions)

## Input

- `requirements.md`
- `stories.md`, `personas.md`
- `screen-data-map.md` (if present — from wireframes skill)

## Question Guidance

Analyse `requirements.md` and `stories.md` first. Derive what you can; ask only where genuine ambiguity exists. Focus on:

- Component boundaries: how the system partitions into logical components (by domain, by capability, by layer)
- Component types: stateful vs stateless, services vs libraries
- Communication patterns (logical level): synchronous (request/response) vs asynchronous (events/messages)
- Cross-cutting concerns: where authorisation, logging, validation, error handling live conceptually
- Data ownership: which component owns each domain entity
- Integration points: external systems this design must interface with, at a logical level
- Brownfield impact (if applicable): which existing components are affected, extended, or replaced
- Frontend aggregation (if `screen-data-map.md` present): screens that pull data from multiple components may warrant a BFF (Backend-for-Frontend) layer. Present the options: direct calls from frontend, BFF aggregation, or client-side composition. Let the human decide — do not assume.

## Output

Four always-on artifacts plus conditional artifacts based on system characteristics.

### components.md

One section per component. Each includes:

- **Name**
- **Purpose** — what this component does
- **Responsibilities** — what it is accountable for
- **State** — stateful or stateless
- **Owns** — domain entities it owns (authoritative source of truth)

### component-methods.md

Per component, the methods it exposes. Each method includes:

- **Name**
- **Inputs** — logical types, not language-specific
- **Outputs** — logical types, not language-specific
- **Preconditions** — what must be true before invocation
- **Postconditions** — what must be true after invocation

### component-dependencies.md

Dependency matrix between components:

- Component A → Component B: communication pattern (sync call, async event, shared state)
- Rationale for each dependency
- Any circular dependencies must be listed with explicit justification

### services.md

Service-layer orchestrations that compose components into business workflows. Each service includes:

- **Name**
- **Purpose** — the business workflow it orchestrates
- **Components used** — referenced from `components.md`
- **Operations** — the workflow steps it exposes
- **Stories addressed** — `S-<n>` IDs from `stories.md`

### cross-cutting.md (always)

System-wide standards that every future unit inherits:

- **Error format** — shape of error responses/returns at the logical level
- **Authorisation model** — roles, permissions, policy style (not implementation)
- **Logging taxonomy** — what gets logged, event names, severity levels
- **Validation approach** — where input validation happens (edge, service, component)

### data-models.md (if persistence)

Domain entities owned by the system. Each entity includes:

- **Name**
- **Owning component** — from `components.md`
- **Fields** — logical types, not DB-specific
- **Relationships** — to other entities (one-to-one, one-to-many, many-to-many)
- **Constraints** — business rules, uniqueness, referential integrity
- **Lifecycle** — creation, updates, deletion rules

### api-contracts.md (if system exposes APIs)

Logical API surface. Each API includes:

- **Name** — operation or resource name
- **Purpose**
- **Inputs** — request shape (logical types)
- **Outputs** — response shape (logical types)
- **Errors** — error codes and conditions (from cross-cutting error format)
- **Consumers** — who calls this API

### event-catalog.md (if event-driven)

Events produced or consumed by the system. Each event includes:

- **Name**
- **Purpose**
- **Producer** — component or service
- **Consumers** — components, services, or external systems
- **Payload** — logical types
- **Delivery semantics** — at-least-once, at-most-once, exactly-once
- **Ordering requirements** — strict, partitioned, none

### external-dependencies.md (if external integrations exist)

External systems this design depends on. Each includes:

- **Name** — logical name
- **Purpose** — what this system does for us
- **Contract** — request/response shape or event schema (if known)
- **Failure mode** — expected behaviour on timeout, unavailability, or error
- **Consumers** — which components/services depend on this

## Validation

Validation rules for this skill's output live in `validation-spec.md` at the skill root. See `aidlc-common/protocols/aidlc-validator-protocol.md` for how they are applied.
