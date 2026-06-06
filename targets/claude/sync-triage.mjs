#!/usr/bin/env node
// sync-triage.mjs — T1 diff-triage gate for an upstream sync.
//
// When upstream changes, this classifies every changed path in `src/` between the
// currently-pinned SHA (UPSTREAM.lock) and a target SHA, into:
//
//   AUTO     — fully handled mechanically; no human attention needed.
//   CONTRACT — a structural change T0 (the build contract) will catch as a hard
//              build failure if unhandled (new/removed/renamed component, etc.).
//              Informational here; the build is the real gate.
//   ESCALATE — a semantic change inside still-parsing content that the build may
//              pass green but that a human should look at (a reworded protocol, a
//              new interaction step, a changed artifact spec, a brand-new file).
//
// DESIGN: T0 already hard-fails on structural drift, so T1 does NOT re-implement
// that — its unique value is surfacing the semantic residual T0 can't see. It is
// FAIL-CLOSED: anything not provably mechanical lands in ESCALATE. The mechanical
// filter is anchored to the adapter's OWN transform (imported transformContent),
// so "mechanical" means exactly "the adapter neutralizes it", never a guess.
//
// This is the DETERMINISTIC backbone (no LLM, fully repeatable). An optional LLM
// refinement of the ESCALATE set is layered on top (see --llm), defaulting to
// ESCALATE on any uncertainty.
//
// Usage:
//   node targets/claude/sync-triage.mjs <target-sha> [--repo <path>] [--json]
//     <target-sha>   upstream commit to compare the pinned SHA against
//     --repo <path>  local upstream clone (default: ../aidlc-workflows relative to
//                    repo root, falling back to a sibling); must have the SHAs
//     --json         emit machine-readable JSON instead of the human report
//
// Exit codes: 0 = nothing to escalate (all AUTO/CONTRACT); 2 = items need human
// review; 1 = error. (Non-zero-on-escalate lets a pipeline pause for the human.)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  transformContent,
  INTERACTION_FLAGS,
  REQUIRED_SRC_DIRS,
  REQUIRED_SKILLS,
  REQUIRED_AGENTS,
} from "./build.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const LOCK = path.join(ROOT, "UPSTREAM.lock");

// --- T2b advisability: deterministically decide when the EXPENSIVE behavioral
// smoke (T2b) is worth running. T2b uniquely verifies runtime WIRING/control-flow
// (orchestrator spawns builder+validator subagents, hook fires, state advances) —
// NOT artifact content. So it only adds value when a change touches the
// "behavioral surface": the agent defs, the control-flow protocols, the
// process-checker, the state-machine/workflow conventions, the orchestrator /
// workflow-composition skills, OR an interaction-flag VALUE (which flips a control
// gate). Pure stage-skill prose / convention wording / validation-spec bodies do
// NOT change wiring → T2b adds nothing there, skip it.
//
// The advisory is FAIL-CLOSED toward running T2b: when unsure, advise it (a missed
// behavioral change that ships broken is far costlier than one extra smoke run).
// Path is the subdir-relative form (leading `<subdir>/` still attached).
const BEHAVIORAL_PATH_RES = [
  /(^|\/)agents\//,                                   // subagent definitions
  /(^|\/)aidlc-common\/protocols\//,                  // orchestrator/builder/validator control flow
  /(^|\/)aidlc-common\/scripts\//,                    // the process-checker (executable gate)
  /(^|\/)skills\/[^/]+\/scripts\//,                   // per-skill executable tools (validator runtime)
  /(^|\/)aidlc-common\/conventions\/aidlc-state-schema\.md$/,
  /(^|\/)aidlc-common\/conventions\/aidlc-workflow-format\.md$/,
  /(^|\/)aidlc-common\/conventions\/aidlc-folder-structure\.md$/, // path assumptions the checker/agents rely on
  /(^|\/)aidlc-common\/conventions\/aidlc-question-format\.md$/,  // clarification-file behavior
  /(^|\/)skills\/aidlc-orchestrator\//,               // workflow composition/dispatch
  /(^|\/)skills\/aidlc-workflow-composition\//,
];
const isBehavioralPath = (p) => BEHAVIORAL_PATH_RES.some((re) => re.test(p));

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// --- args ---
const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const repoFlag = args.indexOf("--repo");
let repo = repoFlag >= 0 ? args[repoFlag + 1] : null;
const positional = args.filter((a, i) => !a.startsWith("--") && !(repoFlag >= 0 && i === repoFlag + 1));
const targetSha = positional[0];
if (!targetSha) die("usage: sync-triage.mjs <target-sha> [--repo <path>] [--json]");

// --- read the lock ---
if (!fs.existsSync(LOCK)) die(`missing ${LOCK}`);
const lock = Object.fromEntries(
  fs.readFileSync(LOCK, "utf-8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i), l.slice(i + 1)];
  })
);
const oldSha = lock.UPSTREAM_SHA;
const subdir = lock.UPSTREAM_SUBDIR || "src";
if (!oldSha) die("UPSTREAM_SHA not set in lock");

// --- locate the upstream clone ---
if (!repo) {
  for (const cand of [path.join(ROOT, "..", "aidlc-workflows"), path.join(ROOT, "aidlc-workflows")]) {
    if (fs.existsSync(path.join(cand, ".git"))) { repo = cand; break; }
  }
}
if (!repo || !fs.existsSync(path.join(repo, ".git"))) {
  die("could not find an upstream clone; pass --repo <path-to-aidlc-workflows-clone>");
}

const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });

// Only the TARGET SHA must be reachable upstream (it's the snapshot we're moving
// TO). We deliberately do NOT require the OLD pinned SHA upstream — on a force-
// pushable branch it may be gone. The "old" side is our LOCAL vendored src/
// (always available, and == the lock's pin by the skew guard), so T1 never
// silently disappears on force-pushed history.
try { git("rev-parse", "--verify", `${targetSha}^{commit}`); }
catch { die(`target SHA '${targetSha}' not found in ${repo} (fetch it first?)`); }

const localSrc = path.join(ROOT, subdir);
if (!fs.existsSync(localSrc)) die(`local vendored ${subdir}/ not found at ${localSrc}`);

// Materialize the target's subdir into a temp dir (archive → tar, no checkout
// needed; works for any reachable target SHA).
const tgtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "triage-tgt-"));
try {
  execFileSync("bash", ["-c", `git -C "${repo}" archive "${targetSha}" -- "${subdir}" | tar -x -C "${tgtRoot}"`], { stdio: "pipe" });
} catch (e) {
  die(`could not extract ${targetSha}:${subdir} — ${e.stderr || e.message}`);
}
const targetSrc = path.join(tgtRoot, subdir);
if (!fs.existsSync(targetSrc)) die(`target ${targetSha} has no '${subdir}/' directory`);

// --- name-status diff (filesystem, rename-aware): local src/ (OLD) vs target src/ (NEW) ---
// git diff --no-index compares two directories with no git-object dependency and
// exits 1 when they differ (not an error) — capture either way.
let raw = "";
try {
  raw = execFileSync("git", ["diff", "--no-index", "--name-status", "-M", localSrc, targetSrc], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }).trim();
} catch (e) {
  if (e.status === 1 && e.stdout != null) raw = e.stdout.trim(); // differences present
  else die(`diff failed: ${e.stderr || e.message}`);
}
// --no-index emits absolute paths; normalize both sides back to `<subdir>/...`.
const normPath = (abs) => {
  for (const [base, pref] of [[localSrc, subdir], [targetSrc, subdir]]) {
    if (abs === base) return pref;
    if (abs.startsWith(base + "/")) return pref + "/" + abs.slice(base.length + 1);
  }
  return abs;
};
if (!raw) {
  report([], { oldSha, targetSha, repo, subdir });
  fs.rmSync(tgtRoot, { recursive: true, force: true });
  process.exit(0);
}

// Returns file content from a side: "old" = local src/, "new" = extracted target.
function show(side, relPath) {
  const base = side === "old" ? localSrc : targetSrc;
  const rel = relPath.startsWith(subdir + "/") ? relPath.slice(subdir.length + 1) : relPath;
  try { return fs.readFileSync(path.join(base, rel), "utf-8"); } catch { return ""; }
}

// Is a MODIFIED text file's change set fully neutralized by the adapter? True iff
// applying transformContent to BOTH old and new collapses the diff to nothing —
// i.e. every changed line differs only in something the adapter rewrites
// (path-anchoring, Kiro→Claude wording). Non-markdown (e.g. the process-checker
// .js, agent .json) is never auto-cleared here (handled structurally by T0).
function fullyMechanical(relOld, relNew) {
  if (!relNew.endsWith(".md")) return false;
  const before = show("old", relOld);
  const after = show("new", relNew);
  if (!before || !after) return false;
  return transformContent(before) === transformContent(after);
}

// Would T0 (the build contract) PROVABLY hard-fail if this exact path
// disappeared/moved? Only true for paths checkRequiredComponents() actually
// asserts: a required skill's SKILL.md, or a required agent's .json. (T0 also
// checks required top-level DIRS and a skill-count floor, but a rename of one
// non-required leaf is NOT caught.) CONTRACT is reserved for these provably-
// covered paths; everything else falls through to ESCALATE (fail-closed). `p` is
// the subdir-relative path with the leading `<subdir>/` still attached.
function t0Covers(p) {
  const rel = p.startsWith(subdir + "/") ? p.slice(subdir.length + 1) : p;
  for (const s of REQUIRED_SKILLS) {
    if (rel === `skills/${s}/SKILL.md`) return true;
  }
  for (const a of REQUIRED_AGENTS) {
    if (rel === `agents/${a}.json`) return true;
  }
  return false;
}

const items = [];
for (const line of raw.split("\n")) {
  const parts = line.split("\t");
  const status = parts[0];
  const code = status[0]; // A/M/D/R/C/T
  if (code === "R" || code === "C") {
    const from = normPath(parts[1]);
    const to = normPath(parts[2]);
    const pct = parseInt(status.slice(1), 10);
    const kind = code === "R" ? "rename" : "copy";
    // CONTRACT only if it's a PURE move (no content change) AND the moved-FROM
    // path is one T0 provably guards (a required component): then T0 hard-fails
    // if the new location/name isn't right. A copy adds NEW shipped surface, and
    // a rename of a non-required path (T0 is blind to it) → ESCALATE. Any content
    // change → ESCALATE regardless.
    const pureMoveOfRequired = code === "R" && pct === 100 && t0Covers(from);
    items.push({
      path: to, from, status: kind === "rename" ? "renamed" : "copied",
      category: pureMoveOfRequired ? "CONTRACT" : "ESCALATE",
      reason: pureMoveOfRequired
        ? `pure rename of a T0-required component (${from}) — T0's checkRequiredComponents verifies it still resolves`
        : pct === 100
          ? `pure ${kind} of a non-T0-guarded path (${from}) — T0 is blind to it; runtime refs to the old path may break — review`
          : `${kind} WITH content change (${pct}% similar) — review the content delta`,
    });
  } else if (code === "A") {
    items.push({
      path: normPath(parts[1]), status: "added", category: "ESCALATE",
      reason: "NEW file — the adapter has no rule for content it has never seen; confirm it needs no transform/contract and (if a new skill/agent) that it's wired",
    });
  } else if (code === "D") {
    const p = normPath(parts[1]);
    const covered = t0Covers(p);
    items.push({
      path: p, status: "deleted", category: covered ? "CONTRACT" : "ESCALATE",
      reason: covered
        ? "removed a T0-required component — T0 hard-fails (checkRequiredComponents)"
        : "removed a non-T0-guarded path — T0 won't notice; runtime refs to it may break — review",
    });
  } else if (code === "M") {
    const p = normPath(parts[1]);
    if (fullyMechanical(p, p)) {
      items.push({ path: p, status: "modified", category: "AUTO",
        reason: "all changes are neutralized by the adapter transform (path-anchoring / Kiro→Claude wording) — output unaffected" });
    } else {
      // Flag the most likely-meaningful sub-signals to focus the human.
      const after = show(targetSha, p);
      const signals = [];
      if (/SKILL\.md$/.test(p) || /CATALOGUE\.md$/.test(p)) {
        for (const flag of INTERACTION_FLAGS) {
          if (new RegExp(`^\\s*${flag}:`, "m").test(after)) signals.push(`interaction flag '${flag}' present`);
        }
      }
      if (/protocol\.md$/.test(p)) signals.push("orchestrator/builder/validator protocol — check for new human-interaction or sub-agent steps");
      items.push({ path: p, status: "modified", category: "ESCALATE",
        reason: "content change NOT fully neutralized by the adapter — semantic review needed" + (signals.length ? `; signals: ${signals.join("; ")}` : "") });
    }
  } else {
    items.push({ path: parts[1] || line, status: code, category: "ESCALATE", reason: `unhandled diff status '${status}' — review` });
  }
}

// --- Compute T2b advisability deterministically from the changed paths ---
// Returns { advised: bool, reasons: [{path, why}] }. Advise T2b when a behavioral-
// surface path is touched by ANY change kind — including DELETION (e.g. removing
// the process-checker is exactly what T2b would catch) and RENAME-AWAY (the source
// path leaving the behavioral surface) — OR when an interaction-flag VALUE flips.
// Fail-closed: a missed behavioral change shipping broken costs more than a smoke run.
function computeT2bAdvice() {
  const reasons = [];
  for (const it of items) {
    // Check BOTH the destination and (for renames/copies/deletes) the source path,
    // so a behavioral file moved OUT of the surface still advises T2b.
    const paths = [it.path, it.from].filter(Boolean);
    const hitPath = paths.find((p) => isBehavioralPath(p));
    if (hitPath) {
      reasons.push({ path: hitPath, why: `behavioral surface ${it.status} (wiring/control-flow)` });
      continue;
    }
    // Interaction-flag VALUE change: compare old vs new flag values in this file.
    if (/SKILL\.md$/.test(it.path) && (it.status === "modified" || it.status === "renamed")) {
      const before = show("old", it.from || it.path);
      const after = show("new", it.path);
      for (const flag of INTERACTION_FLAGS) {
        const re = new RegExp(`^\\s*${flag}:\\s*"(true|false)"`, "m");
        const mb = before.match(re), ma = after.match(re);
        if (mb && ma && mb[1] !== ma[1]) {
          reasons.push({ path: it.path, why: `interaction flag '${flag}' flipped ${mb[1]}→${ma[1]} (control gate)` });
        } else if ((!mb && ma) || (mb && !ma)) {
          reasons.push({ path: it.path, why: `interaction flag '${flag}' added/removed (control gate)` });
        }
      }
    }
  }
  return { advised: reasons.length > 0, reasons };
}
const t2bAdvice = computeT2bAdvice();

report(items, { oldSha, targetSha, repo, subdir }, t2bAdvice);
fs.rmSync(tgtRoot, { recursive: true, force: true });

const escalations = items.filter((i) => i.category === "ESCALATE");
process.exit(escalations.length ? 2 : 0);

// --- output ---
function report(items, meta, t2bAdvice) {
  if (jsonOut) {
    console.log(JSON.stringify({ meta, items, t2b: t2bAdvice }, null, 2));
    return;
  }
  console.log(`\nT1 sync triage: upstream ${meta.subdir}/  ${meta.oldSha.slice(0, 7)} → ${meta.targetSha.slice(0, 7)}`);
  console.log(`  (clone: ${meta.repo})`);
  if (!items.length) { console.log("\n  No changes in the vendored subdir. Nothing to triage.\n"); return; }
  const groups = { AUTO: [], CONTRACT: [], ESCALATE: [] };
  for (const it of items) groups[it.category].push(it);
  const order = [
    ["ESCALATE", "needs human review (semantic / novel)"],
    ["CONTRACT", "structural — the build (T0) is the real gate"],
    ["AUTO", "fully handled by the adapter — no attention needed"],
  ];
  for (const [cat, desc] of order) {
    const g = groups[cat];
    if (!g.length) continue;
    console.log(`\n${cat} (${g.length}) — ${desc}`);
    for (const it of g) {
      console.log(`  • ${it.path}${it.from ? `  (from ${it.from})` : ""}  [${it.status}]`);
      console.log(`      ${it.reason}`);
    }
  }
  console.log(
    `\nSummary: ${groups.ESCALATE.length} to escalate, ${groups.CONTRACT.length} structural (T0-gated), ${groups.AUTO.length} auto.`
  );
  if (groups.ESCALATE.length) {
    console.log("→ A human should review the ESCALATE items before adopting this snapshot.");
    console.log("  (Then run sync-upstream.sh <sha>; T0's contract checks still gate the build.)");
  } else {
    console.log("→ Nothing semantic to escalate. Structural items (if any) are gated by the build.");
  }
  // T2b advisability — the deterministic signal for the expensive behavioral smoke.
  if (t2bAdvice && t2bAdvice.advised) {
    console.log(`\n⚠ T2b RECOMMENDED — this change touches the behavioral surface (runtime wiring),`);
    console.log(`  which only the autonomous workflow smoke can verify. Reasons:`);
    for (const r of t2bAdvice.reasons.slice(0, 8)) console.log(`    - ${r.path}: ${r.why}`);
    console.log(`  Run (costs real Bedrock $): AIDLC_SMOKE_TRUST=1 node targets/claude/smoke.mjs --workflow`);
  } else {
    console.log(`\n✓ T2b not needed — no behavioral-surface change; this is content-only (stage prose,`);
    console.log(`  convention wording, validation specs). The free gates (T0/T1/T3) cover it.`);
  }
  console.log("");
}
