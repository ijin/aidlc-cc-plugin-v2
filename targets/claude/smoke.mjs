#!/usr/bin/env node
// smoke.mjs — T2a headless load smoke for the built plugin.
//
// Runs the freshly-built dist/claude plugin under `claude -p` and asserts on the
// stream-json that it loads and exposes exactly the intended plugin surface:
//
//   - plugin aidlc-v2 present and error-free in system/init
//   - the entry skill aidlc-v2:aidlc is listed
//   - NO framework content leaked into the plugin surface (the payload under
//     framework/ must not be scanned as plugin skills/agents — the plugin ships
//     exactly ONE skill and zero agents; the framework's 38 skills belong to the
//     user's project AFTER installation, not to the plugin)
//   - the run completes without error
//
// This is deliberately small: the plugin is an INSTALLER; the framework's own
// behavior is upstream-tested, and our free deterministic gate for the installed
// tree is test/installer.test.mjs (install → upstream doctor). This smoke exists
// to catch "the plugin won't load / exposes the wrong surface", which no
// filesystem check can prove. It makes ONE billable LLM call — opt-in, not part
// of `npm test`.
//
// Usage:
//   node targets/claude/smoke.mjs [--claude <bin>] [--keep]
//     --claude <b>  path to the claude binary (default: $CLAUDE_BIN or "claude")
//     --keep        keep the scratch dir for debugging
//
// Requires a working `claude` CLI with credentials (Bedrock/Anthropic). If the
// CLI is absent it SKIPS with a clear message (exit 0) unless AIDLC_REQUIRE_SMOKE=1.
// Exit: 0 pass/skip, 1 fail.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DIST = path.join(ROOT, "dist", "claude");
const PLUGIN = "aidlc-v2";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const claudeBin = (() => {
  const i = args.indexOf("--claude");
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return process.env.CLAUDE_BIN || "claude";
})();

let pass = 0, fail = 0;
const fails = [];
function check(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(`${name}: ${detail}`); console.log(`  FAIL  ${name} — ${detail || ""}`); }
}

function claudeAvailable() {
  try { execFileSync(claudeBin, ["--version"], { stdio: "pipe" }); return true; }
  catch { return false; }
}

// Run claude -p in `cwd`, return {code, events:[parsed stream-json lines], timedOut}.
// timeoutMs guards against CLI/network/auth hangs that never reach a result event.
function runClaude(promptText, cwd, extraArgs, timeoutMs = 90_000) {
  const cliArgs = [
    "-p", promptText,
    "--plugin-dir", DIST,
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    ...extraArgs,
  ];
  const r = spawnSync(claudeBin, cliArgs, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 512 * 1024 * 1024,
    input: "", // closed stdin: don't wait for piped input
    env: process.env,
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
  const events = (r.stdout || "")
    .split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const timedOut = r.signal === "SIGTERM" || (r.error && r.error.code === "ETIMEDOUT");
  return { code: r.status, events, err: r.stderr || "", timedOut };
}

const nameOf = (x) => (typeof x === "string" ? x : x && (x.name || x.id)) || "";
const initEvent = (events) => events.find((e) => e.type === "system" && e.subtype === "init");
const resultEvent = (events) => [...events].reverse().find((e) => e.type === "result");

// ---------- T2a: load smoke ----------
function loadSmoke() {
  console.log("\nT2a — load smoke (plugin loads & exposes exactly the installer surface):");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-smoke-"));
  try {
    const { code, events, err, timedOut } = runClaude("Reply with the single word: ok", tmp, ["--max-turns", "1"]);
    if (timedOut) { check(false, "T2a run finished within timeout", "claude -p timed out (90s) — CLI/auth/network hang"); return; }
    const init = initEvent(events);
    if (!init) {
      check(false, "system/init emitted", `no init event (exit ${code})\n${err.slice(0, 400)}`);
      return;
    }
    // Plugin present and error-free.
    const plugins = init.plugins || [];
    const ours = plugins.find((p) => nameOf(p) === PLUGIN);
    check(!!ours, "plugin aidlc-v2 loaded", `not in plugins: ${plugins.map(nameOf).join(", ")}`);
    const perr = init.plugin_errors || [];
    const ourErr = perr.filter((e) => JSON.stringify(e).includes(PLUGIN));
    check(ourErr.length === 0, "no plugin_errors for aidlc-v2", JSON.stringify(ourErr));

    // Exactly the intended surface: ONE skill (the entry skill), namespaced.
    const skills = (init.skills || []).map(nameOf);
    check(skills.includes(`${PLUGIN}:aidlc`), `entry skill ${PLUGIN}:aidlc present`,
      `aidlc-v2 skills seen: ${skills.filter((s) => s.startsWith(PLUGIN + ":")).join(", ") || "(none)"}`);
    // No framework leak: the payload's 38 skills (aidlc-feature, aidlc-mvp, …)
    // must NOT appear as plugin skills — they live under framework/, which the
    // plugin loader must not scan. A leak means the payload landed in a scanned
    // location and users would get 38 broken pre-install commands.
    const leaked = skills.filter((s) => s.startsWith(`${PLUGIN}:aidlc-`));
    check(leaked.length === 0, "no framework skills leaked into the plugin surface", leaked.join(", "));
    // The plugin ships no agents of its own.
    const agents = (init.agents || []).map(nameOf).filter((a) => a.startsWith(`${PLUGIN}:`));
    check(agents.length === 0, "no plugin agents (installer ships none)", agents.join(", "));

    // Run completed without error.
    const res = resultEvent(events);
    check(res && res.is_error !== true, "run completed without error", res ? `subtype ${res.subtype}` : "no result event");
  } finally {
    if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log(`  (kept scratch dir: ${tmp})`);
  }
}

// ---------- main ----------
if (!fs.existsSync(path.join(DIST, ".claude-plugin", "plugin.json"))) {
  console.error(`ERROR: built plugin not found at ${DIST} — run the build first.`);
  process.exit(1);
}
if (!claudeAvailable()) {
  const msg = `'claude' CLI not found (CLAUDE_BIN or PATH=${claudeBin}) — skipping T2 smoke.`;
  if (process.env.AIDLC_REQUIRE_SMOKE === "1") { console.error(`FAIL: ${msg} (AIDLC_REQUIRE_SMOKE=1)`); process.exit(1); }
  console.log(`SKIP: ${msg}`);
  process.exit(0);
}

loadSmoke();

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail) { console.error("\nSmoke failures:"); for (const f of fails) console.error("  - " + f); process.exit(1); }
console.log("T2a smoke passed. ✓");
