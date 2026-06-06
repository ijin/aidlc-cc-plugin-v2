---
name: aidlc-intent-bootstrap
description: |
  AI-DLC intent-bootstrap skill. Owns the entire act of bootstrapping an intent: confirms the org-ai-kb location, generates and confirms the intent slug, picks the next intent number, creates the intent directory and its skeleton files (`intent-prompt.md`, `state/intent-state.md`, `audit/intent-audit.md`, stub `workflow.md`), classifies greenfield/brownfield, and writes a structured `intent.md` and `bootstrap-context.md` for downstream skills.

  Invoked by `aidlc-orchestrator` as the first pre-loop step of every intent. Not normally invoked directly.
metadata:
  phase: bootstrap
  stage: intent-bootstrap
  per-unit: "false"
  human-clarification: "false"
  plan-creation: "false"
  plan-verification: "false"
  artefact-verification: "false"
---

# Intent Bootstrap

Bootstrap an intent end-to-end: create the directory and skeleton files every later skill depends on, classify the intent, and produce `intent.md` and `bootstrap-context.md`. This skill runs before `workflow.md` exists, so it owns everything required to bring an intent into existence.

## Inputs

The orchestrator passes:

- The verbatim intent statement
- The workspace root path
- Any context the human has volunteered (typically nothing)

There is no input file — `intent-prompt.md` does not yet exist; this skill creates it.

## Question Guidance

Ask only what cannot be inferred. In order:

- **org-ai-kb location** — only if it does not yet exist and was not volunteered. Default `<workspace-root>/org-ai-kb/`.
- **Slug** — present the auto-generated kebab-case slug; offer to override.
- **Classification** — greenfield, brownfield, or mixed. Confirm only if non-trivial.
- **Repos in scope** — brownfield/mixed only.
- **Codekb hydration / reverse-engineering need** — brownfield/mixed only.
- **Intent type** — feature, bug fix, migration, refactor, prototype, etc.

For greenfield with no codekb, slug + type may be all that's worth asking.

## Plan

`plan-creation: "false"` — no plan file produced. Execution follows the steps below directly.

## Execution

1. Ensure `org-ai-kb/aidlc-docs/` exists.
2. Pick the next `<nnn>` (zero-padded) by listing existing `intent-*` directories.
3. Create `intent-<nnn>-<slug>/` with subfolders `state/`, `audit/`, `bootstrap/intent-bootstrap/`.
4. Write `intent-prompt.md` (verbatim prompt) at the intent root.
5. Initialise `state/intent-state.md` with the header from `aidlc-state-schema.md`.
6. Initialise `audit/intent-audit.md` with a header.
7. Write `workflow.md` with exactly one line:
   ```
   workflow-composition --phase bootstrap intent.md bootstrap/intent-bootstrap/bootstrap-context.md
   ```
   No `intent-bootstrap` line — by the time `process_checker` reads `workflow.md`, this skill has finished.
8. Write `intent.md` at the intent root.
9. Write `bootstrap-context.md` in `bootstrap/intent-bootstrap/`.

## Output

### intent.md (intent root)

- **Prompt** — verbatim
- **Summary** — one paragraph
- **Slug**
- **Type** — feature, bug fix, migration, refactor, prototype, etc.

### bootstrap-context.md (in `bootstrap/intent-bootstrap/`)

- **Classification** — greenfield / brownfield / mixed (with rationale)
- **Repos in scope** — list, or "none"
- **Codekb status** — hydrated / partial / missing per repo, or "n/a"
- **Reverse-engineering** — needed (per repo) or not needed

## Return value

Return to the orchestrator: `status: complete`, `intent_dir_path`, and the list of artefacts produced.

## Validation

See `validation-spec.md`.
