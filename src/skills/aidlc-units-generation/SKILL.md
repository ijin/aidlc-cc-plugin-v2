---
name: aidlc-units-generation
description: |
  AI-DLC units-generation skill. Decomposes the system into manageable units of work — logical groupings of components and stories for development purposes. For microservices, each unit becomes an independently deployable service. For monoliths, the single unit represents the entire application with logical modules.

  Invoke explicitly via `/skill aidlc-units-generation` when all upstream design artifacts exist and only this step is needed. For fresh development intents, activate `aidlc-orchestrator` instead.
metadata:
  phase: inception
  stage: units-generation
  per-unit: "false"
  human-clarification: "true"
  plan-creation: "true"
  plan-verification: "true"
  artefact-verification: "true"
---

# Units Generation

Decompose the system into manageable units of work. A unit of work is a logical grouping of stories for development purposes. For microservices, each unit becomes an independently deployable service. For monoliths, the single unit represents the entire application with logical modules. Cross-cutting concerns (auth, logging, error handling) form their own unit, built first so others can depend on it.

## Prerequisites

- `requirements.md` must be approved
- `stories.md` and `personas.md` must be approved
- `components.md`, `component-methods.md`, `component-dependencies.md`, `services.md`, `cross-cutting.md` must be approved (application-design is required — it determines components, methods, and services that get grouped into units)
- If wireframes ran: `screen-structure.md` should be available (informs frontend unit organisation)
- If brownfield, brownfield context must be available

## Input

- `requirements.md`
- `stories.md`, `personas.md`
- `components.md`, `component-methods.md`, `component-dependencies.md`, `services.md`, `cross-cutting.md` (from application-design)
- `screen-structure.md` (if present — from wireframes, informs frontend unit boundaries)
- Brownfield context (if applicable)

## Question Guidance

Focus clarifying questions on:

- How should stories be grouped into units — by domain boundary, by deployment independence, by team ownership, or by feature area?
- What are the integration patterns between units — synchronous calls, async events, shared data stores?
- Are there team structure or ownership constraints that should influence unit boundaries?
- Do different parts of the system have different scalability or deployment requirements that warrant separate units?
- Are there clear bounded contexts in the business domain that map to natural unit boundaries?
- Should cross-cutting concerns (from `cross-cutting.md`) be a dedicated shared/platform unit, or embedded within each unit? (Recommend: dedicated unit built first, others depend on it.)
- (Greenfield multi-unit only) What is the deployment model — microservices with independent deployables, or a monolith with logical modules? What directory structure is preferred?
- (If `screen-structure.md` present) Should frontend screen groups map to separate units, or should all frontend live in one unit?

## Output

Three mandatory artifacts:

### units-of-work.md

One section per unit. Each includes:

- **Name** — unit identifier
- **Type** — service (independently deployable) or module (logical grouping within a service)
- **Purpose** — what this unit does
- **Responsibilities** — what it is accountable for
- **Components** — which components from `components.md` belong to this unit
- **Stories** — which story IDs (`S-<n>`) this unit implements (includes both primary-owned and contributing stories)
- **Code organization strategy** (greenfield only) — directory structure for this unit

### units-of-work-dependency.md

Dependency matrix between units:

- Unit A → Unit B: communication pattern (sync call, async event, shared data)
- Rationale for each dependency
- Build/deployment order implications
- Circular dependencies must be listed with explicit justification

### units-of-work-story-map.md

Complete mapping of every story to units. Format:

- **Story ID** — `S-<n>`
- **Primary unit** — the unit that owns the story's acceptance criteria and is responsible for its completion
- **Contributing units** — other units that participate in fulfilling the story (may be empty)
- **Rationale** — why this assignment was made

Every story from `stories.md` must appear. Every story must have exactly one primary unit. A story may have zero or more contributing units. Cross-cutting stories (e.g. system-wide error handling) typically have the cross-cutting/platform unit as primary, with all other units as contributing.

## Validation

Validation rules for this skill's output live in `validation-spec.md` at the skill root. See `aidlc-common/protocols/aidlc-validator-protocol.md` for how they are applied.
