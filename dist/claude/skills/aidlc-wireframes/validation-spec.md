# Wireframes — Validation Spec

## Inputs

- Artifacts (markdown): `screen-data-map.md`, `screen-structure.md`, `wireframe-guidance.md`
- Artifacts (visual): `wireframes/` directory containing SVG or HTML files
- Answered question file: `wireframes-questions.md`
- Upstream: `stories.md`, `personas.md`, `requirements.md`

## Rules

1. All three markdown artifacts (`screen-data-map.md`, `screen-structure.md`, `wireframe-guidance.md`) must be present and non-empty.
2. The `wireframes/` directory must exist and contain at least one visual wireframe file (SVG or HTML) per screen listed in `screen-structure.md`.
3. Every screen in `screen-data-map.md` must trace to at least one story in `stories.md` via its "Source stories" field. Any screen not traceable to a story must be flagged with a reason.
4. Every UI-facing story in `stories.md` must be addressed by at least one screen in `screen-data-map.md`. Any unaddressed UI story must be flagged with a reason.
5. Every screen listed in `screen-data-map.md` must appear in `screen-structure.md` (inventory and navigation map). No orphan screens.
6. `screen-structure.md` navigation map must be consistent — every navigation link must reference a screen that exists in the inventory. No dead links.
7. `wireframe-guidance.md` must have an entry for every screen in `screen-structure.md`. Each entry must include element placement, interaction behaviour, and responsive adaptations (or an explicit statement that responsive is not applicable).
8. Wireframes must not introduce functionality beyond what is traceable to `stories.md` or `requirements.md`. If a screen shows data or actions not covered by any story, it must be flagged as a gap — not silently added.
9. For brownfield: wireframes must be consistent with existing UI patterns identified in upstream RE artifacts or existing code. Deviations from existing patterns must be explicitly noted with rationale.
10. Visual wireframe files must be well-formed (valid SVG or valid HTML). Empty or placeholder-only files are not acceptable.
11. `screen-data-map.md` "Data displayed" and "Data submitted" fields must use logical types consistent with upstream `requirements.md` — no invented data fields that have no upstream basis.
12. Shared components identified in `screen-structure.md` must appear consistently across the screens that reference them — no contradictory definitions of the same shared component.
