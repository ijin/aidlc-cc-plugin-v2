#!/usr/bin/env node
// sync-triage.mjs — T1 diff-triage gate for an upstream sync.
//
// When upstream changes, this classifies every changed path in the vendored
// subdir (upstream's dist/claude, mirrored at src/) between the currently-pinned
// SHA (UPSTREAM.lock) and a target SHA, into:
//
//   AUTO     — shipped verbatim in the payload; the plugin has no obligations.
//              Upstream owns the content's internal coherence (and tests it);
//              the human reads upstream's CHANGELOG for meaning, not this tool.
//   CONTRACT — a structural change T0 (the build contract) will catch as a hard
//              build failure if unhandled (root/children set, hook set, entry
//              skill, version constant, compiled data). Informational here; the
//              build is the real gate.
//   ESCALATE — a change on an INSTALLER-COUPLED file whose semantics T0 cannot
//              assert: settings.json (merge rules + README guidance depend on
//              its meaning), .mcp.json (server config → credentials story),
//              .gitignore (the appended block's content), CLAUDE.md /
//              settings.local.json.example (onboarding claims our README cites),
//              or anything with an unhandled diff status.
//
// DESIGN: under the installer model the payload ships byte-identical, so there
// is no transform whose coverage T1 must prove. Its value is (a) surfacing the
// few files OUR installer/docs are semantically coupled to, and (b) telling the
// reviewer what T0 already guards so they can ignore it. FAIL-CLOSED where the
// coupling is real; deliberately quiet elsewhere.
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
  REQUIRED_SRC_ROOT,
  REQUIRED_CLAUDE_CHILDREN,
  REQUIRED_FRAMEWORK_SKILLS,
} from "./build.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const LOCK = path.join(ROOT, "UPSTREAM.lock");

// Files OUR installer/build/docs are semantically coupled to. A modification
// here parses fine (T0-green) but can silently change what the installer merges
// into user projects or what the README promises — a human must look.
// Paths are subdir-relative (no leading `<subdir>/`).
const INSTALLER_COUPLED = new Set([
  ".claude/settings.json",
  ".mcp.json",
  ".gitignore",
  ".claude/CLAUDE.md",
  ".claude/settings.local.json.example",
  ".claude/tools/aidlc-version.ts",
]);

// Engine control surface: changes here don't obligate the adapter (verbatim
// payload) but are the deterministic signal that the OPTIONAL billable load
// smoke + a careful read of upstream's changelog are worth it before release.
const BEHAVIORAL_PATH_RES = [
  /^\.claude\/hooks\//,
  /^\.claude\/tools\//,
  /^\.claude\/settings\.json$/,
  /^\.claude\/aidlc-common\/protocols\//,
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
const subdir = lock.UPSTREAM_SUBDIR || "dist/claude";
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
// TO). We deliberately do NOT require the OLD pinned SHA upstream — on a
// force-pushable dev branch it may be gone. The "old" side is our LOCAL vendored
// src/ (always available, and == the lock's pin by the skew guard), so T1 never
// silently disappears on force-pushed history.
try { git("rev-parse", "--verify", `${targetSha}^{commit}`); }
catch { die(`target SHA '${targetSha}' not found in ${repo} (fetch it first?)`); }

// The vendored tree lives at src/ locally, regardless of the upstream subdir path.
const localSrc = path.join(ROOT, "src");
if (!fs.existsSync(localSrc)) die(`local vendored src/ not found at ${localSrc}`);

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

// --- name-status diff (filesystem, rename-aware): local src/ (OLD) vs target (NEW) ---
// git diff --no-index compares two directories with no git-object dependency and
// exits 1 when they differ (not an error) — capture either way.
let raw = "";
try {
  raw = execFileSync("git", ["diff", "--no-index", "--name-status", "-M", localSrc, targetSrc], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }).trim();
} catch (e) {
  if (e.status === 1 && e.stdout != null) raw = e.stdout.trim(); // differences present
  else die(`diff failed: ${e.stderr || e.message}`);
}
// --no-index emits absolute paths; normalize both sides to subdir-relative form.
const normPath = (abs) => {
  for (const base of [localSrc, targetSrc]) {
    if (abs === base) return "";
    if (abs.startsWith(base + "/")) return abs.slice(base.length + 1);
  }
  return abs;
};
if (!raw) {
  report([], { oldSha, targetSha, repo, subdir });
  fs.rmSync(tgtRoot, { recursive: true, force: true });
  process.exit(0);
}

// Would T0 (the build contract) PROVABLY hard-fail if this exact path were
// removed or renamed away? Only true for paths the contract's exact-set and
// parse checks actually assert. Everything else falls through (fail-open to
// AUTO for verbatim content, fail-closed to ESCALATE for coupled files).
function t0Covers(rel) {
  // Top-level entries: exact root set.
  if (REQUIRED_SRC_ROOT.includes(rel)) return true;
  if (REQUIRED_SRC_ROOT.some((d) => rel === d)) return true;
  // .claude children: exact set (a direct child FILE like settings.json,
  // CLAUDE.md; child DIRS are asserted via their files' parents existing).
  const claudeChild = rel.match(/^\.claude\/([^/]+)$/);
  if (claudeChild && REQUIRED_CLAUDE_CHILDREN.includes(claudeChild[1])) return true;
  // Hook scripts: exact-set check against settings.json references.
  if (/^\.claude\/hooks\/[^/]+\.ts$/.test(rel)) return true;
  // Every skill dir must carry a SKILL.md; the entry skill is asserted by name.
  if (/^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(rel)) return true;
  for (const s of REQUIRED_FRAMEWORK_SKILLS) {
    if (rel.startsWith(`.claude/skills/${s}/`)) return true;
  }
  // Version constant + compiled data: parse checks.
  if (rel === ".claude/tools/aidlc-version.ts") return true;
  if (/^\.claude\/tools\/data\/(stage-graph|scope-grid|harness)\.json$/.test(rel)) return true;
  return false;
}

const VERBATIM_REASON =
  "shipped verbatim in the payload — the plugin has no transform/contract obligations; " +
  "upstream owns and tests this content (read upstream's CHANGELOG for its meaning)";

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
    if (INSTALLER_COUPLED.has(from) || INSTALLER_COUPLED.has(to)) {
      items.push({
        path: to, from, status: kind === "rename" ? "renamed" : "copied", category: "ESCALATE",
        reason: `${kind} touching an installer-coupled file — review the installer's merge rules and the README`,
      });
    } else if (code === "R" && t0Covers(from)) {
      items.push({
        path: to, from, status: "renamed", category: "CONTRACT",
        reason: `rename of a T0-guarded path (${from}) — the build's exact-set/parse checks hard-fail until the contract is updated`,
      });
    } else {
      items.push({
        path: to, from, status: kind === "rename" ? "renamed" : "copied", category: "AUTO",
        reason: VERBATIM_REASON,
      });
    }
  } else if (code === "A") {
    const p = normPath(parts[1]);
    // A new top-level entry or .claude child hard-fails the exact-set checks.
    const newRoot = !p.includes("/") || /^\.claude\/[^/]+$/.test(p);
    const parentKnown =
      REQUIRED_SRC_ROOT.some((d) => p === d || p.startsWith(d + "/")) &&
      (!p.startsWith(".claude/") || REQUIRED_CLAUDE_CHILDREN.some((c) => p === `.claude/${c}` || p.startsWith(`.claude/${c}/`)));
    if (INSTALLER_COUPLED.has(p)) {
      items.push({ path: p, status: "added", category: "ESCALATE", reason: "new installer-coupled file — review" });
    } else if (newRoot && !parentKnown) {
      items.push({
        path: p, status: "added", category: "CONTRACT",
        reason: "new top-level entry / .claude child — T0's exact-set check hard-fails until REQUIRED_SRC_ROOT/REQUIRED_CLAUDE_CHILDREN and the installer's placement rules are updated",
      });
    } else if (/^\.claude\/hooks\/[^/]+\.ts$/.test(p)) {
      items.push({
        path: p, status: "added", category: "CONTRACT",
        reason: "new hook script — T0 hard-fails unless settings.json references it (exact-set check)",
      });
    } else {
      items.push({ path: p, status: "added", category: "AUTO", reason: VERBATIM_REASON });
    }
  } else if (code === "D") {
    const p = normPath(parts[1]);
    if (t0Covers(p)) {
      items.push({
        path: p, status: "deleted", category: "CONTRACT",
        reason: "removed a T0-guarded path — the build hard-fails (exact-set/parse checks)",
      });
    } else if (INSTALLER_COUPLED.has(p)) {
      items.push({ path: p, status: "deleted", category: "ESCALATE", reason: "installer-coupled file removed — review the installer" });
    } else {
      items.push({ path: p, status: "deleted", category: "AUTO", reason: VERBATIM_REASON });
    }
  } else if (code === "M") {
    const p = normPath(parts[1]);
    if (INSTALLER_COUPLED.has(p)) {
      items.push({
        path: p, status: "modified", category: "ESCALATE",
        reason: "installer-coupled file changed — T0 asserts its SHAPE only; review the semantics " +
          "(settings merge entries, MCP server config/credentials, .gitignore block, onboarding claims the README cites)",
      });
    } else {
      items.push({ path: p, status: "modified", category: "AUTO", reason: VERBATIM_REASON });
    }
  } else {
    items.push({ path: parts[1] || line, status: code, category: "ESCALATE", reason: `unhandled diff status '${status}' — review` });
  }
}

// --- Behavioral advisory: is the optional billable load smoke worth running? ---
// The payload ships verbatim either way; this is purely a review signal — the
// engine's control surface (hooks/tools/protocols/settings) changed, so before
// releasing, run smoke.mjs (one billable LLM call) and read upstream's changelog
// with extra care. Fail-closed: any behavioral-surface touch advises it.
function computeSmokeAdvice() {
  const reasons = [];
  for (const it of items) {
    const paths = [it.path, it.from].filter(Boolean);
    const hitPath = paths.find((p) => isBehavioralPath(p));
    if (hitPath) reasons.push({ path: hitPath, why: `engine control surface ${it.status}` });
  }
  return { advised: reasons.length > 0, reasons };
}
const smokeAdvice = computeSmokeAdvice();

report(items, { oldSha, targetSha, repo, subdir }, smokeAdvice);
fs.rmSync(tgtRoot, { recursive: true, force: true });

const escalations = items.filter((i) => i.category === "ESCALATE");
process.exit(escalations.length ? 2 : 0);

// --- output ---
function report(items, meta, smokeAdvice) {
  if (jsonOut) {
    console.log(JSON.stringify({ meta, items, smoke: smokeAdvice }, null, 2));
    return;
  }
  console.log(`\nT1 sync triage: upstream ${meta.subdir}/  ${meta.oldSha.slice(0, 7)} → ${meta.targetSha.slice(0, 7)}`);
  console.log(`  (clone: ${meta.repo})`);
  if (!items.length) { console.log("\n  No changes in the vendored subdir. Nothing to triage.\n"); return; }
  const groups = { AUTO: [], CONTRACT: [], ESCALATE: [] };
  for (const it of items) groups[it.category].push(it);
  const order = [
    ["ESCALATE", "needs human review (installer/docs-coupled semantics)"],
    ["CONTRACT", "structural — the build (T0) is the real gate"],
    ["AUTO", "verbatim payload — no plugin-side obligations"],
  ];
  for (const [cat, desc] of order) {
    const g = groups[cat];
    if (!g.length) continue;
    console.log(`\n${cat} (${g.length}) — ${desc}`);
    // AUTO is usually the bulk of an upstream release; print a compact summary
    // instead of hundreds of identical verbatim lines.
    if (cat === "AUTO" && g.length > 12) {
      const byStatus = {};
      for (const it of g) byStatus[it.status] = (byStatus[it.status] || 0) + 1;
      console.log(`  ${Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(", ")} — ${VERBATIM_REASON}`);
      continue;
    }
    for (const it of g) {
      console.log(`  • ${it.path}${it.from ? `  (from ${it.from})` : ""}  [${it.status}]`);
      console.log(`      ${it.reason}`);
    }
  }
  console.log(
    `\nSummary: ${groups.ESCALATE.length} to escalate, ${groups.CONTRACT.length} structural (T0-gated), ${groups.AUTO.length} verbatim.`
  );
  if (groups.ESCALATE.length) {
    console.log("→ A human should review the ESCALATE items before adopting this snapshot.");
    console.log("  (Then run sync-upstream.sh <sha>; T0's contract checks still gate the build.)");
  } else {
    console.log("→ Nothing installer-coupled to escalate. Structural items (if any) are gated by the build.");
  }
  if (smokeAdvice && smokeAdvice.advised) {
    console.log(`\n⚠ LOAD SMOKE RECOMMENDED — the engine control surface changed. Before releasing:`);
    for (const r of smokeAdvice.reasons.slice(0, 8)) console.log(`    - ${r.path}: ${r.why}`);
    console.log(`  Run (one billable LLM call): node targets/claude/smoke.mjs`);
    console.log(`  And re-read upstream's CHANGELOG for this range with extra care.`);
  } else {
    console.log(`\n✓ Load smoke not specifically indicated — no engine-control-surface change.`);
  }
  console.log("");
}
