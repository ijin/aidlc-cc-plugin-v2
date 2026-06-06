# Golden masters for T3 quality-regression scoring

A *golden master* is a committed, human-reviewed `aidlc-docs/` tree from a known-good
workflow run. `targets/claude/score.mjs` compares a fresh run's output against one of these
(deterministic, bit-for-bit reproducible — see `test/score.test.mjs` for the parity lock to
upstream's Python scorer) and reports per-phase + overall similarity, with `--min` to gate.

## Layout

```
test/golden/<scenario>/
  vision.md          # the intent/input that drives the run (what to build)
  aidlc-docs/        # the golden output tree (the reference to score against)
    bootstrap/ inception/ construction/ ...
```

## Capturing a golden master (do this from a FULL, reviewed run)

A golden master must come from a **complete, successful, human-reviewed** run — not a
budget-capped or partial one. Procedure:

1. Run the autonomous workflow to completion against the scenario's `vision.md`, with a budget
   high enough to finish (no `error_max_budget_usd`/`error_max_turns`):
   ```bash
   # in a disposable env; this runs untrusted upstream instructions (see smoke.mjs)
   AIDLC_SMOKE_TRUST=1 AIDLC_SMOKE_MAX_BUDGET=50 node targets/claude/smoke.mjs --workflow --keep
   ```
   (or drive `claude -p` directly with the flag-flipped plugin and your own intent.)
2. **Review the generated `aidlc-docs/` tree by hand.** Only promote output you'd be happy to
   regress against — this is the quality bar every future sync is measured against.
3. Copy the reviewed tree here, stripping the per-intent prefix is NOT needed (the scorer
   normalizes `intent-NNN-slug/` and per-unit dirs automatically):
   ```bash
   mkdir -p test/golden/<scenario>
   cp <run>/vision.md test/golden/<scenario>/vision.md
   cp -R <run>/org-ai-kb/aidlc-docs test/golden/<scenario>/aidlc-docs
   ```
4. Commit it. Record which upstream SHA + plugin version produced it in the commit message.

## Using it (T3, release-gated)

T3 is **release-only** — it needs a full (expensive) autonomous run to produce the candidate,
then scores it:

```bash
# 1. produce a candidate tree (full run, --keep), then:
node targets/claude/score.mjs <candidate-aidlc-docs> test/golden/<scenario>/aidlc-docs --min 0.80
```

Pick `--min` from the golden's own self-score (1.0) minus an allowed drift band; start lenient
(e.g. 0.75–0.85) and tighten as you gather runs. A drop below `--min` flags a quality regression
for human review — it is a *signal*, not proof (this is lexical/structural similarity, not a true
semantic-quality judgement; that would need the optional LLM scorer + Bedrock).

## Why no golden master is committed yet

Capturing one requires a full, reviewed run (budget caps currently truncate the smoke runs). The
scorer + harness are in place and parity-verified; commit a golden master once you have a complete
run you're willing to hold as the quality bar.
