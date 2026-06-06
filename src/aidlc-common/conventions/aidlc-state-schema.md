# State Schema

Single source of truth for the `intent-state.md` file format and the state machine it tracks.

## File format

```markdown
# Intent State

intent: <intent-name>
created: <timestamp>
updated: <timestamp>

## Workflow Progress

| Skill | Step | Status | Attempt | Artifacts |
|---|---|---|---|---|
| <skill-name> | <step> | <status> | <n> | <comma-separated bare filenames or —> |
```

## Rules

### 1. One row per skill

Each skill has exactly one row. When updating state, find the existing row for the skill name and replace the values in that row. Do NOT add a new row — duplicate rows break script parsing.

### 2. State key

- Inception skills: Skill column contains the skill name (e.g., `requirements-analysis`).
- Construction skills (per-unit): Skill column contains `<skill-name>:<unit-name>` (e.g., `functional-design:auth-service`).
- Scoped skills: Skill column contains `<skill-name>:<scope-name>` (e.g., `reverse-engineering:payments-api`).

### 3. Artifacts column

Bare filenames only — not full paths (e.g., `requirements.md`, not `inception/requirements-analysis/requirements.md`).

`process_checker` resolves them relative to:
- inception: `inception/<skill>/`
- inception (scoped): `inception/<skill>/<scope>/`
- construction: `construction/<unit>/<skill>/`

Comma-separated, or `—` if none.

### 4. Write responsibilities

See `aidlc-common/protocols/aidlc-orchestrator-protocol.md` — "State write responsibilities".

## Script parsing contract

Scripts parse the table using patterns like:

```bash
grep "<skill-name>" intent-state.md | awk -F'|' '{print $3, $4}'
```

Preserve the exact column layout.

---

## Valid states

| Step | Status | Meaning |
|---|---|---|
| — | not-started | Skill has not begun |
| clarification | pending | Builder needs to generate questions |
| clarification | awaiting-human | Questions written, waiting for answers |
| clarification | answered | Human answered, reviewing for ambiguity |
| clarification | follow-up | Ambiguous answers, follow-up questions generated |
| clarification | complete | Answers clear, ready to plan |
| planning | pending | Builder needs to create plan |
| planning | awaiting-human | Plan written, waiting for approval |
| planning | revision-requested | Human requested changes |
| planning | approved | Plan approved, ready to execute |
| execution | pending | Builder needs to generate artifacts |
| execution | complete | Artifacts written |
| validation | pending | Validator needs to run |
| validation | pass | All checks passed |
| validation | fail | One or more checks failed |
| verification | awaiting-human | Artifacts presented for human review |
| verification | approved | Human approved |
| verification | rejected | Human rejected, needs rework |
| — | halting | Retries exhausted, escalated to human |
| — | complete | Skill finished |

## Valid transitions

The transitions below describe the full path with all flags `"true"` (the defaults). Two flags can collapse paths:

- `human-clarification: "false"` — the builder writes the entire clarification path in one pass (`pending → awaiting-human → answered → complete`); the human is not consulted.
- `plan-creation: "false"` — the planning step is skipped entirely; transition goes from `clarification:complete → execution:pending`.

```
— : not-started                   → clarification : pending

clarification : pending            → clarification : awaiting-human
clarification : awaiting-human     → clarification : answered
clarification : answered           → clarification : follow-up
clarification : answered           → clarification : complete
clarification : follow-up          → clarification : awaiting-human
clarification : complete           → planning : pending           (when plan-creation is true)
clarification : complete           → execution : pending          (when plan-creation is false)

planning : pending                 → planning : awaiting-human
planning : awaiting-human          → planning : approved
planning : awaiting-human          → planning : revision-requested
planning : revision-requested      → planning : awaiting-human
planning : approved                → execution : pending

execution : pending                → execution : complete
execution : complete               → validation : pending

validation : pending               → validation : pass
validation : pending               → validation : fail
validation : pass                  → verification : awaiting-human   (if artefact-verification flag)
validation : pass                  → — : complete                    (if no artefact-verification flag)
validation : fail                  → execution : pending             (if retries left)
validation : fail                  → — : halting                     (if no retries)

verification : awaiting-human      → verification : approved
verification : awaiting-human      → verification : rejected
verification : approved            → — : complete
verification : rejected            → execution : pending             (increment attempt)
```

## Attempt counter

- Starts at 1
- Increments on validation fail with retry, and on verification rejected
- Never decreases
- Max defined by config (default: 3)
- Max reached + validation fail = halting
