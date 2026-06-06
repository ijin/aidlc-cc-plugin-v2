# AI-DLC v2 — sync verification architecture (Q1/Q2/Q3)

Working doc. Decisive answers + a layered verification design, to be pressure-tested with Codex.

## Q1 — Tags with the upstream short hash (now, before upstream tags v2)

Two different things were conflated; separating them resolves it:

- **The PIN (what upstream commit `src/` came from)** stays the **full 40-char SHA** in
  `UPSTREAM.lock`. A short hash is a *label*, not a pin: short hashes are abbreviation-length-
  dependent and can collide / fail to resolve across fetch states. The machine must pin on the
  full SHA for reproducibility.
- **OUR release TAG** — yes, absolutely, and this is the good idea: **we mint tags on our own
  repo now** (we control it; we don't need upstream to tag). Embed the upstream short hash as
  **semver build metadata** so the provenance is human-visible in the tag name:

  `v2.0.0-alpha.1+up.392d576`

  (`+up.<short>` is semver-2.0 build-metadata syntax; git allows `+` in tag names.) The tag is
  immutable and human-readable; the full upstream SHA + tree-hash live in `UPSTREAM.lock`.

When upstream eventually tags v2, nothing changes structurally: `sync-upstream.sh` resolves an
upstream tag → its SHA and records both (the `UPSTREAM_REF`/`UPSTREAM_REF_TYPE` forward-compat).
**Net: full SHA = machine pin (immutable); short hash = human label in our tag; CHANGELOG never
load-bearing.** So "use tags with the short hash" = our release-tagging convention, layered on top
of the SHA pin — adopt it.

## Q2 — Do we even need the AskUserQuestion optimization? **Recommendation: NO, not now.**

This is the highest-leverage decision, and stepping back changes it:

- **Why v1 needed it:** upstream v1 (Q Developer / Kiro) was **file-based** — the AI writes
  questions to a file, the human opens and edits it. In a chat-first tool that's genuinely clunky,
  so the v1 override (→ AskUserQuestion clickable options) was a real UX fix.
- **Why v2 is different:** v2's upstream model is **already conversational**. The orchestrator
  "presents questions in chat and waits"; `aidlc-question-format.md` says the human "may answer in
  chat." So v2's native UX is already "type your answer in the conversation" — good in Claude Code.
- **What AUQ would add:** upgrade "type your answer" → "click a multiple-choice option." Marginal.
  And lossy: AUQ caps at ≤4 options / ≤12-char headers / 1–4 questions, which doesn't fit AIDLC's
  open-ended clarifications well.
- **What it would cost:** the entire agreed overlay + region-hash + state-machine-coverage +
  6-surface + waiver-registry machinery — **permanent complexity, maintained forever, on an
  unstable pre-release upstream** — for a marginal, lossy UX nicety.
- **And it can't be auto-verified:** AUQ doesn't run headlessly, so an automated harness can never
  confirm the overlay actually works — only that the prose shipped. That residual never closes
  cheaply.

**Verdict:** ship v2 with its **native conversational flow**. Do **not** build the AUQ overlay now.
Revisit only if real usage shows the chat Q&A is a friction point — and if so, scope it to the one
surface that hurts, not all six. (The brainstorm's minimal-pragmatist lens, highest-scored, was
right; the overlay design we converged on remains on the shelf, fully specified, if ever needed.)

**Consequence:** with AUQ deferred, conversion is **almost entirely mechanical** → far more of the
sync is automatable, which is exactly what Q3 needs.

## Q3 — Verifying a sync is correct: the gate pyramid

Goal: when upstream changes, gain high confidence (NOT proof — see "honest scope" below) that the
rebuilt plugin (a) is structurally compatible, (b) actually runs and wires up, (c) didn't regress
quality — sustainably/repeatably, with human input *minimized* (not eliminated — see the irreducible
bit) and surgically placed.

Four tiers, cheapest/most-deterministic first. **Every sync runs the free tiers (T0 + T1 +
meta-tests, $0).** T2 is OFF by default (billable; found no plugin defects in practice) — run it
pay-when-warranted, gated by the deterministic `t2b.advised` signal from T1 (true only when the diff
touches the runtime behavioral surface). T3 is release-only. (Updated from the original "clear T0–T2
every sync" — T2 is now opt-in/triggered, not a per-sync gate.)

### Tier 0 — Deterministic structural gates  [automated, free, every build] — PARTLY EXISTS
The `build.mjs` contract (exists, drift-tested) + `claude plugin validate` **(currently run only
manually — must be wired into the build/CI as a script gate)**. Pure functions, no LLM, no network.
Catches: upstream changed *shape* in a way the adapter doesn't handle (new dir/file, agent-schema
change, un-rewritten Kiro construct, missing component, version skew).

### Tier 1 — Diff triage gate  [IMPLEMENTED: targets/claude/sync-triage.mjs]
The irreducible-judgment tier, with its human cost minimized by automation. As built:
- Diffs the vendored subdir between the lock's pinned SHA and a target SHA (rename-aware,
  `git diff --name-status -M`), classifying every changed path into:
  - **AUTO** — a modified `.md` whose changes are *fully neutralized by the adapter*: decided by
    `transformContent(old) === transformContent(new)` (imported from `build.mjs`, so "mechanical"
    means exactly what the adapter actually does — it can't drift from the real transform).
  - **CONTRACT** — structural changes T0 already hard-fails on if unhandled (pure renames of
    required components, deletions, new top-level entries). Informational; the build is the gate.
  - **ESCALATE** — semantic changes inside still-parsing content that build green but a human
    should see (renames *with* content change, non-mechanical `.md` edits, **new files**), with
    focused signals (e.g. "interaction flag present", "protocol — check for new sub-agent steps").
- **Fail-closed:** anything not provably mechanical lands in ESCALATE. Exit 2 when escalations
  exist (lets a pipeline pause). Wired into `sync-upstream.sh` as an advisory pre-swap pass
  (pauses on an interactive TTY; prints-and-proceeds in CI). Its classifier is regression-tested
  by `test/triage.test.mjs` (one fixture per change kind).
- This is v1's 3-category merge, but **automated as triage**, anchored to the adapter's own
  transform, with only the genuinely-new residual reaching a human.
- *Deferred (optional):* an LLM refinement pass over the ESCALATE set (benign-reword vs
  novel-concept), defaulting to ESCALATE on uncertainty. The deterministic backbone above is the
  reliable core and ships first.

### Tier 2 — Headless behavioral smoke test  [IMPLEMENTED: targets/claude/smoke.mjs]
Runs the freshly-built plugin under `claude -p --plugin-dir dist/claude` and asserts on the
stream-json. Split into two tiers by cost (verified facts drove the split):

**T2a — load smoke (cheap, OPT-IN via `RUN_SMOKE=1`; `make smoke`).** `claude -p "<trivial>"
--max-turns 1`, assert from `system/init`: our plugin is in `plugins[]` with no `plugin_errors`;
every required skill (`aidlc-v2:aidlc-orchestrator`, …) and agent
(`aidlc-v2:aidlc-builder-agent`/`-validator-agent`) is present and namespaced; ≥10 skills loaded;
the `result` event is not an error. One turn, minimal cost. This catches the overwhelmingly common
breakage — a sync that produced a plugin that won't load/wire up. *Verified passing against a real
`claude` 2.1.161 run.* NOTE: do **not** use `--bare` (it skips plugin loading — confirmed in `--help`).

**T2b — autonomous workflow smoke (EXPENSIVE, opt-in `--workflow`; `make smoke-workflow`).** A full
orchestrator run is impossible without disabling the human gates, and those flags
(`human-clarification`/`plan-verification`/`artefact-verification`) are read ONLY from each
SKILL.md frontmatter at runtime (`aidlc-process-checker.js:readSkillFrontmatterFlag`) — no
per-intent/workflow/CLI override exists. So T2b **copies `dist/claude` to a scratch dir and flips
those flags to `"false"`** (never touching `src/` or `dist/`), then runs a tiny fixture intent in an
`--add-dir` sandbox with `--max-turns`/`--max-budget-usd` caps and `--include-hook-events`, and
asserts: **builder/validator subagents spawned** (Agent tool_use referencing our agents), the
**process-check hook fired** (SubagentStop), **artifacts created** under the sandbox, run didn't
error. *Verified functional:* the autonomous run created the intent skeleton + `process-checkpoint.json`
+ validator results and advanced `intent-state.md` with no human — i.e. the multi-agent loop and the
flag-flip both work. Structural "did the machinery engage" assertions are robust to LLM
nondeterminism (content quality is T3's job, not asserted here).

Together (when run): T2a (cheap load check) + T2b (autonomous workflow) confirm the converted plugin
loads, the agents wire up, the hook fires, and the workflow advances — *behaviorally* compatible,
not just shape-compatible. **Both are OFF by default** (billable Bedrock; no plugin defects found in
practice): T2a runs only with `RUN_SMOKE=1`, T2b only on `--workflow`+`AIDLC_SMOKE_TRUST=1`, and the
release skill prompts for T2b only when T1's deterministic `t2b.advised` signal fires (the diff
touched the behavioral surface). Both SKIP cleanly if the `claude` CLI is absent.

### Tier 3 — Golden-master quality / regression  [SCORER IMPLEMENTED: targets/claude/score.mjs]
Catches *quality* regression (did the generated artifacts get materially worse). We did NOT vendor
the upstream Python evaluator (Bedrock + Docker + unreleased `strands-agents`); instead the
deterministic **HeuristicScorer is ported to dependency-free Node** — and **parity-locked** to
upstream bit-for-bit (`test/score.test.mjs` asserts the exact values the Python scorer produces:
intent 0.4333 / design 0.2 / completeness 0.6667 / overall 0.3867 on a fixed pair). It scores a
candidate `aidlc-docs/` tree against a committed golden master, per-document (term-frequency cosine
for intent, Jaccard of identifiers+headings for design, heading-coverage for completeness),
aggregated per-phase + overall, with `--min` as a regression gate.

What's deterministic vs not: the **scorer** is pure + reproducible (no LLM/network) — that's why
it's the gate. The **candidate** it scores comes from a full autonomous run (the expensive,
non-deterministic T2b machinery), so T3 is **release-only**, not every sync. The optional LLM scorer
(true semantic judgement, needs Bedrock, non-deterministic) is deliberately NOT ported — score.mjs
is honest lexical/structural similarity, a *signal* for human review, not proof of quality.

Golden masters live under `test/golden/<scenario>/` and must come from a **full, human-reviewed**
run (see `test/golden/README.md` for the capture procedure). None is committed yet — capturing one
needs a complete run (budget caps currently truncate the smoke runs); the scorer + harness are in
place and parity-verified, ready for a golden master when a full reviewed run exists.

### Meta-verification — proving the GATES themselves are correct
"How do we verify our method produces the desired outcome?" — make the gates self-tested:
- **Drift-injection test suite** (`test/drift/`): fixture `src/` trees, one per drift class (new
  dir, renamed orchestrator, reworded `invokeSubAgent`, unmapped tool, changed `.kiro` path, …),
  each asserting the build **fails with the expected message**. (I did this manually once; formalize
  it so every gate has a test proving it catches its target failure.)
- **Idempotency test:** build twice → byte-identical `dist/`.
- **Known-good baseline:** the current pinned SHA builds green + passes Tier 2; that's the reference
  a regression is measured against.
- Run these in CI on every change to `build.mjs`/`sync-upstream.sh`.

### Answers to the explicit sub-questions
- **Can we automate it?** T0 + meta-tests: fully automated, zero human, zero cost, every sync. T1:
  automated triage (also emits the `t2b.advised` trigger), human only on novel concepts. T2:
  off by default, billable — run pay-when-warranted (T2b when `t2b.advised`). T3: cost-gated to releases.
- **Is human input completely impossible to remove?** No — but the *only* irreducible human step is
  **deciding whether/how to adopt a genuinely new upstream concept** (a real judgment). Everything
  else is automated. The gates ensure the human is summoned *only there*, loudly, with the precise
  decision.
- **What gates ensure compatibility / no breakage / no new bugs?** The stack: T0 (shape compatible)
  + T2 (loads, wires up, runs, advances on the *autonomous* path) + T3-at-release (quality didn't
  regress) + meta-tests (the gates provably catch their failure modes). This RAISES CONFIDENCE; it
  does **not prove** "nothing breaks" — T0 ∧ T2 covers shape + autonomous-engagement, NOT the
  interactive approval path (T2 can't run it headlessly) and NOT artifact-content correctness
  (that's T3, release-only). Those two holes are covered by the periodic interactive smoke + T3.
- **Sustainable/repeatable/verifiable?** Repeatable: SHA pin + pure transform + scripted tiers.
  Verifiable: each tier emits machine-checkable assertions; meta-tests verify the tiers. Sustainable:
  per-sync cost is T0+T1+T2 (cheap, fast); the expensive T3 is rare.

### Pipeline shape
See **"Revised pipeline (per sync)"** under the Codex-review section below — that is the
authoritative sequence (T3 runs BEFORE the immutable tag; interactive-approval path covered
separately).

## Codex review — verdicts + adopted corrections

All three conclusions **confirmed** (no fatal flaw). Corrections folded in:

**Q1 — adopt, with guardrails.** Full-SHA-as-pin correct. The `+up.<short>` tag is sound as a
human **provenance label, NOT identity**: SemVer build metadata is *ignored for precedence*, so
**never publish two releases differing only after `+`** — always increment `alpha.N`. Git tags are
**not inherently immutable** → use **annotated + protected** tags and put the **full upstream SHA in
the tag message**. (Also: `UPSTREAM_SRC_TREE_HASH` is referenced in this doc but not yet in the lock
— add it before relying on tree-drift detection.)

**Q2 — confirmed skip, not rationalization.** Grounded in source: native conversational contract
(`aidlc-question-format.md:24,28`), builders forbidden to talk to the human
(`aidlc-builder-protocol.md:106`); AUQ is lossy under its limits and not headlessly verifiable.
**What would flip it:** measurable user friction with typed answers, upstream stabilization,
headless AUQ support, or a *very narrow orchestrator-only* overlay for one painful surface.

**Q3 — good architecture, but "nothing breaks" OVERCLAIMS. Re-scope the claim and fix gates:**
- **T2 will HANG on the native flow** — it waits for human clarification/approval
  (`aidlc-builder-protocol.md:53`, `aidlc-workflow-composition/SKILL.md:14`). **The smoke test MUST
  run an explicit AUTONOMOUS path**: a fixture intent on skills with `human-clarification:false` /
  `plan-verification:false` / `artefact-verification:false` (or a preseeded approval policy), so it
  runs to completion without a human. This is mandatory, not optional.
- **T2 asserts EVENTS + FILES, never prose:** plugin_errors empty, `Agent` tool calls present, hook
  event present, process_checker actually ran, expected artifact paths exist, checkpoint/state
  progressed, result not capped. (Robust to LLM nondeterminism precisely because it ignores content.)
- **`claude plugin validate` is currently only run manually — wire it into T0 as a script gate.**
- **Honest scope of the guarantee:** the pyramid REDUCES risk; it does **not** prove "nothing
  breaks." Concrete all-pass-but-broken hole: **interactive chat approval breaks**, but T0 passes,
  T1 misses it, T2 (autonomous) never exercises it, T3 only runs at release. Quality regressions
  also live only at T3 (process_checker confirms *coverage*, not artifact *correctness* —
  `aidlc-process-checker.js:18`). State this honestly; add a periodic interactive smoke (manual or
  SDK `canUseTool`) to cover the approval path T2 can't.
- **Sequencing fix:** run **T3 BEFORE** the public immutable tag, not after commit+tag.

### Revised pipeline (per sync)
`sync-upstream.sh <sha>` → **T0** (build + contract + wired `claude plugin validate`) → **T1**
(triage; escalate novel) → **T2** (headless smoke on an AUTONOMOUS fixture; assert events+files) →
[human approves T1 residual] → commit → **T3 at release-candidate** → annotated+protected tag
`v2.0.0-alpha.N+up.<short>` (full SHA in tag message). Interactive-approval path covered by a
separate periodic check (T2 can't reach it headlessly).

### Open risks
- T2 LLM nondeterminism: a flaky run could fail a structurally-fine plugin → use structural
  assertions (machinery engaged), retry-once, and don't assert on generated *content*, only on
  *engagement*. Quality content is T3's job (scored, not asserted).
- T3 deps (strands-agents unreleased, Bedrock) may block full reuse → fall back to a trimmed
  scorer-only harness on a committed golden master.
- T1 triage agent could misclassify a novel concept as mechanical → mitigate by making the kiro
  smell + any uncontracted hunk default to ESCALATE (fail-closed toward human review).
- Headless `claude -p` cost/time per sync (T2) — bounded by `--max-turns`/`--max-budget-usd`, and
  the smoke intent is deliberately tiny.
