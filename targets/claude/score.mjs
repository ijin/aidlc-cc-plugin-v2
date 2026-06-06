#!/usr/bin/env node
// score.mjs — T3 deterministic artifact scorer (quality-regression core).
//
// A faithful, dependency-free Node port of upstream's HeuristicScorer
// (scripts/aidlc-evaluator/.../qualitative/scorer.py). It compares a CANDIDATE
// aidlc-docs/ tree (produced by a workflow run) against a committed GOLDEN master,
// per-document, and aggregates per-phase + overall. Pure + reproducible: no LLM, no
// network, no Bedrock — same inputs always yield identical scores (that's why it's
// the gate, not the non-deterministic LLM scorer, which upstream keeps as optional).
//
// What it is: a STRUCTURAL/LEXICAL similarity check (term-frequency cosine for
// intent, Jaccard of identifiers+headings for design, heading-coverage for
// completeness). It catches a candidate that drifted materially from the golden
// shape/content — NOT a true semantic-quality judgement (that needs the LLM scorer).
//
// Usage:
//   node targets/claude/score.mjs <candidate-docs-dir> <golden-docs-dir> [--json] [--min <0..1>]
//     --min <n>  fail (exit 2) if overall_score < n (regression gate); else report-only
//
// Exit: 0 ok / 2 below --min / 1 error.

import fs from "node:fs";
import path from "node:path";

// --- exact constants ported from upstream scorer.py (must match bit-for-bit) ---
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "this", "that",
  "these", "those", "it", "its", "not", "no", "as", "if", "then",
  "than", "so", "up", "out", "about",
]);

// Workflow-state files excluded from scoring (state, not design intent).
const SKIP_FILES = new Set([
  "aidlc-state.md", "audit.md", "intent-state.md", "intent-audit.md", "intent-prompt.md",
]);

// Python's round() uses banker's rounding (round-half-to-even); JS Math.round is
// half-up. Match Python so the port is truly bit-for-bit (e.g. 0.66665 → 0.6666,
// not 0.6667). Operates at 4 decimals.
// Round to 4 decimals EXACTLY like Python's round(x, 4) (round-half-to-even on the
// decimal expansion of the double). Naive approaches all diverge somewhere:
//   - n*1e4 then round: float error on non-representable values (0.12345)
//   - Number(n.toFixed(4)): half-UP on exact representable ties (0.03125→0.0313,
//     but Python gives 0.0312)
// So expand to a high-precision decimal string (toFixed(20) round-trips a double),
// then round the DECIMAL at the 5th place with half-to-even via BigInt. Verified
// identical to Python across ties (0.03125, 0.09375), near-ties (0.12345, 0.12355),
// and ratios (1/3, 2/3, 0.66675, 0.08896).
function round4(n) {
  if (!Number.isFinite(n)) return n;
  const neg = n < 0;
  const s = Math.abs(n).toFixed(20);
  const dot = s.indexOf(".");
  const intPart = s.slice(0, dot);
  const frac = s.slice(dot + 1);
  const keep = frac.slice(0, 4);
  const rest = frac.slice(4); // digits past the 4th decimal decide the rounding
  const digits = intPart + keep; // integer value scaled by 1e4
  const firstRest = rest.charCodeAt(0) - 48;
  let roundUp;
  if (firstRest > 5) roundUp = true;
  else if (firstRest < 5) roundUp = false;
  else if (/[1-9]/.test(rest.slice(1))) roundUp = true; // > half
  else roundUp = ((digits.charCodeAt(digits.length - 1) - 48) % 2 === 1); // exact half → to even
  const scaled = BigInt(digits) + (roundUp ? 1n : 0n);
  const str = scaled.toString().padStart(5, "0");
  const ip = str.slice(0, str.length - 4) || "0";
  const fp = str.slice(str.length - 4);
  return Number((neg ? "-" : "") + ip + "." + fp);
}

// --- tokenization + similarity (ported verbatim) ---
function tokenize(text) {
  const words = (text.toLowerCase().match(/[a-z][a-z0-9_-]*/g) || []);
  return words.filter((w) => !STOPWORDS.has(w) && w.length > 1);
}
function termCounts(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}
function cosineSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0.0;
  let overlap = 0;
  for (const [k, v] of a) if (b.has(k)) overlap += v * b.get(k);
  let magA = 0; for (const v of a.values()) magA += v * v;
  let magB = 0; for (const v of b.values()) magB += v * v;
  magA = Math.sqrt(magA); magB = Math.sqrt(magB);
  if (magA === 0 || magB === 0) return 0.0;
  return overlap / (magA * magB);
}
function extractIdentifiers(text) {
  const camel = text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) || [];
  const snake = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [];
  const paths = text.match(/\b\w+(?:\/\w+)+(?:\.\w+)?\b/g) || [];
  const out = new Set();
  for (const s of [...camel, ...snake, ...paths]) out.add(s.toLowerCase());
  return out;
}
function extractHeadings(text) {
  const out = [];
  for (const m of text.matchAll(/^#+\s+(.+)$/gm)) out.push(m[1].trim().toLowerCase());
  return out;
}
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// --- per-document score ---
function scoreDocument(refText, candText) {
  const intent = cosineSimilarity(termCounts(tokenize(refText)), termCounts(tokenize(candText)));
  const refIds = extractIdentifiers(refText), candIds = extractIdentifiers(candText);
  const refH = extractHeadings(refText), candH = extractHeadings(candText);
  const refHset = new Set(refH), candHset = new Set(candH);
  const idSim = jaccard(refIds, candIds);
  const headingSim = jaccard(refHset, candHset);
  const design = 0.6 * idSim + 0.4 * headingSim;
  let completeness;
  if (refHset.size) {
    let inter = 0; for (const h of refHset) if (candHset.has(h)) inter++;
    completeness = inter / refHset.size;
  } else {
    completeness = candHset.size === 0 ? 1.0 : 0.0;
  }
  // Upstream rounds the three component scores FIRST, then DocumentScore's
  // __post_init__ computes overall from those ROUNDED fields. Match that order
  // (computing overall from raw values diverges in the 4th decimal).
  const ri = round4(intent), rd = round4(design), rc = round4(completeness);
  return {
    intent_similarity: ri,
    design_similarity: rd,
    completeness: rc,
    overall: round4(0.4 * ri + 0.4 * rd + 0.2 * rc),
  };
}

// --- path normalization + phase classification (ported) ---
function normalisePath(rel) {
  // strip v2 intent prefix: "intent-NNN-slug/..." → "..." (exactly 3 digits, per upstream)
  let p = rel.replace(/^intent-\d{3}-[^/]+\//, "");
  // collapse per-unit construction dir: "construction/<unit>/..." → "construction/_unit_/..."
  p = p.replace(/^(construction\/)[^/]+\/(.*)$/, "$1_unit_/$2");
  return p;
}
function phaseOf(normPath) {
  if (normPath.startsWith("inception/")) return "inception";
  if (normPath.startsWith("construction/")) return "construction";
  if (normPath.startsWith("bootstrap/")) return "bootstrap";
  return "other";
}

// Collect scorable .md docs under a docs root → {map: Map<normPath, absPath>,
// collisions: Set<normPath>}. Collisions arise when per-unit construction paths
// normalize to the same key (faithful to upstream's single-_unit_ collapse).
function collectDocs(root) {
  const map = new Map();
  const collisions = new Set();
  if (!fs.existsSync(root)) return { map, collisions };
  const walk = (dir) => {
    // Sort entries so traversal order matches upstream's sorted(rglob).
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md") && !SKIP_FILES.has(e.name)) {
        // Upstream skips empty docs; match it (an empty file is not a scorable artifact).
        if (fs.readFileSync(full, "utf-8").trim() === "") continue;
        const norm = normalisePath(path.relative(root, full));
        // Per-unit construction paths collapse to construction/_unit_/... (faithful
        // to upstream), so multiple units overwrite each other — a multi-unit blind
        // spot. Track collisions so the caller can surface the limitation.
        if (map.has(norm)) collisions.add(norm);
        map.set(norm, full);
      }
    }
  };
  walk(root);
  return { map, collisions };
}

export function compareDocs(candidateRoot, goldenRoot) {
  const { map: golden, collisions: goldenCollisions } = collectDocs(goldenRoot);
  const { map: candidate } = collectDocs(candidateRoot);
  const phases = new Map(); // phase → [docScore]
  const unmatchedRef = [], unmatchedCand = [];
  for (const [norm, goldenAbs] of golden) {
    const candAbs = candidate.get(norm);
    if (!candAbs) { unmatchedRef.push(norm); continue; }
    const s = scoreDocument(fs.readFileSync(goldenAbs, "utf-8"), fs.readFileSync(candAbs, "utf-8"));
    const ph = phaseOf(norm);
    if (!phases.has(ph)) phases.set(ph, []);
    phases.get(ph).push({ path: norm, ...s });
  }
  for (const norm of candidate.keys()) if (!golden.has(norm)) unmatchedCand.push(norm);

  const phaseScores = [];
  for (const [phase, docs] of phases) {
    const n = docs.length;
    const avg = (k) => round4(docs.reduce((a, d) => a + d[k], 0) / n);
    phaseScores.push({
      phase, documents: docs,
      avg_intent: avg("intent_similarity"), avg_design: avg("design_similarity"),
      avg_completeness: avg("completeness"), avg_overall: avg("overall"),
    });
  }
  const scored = phaseScores.filter((p) => p.documents.length);
  const overall_score = scored.length
    ? round4(scored.reduce((a, p) => a + p.avg_overall, 0) / scored.length) : 0.0;
  return {
    overall_score,
    phases: phaseScores,
    unmatched_reference: unmatchedRef.sort(),
    unmatched_candidate: unmatchedCand.sort(),
    // Per-unit construction paths that collapsed to one key (multi-unit blind spot).
    unit_collapse: [...goldenCollisions].sort(),
  };
}

// --- CLI ---
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = process.argv.slice(2);
  const jsonOut = args.includes("--json");
  const minIdx = args.indexOf("--min");
  let min = null;
  if (minIdx >= 0) {
    // An invalid --min must NOT silently disable the gate (NaN comparisons are
    // always false → would "pass"). Require a finite number in [0,1].
    min = Number(args[minIdx + 1]);
    if (!Number.isFinite(min) || min < 0 || min > 1) {
      console.error(`ERROR: --min must be a number in [0,1], got '${args[minIdx + 1]}'`);
      process.exit(1);
    }
  }
  const positional = args.filter((a, i) => !a.startsWith("--") && !(minIdx >= 0 && i === minIdx + 1));
  const [candidate, golden] = positional;
  if (!candidate || !golden) {
    console.error("usage: score.mjs <candidate-docs-dir> <golden-docs-dir> [--json] [--min <0..1>]");
    process.exit(1);
  }
  if (!fs.existsSync(golden)) { console.error(`ERROR: golden dir not found: ${golden}`); process.exit(1); }
  const result = compareDocs(candidate, golden);
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nT3 quality score: candidate vs golden`);
    console.log(`  candidate: ${candidate}`);
    console.log(`  golden:    ${golden}\n`);
    for (const p of result.phases) {
      console.log(`  ${p.phase.padEnd(13)} overall ${p.avg_overall.toFixed(4)}  (intent ${p.avg_intent.toFixed(2)} design ${p.avg_design.toFixed(2)} complete ${p.avg_completeness.toFixed(2)})  [${p.documents.length} docs]`);
    }
    console.log(`\n  OVERALL: ${result.overall_score.toFixed(4)}`);
    if (result.unmatched_reference.length) console.log(`  ⚠ ${result.unmatched_reference.length} golden doc(s) MISSING from candidate: ${result.unmatched_reference.slice(0, 8).join(", ")}${result.unmatched_reference.length > 8 ? " …" : ""}`);
    if (result.unmatched_candidate.length) console.log(`  · ${result.unmatched_candidate.length} extra candidate doc(s) not in golden`);
    if (result.unit_collapse.length) console.log(`  ⚠ ${result.unit_collapse.length} per-unit path(s) collapsed to one key (multi-unit blind spot, faithful to upstream): ${result.unit_collapse.slice(0, 5).join(", ")}`);
  }
  if (min != null) {
    // Gate soundness: overall_score only averages the docs that MATCHED. A
    // candidate missing half the golden docs could score 1.0 on what's present
    // and slip past --min. Under the gate, any missing golden doc is fatal — the
    // run must produce the expected artifacts AND at the expected quality.
    if (result.unmatched_reference.length) {
      console.error(
        `\nFAIL: ${result.unmatched_reference.length} golden doc(s) missing from the candidate ` +
          `(gate mode requires all golden docs present):\n  ${result.unmatched_reference.join("\n  ")}`
      );
      process.exit(2);
    }
    if (result.overall_score < min) {
      console.error(`\nFAIL: overall ${result.overall_score} < --min ${min} (quality regression).`);
      process.exit(2);
    }
    console.log(`\nPASS: overall ${result.overall_score} >= --min ${min}, all golden docs present.`);
  }
}
