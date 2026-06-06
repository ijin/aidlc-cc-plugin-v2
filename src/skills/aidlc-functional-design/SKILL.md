---
name: aidlc-functional-design
description: |
  AI-DLC functional-design skill. Produces `business-logic-model.md`, `domain-entities.md`, and `business-rules.md` for a single construction unit, given approved application-design and units-of-work artifacts. Technology-agnostic.

  Invoke explicitly via `/skill aidlc-functional-design --unit <unit>` when all upstream artifacts exist and only this step is needed. For fresh development intents, activate `aidlc-orchestrator` instead.
metadata:
  phase: construction
  stage: functional-design
  per-unit: "true"
  human-clarification: "true"
  plan-creation: "true"
  plan-verification: "true"
  artefact-verification: "true"
---

# Functional Design

Design the detailed business logic for a unit using domain-driven design principles — domain entities, business rules, state lifecycles, and the behavioural model that governs how the unit fulfils the stories mapped to it. Strictly technology-agnostic: captures what the unit does in business terms, not how it is implemented.

This skill refines and deepens the application design. Where application design established component boundaries, methods, and dependencies at a system-wide level, functional design zooms into a single unit and models its internal business logic with enough precision to implement without further clarification.

## Prerequisites

- Application design artifacts must be approved (`components.md`, `component-methods.md`, `component-dependencies.md`, `services.md`, `cross-cutting.md`, and any conditional artifacts)
- Units generation must be complete — `units-of-work.md` and `units-of-work-story-map.md` must be available
- `stories.md` must be approved

## Input

- Unit context: `units-of-work.md`, `units-of-work-story-map.md`
- Application design artifacts: `components.md`, `component-methods.md`, `component-dependencies.md`, `services.md`, `cross-cutting.md`
- Conditional application design artifacts if present: `data-models.md`, `api-contracts.md`, `event-catalog.md`, `external-dependencies.md`
- `stories.md`

## Question Guidance

Analyse the unit definition, the story mapping, and the application design artifacts first. Derive what you can; ask only where genuine ambiguity remains that would materially affect the quality of the functional design. Focus on:

- **Domain entities**: Are the entities assigned to this unit's components (from `data-models.md`) complete? Are there missing attributes, relationships, or lifecycle rules that the application design left abstract?
- **Business rules**: What decision logic, validation rules, and constraints govern the unit's behaviour? Which rules are hard constraints vs. soft constraints (preferences, defaults)?
- **State transitions**: Do any entities have lifecycle states? What triggers transitions, and what are the invariants that must hold at each state? Are there terminal states?
- **Business workflows**: How do the services and component methods assigned to this unit compose into end-to-end business flows? What are the happy paths and the exception paths?
- **Edge cases and error scenarios**: What happens when inputs are invalid, dependencies are unavailable, or business rules conflict? What are the boundary conditions?
- **Calculations and algorithms**: Are there formulas, scoring models, ranking algorithms, or transformation logic that need precise definition?
- **Domain events**: What domain-significant events does this unit produce or consume? What are the triggers and consequences?
- **Concurrency and contention**: When multiple actors can modify the same entity simultaneously, what are the conflict resolution rules?
- **Data derivation and aggregation**: Are there computed or derived fields? What are the source fields and computation rules? When are they recalculated?
- **Temporal rules**: Are there time-dependent business rules — expiration, scheduling, time windows, SLAs, grace periods?
- **Multi-tenancy** (if applicable): How does tenant isolation affect business rules and entity boundaries?
- **Brownfield considerations** (if applicable): Which existing business rules must be preserved? Are there undocumented behaviours that need to be captured?

## Output

Three artifacts.

### business-logic-model.md

The behavioural model of the unit:

- **Unit scope** — unit name, stories mapped to this unit (`S-<n>` IDs from `units-of-work-story-map.md`), owning components
- **Business workflows** — per service operation assigned to this unit: step-by-step flow, decision points, branching logic, error handling. Reference component methods from `component-methods.md`.
- **Domain events** — events produced and consumed within this unit's scope, with triggers, payload descriptions, and downstream consequences. Must be consistent with `event-catalog.md` if present.
- **Integration touchpoints** — where this unit's workflows interact with components or services outside its boundary. Reference `component-dependencies.md` for the communication pattern.

### domain-entities.md

Detailed entity definitions for all entities owned by this unit's components. Refines and extends `data-models.md`:

- **Entity name** — from `data-models.md`
- **Owning component** — from `components.md`
- **Attributes** — complete list with logical types, optionality, default values. Include derived/computed attributes with their computation rules.
- **Relationships** — to other entities, with cardinality and navigation direction
- **Invariants** — conditions that must always hold true for the entity
- **Lifecycle** — states (if stateful), transitions, triggers, and guards for each transition. For entities with complex state lifecycles, include a state machine definition: enumerate all states, valid transitions, guard conditions, and entry/exit actions. If the entity is not stateful, state this explicitly.
- **Constraints** — uniqueness, referential integrity, and business-rule-derived constraints
- **Concurrency** — conflict resolution strategy when concurrent modifications are possible (if applicable)

### business-rules.md

Explicit catalogue of every business rule:

- **Rule ID** — `BR-<n>`, sequential within the unit
- **Name** — short descriptive name
- **Description** — what the rule enforces or decides
- **Type** — constraint, validation, calculation, authorisation, or state-transition
- **Trigger** — when the rule is evaluated
- **Logic** — declarative expression (if-then, formula, table, or decision tree). Rules with complex conditional logic involving multiple variables and outcomes must use a decision table format.
- **Violation behaviour** — what happens when the rule is violated
- **Stories** — `S-<n>` IDs this rule supports, traceable via `units-of-work-story-map.md`

## Validation

Validation rules for this skill's output live in `validation-spec.md` at the skill root. See `aidlc-common/protocols/aidlc-validator-protocol.md` for how they are applied.
