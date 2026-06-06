# Workflow File Format

The workflow file is `workflow.md` in the intent directory. It is a simple text file — one skill invocation per line. Each line contains the skill name followed by input file paths separated by spaces.

```
<skill-name> <input-file-1> [<input-file-2> ...]
```

For construction-phase skills with `per-unit: "true"` that execute per-unit, add `--unit <unit-name>` after the skill name:

```
<skill-name> --unit <unit-name> <input-file-1> [<input-file-2> ...]
```

When `--unit` is present:
- Artifacts are written to `construction/<unit-name>/<skill-name>/` instead of `inception/<skill-name>/`
- The state key becomes `<skill-name>:<unit-name>` so the same skill can run independently for different units

For skills outside the inception phase that don't use `--unit`, add `--phase <phase-name>` after the skill name to route artifacts to the correct subtree:

```
<skill-name> --phase <phase-name> <input-file-1> [<input-file-2> ...]
```

When `--phase` is present:
- Artifacts are written to `<phase-name>/<skill-name>/` instead of the default `inception/<skill-name>/`
- Use this for `bootstrap` and `operations` skills

For skills that run multiple times within the same phase against different scopes (e.g., reverse-engineering one repo at a time), add `--scope <scope-name>` after the skill name:

```
<skill-name> --scope <scope-name> <input-file-1> [<input-file-2> ...]
```

When `--scope` is present:
- Artifacts are written to `<phase>/<skill-name>/<scope-name>/` instead of `<phase>/<skill-name>/`
- The state key becomes `<skill-name>:<scope-name>` so the same skill can run independently for different scopes
- `--scope` is phase-agnostic — it adds a subdirectory within whatever phase the skill belongs to

`--scope` is mandatory for `reverse-engineering` (always scoped to a repo name, even with a single repo).

`--phase`, `--unit`, and `--scope` are mutually exclusive. `--unit` implies `construction`. `--scope` preserves the skill's declared phase.

Lines starting with `#` are comments. Empty lines are ignored.

## Bootstrap skills are not in workflow.md

`workflow.md` lists only downstream skills (inception, construction, operations). The two bootstrap skills (`intent-bootstrap` and `workflow-composition`) run via the orchestrator's bootstrap pre-loop and are never present in `workflow.md`:

- `intent-bootstrap` runs before `workflow.md` exists; it creates the file with one stub line for `workflow-composition`.
- `workflow-composition` reads that stub, then rewrites `workflow.md` from scratch with the chosen downstream skills.

By the time `process_checker` reads `workflow.md` to drive the standard skill loop, both bootstrap skills are already complete and the file contains only downstream skill lines.

## File extension

The file **must** be named `workflow.md`. `process_checker` looks for this exact filename.

## Example

```
# Inception phase
reverse-engineering --scope payments-api org-ai-kb/aidlc-docs/intent-001-ideation-portal/intent.md
reverse-engineering --scope shared-auth org-ai-kb/aidlc-docs/intent-001-ideation-portal/intent.md
requirements-analysis org-ai-kb/aidlc-docs/intent-001-ideation-portal/intent.md
user-stories org-ai-kb/aidlc-docs/intent-001-ideation-portal/inception/requirements-analysis/requirements.md
application-design org-ai-kb/aidlc-docs/intent-001-ideation-portal/inception/requirements-analysis/requirements.md org-ai-kb/aidlc-docs/intent-001-ideation-portal/inception/user-stories/stories.md org-ai-kb/aidlc-docs/intent-001-ideation-portal/inception/user-stories/personas.md

# Construction phase — per-unit skills
functional-design --unit recommendation-engine org-ai-kb/aidlc-docs/intent-001-ideation-portal/inception/units-generation/units-of-work.md org-ai-kb/aidlc-docs/intent-001-ideation-portal/inception/user-stories/stories.md org-ai-kb/aidlc-docs/intent-001-ideation-portal/inception/application-design/components.md
functional-design --unit data-collection org-ai-kb/aidlc-docs/intent-001-ideation-portal/inception/units-generation/units-of-work.md org-ai-kb/aidlc-docs/intent-001-ideation-portal/inception/user-stories/stories.md org-ai-kb/aidlc-docs/intent-001-ideation-portal/inception/application-design/components.md
```

Do not use markdown tables. Do not add headers or formatting. The script parses this file line by line.
