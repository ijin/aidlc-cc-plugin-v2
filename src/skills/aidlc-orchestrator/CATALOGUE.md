# Skill Catalogue

Catalogue of AI-DLC skills. Each skill is a directory under `skills/<skill-name>/` and follows the [Agent Skills specification](https://agentskills.io/specification). The catalogue is the orchestrator's source when composing a workflow.

Skills are composable. Phases and stages are organising concepts the orchestrator uses to group and present skills — they are not a rigid pipeline. A customer can reorder, insert, or omit any skill when composing a workflow.

## Skill folder layout

```
skills/<skill-name>/
├── SKILL.md              ← frontmatter (name, description, AI-DLC metadata) + instructions
├── validation-spec.md    ← validation rules + upstream inputs for the validator
└── scripts/              ← optional; omit if no scripts
```

Generic builder and validator behaviour lives in `aidlc-common/protocols/aidlc-builder-protocol.md` and `aidlc-common/protocols/aidlc-validator-protocol.md`. Per-skill folders only hold what differs between skills.

## Frontmatter metadata

Every skill's `SKILL.md` frontmatter carries, under `metadata`, the fields the orchestrator reads:

- `phase` — `bootstrap`, `inception`, `construction`, or `operations`
- `stage` — organising tag (e.g. `requirements-analysis`, `user-stories`); multiple skills may share a stage when fan-out happens
- `per-unit` — `"true"` when the skill runs once per unit in the construction phase
- `human-clarification` — `"true"` (default) if the human answers clarification questions; `"false"` if the builder records the questions, picks its own recommended answers, and proceeds autonomously
- `plan-creation` — `"true"` (default) if the builder writes a plan file before execution; `"false"` if the skill skips planning entirely and goes from clarification straight to execution
- `plan-verification` — `"true"` (default) if the human approves the plan before execution. Ignored when `plan-creation: "false"`. Invalid combination: `plan-creation: "false"` with `plan-verification: "true"`.
- `artefact-verification` — `"true"` (default) if the human reviews artifacts after the validator passes

Values are strings per the agentskills.io spec. The orchestrator parses `"true"`/`"false"` as booleans.

## Flag semantics

- `human-clarification: "true"` (default) — the builder writes clarification questions, the orchestrator presents them to the human, the human answers in chat or in the file, then the orchestrator hands the answers back to the builder. `"false"` — the builder writes the questions, picks its own recommended answers in the file (recording rationale), transitions clarification straight from `pending` through `answered` to `complete` in one builder pass, and proceeds. The human is not consulted.
- `plan-creation: "true"` (default) — the builder writes a plan file as an explicit step. `"false"` — the skill skips the planning step entirely; state goes from `clarification:complete` directly to `execution:pending`. No plan file is produced.
- `plan-verification: "true"` (default) — human approves the plan before the builder executes. `"false"` — builder proceeds without plan approval. Ignored when `plan-creation: "false"`.
- `artefact-verification: "true"` (default) — human reviews artifacts after the validator passes. `"false"` — validator pass = skill complete; human is only consulted on halting condition.

Clarification is always *attempted* — the questions file always exists for traceability — but the `human-clarification` flag controls whether the human is in the loop.

## Naming convention

All skills we supply are prefixed `aidlc-` to distinguish them from customer-contributed or third-party skills. The `stage` tag is the bare unprefixed name (e.g. `requirements-analysis`) and remains the human-facing vocabulary.

## Available skills

Legend: ✅ implemented (folder exists under `skills/`), 🚧 not yet implemented.

Default flags (when not stated): `human-clarification: true`, `plan-creation: true`, `plan-verification: true`, `artefact-verification: true`.

### Bootstrap phase

The bootstrap phase runs once per intent. The orchestrator drives `intent-bootstrap` outside `process_checker` (it has to — the file `process_checker` reads doesn't exist yet). After `intent-bootstrap` completes, the intent skeleton exists with a stub `workflow.md` containing only the `workflow-composition` line. From there, `workflow-composition` runs through the standard loop and rewrites `workflow.md` with the chosen downstream skills. Bootstrap skills are never present in `workflow.md`.

Both bootstrap skills set `human-clarification: false` and `plan-creation: false` because their decisions follow rote patterns: question files are auto-answered with the builder's recommendations (recorded for audit), planning is skipped, and execution proceeds directly. `workflow-composition` keeps `artefact-verification: true` so the human still approves the composed workflow.

| Skill | Stage | Per-Unit | Human-Clar | Plan-Create | Plan-Verify | Artefact-Verify | Status |
|---|---|---|---|---|---|---|---|
| aidlc-intent-bootstrap       | intent-bootstrap       | No  | false | false | n/a   | false | ✅ |
| aidlc-workflow-composition   | workflow-composition   | No  | false | false | n/a   | true  | ✅ |

### Inception phase

| Skill | Stage | Per-Unit | Human-Clar | Plan-Create | Plan-Verify | Artefact-Verify | Status |
|---|---|---|---|---|---|---|---|
| aidlc-reverse-engineering    | reverse-engineering    | No  | true | true | true | true | ✅ |
| aidlc-requirements-analysis  | requirements-analysis  | No  | true | true | true | true | ✅ |
| aidlc-user-stories           | user-stories           | No  | true | true | true | true | ✅ |
| aidlc-wireframes             | wireframes             | No  | true | true | true | true | ✅ |
| aidlc-application-design     | application-design     | No  | true | true | true | true | ✅ |
| aidlc-units-generation       | units-generation       | No  | true | true | true | true | ✅ |

### Construction phase

| Skill | Stage | Per-Unit | Human-Clar | Plan-Create | Plan-Verify | Artefact-Verify | Status |
|---|---|---|---|---|---|---|---|
| aidlc-functional-design      | functional-design      | Yes | true | true | true | true | ✅ |
| aidlc-nfr-assessment         | nfr-assessment         | Yes | true | true | true | true | ✅ |
| aidlc-nfr-design             | nfr-design             | Yes | true | true | true | true | ✅ |
| aidlc-infrastructure-design  | infrastructure-design  | Yes | true | true | true | true | ✅ |
| aidlc-code-generation        | code-generation        | Yes | true | true | true | true | ✅ |
| aidlc-build-and-test         | build-and-test         | No  | true | true | true | true | 🚧 |

The orchestrator or the human may override flags per-intent when composing the workflow.

When a skill is implemented, flip its Status to ✅ and ensure the folder contains `SKILL.md` and `validation-spec.md` at minimum.
