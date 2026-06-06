---
name: aidlc-reverse-engineering
description: |
  AI-DLC reverse-engineering skill. Analyses an existing codebase and produces design artifacts that describe what exists — mirroring the Application Design format so downstream stages can consume RE artifacts identically. Additional RE-specific artifacts capture technology reality and code health.

  Invoke explicitly via `/skill aidlc-reverse-engineering` when you need to analyse an existing codebase without running the full AI-DLC flow. For fresh development intents, activate `aidlc-orchestrator` instead.
metadata:
  phase: inception
  stage: reverse-engineering
  per-unit: "false"
  human-clarification: "true"
  plan-creation: "true"
  plan-verification: "true"
  artefact-verification: "true"
---

# Reverse Engineering

Analyse an existing codebase and produce design artifacts that describe what exists. Output mirrors the Application Design format so downstream stages can consume RE artifacts identically. Additional RE-specific artifacts capture technology reality and code health.

## Prerequisites

- The target codebase must be accessible (local clone or readable workspace)
- Requirements Analysis should indicate brownfield classification
- This skill is always invoked with `--scope <repo-name>` — one invocation per repo, even with a single repo

## Input

- Human's statement of intent (to scope what areas to focus on)
- The target codebase (file system access)
- `requirements.md` (if available — to focus RE on relevant areas)

Artifacts are written to `inception/reverse-engineering/<repo-name>/`. Downstream skills read RE artifacts from there using the repo name from `bootstrap-context.md`.

## Chunking Strategy

Do not analyse the entire codebase in one pass. Use a hybrid approach:

1. **Structural scan** — quick pass over top-level packages/modules to build a map
2. **Deep-dive per business flow** — analyse one flow/feature at a time, crossing package boundaries as needed
3. **Assembly** — consolidate per-chunk findings into unified artifacts

Chunk boundaries:
- Small codebase (< 50 files): single chunk, full analysis
- Medium codebase (50–200 files): one chunk per major package or bounded context
- Large codebase (200+ files): one chunk per business flow relevant to the intent

Present the structural scan and proposed chunks to the human for approval before deep-diving.

## Question Guidance

Focus clarifying questions on:
- Which areas of the codebase are relevant to the current intent?
- What depth is needed? (full analysis vs. focused on specific flows)
- Are there undocumented conventions or tribal knowledge the AI should know?
- Which business flows are most critical to understand first?

Do not ask about future design decisions — RE documents what exists, not what should be.

## Output

### Forward-flow equivalent artifacts (same format as Application Design)

- **components.md** — discovered components with purpose, responsibilities, state, ownership
- **component-methods.md** — key methods per component with inputs/outputs
- **component-dependencies.md** — dependency matrix with communication patterns
- **services.md** — discovered service orchestrations and business workflows
- **cross-cutting.md** — existing error handling, auth model, logging, validation patterns
- **data-models.md** — discovered entities, fields, relationships, constraints (if persistence)
- **api-contracts.md** — existing API surface (if APIs exist)
- **event-catalog.md** — existing events (if event-driven)
- **external-dependencies.md** — external systems the codebase integrates with

### RE-specific artifacts

- **technology-stack.md** — languages, frameworks, versions, build tools, runtime dependencies
- **code-structure.md** — file/folder layout, naming conventions, module boundaries
- **code-quality-assessment.md** — test coverage, patterns, anti-patterns, tech debt indicators

### Per-chunk artifacts (for medium/large codebases)

- **chunks/<chunk-name>.md** — detailed analysis of one chunk, consolidated into the above during assembly

## Assembly

After all chunks are analysed, consolidate per-chunk findings into the unified artifacts. For multi-agent execution, chunks can run in parallel; assembly runs after all complete. For single-agent, chunks run sequentially and assembly happens at the end.

## Downstream Consumption

Future stages should look for artifacts in both:
1. `inception/reverse-engineering/` — RE-discovered design
2. `inception/application-design/` — human-approved design (may extend or override RE)

If both exist, Application Design takes precedence. RE artifacts serve as the baseline that Application Design refines.

## Validation

Validation rules for this skill's output live in `validation-spec.md` at the skill root. See `aidlc-common/protocols/aidlc-validator-protocol.md` for how they are applied.
