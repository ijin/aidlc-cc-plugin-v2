# Builder Protocol

Execution protocol for the builder. This file is packaged with every builder alongside the skill's `SKILL.md` and `validation-spec.md`.

---

## 1. Inputs

The builder receives from the orchestrator:

- Input file paths (one or more)
- Path to `aidlc-common/conventions/aidlc-folder-structure.md`

Each invocation may also include:
- Answered question file path (after clarification)
- Approved plan file path (after plan approval)
- Validation report path (after failed validation)

The builder is stateless. Each invocation is independent. All state is in the files on disk.

## 2. Protocol

The builder reads the active skill's `SKILL.md` frontmatter to determine the flow. The two flags that affect builder behaviour are:

- `human-clarification` (default `"true"`) — when `"false"`, the builder writes the question file with both questions AND its own recommended answers filled in, then transitions clarification straight from `pending` through `awaiting-human → answered → complete` in a single pass, and proceeds. The orchestrator does not present questions to the human. The questions file still exists for traceability.
- `plan-creation` (default `"true"`) — when `"false"`, the builder skips the planning step entirely. State goes from `clarification:complete` directly to `execution:pending`, then to `execution:complete`. No plan file is produced.

Apply these flags consistently across all invocation paths below.

### 2.1 Invocation with Input Files

1. Read the skill's `SKILL.md` (including frontmatter flags) and `validation-spec.md`.
2. Read all input files at the provided paths.
3. Determine output paths from `aidlc-common/conventions/aidlc-folder-structure.md`.
4. Assess whether clarification is needed based on available context and the validation-spec.

**If clarification is needed and `human-clarification: "true"`:**
- Generate clarifying questions using `aidlc-common/conventions/aidlc-question-format.md`.
- Write questions to the question file. Leave `[Answer]:` blank.
- Transition state to `clarification : awaiting-human`.
- Return to the orchestrator: status `clarification-needed`, question file path.
- Stop.

**If clarification is needed and `human-clarification: "false"`:**
- Generate clarifying questions in the same format, but **fill in your recommended answer** for each question on the `[Answer]:` line. Capture brief reasoning beside each answer (the existing Recommendation field already holds rationale).
- Write the file. Update state through `pending → awaiting-human → answered → complete` in this single pass (the orchestrator is not consulted).
- Continue to planning (or execution, if `plan-creation: "false"`).

**If no clarification is needed and `human-clarification: "false"`:**
- Transition clarification straight to `complete` (no question file needed).
- Continue to planning (or execution, if `plan-creation: "false"`).

**If no clarification is needed and `human-clarification: "true"`:**
- You MUST still generate a clarification question file. Even for well-specified intents,
  there are always edge cases, ambiguities, or implementation choices worth surfacing to the
  human. Probe for: input validation edge cases, error handling choices not fully specified,
  behaviour for boundary inputs, technology or library choices where the spec leaves room.
  Write at least 3 questions with your recommendations. Leave `[Answer]:` blank.
- Transition state to `clarification : awaiting-human`.
- Return to the orchestrator: status `clarification-needed`, question file path.
- Stop.

### 2.2 Invocation with Answered Questions

1. Read the answered question file.
2. Analyse answers for ambiguities (vague responses, contradictions, undefined terms).

**If ambiguities found:**
- Write follow-up questions to the question file.
- Return to the orchestrator: status `clarification-needed`, question file path.
- Stop.

**If answers are clear:**
- Proceed to Planning.

### 2.3 Planning

Skip this step entirely when the skill's `plan-creation: "false"` — go straight to Execution and let `execution:pending → execution:complete` be the next transition. Otherwise:

1. Create a plan with checkboxes in the plan file.
2. Transition state to `planning : awaiting-human` (regardless of `plan-verification` — the orchestrator handles that flag).
3. Return to the orchestrator: status `plan-ready`, plan file path.
4. Stop.

### 2.4 Invocation to Execute

1. Execute the plan. Generate artifacts as defined in the skill's `SKILL.md`.
2. Mark plan checkboxes as complete.
3. Do NOT self-validate against `validation-spec.md` and do NOT run anything in the skill's `scripts/` directory. Scripts are exclusively for the validator. Your job is to produce artifacts; validation is the validator's job.
4. Update the state file Artifacts column with bare filenames only (e.g., `requirements.md`, not `inception/requirements-analysis/requirements.md`).
5. Return to the orchestrator: status `complete`, artifact filenames.

### 2.5 Invocation After Failed Validation

1. Read the validation report at the provided path.
2. Read the current artifacts.
3. Fix the issues identified.
4. Rewrite artifacts.
5. Return to the orchestrator: status `complete`, updated artifact paths, question file path.

---

## 3. Rules (apply to every skill)

1. Read `validation-spec.md` before assessing clarification — it informs what questions to ask and what standards to build toward.
2. Do not interact with the human directly. All human communication is routed through the orchestrator.
3. Do not read the validator protocol.
4. **Scope-by-phase.** Do not ask about or design for concerns that belong to a later skill:
   - **Inception-phase skills** (requirements-analysis, user-stories, application-design): do not ask about tech stack, frameworks, databases, protocols, infrastructure, or deployment. Those belong to construction (nfr-assessment and beyond).
   - **application-design**: describe logical behaviour only — no language, framework, database, protocol, broker, or vendor specifics.
   - **functional-design**: technology-agnostic domain/business logic only.
5. **Gap handling.** If you discover a requirement or capability not covered by the inputs, raise it as a follow-up question. Do not silently add functionality beyond what is documented upstream.
6. **Brownfield context.** When a skill's prerequisites mention brownfield, accept brownfield context from any available source: codekb, reverse-engineering artifacts, org-level knowledge base, or LLM analysis of the existing codebase. Do not restate this in the skill's `SKILL.md`.

## 4. State File Responsibilities

The builder writes the following state transitions to `intent-state.md` (subject to the per-skill flags above):

- `clarification:pending → clarification:awaiting-human` (after generating questions, when `human-clarification: "true"`)
- `clarification:awaiting-human → clarification:follow-up` (after generating follow-up questions)
- `clarification:answered → clarification:complete` (after confirming answers are clear, when `human-clarification: "true"`)
- `clarification:pending → clarification:awaiting-human → clarification:answered → clarification:complete` in a single pass (when `human-clarification: "false"`; the builder fills its own answers)
- `planning:pending → planning:awaiting-human` (after generating plan, only when `plan-creation: "true"`)
- `execution:pending → execution:complete` (after generating artifacts)

When `plan-creation: "false"`, the builder skips planning entirely; the state row never has a `planning` step.

The builder does NOT write human-response transitions (`awaiting-human → answered`, `awaiting-human → approved`). Those are written by the orchestrator — except in the `human-clarification: "false"` case, where the builder writes the full clarification path itself because no human is in the loop.

See `aidlc-common/conventions/aidlc-state-schema.md` for the state file format, valid states, and transitions.
