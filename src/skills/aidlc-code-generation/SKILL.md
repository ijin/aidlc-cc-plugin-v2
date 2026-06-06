---
name: aidlc-code-generation
description: |
  AI-DLC code-generation skill. Generates production-ready code in small, testable layers — models, business logic, API, integration — with per-layer build verification and checkpoint tracking. Designed for re-invocation; state is tracked via per-layer checkboxes in the plan.

  Invoke explicitly via `/skill aidlc-code-generation --unit <unit>` when all upstream design artifacts exist and only this step is needed. For fresh development intents, activate `aidlc-orchestrator` instead.
metadata:
  phase: construction
  stage: code-generation
  per-unit: "true"
  human-clarification: "true"
  plan-creation: "true"
  plan-verification: "true"
  artefact-verification: "true"
---

# Code Generation

Generate production-ready code in small, testable chunks following a layered approach. Each layer is built, tested, and verified before proceeding to the next. Designed for re-invocation — state is tracked via per-layer checkboxes in the plan.

## Prerequisites

- Application Design artifacts must be approved (from `inception/application-design/` or `inception/reverse-engineering/`)
- Unit Design / Functional Design must be approved (if applicable)
- For brownfield: RE artifacts must be available for coding convention extraction

## Input

- `components.md`, `component-methods.md`, `component-dependencies.md`, `services.md`
- `cross-cutting.md`, `data-models.md`, `api-contracts.md` (as applicable)
- `units-of-work.md` and unit assignment (if per-unit execution)
- `functional-design/` artifacts (if applicable — business logic and rules to implement)
- For brownfield: `technology-stack.md`, `code-structure.md` from RE, plus the target codebase

## Layered Chunking Strategy

Code generation proceeds layer by layer. Each layer is a small batch of related files that can be built and tested independently.

### Layer ordering (adapt to architecture style)

**Layered / MVC:**
1. Models — entities, DTOs, enums, migrations
2. Business Logic — services, validators, domain logic + unit tests
3. API — controllers, routes, middleware + API tests
4. Integration — external clients, event publishers, configuration

**Hexagonal / Clean / Ports-and-Adapters:**
1. Domain Core — entities, value objects, domain services, port interfaces
2. Application — use cases, DTOs, application services
3. Inbound Adapters — controllers, event listeners, CLI handlers
4. Outbound Adapters — repository implementations, external clients
5. Configuration — DI wiring, env config, migrations

**Frontend:**
1. Foundation — layout, navigation, routing, design system setup
2. Pages — page components with data fetching
3. Features — feature components, state management, forms
4. Shared — reusable components, utilities, API client hooks

### Layer rules

- Each layer: 5–8 files maximum. If more, split into sub-layers (2a, 2b).
- Unit tests are co-located with their layer — not deferred to end.
- Each layer must compile independently — no forward references to ungenerated layers.

## Question Guidance

Focus clarifying questions on:
- Implementation priority if component order is ambiguous
- Error handling approach if not specified in `cross-cutting.md`
- Logging and observability level needed
- For brownfield: confirm extracted coding conventions are correct

Do not ask about architecture, tech stack, component structure, or business logic — these are decided in prior artifacts.

## Execution Model

### On each invocation:
1. Read the plan. Find the first layer without a ✅ marker.
2. For partially-completed layers, verify checked files exist on disk. Re-generate any missing.
3. Generate unchecked files for the current layer.
4. Build and run tests for the current layer.
5. If pass: mark layer ✅, present to human.
6. If compile failure: self-correct up to 3 attempts, then stop and present error.
7. If test/logic failure: stop and present to human immediately.

### Brownfield-specific:
- Extract coding conventions from existing files before generating any code.
- For each file being modified: read current content, present diff summary, get approval before writing.
- Run existing test suite before modifications to establish baseline.

## Output

### Plan artifact
- **code-generation-plan.md** — layered plan with per-file checkboxes grouped by layer. Each layer has: name, file list (action, purpose, story traceability), verification criteria, checkpoint marker.

### Code artifacts
- Application source code in the workspace (not in aidlc-docs/)
- Tests co-located per layer

### Documentation artifacts
- **code-generation-plan.md** — plan with progress state
- **CODE_SUMMARY.md** — summary of what was generated, decisions made, conventions followed

## Validation

Validation rules for this skill's output live in `validation-spec.md` at the skill root. See `aidlc-common/protocols/aidlc-validator-protocol.md` for how they are applied.
