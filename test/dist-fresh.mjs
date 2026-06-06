#!/usr/bin/env node
// dist-fresh.mjs — guard: the committed dist/claude/ must equal a fresh build of
// the current src/ (+ targets/claude/ overlays). Catches the footgun where someone
// edits src/ or the build and commits without rebuilding dist/, shipping stale
// content. Builds to a THROWAWAY dir (via AIDLC_OUT_DIR) so the working tree is
// never mutated, then compares file-set + bytes.
//
// Usage: node test/dist-fresh.mjs   (exit 0 = dist is fresh; 1 = stale/drifted)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const COMMITTED = path.join(ROOT, "dist", "claude");
const BUILD = path.join(ROOT, "targets", "claude", "build.mjs");

function listFiles(root) {
  const out = [];
  const walk = (d, rel) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(root, "");
  return out;
}

if (!fs.existsSync(COMMITTED)) {
  console.error(`FAIL: committed dist/claude not found at ${COMMITTED} — run the build and commit it.`);
  process.exit(1);
}

// Build a fresh copy into a temp dir (claude-validate skipped so this is hermetic).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-distfresh-"));
const freshOut = path.join(tmp, "claude");
try {
  execFileSync("node", [BUILD, "build"], {
    cwd: ROOT,
    stdio: "pipe",
    env: { ...process.env, AIDLC_OUT_DIR: freshOut, CLAUDE_BIN: "/nonexistent/claude", AIDLC_REQUIRE_CLAUDE_VALIDATE: "0" },
  });
} catch (e) {
  console.error(`FAIL: fresh build errored:\n${(e.stdout || "") + (e.stderr || "")}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

const committedFiles = new Set(listFiles(COMMITTED));
const freshFiles = new Set(listFiles(freshOut));
const drift = [];

for (const f of freshFiles) if (!committedFiles.has(f)) drift.push(`+ ${f}  (fresh build has it; committed dist/ does not)`);
for (const f of committedFiles) if (!freshFiles.has(f)) drift.push(`- ${f}  (committed dist/ has it; fresh build does not)`);
for (const f of freshFiles) {
  if (!committedFiles.has(f)) continue;
  const a = fs.readFileSync(path.join(freshOut, f));
  const b = fs.readFileSync(path.join(COMMITTED, f));
  if (!a.equals(b)) drift.push(`~ ${f}  (content differs from a fresh build)`);
}

fs.rmSync(tmp, { recursive: true, force: true });

if (drift.length) {
  console.error("FAIL: committed dist/claude is STALE — it does not match a fresh build of src/.");
  console.error("Rebuild and commit it together:  node targets/claude/build.mjs && git add dist/ && git commit\n");
  for (const d of drift.slice(0, 40)) console.error("  " + d);
  if (drift.length > 40) console.error(`  … and ${drift.length - 40} more`);
  process.exit(1);
}
console.log(`dist/claude is fresh — matches a clean build of src/ (${committedFiles.size} files). ✓`);
