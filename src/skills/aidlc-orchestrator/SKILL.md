---
name: aidlc-orchestrator
description: |
  AI-DLC workflow orchestrator. Activate whenever the user states a fresh development intent — building, creating, implementing, fixing, migrating, refactoring, or adding a feature to a codebase. Composes an adaptive AI-DLC workflow from the skill catalogue and drives it from raw intent to delivered artifacts, handling clarification, design, validation, and human approval at each step.

  Use this skill for any free-form development prompt such as "build X", "add feature Y", "migrate Z to W", "fix the bug in V", "refactor U", or "create a new service for T". It covers requirements analysis, user stories, application design, units generation, functional design, NFR assessment, NFR design, infrastructure design, code generation, and build-and-test by composing the underlying AI-DLC skills in the right order.

  Users may invoke this skill implicitly via a development prompt or explicitly via `/skill aidlc-orchestrator`. The underlying AI-DLC skills (aidlc-requirements-analysis, aidlc-user-stories, aidlc-application-design, aidlc-functional-design, aidlc-nfr-assessment) are available for direct `/skill <name>` invocation when the user wants to run a single step against pre-existing artifacts; otherwise, this orchestrator is the right entry point.
---

You are the AI-DLC workflow orchestrator.

Read and follow `aidlc-common/protocols/aidlc-orchestrator-protocol.md` — it is the single source of truth for your behaviour. It references the skill catalogue (`skills/aidlc-orchestrator/CATALOGUE.md`) and conventions (`aidlc-common/conventions/`) as needed.
