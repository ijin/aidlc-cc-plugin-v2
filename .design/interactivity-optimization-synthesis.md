# AI-DLC v2 — upstream sync + AskUserQuestion optimization: design synthesis

Working doc (not shipped). Output of a 4-proposal / 4-critique / 1-synthesis brainstorm,
to be hardened with Codex before implementation.

## Q1 — Pin mechanism: lock vs tag vs CHANGELOG

**Keep `UPSTREAM.lock` SHA as the sole build-consumed pin.** A full SHA is the only
immutable, content-addressed input; a tag is a human alias (and v2 has none, and tags on a
force-pushable repo can move); a CHANGELOG is prose and can never drive a `git checkout`.

Forward-compat (additive, resolution semantics unchanged):
- `UPSTREAM_REF` + `UPSTREAM_REF_TYPE` (`branch`|`tag`), resolved to a SHA at sync; the build
  still reads only `UPSTREAM_SHA`. Tag = label/provenance, never the pin.
- `UPSTREAM_SRC_TREE_HASH` = `git rev-parse <SHA>:src` — asserted at sync and at build start.
  Detects lock-vs-vendored-`src/` skew and force-push mutation of `src/` under a reused SHA.
- `--verify-tag` mode: re-resolve the tag; fail if it no longer equals the recorded SHA (moved tag).
- CHANGELOG stays in the commit body only.

## Q2 — Determinism verdict

Deterministic for the **mechanical transform** (fixed SHA → byte-identical `src/`;
`transformContent` is pure; contract aborts loudly; sync rewrites lock only on green) **and for
drift detection**. Human needed only for **adoption** of a genuinely new upstream concept.
Gap closures: promote any newly-discovered Kiro primitive (surfaced by the `/\bkiro\b/i` WARN)
into `DIST_FORBIDDEN` so the one-time judgment becomes a permanent hard check; close semantic
drift in still-parsing markdown via region-baseline hashing on flag tokens + channel prose.

## Q3 — AskUserQuestion optimization

**Applicable; the orchestrator (main loop) is the only possible host** (builder/validator are
subagents, forbidden to talk to the human, and AskUserQuestion is main-loop-only).

### The critique that reshaped the design (all 4 proposals shared one fatal flaw)
Append-only injection is WRONG here, because:
1. `dist/.../skills/aidlc-orchestrator/SKILL.md` is a ~13-line stub; behavior lives in
   `aidlc-common/protocols/aidlc-orchestrator-protocol.md`.
2. The three "present X, wait" lines sit **inside a fenced ```pseudocode``` block** (§3 loop) —
   a model reads them as an illustrative sketch, not the operative channel instruction.
3. `aidlc-question-format.md` carries **contradictory** prose ("present questions one at a time
   in chat, wait for the answer") — the OPPOSITE of AskUserQuestion's batch-of-1-4 model.
   Appending beside a contradiction does not neutralize it.
4. **Missed interaction surfaces**: workflow-composition's artifact approval lives in
   `src/skills/aidlc-workflow-composition/SKILL.md` §2 (reached in the §1.1 bootstrap pre-loop,
   not at any §3 anchor); plus the validator-fail **halt-and-present-to-human** escalation
   (protocol ~line 63). An append keyed to §3 silently ships these un-optimized.

### Mechanism (REPLACE-at-seam overlay, build-owned)
- A single in-repo Claude-only overlay (`targets/claude/overlays/askuserquestion-presentation.md`),
  injected by a new `buildOverlay()` step (after `buildAgents`, before `validate`), into the
  **set** of presentation-bearing surfaces — not one file:
  - clarification channel prose in `aidlc-question-format.md` → **REPLACE** the contradictory
    "one-at-a-time-in-chat" region with the AskUserQuestion mapping (1 question/AUQ call, option
    text→label+description, `d) Other`→built-in free-text, `Recommendation`→prefix, batch 1-4
    with a chat-or-file fallback when a round exceeds limits);
  - plan-approval (gated on `plan-creation` true), artifact-approval, workflow-composition
    approval (the missed 4th surface), halt-escalation (5th) → flag-anchored sections;
  - write the chosen option back to the `[Answer]:` line (letter + verbatim text) before the
    state transition, preserving the file-based audit trail.
- Key on **flag tokens + file identity**, never upstream sentences. Idempotent strip-then-replace
  between stable sentinel markers; a second in-memory pass must be byte-identical.

### Re-apply method (replaces v1's manual 3-category merge)
- Deterministic injection on **every build** (which every sync runs). The unit shrinks from v1's
  7 whole-file overrides to ~4-5 anchored **regions** in 2-3 files.
- `INTERACTION-BASELINE.json` stores a **normalized SHA-256 per load-bearing region**. On any
  mismatch the build **THROWS at a located region** with one-line re-bless instructions — turning
  "did a human notice in the diff?" into "the build stops and names the broken assumption."
- Residual (advisory prose: build proves it SHIPPED, not that the orchestrator CALLS AUQ) closed
  by a **runtime eval gate** (empirical-prompt-tuning), optional SubagentStop/PostToolUse backstop.

### Contract checks to add
OVERLAY-PRESENT; ASKUSERQUESTION-CONSTRAINTS-LINT (≤12-char header, ≤4 options, 1-4 q/call,
explicit Other, oversized-round fallback); REGION-ANCHOR-HASH; OVERLAY-COMPLETENESS (injected
sites == regions, vanished seam = hard fail); OPTIMIZATION-APPLIED postcondition (dist channel
region CONTAINS AskUserQuestion AND the one-at-a-time phrasing is GONE — proves REPLACE not
append); INTERACTION-INVENTORY (all surfaces covered, anchored on flags+skill presence, not a
present/wait regex); FLAG-VOCABULARY-BASELINE (parse {human-clarification, plan-verification,
artefact-verification [British spelling], plan-creation, per-unit}, diff vs committed baseline);
SUBAGENT-SAFETY (AUQ only in orchestrator/common, never in dist agents); MAIN-LOOP-ONLY-PRESERVED;
UPSTREAM_SRC_TREE_HASH; IDEMPOTENCY self-test.

### Codex review round 1 — verified findings (design v2 incorporates these)

Codex verified against source and **confirmed**: the question-format contradiction
(`aidlc-question-format.md:5` saves all-at-once vs `:24` present one-at-a-time/wait), the
fenced-pseudocode interaction loop (`orchestrator-protocol.md:39` fence; clarification `:46`,
plan `:54`, **validator-fail halt `:63`**, artifact `:66`), and the workflow-composition gate
(`aidlc-workflow-composition/SKILL.md:14` sets `artefact-verification:"true"`, `:19` is the
approval gate). It then found the surface set **still incomplete**:

- **[High] Subagent-leakage via the overlay target.** `aidlc-question-format.md` is read by
  **builders** (`builder-protocol.md:38`), who are forbidden human interaction (`:106`). Putting
  AskUserQuestion prose *in that shared file* leaks main-loop-only behavior into subagent-readable
  docs. → AUQ guidance must live in an **orchestrator-only** surface (or be explicitly fenced
  "orchestrator-only"), and the SUBAGENT-SAFETY lint must also forbid AUQ text in any file
  builders/validators are told to read — not just `dist/agents/`.
- **[High] CATALOGUE.md is an unlisted interaction source.** The orchestrator reads the catalogue
  (`orchestrator-protocol.md:7`); `CATALOGUE.md:34` still says the human answers "in chat or in
  the file" and `:36` defines plan/artifact approval. A 3-file overlay leaves stale channel prose
  in a file the orchestrator reads → must be a covered surface.
- **[Med] intent-bootstrap unresolved.** Its flags disable human clarification, yet
  `aidlc-intent-bootstrap/SKILL.md:31` still says "Ask only…" / "present the auto-generated slug;
  offer to override." → either declare it auto-answer-only under `human-clarification:false`, or
  treat org-kb/slug/classification as a bootstrap interaction surface. Decide explicitly.
- **[Med] Approval/rejection → STATE mapping is underspecified.** Writing the chosen option back
  to `[Answer]` fits *clarification* but not plan/artifact *decisions*, which require state
  transitions: `planning:approved`/`planning:revision-requested` (`state-schema.md:103`),
  `verification:approved`/`verification:rejected` (`:119`). The overlay must specify
  response→state-transition mappings + audit writes, not only answer-file preservation.

**The deepest refinement — anchor the inventory to the STATE MACHINE, not a file list.** Codex:
"the inventory must be state-machine-driven: every `awaiting-human`, `revision-requested`,
`rejected`, `halting`, and human-response transition needs an owned presentation rule or an
explicit 'not AUQ-applicable' waiver." The state transitions in `state-schema.md` are
machine-readable and stable — they are the canonical, drift-resistant anchor (a new human
touchpoint shows up as a new `awaiting-human`-class transition, which the contract can diff
against a committed baseline). This supersedes "hash a hand-picked set of files."

### Design v2 — net changes from the above
1. **Inventory anchor = state machine.** Parse the `awaiting-human`/`revision-requested`/
   `rejected`/`halting` transitions from `state-schema.md`; each must have either an overlay
   presentation rule or a committed `NOT-AUQ-APPLICABLE` waiver. New/changed transition →
   build fails (`STATE-SURFACE-COVERAGE` check) — this is the real completeness guarantee.
2. **Overlay home = orchestrator-only.** The AUQ presentation spec lives in an orchestrator-only
   file (the orchestrator protocol's own overlay region and/or a new orchestrator-only doc the
   protocol references). Shared/subagent-readable files (`question-format.md`, builder/validator
   protocols) get at most a neutral, channel-agnostic note; their contradictory channel prose is
   REPLACED with channel-neutral wording, not with AUQ instructions.
3. **Surfaces (now 6, state-anchored):** clarification, plan-approval (gated on `plan-creation`),
   artifact-approval, **workflow-composition approval**, **validator-fail halt/escalation**, and
   the **CATALOGUE channel prose**. intent-bootstrap explicitly classified (waiver: auto-answer).
4. **Response→state mapping in the overlay:** clarification → `[Answer]` writeback; plan decision
   → `planning:approved|revision-requested`; artifact/workflow decision →
   `verification:approved|rejected`; each with the audit write the state machine expects.
5. **SUBAGENT-SAFETY lint widened:** AUQ tokens must appear ONLY in orchestrator-only surfaces —
   forbidden in `dist/agents/*.md` AND in any file the builder/validator protocols instruct a
   subagent to read.

### Codex review round 2 — AGREE (convergence reached)
Codex confirmed all 4 prior findings are resolved at the design level and that the
state-machine-anchored inventory "is the right completeness guarantee… stronger than a hand-picked
file list because human interaction is represented canonically by `awaiting-human`,
`revision-requested`, `rejected`, and `halting` transitions. Requiring every such transition to
have either an overlay rule or committed waiver gives you deterministic drift detection."

**Final implementation caveat (adopted):** the waiver/rule registry must be a **machine-readable
mapping**, not prose — `transition-key → rule-id | waiver-id` (in `INTERACTION-BASELINE.json`).
The build must fail on **orphaned rules or waivers** (a rule/waiver whose transition no longer
exists, or a transition with neither). This closes the loop: every human-interaction transition is
either owned by an overlay presentation rule or explicitly waived, and both directions are checked.

→ Design is **agreed sound + sustainable + deterministic to implement.**

### Open risks (can't be closed by build checks alone)
- Advisory prose: build verifies presence, not runtime behavior → needs the eval gate.
- Semantic inversion in a stable-shape grammar (markers unchanged, option meaning / `[Answer]`
  semantics changed) → region-hash catches a reword, not a meaning change.
- File rename / loop split evades `checkSrcContract` (top-level only) → backstopped by
  OVERLAY-COMPLETENESS + REGION-ANCHOR-HASH + tree-hash, as a loud stop.
- Re-bless reviewer fatigue (cosmetic edits still fire the hash) — but one-region scope is far
  cheaper than v1's whole-file merge.
- AskUserQuestion's ≤4-option / short-header / 1-4-question limits lose fidelity on long or
  many-option questions → chunk/truncate/fallback, lossy.
- A new interaction point on an *existing* flag, or a new flag *value*, slips the name-only
  baseline → surfaces via the kiro WARN at sync, needs a one-time overlay extension.
