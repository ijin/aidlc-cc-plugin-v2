#!/usr/bin/env node
// test/installer.test.mjs — deterministic end-to-end gate for the installer
// plugin: install the committed dist/claude payload into a scratch project and
// prove the result is a working AI-DLC install BY UPSTREAM'S OWN DEFINITION
// (its `doctor` self-check), plus the installer's safety properties:
//
//   1. fresh install → upstream doctor passes (0 failed)
//   2. idempotency   → second run changes nothing
//   3. --check       → writes nothing
//   4. merge         → pre-existing settings.json/.mcp.json/.gitignore are
//                      preserved and only additively extended
//   5. self-guard    → refuses to install into the plugin's own directory
//
// Free and local (bun runs TypeScript; no LLM calls). Requires bun — SKIPS with
// exit 0 when absent (set AIDLC_REQUIRE_INSTALLER_TEST=1 to hard-require, e.g.
// in release CI that installs bun).
//
// Usage: node test/installer.test.mjs

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPT_DIR, "..");
const DIST = path.join(REPO, "dist", "claude");
const INSTALLER = path.join(DIST, "installer", "aidlc-install.ts");

let pass = 0, fail = 0;
const fails = [];
function check(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(`${name}: ${detail}`); console.log(`  FAIL  ${name} — ${detail}`); }
}

try {
  execFileSync("bun", ["--version"], { stdio: "pipe" });
} catch {
  const msg = "bun not on PATH — skipping installer end-to-end test.";
  if (process.env.AIDLC_REQUIRE_INSTALLER_TEST === "1") {
    console.error(`FAIL: ${msg} (AIDLC_REQUIRE_INSTALLER_TEST=1)`);
    process.exit(1);
  }
  console.log(`SKIP: ${msg}`);
  process.exit(0);
}
if (!fs.existsSync(INSTALLER)) {
  console.error(`FAIL: installer not found at ${INSTALLER} — build dist/ first.`);
  process.exit(1);
}

// run bun installer; never throws.
function runInstaller(args) {
  try {
    const out = execFileSync("bun", [INSTALLER, ...args], { encoding: "utf-8", stdio: "pipe", timeout: 60_000 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") };
  }
}

function listFiles(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

console.log("Installer end-to-end (committed dist/claude payload):");

// ---------- 3. --check writes nothing ----------
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-inst-check-"));
  const { code } = runInstaller(["--project", proj, "--check"]);
  check(code === 0, "--check exits 0", `exit ${code}`);
  check(listFiles(proj).length === 0, "--check writes nothing", `files appeared: ${listFiles(proj).slice(0, 5).join(", ")}`);
  fs.rmSync(proj, { recursive: true, force: true });
}

// ---------- 1 + 2. fresh install → doctor; idempotent re-run ----------
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-inst-"));
{
  const { code, out } = runInstaller(["--project", proj]);
  check(code === 0, "fresh install exits 0", `exit ${code}\n${out.slice(0, 400)}`);
  for (const canary of [
    ".claude/tools/aidlc-lib.ts",
    ".claude/skills/aidlc/SKILL.md",
    ".claude/settings.json",
    ".mcp.json",
    ".gitignore",
    "aidlc/spaces/default/memory/org.md",
  ]) {
    check(fs.existsSync(path.join(proj, canary)), `installed: ${canary}`, "missing");
  }

  // Upstream's own doctor must pass on the installed tree — this is the whole
  // architecture's keystone: the payload we ship, placed by our installer, is a
  // valid AI-DLC install by upstream's own definition.
  let doctorOut = "";
  let doctorCode = 0;
  try {
    doctorOut = execFileSync("bun", [path.join(proj, ".claude", "tools", "aidlc-utility.ts"), "doctor"], {
      cwd: proj,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 120_000,
    });
  } catch (e) {
    doctorCode = e.status ?? 1;
    doctorOut = (e.stdout || "") + (e.stderr || "");
  }
  const failedMatch = doctorOut.match(/(\d+) passed, (\d+) failed/);
  check(doctorCode === 0 && failedMatch && failedMatch[2] === "0",
    "upstream doctor passes on the installed tree (0 failed)",
    `exit ${doctorCode}; tail:\n${doctorOut.slice(-600)}`);

  // Idempotency: second run must change nothing.
  const before = listFiles(proj).map((f) => `${f}:${fs.statSync(path.join(proj, f)).size}`).join("\n");
  const second = runInstaller(["--project", proj]);
  const after = listFiles(proj).map((f) => `${f}:${fs.statSync(path.join(proj, f)).size}`).join("\n");
  check(second.code === 0 && /0 created, 0 updated, 0 merged, 0 seeded/.test(second.out),
    "re-run reports nothing to do", second.out.split("\n").find((l) => l.includes("created")) || second.out.slice(0, 200));
  check(before === after, "re-run changes no files", "file list/size drifted");
}
fs.rmSync(proj, { recursive: true, force: true });

// ---------- 4. merge into a project with existing config ----------
{
  const proj2 = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-inst-merge-"));
  fs.mkdirSync(path.join(proj2, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(proj2, ".claude", "settings.json"), JSON.stringify({
    model: "sonnet",
    permissions: { allow: ["Bash(npm test:*)"] },
    hooks: { PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "my-hook.sh" }] }] },
    env: { AWS_REGION: "ap-northeast-1" },
  }, null, 2));
  fs.writeFileSync(path.join(proj2, ".mcp.json"), JSON.stringify({
    mcpServers: { context7: { type: "http", url: "https://mine" } },
  }));
  fs.writeFileSync(path.join(proj2, ".gitignore"), "node_modules\n");

  const { code } = runInstaller(["--project", proj2]);
  check(code === 0, "merge install exits 0", `exit ${code}`);

  const s = JSON.parse(fs.readFileSync(path.join(proj2, ".claude", "settings.json"), "utf-8"));
  check(s.model === "sonnet", "user model preserved (not forced to upstream default)", `model=${s.model}`);
  check(s.env.AWS_REGION === "ap-northeast-1", "user env var preserved", `AWS_REGION=${s.env.AWS_REGION}`);
  check(s.permissions.allow.includes("Bash(npm test:*)"), "user permission preserved", JSON.stringify(s.permissions.allow));
  check(s.permissions.allow.some((p) => p.includes(".claude/tools")), "framework permission added", JSON.stringify(s.permissions.allow));
  const weGroup = (s.hooks.PostToolUse || []).find((g) => g.matcher === "Write|Edit");
  check(weGroup && weGroup.hooks.some((h) => h.command === "my-hook.sh"), "user hook preserved", JSON.stringify(weGroup));
  check(weGroup && weGroup.hooks.some((h) => h.command.includes("aidlc-audit-logger.ts")), "framework hook added to same matcher group", JSON.stringify(weGroup));
  check(Array.isArray(s.hooks.SessionStart) && s.hooks.SessionStart.length > 0, "SessionStart hook added", "missing");

  const m = JSON.parse(fs.readFileSync(path.join(proj2, ".mcp.json"), "utf-8"));
  check(m.mcpServers.context7.url === "https://mine", "user MCP server config preserved", m.mcpServers.context7.url);
  check("aws-pricing" in m.mcpServers, "missing MCP servers added", Object.keys(m.mcpServers).join(", "));

  const gi = fs.readFileSync(path.join(proj2, ".gitignore"), "utf-8");
  check(gi.startsWith("node_modules"), "user .gitignore content preserved", gi.slice(0, 40));
  check(gi.includes("aidlc/active-space"), "AI-DLC ignore block appended", "block missing");
  check((gi.match(/# AI-DLC —/g) || []).length === 1, "AI-DLC block appended exactly once", "duplicated");

  fs.rmSync(proj2, { recursive: true, force: true });
}

// ---------- 5. refuses to install into the plugin itself ----------
{
  const { code, out } = runInstaller(["--project", DIST]);
  check(code !== 0 && /refusing/i.test(out), "refuses --project <plugin dir>", `exit ${code}: ${out.slice(0, 200)}`);
}

// ---------- 6. fresh-install CONFLICT: pre-existing user file is never overwritten ----------
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-inst-conflict-"));
  fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
  const userMemory = "# My project memory — do not clobber\n";
  fs.writeFileSync(path.join(proj, ".claude", "CLAUDE.md"), userMemory);
  const { code, out } = runInstaller(["--project", proj]);
  check(code === 3, "fresh install with differing user file exits 3 (conflict)", `exit ${code}`);
  check(/CONFLICTS/.test(out) && /\.claude\/CLAUDE\.md|\.claude\\CLAUDE\.md/.test(out),
    "conflict report names the file", out.slice(-400));
  check(fs.readFileSync(path.join(proj, ".claude", "CLAUDE.md"), "utf-8") === userMemory,
    "user file left byte-identical", "was modified");
  // The rest of the framework still landed (install proceeds around the conflict).
  check(fs.existsSync(path.join(proj, ".claude", "tools", "aidlc-lib.ts")), "non-conflicting files still installed", "missing");
  // The completion seal: a conflicted install must NOT mint the version marker —
  // otherwise a re-run would masquerade as an UPDATE and silently overwrite the
  // conflicting file the fresh-install protection refused to touch.
  check(!fs.existsSync(path.join(proj, ".claude", "tools", "aidlc-version.ts")),
    "version marker withheld on conflicted install (completion seal)", "marker was written");
  // Re-run without resolving: the same file must STILL be protected.
  const rerun = runInstaller(["--project", proj]);
  check(rerun.code === 3, "unresolved re-run still exits 3 (stays fresh, not update)", `exit ${rerun.code}`);
  check(fs.readFileSync(path.join(proj, ".claude", "CLAUDE.md"), "utf-8") === userMemory,
    "user file STILL byte-identical after re-run", "was modified on the second run");
  // Resolve the conflict (user moves their file aside), re-run → completes and seals.
  fs.renameSync(path.join(proj, ".claude", "CLAUDE.md"), path.join(proj, ".claude", "CLAUDE.md.mine"));
  const resolved = runInstaller(["--project", proj]);
  check(resolved.code === 0, "re-run after resolving conflicts exits 0", `exit ${resolved.code}\n${resolved.out.slice(-300)}`);
  check(fs.existsSync(path.join(proj, ".claude", "tools", "aidlc-version.ts")),
    "version marker written once conflict-free", "marker still missing");
  fs.rmSync(proj, { recursive: true, force: true });
}

// ---------- 7. UPDATE refreshes framework files and reports the overwrite ----------
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-inst-update-"));
  let r = runInstaller(["--project", proj]);
  check(r.code === 0, "update-scenario base install exits 0", `exit ${r.code}`);
  // Simulate an older install with a locally-drifted framework file.
  const verFile = path.join(proj, ".claude", "tools", "aidlc-version.ts");
  fs.writeFileSync(verFile, fs.readFileSync(verFile, "utf-8").replace(/AIDLC_VERSION = "[^"]+"/, 'AIDLC_VERSION = "0.0.1"'));
  const libFile = path.join(proj, ".claude", "tools", "aidlc-lib.ts");
  fs.writeFileSync(libFile, "// locally drifted\n");
  r = runInstaller(["--project", proj]);
  check(r.code === 0, "update exits 0 (no conflicts on update)", `exit ${r.code}\n${r.out.slice(-300)}`);
  check(/Updating existing install: 0\.0\.1/.test(r.out), "update mode detected from version marker", r.out.split("\n")[1]);
  check(fs.readFileSync(libFile, "utf-8").includes("deriveHarnessDir"), "drifted framework file refreshed on update", "still drifted");
  check(/Refreshed framework files/.test(r.out) && /aidlc-lib\.ts/.test(r.out),
    "update lists every differing overwrite (nothing silent)", r.out.slice(-400));
  fs.rmSync(proj, { recursive: true, force: true });
}

// ---------- 8. symlink safety: never writes through symlinks ----------
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-inst-symlink-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-inst-outside-"));
  // A symlinked FILE target: .mcp.json -> outside file.
  const outsideMcp = path.join(outside, "their-mcp.json");
  fs.writeFileSync(outsideMcp, '{"mcpServers":{}}');
  fs.symlinkSync(outsideMcp, path.join(proj, ".mcp.json"));
  // A symlinked DIRECTORY: .claude -> outside dir (every .claude write must be refused).
  const outsideClaude = path.join(outside, "their-claude");
  fs.mkdirSync(outsideClaude);
  fs.symlinkSync(outsideClaude, path.join(proj, ".claude"));
  const { code, out } = runInstaller(["--project", proj]);
  check(code === 3, "symlinked targets exit 3 (conflicts)", `exit ${code}`);
  check(/symlink/i.test(out), "conflict reason cites the symlink", out.slice(-300));
  check(fs.readFileSync(outsideMcp, "utf-8") === '{"mcpServers":{}}', "outside file untouched through file symlink", "was modified");
  check(fs.readdirSync(outsideClaude).length === 0, "outside dir untouched through dir symlink", `files appeared: ${fs.readdirSync(outsideClaude).slice(0, 5).join(", ")}`);
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail) { console.error("\nInstaller failures:"); for (const f of fails) console.error("  - " + f); process.exit(1); }
console.log("Installer end-to-end behaves as designed. ✓");
