# AI-DLC Folder Structure

```
org-ai-kb/
│
├── codekb/
│   ├── <repo-a>/
│   │   ├── summary.md                     tech stack, purpose, ownership (RE-generated)
│   │   ├── architecture.md                (RE-generated)
│   │   ├── integration-map.md             (RE-generated)
│   │   ├── intent-history.md              which intents touched this repo (last entry = latest)
│   │   └── engineering/
│   │       ├── intent-<nnn>/
│   │       │   ├── domain-entities.md
│   │       │   ├── business-rules.md
│   │       │   ├── nfr-design.md
│   │       │   ├── infrastructure-design.md
│   │       │   └── deployment-architecture.md
│   │       └── intent-<nnn>/
│   │           └── ...
│   ├── <repo-b>/
│   │   └── ...
│   └── <repo-n>/
│       └── ...
│
└── aidlc-docs/
    └── intent-<nnn>-<intent-name>/
        │
        ├── intent-prompt.md                 raw user prompt (seeded by orchestrator)
        ├── intent.md                        structured intent (produced by intent-bootstrap)
        ├── workflow.md                      approved workflow (seeded by orchestrator, appended by workflow-composition)
        │
        ├── state/
        │   ├── intent-state.md             overall intent + inception progress
        │   ├── process-checkpoint.json     process_checker's own state
        │   ├── <unit-name>-state.md
        │   └── <unit-name>-state.md
        │
        ├── audit/
        │   ├── intent-audit.md
        │   ├── <unit-name>-audit.md
        │   └── <unit-name>-audit.md
        │
        ├── bootstrap/
        │   ├── intent-bootstrap/                (artifacts produced by the intent-bootstrap skill)
        │   │   ├── intent-bootstrap-questions.md
        │   │   ├── intent-bootstrap-plan.md
        │   │   └── bootstrap-context.md
        │   └── workflow-composition/            (artifacts produced by the workflow-composition skill)
        │       ├── workflow-composition-questions.md
        │       ├── workflow-composition-plan.md
        │       └── workflow-rationale.md
        │
        ├── inception/
        │   ├── reverse-engineering/            (one subdirectory per repo, always scoped)
        │   │   └── <repo-name>/
        │   │       ├── reverse-engineering-questions.md
        │   │       ├── reverse-engineering-plan.md
        │   │       ├── components.md
        │   │       ├── component-methods.md
        │   │       ├── component-dependencies.md
        │   │       ├── services.md
        │   │       ├── cross-cutting.md
        │   │       ├── data-models.md             (if persistence)
        │   │       ├── api-contracts.md           (if APIs)
        │   │       ├── event-catalog.md           (if event-driven)
        │   │       ├── external-dependencies.md   (if external integrations)
        │   │       ├── technology-stack.md
        │   │       ├── code-structure.md
        │   │       ├── code-quality-assessment.md
        │   │       └── chunks/                    (for medium/large codebases)
        │   │           └── <chunk-name>.md
        │   ├── requirements-analysis/          (artifacts produced by the requirements-analysis skill)
        │   │   ├── requirements-analysis-questions.md
        │   │   ├── requirements-analysis-plan.md
        │   │   └── requirements.md
        │   ├── user-stories/                   (artifacts produced by the user-stories skill)
        │   │   ├── user-stories-questions.md
        │   │   ├── user-stories-plan.md
        │   │   ├── stories.md
        │   │   └── personas.md
        │   ├── wireframes/                     (artifacts produced by the wireframes skill, if UI intent)
        │   │   ├── wireframes-questions.md
        │   │   ├── wireframes-plan.md
        │   │   ├── screen-data-map.md
        │   │   ├── screen-structure.md
        │   │   ├── wireframe-guidance.md
        │   │   └── wireframes/                 (visual files — SVG or HTML per screen)
        │   │       └── <screen-name>.svg|html
        │   ├── application-design/             (artifacts produced by the application-design skill)
        │   │   ├── application-design-questions.md
        │   │   ├── application-design-plan.md
        │   │   ├── components.md
        │   │   ├── component-methods.md
        │   │   ├── component-dependencies.md
        │   │   ├── services.md
        │   │   ├── cross-cutting.md
        │   │   ├── data-models.md                 (if persistence)
        │   │   ├── api-contracts.md               (if system exposes APIs)
        │   │   ├── event-catalog.md               (if event-driven)
        │   │   └── external-dependencies.md       (if external integrations)
        │   └── units-generation/                (artifacts produced by the units-generation skill)
        │       ├── units-generation-questions.md
        │       ├── units-generation-plan.md
        │       ├── units-of-work.md
        │       ├── units-of-work-dependency.md
        │       └── units-of-work-story-map.md
        │
        ├── construction/
        │   ├── <unit-name>/                     (one subdirectory per unit; per-unit skills write here)
        │   │   ├── unit-summary.md
        │   │   ├── adr.md
        │   │   ├── functional-design/
        │   │   │   ├── functional-design-questions.md
        │   │   │   ├── functional-design-plan.md
        │   │   │   ├── business-logic-model.md
        │   │   │   ├── domain-entities.md
        │   │   │   └── business-rules.md
        │   │   ├── nfr-assessment/
        │   │   │   ├── nfr-assessment-questions.md
        │   │   │   ├── nfr-assessment-plan.md
        │   │   │   ├── nfr-requirements.md
        │   │   │   └── tech-stack-decisions.md
        │   │   ├── nfr-design/
        │   │   │   ├── nfr-design-questions.md
        │   │   │   ├── nfr-design-plan.md
        │   │   │   ├── nfr-design-patterns.md
        │   │   │   └── logical-components.md
        │   │   ├── infrastructure-design/
        │   │   │   ├── infrastructure-design-questions.md
        │   │   │   ├── infrastructure-design-plan.md
        │   │   │   ├── infrastructure-design.md
        │   │   │   └── deployment-architecture.md
        │   │   ├── code/
        │   │   │   ├── code-generation-questions.md
        │   │   │   ├── code-generation-plan.md
        │   │   │   └── CODE_SUMMARY.md
        │   │   └── ...
        │   ├── <unit-name>/
        │   │   └── ...
        │   └── build-and-test/
        │
        └── operations/
            └── (skills to be defined)
```

## Document Lifecycle

There are two categories of documents in codekb.

**Category 1: Reverse-engineering documents** live flat at `codekb/<repo>/`. Generated when a repo is first onboarded via reverse engineering. They describe the repo as it exists today.

**Category 2: Engineering documents** are generated during construction and live under `codekb/<repo>/engineering/intent-<nnn>/`. During construction they reside in `aidlc-docs/intent-<nnn>/construction/<unit>/`. After the unit is deployed, they are moved to `codekb/<repo>/engineering/intent-<nnn>/`. Each intent gets its own folder.

`intent-history.md` tracks which intents touched the repo in order. The last entry is the latest state.

## Design Knowledge Split

The intent folder captures the story of how work was done — the questions asked, plans made, decisions recorded, and progress tracked. Once an intent is complete, this folder becomes an immutable historical record. It answers "what happened and why."

The codekb captures the current truth about each repository — its domain model, business rules, non-functional design, infrastructure, and how it integrates with other systems. Unlike the intent folder, codekb documents are living. They are never overwritten, only extended — although old decisions may become void over time, which may lead to removal of outdated sections.

## Workspace Setup

During construction, each unit team opens:

```
<workspace>/
├── org-ai-kb/                      (cloned — shared across teams)
└── <target-repo>/                  (the code being worked on)
```
