---
name: aidlc-user-stories
description: |
  AI-DLC user-stories skill. Decomposes an approved `requirements.md` into INVEST-compliant stories and domain-grounded personas.

  Invoke explicitly via `/skill aidlc-user-stories` when requirements are already written and only this step is needed. For fresh development intents, activate `aidlc-orchestrator` instead.
metadata:
  phase: inception
  stage: user-stories
  per-unit: "false"
  human-clarification: "true"
  plan-creation: "true"
  plan-verification: "true"
  artefact-verification: "true"
---

# User Stories

Decompose approved requirements into stories across all system layers — user-facing, system/backend, integration, and operational. Create personas for user-facing stories. Stories are the contract between requirements and design.

## Prerequisites

- `requirements.md` must be approved

## Input

- `requirements.md`

## Question Guidance

Analyse `requirements.md` first. Derive what you can; ask where the human's input would meaningfully shape the output. Focus on:

- Who are the distinct human user types? Are there personas beyond the obvious (e.g., operators, support staff, auditors) that should have stories?
- Should stories cover backend/system behaviours, integration flows, and operational concerns — or is this primarily user-facing?
- How should stories be organised — by user journey, by feature area, by system layer, or by domain? What grouping makes most sense for this intent?
- What edge cases and error scenarios matter most? Which failure modes, boundary conditions, or dependency failures should have explicit stories?
- For each NFR in `requirements.md` — should it become its own story, a cross-cutting acceptance criterion on multiple stories, or both?
- (Brownfield only) Which existing behaviours must be preserved unchanged? Are regression protection stories needed?

## Output

Two artifacts.

### personas.md

One section per human persona. Each includes name, role, goals, and context. Personas must be grounded in the domain — no generic archetypes. If the intent has no human users (pure backend/infra), state "No human personas — system-only intent."

### stories.md

Stories covering all layers identified in `requirements.md`. Two formats:

- User story: `As a [persona], I want [goal], so that [benefit].`
- System story: `As the [system/service], when [trigger], it must [behavior].`

Each story includes:

- **ID** — `S-<n>`, sequential
- **Acceptance criteria** — verifiable as pass/fail
- **Requirements** — `Requirements: FR-x, NFR-y, ...` traceable to `requirements.md`

Stories must follow INVEST criteria (Independent, Negotiable, Valuable, Estimable, Small, Testable).

## Validation

Validation rules for this skill's output live in `validation-spec.md` at the skill root. See `aidlc-common/protocols/aidlc-validator-protocol.md` for how they are applied.
