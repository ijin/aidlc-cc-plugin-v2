# Validator Protocol

Execution protocol for the validator. This file is the single source of truth for validator behaviour. It is packaged alongside the skill's `validation-spec.md`.

---

## 1. Inputs

The validator receives from the orchestrator:

- Artifact paths to validate
- Answered question file path
- Upstream artifact paths (for traceability checks) — listed in the skill's `validation-spec.md` "Inputs" section
- Skill output directory path
- Skill scripts directory path (may be absent if the skill has no scripts)

## 2. Protocol

1. Read `validation-spec.md` (including its "Inputs" section).
2. Read all artifacts at the provided paths.
3. Read all upstream artifacts listed in `validation-spec.md`.
4. Read the answered question file.
5. Run every script in the skill's `scripts/` directory **exactly once**. Capture output and exit code of each. If the directory is absent or empty, record "no scripts". If any script fails, the overall validation status MUST be `fail` regardless of your other findings — but do not stop; run the remaining scripts first.
6. Validate:
   - **Spec compliance** — every rule in `validation-spec.md` is checked against the artifacts.
   - **Script results** — fold the exit codes captured in step 5 into the findings. Do not re-run the scripts.
   - **Clarification consistency** — artifacts are consistent with the answers in the question file.
   - **Completeness** — gaps the spec may not have anticipated (missing coverage, unstated assumptions, logical inconsistencies).
7. Write a validation report to the skill output folder.
8. Return to the orchestrator: status `pass` or `fail`, validation report path.

## 3. Validation Report Format

The report has two parts.

### 3.1 Human-Readable Section

Write in whatever markdown format is natural. Include:

- **Status:** `pass` or `fail`
- **Rules checked:** list of validation-spec rules with pass/fail per rule
- **Scripts invoked:** list of every script in `scripts/` with exit code and output
- **Findings:** for each failure, the rule violated (or script that failed), the artifact and section where the violation occurs, and a description of the issue
- **Recommendations:** suggested fixes (the validator does not fix, only recommends)

### 3.2 Machine-Readable Block

At the very end of the report, append a plain-text block with fixed delimiters. This block is parsed by `process_checker`. Format is exact — no markdown, no extra whitespace, no variations.

```
---PROCESS-CHECK-DATA---
STATUS: PASS
TOOLS: verify-structure.sh,check-coverage.py
RULES: 1,2,3,4,5
---END-PROCESS-CHECK-DATA---
```

Rules:
- `STATUS` must be exactly `PASS` or `FAIL` (uppercase)
- `TOOLS` is a comma-separated list of script filenames that were executed. If no scripts exist, use `TOOLS: none`. (The field is named `TOOLS` for backward compatibility with process_checker; it holds the `scripts/` filenames.)
- `RULES` is a comma-separated list of rule numbers from `validation-spec.md` that were checked
- Delimiters must appear exactly as shown
- This block must be the last thing in the file

## 4. Rules (apply to every skill)

1. Never fix artifacts. Validate and report only.
2. Do not interact with the human directly.
3. Do not read the builder protocol or the skill's `SKILL.md`. You do not know how artifacts were produced, only whether they meet the spec.
4. Do not carry context from previous validation runs.

## 5. State File Responsibilities

The validator writes the following state transitions to `intent-state.md`:

- `validation:pending → validation:pass` (after all checks pass)
- `validation:pending → validation:fail` (after one or more checks fail)

The validator does NOT write any other state transitions.

See `aidlc-common/conventions/aidlc-state-schema.md` for state file format.
