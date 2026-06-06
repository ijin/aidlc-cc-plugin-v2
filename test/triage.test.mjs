#!/usr/bin/env node
// triage.test.mjs — verifies the T1 sync-triage classifier puts each kind of
// upstream change in the right bucket (AUTO / CONTRACT / ESCALATE). Builds a
// throwaway git repo with a known old→new diff, runs sync-triage.mjs --json
// against it, and asserts the classification.
//
// Usage: node test/triage.test.mjs   (exit 0 = all pass)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPT_DIR, "..");
const TRIAGE = path.join(REPO, "targets", "claude", "sync-triage.mjs");

let pass = 0, fail = 0;
const fails = [];
function check(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(`${name}: ${detail}`); console.log(`  FAIL  ${name} — ${detail}`); }
}

const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf-8" });

// Build a throwaway upstream-like repo with a src/ subdir, two commits (old→new)
// exercising every classification path.
const up = fs.mkdtempSync(path.join(os.tmpdir(), "triage-up-"));
git(up, "init", "-q");
git(up, "config", "user.email", "t@t.t");
git(up, "config", "user.name", "t");
git(up, "config", "commit.gpgsign", "false");

const w = (p, c) => {
  const full = path.join(up, p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, c);
};

// --- OLD state ---
w("src/skills/aidlc-orchestrator/SKILL.md", "name: aidlc-orchestrator\n\nSee aidlc-common/protocols/x.md.\n");
w("src/skills/aidlc-mech/SKILL.md", "Use `invokeSubAgent` with name `aidlc-builder-agent`.\n"); // → mechanical
w("src/skills/aidlc-semantic/SKILL.md", "Original prose about requirements.\n");                // → semantic edit
w("src/skills/aidlc-nonreq/SKILL.md", "stable content\n");                                      // non-required → ESCALATE on rename
w("src/skills/aidlc-doomed/validation-spec.md", "to be deleted\n");                             // non-required → ESCALATE on delete
w("src/agents/aidlc-builder-agent.json", '{"name":"aidlc-builder-agent"}\n');                   // REQUIRED → CONTRACT on rename
git(up, "add", "-A");
git(up, "commit", "-qm", "old");
const OLD = git(up, "rev-parse", "HEAD").trim();

// --- NEW state ---
// mechanical-only: the Kiro form rewritten to the already-Claude form → transformContent equal
w("src/skills/aidlc-mech/SKILL.md", "Use the Agent tool to invoke the `aidlc-builder-agent` subagent.\n");
// semantic: real new prose
w("src/skills/aidlc-semantic/SKILL.md", "Original prose about requirements.\n\nNEW: a brand-new approval step.\n");
// pure rename of a NON-required skill → ESCALATE (T0 is blind to it)
fs.mkdirSync(path.join(up, "src/skills/aidlc-moved"), { recursive: true });
fs.renameSync(path.join(up, "src/skills/aidlc-nonreq/SKILL.md"), path.join(up, "src/skills/aidlc-moved/SKILL.md"));
fs.rmdirSync(path.join(up, "src/skills/aidlc-nonreq"));
// pure rename of a REQUIRED component (builder agent) → CONTRACT (T0 guards it)
fs.renameSync(path.join(up, "src/agents/aidlc-builder-agent.json"), path.join(up, "src/agents/aidlc-builder-agent-renamed.json"));
// deletion of a non-required file → ESCALATE
fs.rmSync(path.join(up, "src/skills/aidlc-doomed/validation-spec.md"));
fs.rmdirSync(path.join(up, "src/skills/aidlc-doomed"));
// addition
w("src/skills/aidlc-brandnew/SKILL.md", "name: aidlc-brandnew\n\nA new skill.\n");
git(up, "add", "-A");
git(up, "commit", "-qm", "new");
const NEW = git(up, "rev-parse", "HEAD").trim();

// A throwaway "our repo": the two .mjs the tool needs, the lock, AND a local
// vendored src/ holding the OLD upstream state (T1 now uses local src/ as the
// "old" side — immune to upstream force-push — so we materialize it here).
const our = fs.mkdtempSync(path.join(os.tmpdir(), "triage-our-"));
fs.mkdirSync(path.join(our, "targets", "claude"), { recursive: true });
fs.copyFileSync(TRIAGE, path.join(our, "targets", "claude", "sync-triage.mjs"));
fs.copyFileSync(path.join(REPO, "targets", "claude", "build.mjs"), path.join(our, "targets", "claude", "build.mjs"));
fs.writeFileSync(path.join(our, "UPSTREAM.lock"), `UPSTREAM_SHA=${OLD}\nUPSTREAM_SUBDIR=src\n`);
// Extract the OLD upstream src/ into our-repo's src/ (the vendored "old" side).
execFileSync("bash", ["-c", `git -C "${up}" archive "${OLD}" -- src | tar -x -C "${our}"`], { stdio: "pipe" });

let result;
try {
  const out = execFileSync(
    "node",
    [path.join(our, "targets", "claude", "sync-triage.mjs"), NEW, "--repo", up, "--json"],
    { encoding: "utf-8" }
  );
  result = JSON.parse(out);
} catch (e) {
  // exit 2 (escalations present) is expected; its stdout still holds the JSON.
  if (e.stdout) { try { result = JSON.parse(e.stdout); } catch { /* fall through */ } }
  if (!result) { console.error("triage failed to produce JSON:\n", e.stdout, e.stderr); process.exit(1); }
}

const cat = (substr) => {
  const it = result.items.find((i) => i.path.includes(substr));
  return it ? it.category : `(no item matching ${substr})`;
};

check(cat("aidlc-mech/") === "AUTO", "mechanical-only edit → AUTO", `got ${cat("aidlc-mech/")}`);
check(cat("aidlc-semantic/") === "ESCALATE", "semantic edit → ESCALATE", `got ${cat("aidlc-semantic/")}`);
check(cat("aidlc-moved/") === "ESCALATE", "pure rename of NON-required skill → ESCALATE (T0 blind)", `got ${cat("aidlc-moved/")}`);
check(cat("aidlc-builder-agent-renamed.json") === "CONTRACT", "pure rename of REQUIRED component → CONTRACT (T0 guards)", `got ${cat("aidlc-builder-agent-renamed.json")}`);
check(cat("aidlc-doomed/") === "ESCALATE", "deletion of NON-required file → ESCALATE (T0 blind)", `got ${cat("aidlc-doomed/")}`);
check(cat("aidlc-brandnew/") === "ESCALATE", "new file → ESCALATE", `got ${cat("aidlc-brandnew/")}`);

// T2b advisability: this diff renamed an agents/*.json (behavioral surface) → advised.
check(result.t2b && result.t2b.advised === true, "T2b advised when agents/ changes (behavioral surface)",
  `t2b=${JSON.stringify(result.t2b)}`);
check(result.t2b.reasons.some((r) => r.path.includes("agents/")), "T2b reason cites the agents/ path",
  JSON.stringify(result.t2b.reasons));

// --- Separate scenario: a CONTENT-ONLY diff must NOT advise T2b ---
// (rebuild a fresh old→new pair where the only change is stage-skill prose)
const up2 = fs.mkdtempSync(path.join(os.tmpdir(), "triage-up2-"));
git(up2, "init", "-q"); git(up2, "config", "user.email", "t@t.t"); git(up2, "config", "user.name", "t"); git(up2, "config", "commit.gpgsign", "false");
const w2 = (p, c) => { const f = path.join(up2, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
w2("src/skills/aidlc-orchestrator/SKILL.md", "name: aidlc-orchestrator\n\nbody\n");
w2("src/skills/aidlc-requirements-analysis/SKILL.md", "---\nname: aidlc-requirements-analysis\nmetadata:\n  human-clarification: \"true\"\n---\n# Reqs\nOriginal prose.\n");
w2("src/agents/aidlc-builder-agent.json", '{"name":"aidlc-builder-agent"}\n');
git(up2, "add", "-A"); git(up2, "commit", "-qm", "old");
const OLD2 = git(up2, "rev-parse", "HEAD").trim();
// content-only change: stage-skill prose, no flag flip, no behavioral path
w2("src/skills/aidlc-requirements-analysis/SKILL.md", "---\nname: aidlc-requirements-analysis\nmetadata:\n  human-clarification: \"true\"\n---\n# Reqs\nOriginal prose. PLUS a clarifying sentence about scope.\n");
git(up2, "add", "-A"); git(up2, "commit", "-qm", "new"); const NEW2 = git(up2, "rev-parse", "HEAD").trim();
const our2 = fs.mkdtempSync(path.join(os.tmpdir(), "triage-our2-"));
fs.mkdirSync(path.join(our2, "targets", "claude"), { recursive: true });
fs.copyFileSync(TRIAGE, path.join(our2, "targets", "claude", "sync-triage.mjs"));
fs.copyFileSync(path.join(REPO, "targets", "claude", "build.mjs"), path.join(our2, "targets", "claude", "build.mjs"));
fs.writeFileSync(path.join(our2, "UPSTREAM.lock"), `UPSTREAM_SHA=${OLD2}\nUPSTREAM_SUBDIR=src\n`);
execFileSync("bash", ["-c", `git -C "${up2}" archive "${OLD2}" -- src | tar -x -C "${our2}"`], { stdio: "pipe" });
let r2;
try { r2 = JSON.parse(execFileSync("node", [path.join(our2, "targets", "claude", "sync-triage.mjs"), NEW2, "--repo", up2, "--json"], { encoding: "utf-8" })); }
catch (e) { if (e.stdout) try { r2 = JSON.parse(e.stdout); } catch {} }
check(r2 && r2.t2b && r2.t2b.advised === false, "T2b NOT advised for content-only stage-prose change", `t2b=${JSON.stringify(r2 && r2.t2b)}`);

// --- Separate scenario: an interaction-flag VALUE flip must advise T2b ---
w2("src/skills/aidlc-requirements-analysis/SKILL.md", "---\nname: aidlc-requirements-analysis\nmetadata:\n  human-clarification: \"false\"\n---\n# Reqs\nOriginal prose.\n");
git(up2, "add", "-A"); git(up2, "commit", "-qm", "flip"); const FLIP = git(up2, "rev-parse", "HEAD").trim();
let r3;
try { r3 = JSON.parse(execFileSync("node", [path.join(our2, "targets", "claude", "sync-triage.mjs"), FLIP, "--repo", up2, "--json"], { encoding: "utf-8" })); }
catch (e) { if (e.stdout) try { r3 = JSON.parse(e.stdout); } catch {} }
check(r3 && r3.t2b && r3.t2b.advised === true && r3.t2b.reasons.some((x) => /flag .*flipped/.test(x.why)),
  "T2b advised when an interaction flag value flips (control gate)", `t2b=${JSON.stringify(r3 && r3.t2b)}`);

// --- Scenario: DELETING a behavioral file must advise T2b (Codex false-neg repro) ---
w2("src/aidlc-common/scripts/aidlc-process-checker.js", "// checker\nconsole.log('x');\n");
git(up2, "add", "-A"); git(up2, "commit", "-qm", "add-checker"); const WITHCHK = git(up2, "rev-parse", "HEAD").trim();
fs.rmSync(path.join(up2, "src/aidlc-common/scripts/aidlc-process-checker.js"));
git(up2, "add", "-A"); git(up2, "commit", "-qm", "del-checker"); const DELCHK = git(up2, "rev-parse", "HEAD").trim();
// re-vendor the WITHCHK state as the local "old" side, then triage forward to DELCHK
fs.rmSync(path.join(our2, "src"), { recursive: true, force: true });
execFileSync("bash", ["-c", `git -C "${up2}" archive "${WITHCHK}" -- src | tar -x -C "${our2}"`], { stdio: "pipe" });
fs.writeFileSync(path.join(our2, "UPSTREAM.lock"), `UPSTREAM_SHA=${WITHCHK}\nUPSTREAM_SUBDIR=src\n`);
let r4;
try { r4 = JSON.parse(execFileSync("node", [path.join(our2, "targets", "claude", "sync-triage.mjs"), DELCHK, "--repo", up2, "--json"], { encoding: "utf-8" })); }
catch (e) { if (e.stdout) try { r4 = JSON.parse(e.stdout); } catch {} }
check(r4 && r4.t2b && r4.t2b.advised === true,
  "T2b advised when a behavioral file is DELETED (process-checker)", `t2b=${JSON.stringify(r4 && r4.t2b)}`);

fs.rmSync(up2, { recursive: true, force: true });
fs.rmSync(our2, { recursive: true, force: true });

// Cleanup.
fs.rmSync(up, { recursive: true, force: true });
fs.rmSync(our, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail) { console.error("\nT1 triage misclassified:"); for (const f of fails) console.error("  - " + f); process.exit(1); }
console.log("T1 triage classifies every change kind correctly. ✓");
