# User Stories — Validation Spec

## Inputs

- Artifacts: `personas.md`, `stories.md`
- Answered question file: `user-stories-questions.md`
- Upstream: `requirements.md`

## Rules

1. Both `personas.md` and `stories.md` must be present. If there are no human personas, `personas.md` must state this explicitly.
2. Every story must follow INVEST criteria and have verifiable pass/fail acceptance criteria.
3. Every story must have a unique `S-<n>` ID and a `Requirements:` line listing the FR/NFR identifiers it addresses.
4. Every FR and NFR in `requirements.md` must be addressed by at least one story. Any requirement not covered must be explicitly documented with a reason.
5. Stories must cover all system layers implied by `requirements.md` — not just user-facing behaviour.
6. Personas must be grounded in the domain and requirements — not generic archetypes.
7. No two stories may describe the same behaviour. Overlap must be consolidated.
