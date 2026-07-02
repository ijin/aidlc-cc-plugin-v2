#!/usr/bin/env node
// triage.test.mjs — verifies the T1 sync-triage classifier puts each kind of
// upstream change in the right bucket (AUTO / CONTRACT / ESCALATE) under the
// installer model. Builds a throwaway upstream-like git repo with a dist/claude
// subdir and a known old→new diff, runs sync-triage.mjs --json against it, and
// asserts the classification and the load-smoke advisory.
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

function newUpstream() {
  const up = fs.mkdtempSync(path.join(os.tmpdir(), "triage-up-"));
  git(up, "init", "-q");
  git(up, "config", "user.email", "t@t.t");
  git(up, "config", "user.name", "t");
  git(up, "config", "commit.gpgsign", "false");
  return up;
}
const writeIn = (root) => (p, c) => {
  const full = path.join(root, p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, c);
};

// Minimal new-layout tree under dist/claude (the vendored subdir).
function seedOldState(w) {
  w("dist/claude/.claude/settings.json", JSON.stringify({
    hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "bun $CLAUDE_PROJECT_DIR/.claude/hooks/aidlc-stop.ts" }] }] },
  }, null, 2) + "\n");
  w("dist/claude/.claude/hooks/aidlc-stop.ts", "// stop hook\n");
  w("dist/claude/.claude/tools/aidlc-version.ts", 'export const AIDLC_VERSION = "9.9.9";\n');
  w("dist/claude/.claude/tools/aidlc-utility.ts", "// utility\n");
  w("dist/claude/.claude/knowledge/guide.md", "Original guidance.\n");
  w("dist/claude/.claude/skills/aidlc/SKILL.md", "---\nname: aidlc\n---\nbody\n");
  w("dist/claude/.claude/skills/aidlc-feature/SKILL.md", "---\nname: aidlc-feature\n---\nbody\n");
  w("dist/claude/.claude/CLAUDE.md", "# Onboarding\nOriginal claims.\n");
  w("dist/claude/.mcp.json", JSON.stringify({ mcpServers: { context7: { type: "http", url: "https://x" } } }) + "\n");
  w("dist/claude/.gitignore", "# AI-DLC — ignores\naidlc/active-space\n");
  w("dist/claude/aidlc/spaces/default/memory/org.md", "# Org\n");
}

// "Our repo" fixture: the two .mjs the tool needs, the lock, and a vendored
// src/ = the OLD dist/claude tree (T1 uses local src/ as the "old" side).
function makeOurRepo(up, oldSha) {
  const our = fs.mkdtempSync(path.join(os.tmpdir(), "triage-our-"));
  fs.mkdirSync(path.join(our, "targets", "claude"), { recursive: true });
  fs.copyFileSync(TRIAGE, path.join(our, "targets", "claude", "sync-triage.mjs"));
  fs.copyFileSync(path.join(REPO, "targets", "claude", "build.mjs"), path.join(our, "targets", "claude", "build.mjs"));
  fs.writeFileSync(path.join(our, "UPSTREAM.lock"), `UPSTREAM_SHA=${oldSha}\nUPSTREAM_SUBDIR=dist/claude\n`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "triage-x-"));
  execFileSync("bash", ["-c", `git -C "${up}" archive "${oldSha}" -- dist/claude | tar -x -C "${tmp}"`], { stdio: "pipe" });
  fs.renameSync(path.join(tmp, "dist", "claude"), path.join(our, "src"));
  fs.rmSync(tmp, { recursive: true, force: true });
  return our;
}

function runTriage(our, up, targetSha) {
  try {
    return JSON.parse(execFileSync(
      "node",
      [path.join(our, "targets", "claude", "sync-triage.mjs"), targetSha, "--repo", up, "--json"],
      { encoding: "utf-8" }
    ));
  } catch (e) {
    // exit 2 (escalations present) is expected; stdout still holds the JSON.
    if (e.stdout) { try { return JSON.parse(e.stdout); } catch { /* fall through */ } }
    console.error("triage failed to produce JSON:\n", e.stdout, e.stderr);
    process.exit(1);
  }
}

// ---------- Scenario 1: one change of every classification kind ----------
const up = newUpstream();
const w = writeIn(up);
seedOldState(w);
git(up, "add", "-A");
git(up, "commit", "-qm", "old");
const OLD = git(up, "rev-parse", "HEAD").trim();

// verbatim content edit → AUTO
w("dist/claude/.claude/knowledge/guide.md", "Original guidance. PLUS new prose.\n");
// installer-coupled: settings.json semantic change → ESCALATE (+ smoke advised)
w("dist/claude/.claude/settings.json", JSON.stringify({
  hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "bun $CLAUDE_PROJECT_DIR/.claude/hooks/aidlc-stop.ts" }] }] },
  env: { NEW_VAR: "1" },
}, null, 2) + "\n");
// installer-coupled: onboarding + MCP changes → ESCALATE
w("dist/claude/.claude/CLAUDE.md", "# Onboarding\nCHANGED claims.\n");
w("dist/claude/.mcp.json", JSON.stringify({ mcpServers: { context7: { type: "http", url: "https://CHANGED" } } }) + "\n");
// new deep content file → AUTO
w("dist/claude/.claude/knowledge/new-doc.md", "brand new\n");
// new top-level entry → CONTRACT (exact root set)
w("dist/claude/EXTRA.md", "surprise\n");
// engine tool modified → AUTO but smoke-advised
w("dist/claude/.claude/tools/aidlc-utility.ts", "// utility v2\n");
// a skill's SKILL.md deleted → CONTRACT (every-skill-has-SKILL.md)
fs.rmSync(path.join(up, "dist/claude/.claude/skills/aidlc-feature/SKILL.md"));
git(up, "add", "-A");
git(up, "commit", "-qm", "new");
const NEW = git(up, "rev-parse", "HEAD").trim();

const our = makeOurRepo(up, OLD);
const result = runTriage(our, up, NEW);

const cat = (substr) => {
  const it = result.items.find((i) => i.path.includes(substr) || (i.from || "").includes(substr));
  return it ? it.category : `(no item matching ${substr})`;
};

check(cat("knowledge/guide.md") === "AUTO", "verbatim content edit → AUTO", `got ${cat("knowledge/guide.md")}`);
check(cat("settings.json") === "ESCALATE", "settings.json change → ESCALATE (installer-coupled)", `got ${cat("settings.json")}`);
check(cat("CLAUDE.md") === "ESCALATE", "CLAUDE.md change → ESCALATE (README cites it)", `got ${cat("CLAUDE.md")}`);
check(cat(".mcp.json") === "ESCALATE", ".mcp.json change → ESCALATE (credentials story)", `got ${cat(".mcp.json")}`);
check(cat("knowledge/new-doc.md") === "AUTO", "new deep content file → AUTO (verbatim)", `got ${cat("knowledge/new-doc.md")}`);
check(cat("EXTRA.md") === "CONTRACT", "new top-level entry → CONTRACT (exact root set)", `got ${cat("EXTRA.md")}`);
check(cat("tools/aidlc-utility.ts") === "AUTO", "engine tool edit → AUTO (verbatim payload)", `got ${cat("tools/aidlc-utility.ts")}`);
check(cat("skills/aidlc-feature/SKILL.md") === "CONTRACT", "deleted SKILL.md → CONTRACT (T0 asserts it)", `got ${cat("skills/aidlc-feature/SKILL.md")}`);

// Load-smoke advisory: settings.json + tools/ changed → advised, citing them.
check(result.smoke && result.smoke.advised === true, "smoke advised when engine control surface changes",
  `smoke=${JSON.stringify(result.smoke)}`);
check(result.smoke.reasons.some((r) => /settings\.json|tools\//.test(r.path)), "smoke reason cites the control-surface path",
  JSON.stringify(result.smoke.reasons));

fs.rmSync(up, { recursive: true, force: true });
fs.rmSync(our, { recursive: true, force: true });

// ---------- Scenario 2: content-only diff → no escalations, no smoke ----------
const up2 = newUpstream();
const w2 = writeIn(up2);
seedOldState(w2);
git(up2, "add", "-A");
git(up2, "commit", "-qm", "old");
const OLD2 = git(up2, "rev-parse", "HEAD").trim();
w2("dist/claude/.claude/knowledge/guide.md", "Original guidance, gently reworded.\n");
w2("dist/claude/.claude/skills/aidlc-feature/SKILL.md", "---\nname: aidlc-feature\n---\nbody with an extra sentence\n");
git(up2, "add", "-A");
git(up2, "commit", "-qm", "new");
const NEW2 = git(up2, "rev-parse", "HEAD").trim();
const our2 = makeOurRepo(up2, OLD2);
const r2 = runTriage(our2, up2, NEW2);
check(r2.items.every((i) => i.category === "AUTO"), "content-only diff → all AUTO",
  JSON.stringify(r2.items.filter((i) => i.category !== "AUTO")));
check(r2.smoke && r2.smoke.advised === false, "smoke NOT advised for content-only diff", `smoke=${JSON.stringify(r2.smoke)}`);

// ---------- Scenario 3: hook deletion → CONTRACT + smoke advised ----------
fs.rmSync(path.join(up2, "dist/claude/.claude/hooks/aidlc-stop.ts"));
git(up2, "add", "-A");
git(up2, "commit", "-qm", "del-hook");
const DELHOOK = git(up2, "rev-parse", "HEAD").trim();
// re-vendor NEW2 as the local old side
fs.rmSync(path.join(our2, "src"), { recursive: true, force: true });
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "triage-x2-"));
  execFileSync("bash", ["-c", `git -C "${up2}" archive "${NEW2}" -- dist/claude | tar -x -C "${tmp}"`], { stdio: "pipe" });
  fs.renameSync(path.join(tmp, "dist", "claude"), path.join(our2, "src"));
  fs.rmSync(tmp, { recursive: true, force: true });
}
fs.writeFileSync(path.join(our2, "UPSTREAM.lock"), `UPSTREAM_SHA=${NEW2}\nUPSTREAM_SUBDIR=dist/claude\n`);
const r3 = runTriage(our2, up2, DELHOOK);
const hookItem = r3.items.find((i) => i.path.includes("hooks/aidlc-stop.ts"));
check(hookItem && hookItem.category === "CONTRACT", "deleted hook script → CONTRACT (exact-set check)",
  JSON.stringify(hookItem));
check(r3.smoke && r3.smoke.advised === true, "smoke advised when a hook is deleted", `smoke=${JSON.stringify(r3.smoke)}`);

fs.rmSync(up2, { recursive: true, force: true });
fs.rmSync(our2, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail) { console.error("\nT1 triage misclassified:"); for (const f of fails) console.error("  - " + f); process.exit(1); }
console.log("T1 triage classifies every change kind correctly. ✓");
