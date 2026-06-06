---
name: aidlc-requirements-analysis
description: |
  AI-DLC requirements-analysis skill. Produces a structured `requirements.md` from an intent statement, classifying greenfield vs brownfield and capturing functional and non-functional requirements with measurable criteria.

  Invoke explicitly via `/skill aidlc-requirements-analysis` when the user already has an intent and wants only this single step. For fresh development intents that should go through the full AI-DLC flow (requirements → stories → design → code), activate `aidlc-orchestrator` instead.
metadata:
  phase: inception
  stage: requirements-analysis
  per-unit: "false"
  human-clarification: "true"
  plan-creation: "true"
  plan-verification: "true"
  artefact-verification: "true"
---

# Requirements Analysis

Elicit, structure, and validate requirements from the human's statement of intent. Determine whether the intent is greenfield, brownfield, or a mix by reasoning over codekb.

## Prerequisites

- org-ai-kb must be set up
- codekb must be hydrated (if existing repos are in scope)

## Input

- Human's statement of intent
- codekb summaries, integration maps, and domain entities for all repos

## Question Guidance

Focus clarifying questions on:

- What exactly is being requested? What is the expected outcome?
- Request type: new feature, bug fix, refactoring, migration, enhancement, new project?
- Scope: single component, multiple components, system-wide, cross-system?
- Based on codekb, infer whether this is greenfield or brownfield. If codekb has relevant repos, state your assessment and ask the human to confirm: "This looks like a brownfield change affecting repos X and Y — is that correct?"
- If codekb has repos, identify which appear affected and confirm scope with the human.
- Functional requirements: core features, user interactions, system behaviours, data requirements.
- Non-functional requirements: performance, security, scalability, usability.
- Business context: goals, success criteria, stakeholder needs, constraints.
- Compliance: regulatory, accessibility, data privacy considerations.

## Output

A requirements document named `requirements.md` containing:

- **Intent summary** — type (new feature, bug fix, migration, etc.), scope (single component to system-wide), complexity, greenfield/brownfield classification, affected repos
- **Functional requirements** — numbered `FR-<n>`, each verifiable as pass/fail
- **Non-functional requirements** — measurable where possible (e.g. "p95 < 200ms", not "fast")
- **Assumptions** — flagged as assumptions, not stated as facts
- **Out of scope** — explicitly excluded items

All sections mandatory. If empty, state "None identified".

## Validation

Validation rules for this skill's output live in `validation-spec.md` at the skill root. Deterministic post-condition scripts live in `scripts/`. See `aidlc-common/protocols/aidlc-validator-protocol.md` for how they are applied.
