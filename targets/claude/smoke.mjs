#!/usr/bin/env node
// smoke.mjs — T2 headless behavioral smoke test for the built plugin.
//
// Runs the freshly-built dist/claude plugin under `claude -p` and asserts on the
// stream-json that it actually loads and wires up. Two tiers:
//
//   T2a (default, cheap, deterministic-ish): "does it load and wire up?"
//     - claude -p "<trivial>" --plugin-dir dist/claude --max-turns 1
//     - assert system/init: plugin present & error-free; ALL required skills,
//       agents, and slash-commands present and namespaced aidlc-v2:*; run completes.
//     One turn, minimal cost. This is the gate that runs every sync.
//
//   T2b (opt-in via --workflow, EXPENSIVE): "does the orchestrator actually run?"
//     - copies dist/claude to a scratch dir with interaction flags flipped to
//       "false" (a full run otherwise HANGS waiting for a human — flags are read
//       only from SKILL.md frontmatter, with no runtime override), runs a tiny
//       fixture intent in a sandbox, and asserts the builder/validator subagents
//       spawned, the process-check hook fired, and aidlc-docs artifacts appeared.
//     Real Bedrock cost + minutes; only when explicitly requested.
//
// Why this shape: a full autonomous workflow is impossible without flipping the
// SKILL.md interaction flags, and that's costly to run — so the cheap "wired up"
// assertions (which catch the overwhelmingly common breakage: a sync that produced
// a plugin that won't load) are separated from the expensive behavioral run.
//
// Usage:
//   node targets/claude/smoke.mjs [--workflow] [--claude <bin>] [--keep]
//     --workflow    also run T2b (the expensive autonomous orchestrator run)
//     --claude <b>  path to the claude binary (default: $CLAUDE_BIN or "claude")
//     --keep        keep the scratch/sandbox dirs for debugging
//
// Requires a working `claude` CLI with credentials (Bedrock/Anthropic). If the CLI
// is absent it SKIPS with a clear message (exit 0) unless AIDLC_REQUIRE_SMOKE=1.
// Exit: 0 pass/skip, 1 fail.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { REQUIRED_SKILLS, REQUIRED_AGENTS, INTERACTION_FLAGS } from "./build.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DIST = path.join(ROOT, "dist", "claude");
const PLUGIN = "aidlc-v2";

const args = process.argv.slice(2);
const runWorkflow = args.includes("--workflow");
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

// Run claude -p in `cwd`, return {code, events:[parsed stream-json lines], raw, timedOut}.
// `pluginDir` lets T2b point at its flag-flipped scratch plugin. `timeoutMs` guards
// against CLI/network/auth/hook hangs that never reach a result event (closed stdin
// and --max-turns/budget do NOT protect against those).
function runClaude(promptText, cwd, extraArgs, pluginDir = DIST, timeoutMs = 90_000) {
  const cliArgs = [
    "-p", promptText,
    "--plugin-dir", pluginDir,
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
  return { code: r.status, events, raw: r.stdout || "", err: r.stderr || "", timedOut };
}

const nameOf = (x) => (typeof x === "string" ? x : x && (x.name || x.id)) || "";
const initEvent = (events) => events.find((e) => e.type === "system" && e.subtype === "init");
const resultEvent = (events) => [...events].reverse().find((e) => e.type === "result");

// ---------- T2a: load smoke ----------
function loadSmoke() {
  console.log("\nT2a — load smoke (plugin loads & wires up):");
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
    // A clean load has no plugin_errors field, or an empty one. Fail if ours errored.
    const perr = init.plugin_errors || [];
    const ourErr = perr.filter((e) => JSON.stringify(e).includes(PLUGIN));
    check(ourErr.length === 0, "no plugin_errors for aidlc-v2", JSON.stringify(ourErr));
    // All required skills present, namespaced.
    const skills = (init.skills || []).map(nameOf);
    for (const s of REQUIRED_SKILLS) {
      check(skills.includes(`${PLUGIN}:${s}`), `skill ${PLUGIN}:${s} present`, `skills: ${skills.filter((x) => x.includes("aidlc-v2")).join(", ")}`);
    }
    // Spot-check the full skill set is namespaced & sizeable (catches a half-load).
    const ns = skills.filter((s) => s.startsWith(`${PLUGIN}:`));
    check(ns.length >= 10, `>=10 aidlc-v2 skills present (${ns.length})`, ns.join(", "));
    // Required agents present, namespaced.
    const agents = (init.agents || []).map(nameOf);
    for (const a of REQUIRED_AGENTS) {
      check(agents.includes(`${PLUGIN}:${a}`), `agent ${PLUGIN}:${a} present`, `agents: ${agents.filter((x) => x.includes("aidlc-v2")).join(", ")}`);
    }
    // Run completed without error.
    const res = resultEvent(events);
    check(res && res.is_error !== true, "run completed without error", res ? `subtype ${res.subtype}` : "no result event");
  } finally {
    if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- T2b: autonomous workflow smoke ----------
function flipFlagsToFalse(skillMd) {
  let t = skillMd;
  for (const flag of INTERACTION_FLAGS) {
    t = t.replace(new RegExp(`^(\\s*${flag}:\\s*)"true"\\s*$`, "m"), `$1"false"`);
  }
  return t;
}

function workflowSmoke() {
  console.log("\nT2b — autonomous workflow smoke (orchestrator runs end-to-end):");
  // Scratch copy of the plugin with interaction flags flipped false (so the run
  // doesn't hang waiting for a human). We never touch dist/ or src/.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-smoke-plugin-"));
  const scratchPlugin = path.join(scratch, "claude");
  fs.cpSync(DIST, scratchPlugin, { recursive: true });
  let flipped = 0;
  for (const skillMd of findSkillMds(path.join(scratchPlugin, "skills"))) {
    const before = fs.readFileSync(skillMd, "utf-8");
    const after = flipFlagsToFalse(before);
    if (after !== before) { fs.writeFileSync(skillMd, after); flipped++; }
  }
  check(flipped > 0, "flipped interaction flags in scratch plugin", `flipped ${flipped} skill files`);

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-smoke-ws-"));
  try {
    const prompt = "Build a tiny one-function utility: a function that returns the sum of two integers. Run the AI-DLC v2 workflow autonomously end to end with no questions.";
    const timeoutMs = Number(process.env.AIDLC_SMOKE_TIMEOUT_MS || 30 * 60 * 1000); // 30 min default
    const extra = [
      "--include-hook-events",
      "--add-dir", sandbox,
      "--max-turns", process.env.AIDLC_SMOKE_MAX_TURNS || "60",
    ];
    if (process.env.AIDLC_SMOKE_MAX_BUDGET) extra.push("--max-budget-usd", process.env.AIDLC_SMOKE_MAX_BUDGET);
    const { events, code, timedOut } = runClaude(prompt, sandbox, extra, scratchPlugin, timeoutMs);
    if (timedOut) { check(false, "T2b run finished within timeout", `claude -p exceeded ${Math.round(timeoutMs / 60000)}min — likely a hang`); return; }

    // (1) Builder AND validator subagents invoked (the design promises both; a run
    // that never reaches validation must not pass).
    const toolUses = events.flatMap((e) => collectToolUses(e));
    const tuJson = JSON.stringify(toolUses);
    check(/aidlc-builder-agent/.test(tuJson), "builder subagent invoked", `agent tool_uses: ${toolUses.map((t) => t.name).join(", ").slice(0, 200)}`);
    check(/aidlc-validator-agent/.test(tuJson), "validator subagent invoked", "no aidlc-validator-agent tool_use observed");

    // (2) OUR process-check hook fired — match its concrete additionalContext, not
    // any generic hook event (other installed plugins also emit hooks). The hook
    // injects the process-checker path / its mandatory-reminder text.
    const hookFired = events.some((e) => {
      const s = JSON.stringify(e);
      return /aidlc-process-checker\.js/.test(s) || /An AI-DLC sub-agent just completed/.test(s);
    });
    check(hookFired, "process-check hook fired (our SubagentStop reminder)", "our hook's additionalContext not seen in any event");

    // (3) Concrete AI-DLC artifacts exist (not just "some file"). These are the
    // state-machine spine the workflow must write.
    const found = (rel) => globUnder(sandbox, rel);
    const stateFile = found("state/intent-state.md");
    const workflowFile = found("workflow.md");
    const checkpoint = found("state/process-checkpoint.json");
    check(!!stateFile, "intent-state.md created", `not found under ${sandbox}`);
    check(!!workflowFile, "workflow.md created", `not found under ${sandbox}`);
    check(!!checkpoint, "process-checkpoint.json created (process-checker ran)", `not found under ${sandbox}`);

    // (4) Terminal state. A turn/budget CAP is only ACCEPTABLE if the run was in a
    // HEALTHY, advancing state when capped — not merely that the spine files exist.
    // We require: validator reached, state+checkpoint written, AND the checkpoint's
    // `error` field is null (process-checker's "healthy, proceed" signal — a run
    // stuck in a failure loop would have a non-null error). Otherwise the cap is
    // inconclusive/stuck, which is the workflow-control failure T2b must catch.
    const res = resultEvent(events);
    const CAPPED = new Set(["error_max_budget_usd", "error_max_turns"]);
    let checkpointHealthy = false, checkpointNote = "no checkpoint";
    if (checkpoint) {
      try {
        const cp = JSON.parse(fs.readFileSync(checkpoint, "utf-8"));
        // The process-checker ALWAYS writes an `error` field (null when healthy).
        // A MISSING field is schema drift or a fabricated/truncated checkpoint, so
        // fail closed: require the field present AND explicitly null.
        checkpointHealthy = Object.hasOwn(cp, "error") && cp.error === null;
        checkpointNote = `error=${JSON.stringify(cp.error)} hasErrorField=${Object.hasOwn(cp, "error")} current=${JSON.stringify(cp.current)}`;
      } catch (e) { checkpointNote = `unparseable checkpoint: ${e.message}`; }
    }
    const progressed = /aidlc-validator-agent/.test(tuJson) && !!stateFile && checkpointHealthy;
    if (res && res.is_error !== true) {
      check(true, "workflow run completed (success)", "");
    } else if (res && CAPPED.has(res.subtype)) {
      check(progressed, `cap (${res.subtype}) reached while HEALTHY & advancing`,
        `cap without validator+state+healthy-checkpoint — inconclusive/stuck, not a clean bound (${checkpointNote})`);
      if (progressed) console.log(`        (note: intentional ${res.subtype} cap; checkpoint healthy [${checkpointNote}])`);
    } else {
      check(false, "workflow run did not error", res ? `subtype ${res.subtype}` : `no result event (exit ${code})`);
    }
  } finally {
    if (!keep) {
      fs.rmSync(scratch, { recursive: true, force: true });
      fs.rmSync(sandbox, { recursive: true, force: true });
    } else {
      console.log(`  (kept scratch plugin: ${scratchPlugin})\n  (kept sandbox: ${sandbox})`);
    }
  }
}

function findSkillMds(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const md = path.join(dir, e.name, "SKILL.md");
      if (fs.existsSync(md)) out.push(md);
    }
  }
  return out;
}
function collectToolUses(e) {
  // tool_use blocks appear in assistant message content or stream_event deltas.
  const out = [];
  const scan = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (obj.type === "tool_use" && obj.name) out.push({ name: obj.name, input: obj.input });
    for (const v of Object.values(obj)) { if (v && typeof v === "object") scan(v); }
  };
  scan(e);
  return out;
}
// Find a file anywhere under `dir` whose path ends with `relSuffix` (e.g.
// "state/intent-state.md"). Returns the absolute path or null. Used to assert
// SPECIFIC AI-DLC artifacts exist, not just "some file in the sandbox".
function globUnder(dir, relSuffix) {
  const suffix = "/" + relSuffix.replace(/^\/+/, "");
  let found = null;
  const walk = (d) => {
    if (found) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (("/" + path.relative(dir, full)).endsWith(suffix) || full.endsWith(suffix)) { found = full; return; }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found;
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
if (runWorkflow) {
  // T2b runs freshly-synced upstream SKILL.md instructions under
  // --dangerously-skip-permissions. --add-dir scopes accidental writes but is NOT
  // a security sandbox: a malicious or badly-drifted skill could use tools as the
  // current OS user. Require explicit acknowledgement that you're in a disposable
  // environment (no secrets, throwaway machine/container/CI).
  if (process.env.AIDLC_SMOKE_TRUST !== "1") {
    console.error(
      "\nREFUSING T2b: it executes freshly-synced upstream instructions with permission bypass.\n" +
      "--add-dir is NOT isolation. Run only on a disposable machine/container/CI with no secrets,\n" +
      "then set AIDLC_SMOKE_TRUST=1 to acknowledge and proceed."
    );
    process.exit(1);
  }
  workflowSmoke();
} else {
  console.log("\n(T2b autonomous workflow smoke skipped — pass --workflow to run it; it costs real Bedrock time/$ and runs untrusted upstream instructions, so it also needs AIDLC_SMOKE_TRUST=1.)");
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail) { console.error("\nSmoke failures:"); for (const f of fails) console.error("  - " + f); process.exit(1); }
console.log("T2 smoke passed. ✓");
