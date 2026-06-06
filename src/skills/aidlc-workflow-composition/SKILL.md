---
name: aidlc-workflow-composition
description: |
  AI-DLC workflow-composition skill. Picks the skills that will run for this intent from the catalogue, sets per-skill flags, and appends the resulting lines to `workflow.md`.

  Invoked by `aidlc-orchestrator` immediately after `aidlc-intent-bootstrap`. Not normally invoked directly.
metadata:
  phase: bootstrap
  stage: workflow-composition
  per-unit: "false"
  human-clarification: "false"
  plan-creation: "false"
  plan-verification: "false"
  artefact-verification: "true"
---

# Workflow Composition

Compose the adaptive workflow for this intent by selecting skills from `skills/aidlc-orchestrator/CATALOGUE.md` and rewriting `workflow.md`. The artefact-verification step is the workflow-approval gate — the human approves the composed workflow before any inception-phase skill runs.

## Prerequisites

- `intent.md` at the intent root
- `bootstrap-context.md` in `bootstrap/intent-bootstrap/`

## Input

- `intent.md`
- `bootstrap-context.md`
- `skills/aidlc-orchestrator/CATALOGUE.md`

## Question Guidance

Apply §1 to evaluate every catalogue skill against the intent. Derive what you can; ask only on genuine ambiguity. Examples:

- Should reverse-engineering run? (skip if codekb is hydrated)
- For a tiny bug fix, should user-stories or application-design be skipped?
- Any per-skill flag overrides (`plan-verification`, `artefact-verification`)?

## 1. Composition Rules

1. Start from the catalogue; evaluate each skill against the intent. Never assume a fixed pipeline.
2. **Right-sizing principle.** Three skills are essentially always-on: `requirements-analysis`, `code-generation`, `build-and-test`. Everything else is conditional. Skip aggressively when the intent is narrow in scope, low in novelty, single-actor, single-component, or pure implementation. Include only when the skill's output would meaningfully shape what comes next. A workflow that has every skill is rarely the right answer.
3. When the right-sizing principle leaves you genuinely uncertain about a skill, lean toward including it.
4. Construction skills with `per-unit: "true"` run once per unit. With one unit, collapse them into a single pass.
5. The composed workflow is a recommendation, not a contract. The orchestrator may pause and insert a skipped skill mid-execution if needed.
6. Do not reference the examples in §3 by name when presenting the workflow — they are internal reasoning aids.
7. Only list skills that will execute. Do not list skipped skills.
8. Reverse engineering:
   - codekb hydrated for the affected repos → skip RE.
   - Otherwise → one `reverse-engineering` invocation per repo that needs analysis.
   - Greenfield with integration targets → RE those targets only.
   - Brownfield → RE included by default for affected repos.
9. **Human-facing vocabulary.** When presenting the workflow to the human, refer to each skill by its `stage` and `phase` from the catalogue (e.g. "user stories stage", "inception phase"). Use skill names only for internal reasoning and as disambiguators when one stage maps to multiple skills.

## 2. Presentation

Group the composition by phase → stage, in execution order. When one stage maps to one skill, the stage alone is enough. When multiple skills share a stage, list each as a sub-bullet with the skill name as disambiguator.

```
Proposed workflow

Inception phase
  1. Requirements analysis stage
  2. User stories stage
  3. Application design stage
  4. Units generation stage

Construction phase (per unit: <unit-name>)
  5. Functional design stage
  6. NFR assessment stage
  ...
```

## 3. Examples

Examples are arranged from minimal to maximal. Each notes what was **skipped** and why — that's where the right-sizing reasoning lives.

### A. Trivial bug fix — typo, off-by-one, missing null check (greenfield or brownfield)

**Workflow:** requirements-analysis → code-generation → build-and-test.

(For brownfield: prepend reverse-engineering for the affected repo if codekb is not hydrated.)

**Skipped:** user-stories (no new user-facing behaviour), application-design (no component changes), units-generation (one trivial change), functional-design (no new domain logic), nfr-assessment (no NFR shift), nfr-design, infrastructure-design.

### B. Simple single-component utility — calculator, string parser, CSV exporter, CLI tool

**Workflow:** requirements-analysis → code-generation → build-and-test.

**Skipped:** user-stories (one obvious actor, one happy path), application-design (single component, no orchestration), units-generation (one unit, trivially), functional-design (logic is the requirements), nfr-assessment (defaults are fine), nfr-design, infrastructure-design.

A calculator does not need a story map and a domain model. The requirements doc captures the operations; the build-and-test skill catches mistakes. If during code-generation a real ambiguity surfaces (rounding rules, error semantics), pause and insert functional-design — that's what rule 5 is for.

### C. Refactor with no behaviour change — rename, extract, restructure (brownfield)

**Workflow:** reverse-engineering → requirements-analysis → application-design → code-generation → build-and-test.

**Skipped:** user-stories (no behaviour change, hence no new stories), units-generation (single unit unless the refactor is huge), functional-design (business logic is preserved verbatim), nfr-assessment (NFRs don't change), nfr-design, infrastructure-design.

Application design is in because the whole point of a refactor is to change component boundaries.

### D. Small feature add to an existing service — new endpoint, new field, new validation rule (brownfield)

**Workflow:** reverse-engineering → requirements-analysis → user-stories → functional-design → code-generation → build-and-test.

**Skipped:** application-design (existing component boundaries are reused), units-generation (one unit — the existing service), nfr-assessment (NFRs inherited from the service unless the feature changes them), nfr-design, infrastructure-design.

Functional-design runs but with `--unit <existing-service-name>`, refining only the new business rules.

### E. New feature requiring a new component in an existing system (brownfield)

**Workflow:** reverse-engineering → requirements-analysis → user-stories → application-design → functional-design → nfr-assessment → code-generation → build-and-test.

**Skipped:** units-generation (the new component is the unit), nfr-design and infrastructure-design (only if the existing infra absorbs the new component without changes — otherwise include them).

### F. Migration — language, framework, database, or platform change (brownfield)

**Workflow:** reverse-engineering → requirements-analysis → application-design → functional-design → nfr-assessment → nfr-design → infrastructure-design → code-generation → build-and-test.

**Skipped:** user-stories (no new behaviour, just a different substrate), units-generation (existing component boundaries usually carry over).

NFR design and infrastructure design are mandatory in a migration: that's where the migration lives.

### G. Greenfield single-service system — small to medium scope

**Workflow:** requirements-analysis → user-stories → application-design → functional-design → nfr-assessment → nfr-design → infrastructure-design → code-generation → build-and-test.

**Skipped:** reverse-engineering (greenfield, no integration targets), units-generation (single unit).

Per-unit construction skills run once with `--unit <service-name>`.

### H. Greenfield multi-service system — full pipeline

**Workflow:** requirements-analysis → user-stories → application-design → units-generation → functional-design (per unit) → nfr-assessment (per unit) → nfr-design (per unit) → infrastructure-design (per unit) → code-generation (per unit) → build-and-test.

**Skipped:** reverse-engineering, unless the system integrates with existing repos that aren't in codekb — in which case RE those repos first.

This is the textbook full pipeline. Most intents are not this; reach for it only when units-generation actually produces multiple units.

### I. Cross-repo brownfield change — touching two or more existing repos

**Workflow:** reverse-engineering (one per affected repo) → requirements-analysis → user-stories (if user-facing) → application-design → functional-design (per unit) → nfr-assessment (per unit) → code-generation (per unit) → build-and-test.

**Skipped:** units-generation (the affected repos *are* the units; map them directly), nfr-design and infrastructure-design (include only if cross-repo NFRs or shared infra change).

User-stories and application-design earn their place when the change spans repo boundaries — that's where the seams of the change get pinned down.

## Output

### workflow.md (rewritten at the intent root)

When this skill runs, `workflow.md` is a stub containing only the line that invoked this skill. Rewrite it from scratch with one line per chosen downstream skill, in execution order, per `aidlc-workflow-format.md`. Do not retain the bootstrap stub line; the first line must be a real downstream skill (typically `requirements-analysis` or `reverse-engineering`).

Routing flags are required for non-inception skills, per `aidlc-workflow-format.md`: construction skills use `--unit <unit>` (per-unit) or `--phase construction` (single pass); operations skills use `--phase operations`; inception skills omit both.

### workflow-rationale.md (in this skill's output dir)

One short bullet per skill explaining inclusion or skip, grouped by phase.

## Validation

See `validation-spec.md`.
