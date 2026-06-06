#!/usr/bin/env node
// score.test.mjs — verifies the T3 deterministic scorer (score.mjs):
//   - identical docs → 1.0 across all dimensions
//   - a known doc pair → the EXACT values upstream's Python scorer produces
//     (cross-checked: intent 0.4333 / design 0.2 / completeness 0.6667 / overall 0.3867)
//   - missing/extra docs are reported as unmatched
//   - determinism: scoring twice yields identical output
//
// Usage: node test/score.test.mjs   (exit 0 = all pass)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { compareDocs } from "../targets/claude/score.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const fails = [];
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
function check(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(`${name}: ${detail}`); console.log(`  FAIL  ${name} — ${detail || ""}`); }
}

// Build a throwaway candidate/golden pair of doc trees.
function makeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "score-test-"));
const gold = path.join(tmp, "gold");
const cand = path.join(tmp, "cand");

const GOLD_REQ = `# Requirements

## Functional Requirements
The MathEngine component computes results. See src/math/engine.py for run_compute.
Supports add, subtract, multiply operations with proper error handling.

## Non-Functional Requirements
Latency under 100ms. The ResponseModel wraps each result.
`;
const CAND_REQ = `# Requirements

## Functional Requirements
A Calculator service handles arithmetic. See src/calc/core.py for the compute_value method.
Supports add and divide operations.

## Quality Attributes
Fast responses required.
`;

try {
  // 1. identical docs → 1.0
  makeTree(gold, { "inception/requirements-analysis/requirements.md": GOLD_REQ });
  makeTree(cand, { "inception/requirements-analysis/requirements.md": GOLD_REQ });
  let r = compareDocs(cand, gold);
  check(close(r.overall_score, 1.0), "identical docs → overall 1.0", `got ${r.overall_score}`);

  // 2. known pair → EXACT values matching upstream Python (parity-locked)
  fs.rmSync(cand, { recursive: true, force: true });
  makeTree(cand, { "inception/requirements-analysis/requirements.md": CAND_REQ });
  r = compareDocs(cand, gold);
  const d = r.phases[0].documents[0];
  check(close(d.intent_similarity, 0.4333, 1e-4), "intent matches Python (0.4333)", `got ${d.intent_similarity}`);
  check(close(d.design_similarity, 0.2, 1e-4), "design matches Python (0.2)", `got ${d.design_similarity}`);
  check(close(d.completeness, 0.6667, 1e-4), "completeness matches Python (0.6667)", `got ${d.completeness}`);
  check(close(d.overall, 0.3867, 1e-4), "overall matches Python (0.3867)", `got ${d.overall}`);

  // 3. missing golden doc → unmatched_reference; extra candidate doc → unmatched_candidate
  fs.rmSync(cand, { recursive: true, force: true });
  fs.rmSync(gold, { recursive: true, force: true });
  makeTree(gold, {
    "inception/requirements-analysis/requirements.md": GOLD_REQ,
    "inception/user-stories/user-stories.md": "# Stories\n## Epic\nA story.\n",
  });
  makeTree(cand, {
    "inception/requirements-analysis/requirements.md": GOLD_REQ,
    "construction/_unit_/code/extra.md": "# Extra\nNot in golden.\n",
  });
  r = compareDocs(cand, gold);
  check(r.unmatched_reference.includes("inception/user-stories/user-stories.md"), "missing golden doc reported", JSON.stringify(r.unmatched_reference));
  check(r.unmatched_candidate.length >= 1, "extra candidate doc reported", JSON.stringify(r.unmatched_candidate));

  // 4. phase classification + per-unit normalization
  fs.rmSync(cand, { recursive: true, force: true });
  fs.rmSync(gold, { recursive: true, force: true });
  makeTree(gold, { "intent-001-foo/construction/my-unit/code/code-generation-plan.md": "# Plan\n## Step\nx\n" });
  makeTree(cand, { "intent-001-foo/construction/other-unit/code/code-generation-plan.md": "# Plan\n## Step\nx\n" });
  r = compareDocs(cand, gold);
  const constr = r.phases.find((p) => p.phase === "construction");
  check(!!constr && close(constr.avg_overall, 1.0), "per-unit paths normalize + classify as construction", JSON.stringify(r.phases.map((p) => p.phase)));

  // 5. determinism: same inputs → identical result twice
  const a = JSON.stringify(compareDocs(cand, gold));
  const b = JSON.stringify(compareDocs(cand, gold));
  check(a === b, "scoring is deterministic (identical output twice)", "differed");

  // 6. CLI gate: missing golden doc must FAIL under --min (not pass on present docs).
  // (candidate has only requirements.md; golden also has user-stories.md from case 3 setup)
  const scoreCli = path.join(SCRIPT_DIR, "..", "targets", "claude", "score.mjs");
  fs.rmSync(cand, { recursive: true, force: true });
  fs.rmSync(gold, { recursive: true, force: true });
  makeTree(gold, {
    "inception/requirements-analysis/requirements.md": GOLD_REQ,
    "inception/user-stories/user-stories.md": "# Stories\n## Epic\nA story.\n",
  });
  makeTree(cand, { "inception/requirements-analysis/requirements.md": GOLD_REQ });
  const run = (extra) => spawnSync("node", [scoreCli, cand, gold, ...extra], { encoding: "utf-8" });
  const missGate = run(["--min", "0.5"]);
  check(missGate.status === 2 && /missing/i.test(missGate.stderr), "--min fails when golden docs are missing", `exit ${missGate.status}: ${(missGate.stderr || "").slice(0, 120)}`);

  // 7. CLI gate: invalid --min must ERROR (exit 1), not silently pass.
  const badMin = run(["--min", "oops"]);
  check(badMin.status === 1 && /--min must be a number/.test(badMin.stderr), "invalid --min errors (exit 1)", `exit ${badMin.status}`);

  // 8. completeness rounding parity on an EXACT representable tie: 1 of 32 matching
  // headings = 0.03125, which Python round()s half-to-even to 0.0312 (NOT 0.0313).
  // This is the case naive toFixed/scaled rounding gets wrong.
  fs.rmSync(cand, { recursive: true, force: true });
  fs.rmSync(gold, { recursive: true, force: true });
  // ref has EXACTLY 32 distinct headings; candidate matches EXACTLY 1 → 1/32 = 0.03125.
  const refHeads = Array.from({ length: 32 }, (_, i) => `# Heading ${i + 1}\nbody ${i + 1}\n`).join("\n");
  makeTree(gold, { "inception/x/x.md": refHeads });
  makeTree(cand, { "inception/x/x.md": "# Heading 1\nbody 1\n" }); // 1 of 32 headings match
  r = compareDocs(cand, gold);
  const compVal = r.phases[0].documents[0].completeness;
  check(close(compVal, 0.0312, 1e-9),
    "exact-tie completeness 1/32=0.03125 → 0.0312 (half-to-even, matches Python)", `got ${compVal}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail) { console.error("\nScorer failures:"); for (const f of fails) console.error("  - " + f); process.exit(1); }
console.log("T3 deterministic scorer is correct & parity-locked to upstream. ✓");
