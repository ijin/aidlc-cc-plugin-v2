#!/usr/bin/env node
// test/drift-injection.mjs — Meta-verification: prove each build contract gate
// actually FAILS on the upstream-drift it is meant to catch (and that a clean
// build PASSES). Without this, a contract check could silently degrade (e.g. a
// regex that no longer matches) and we'd never know until a bad sync shipped.
//
// Strategy: copy the whole repo into a throwaway temp dir, mutate src/ (or a
// manifest) to simulate one drift class, run `node targets/claude/build.mjs`
// there, and assert the build exits non-zero AND the output contains the
// expected message fragment. The real repo is never mutated.
//
// Also runs two positive checks: a clean build PASSES, and building twice yields
// byte-identical dist/ (idempotency).
//
// Usage: node test/drift-injection.mjs   (exit 0 = all gates behave correctly)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync } from "node:child_process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPT_DIR, "..");

let pass = 0;
let fail = 0;
const failures = [];

function record(ok, name, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(`${name}: ${detail}`);
    console.log(`  FAIL  ${name} — ${detail}`);
  }
}

// Run the build in `dir`; return {code, out}. Never throws.
function runBuild(dir, env = {}) {
  try {
    const out = execFileSync("node", ["targets/claude/build.mjs", "build"], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: "pipe",
      encoding: "utf-8",
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") };
  }
}

// Make a clean throwaway copy of the repo (excluding heavy/irrelevant dirs).
function freshCopy() {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-drift-"));
  // Copy tracked + working files we need: src/, targets/, package.json,
  // .claude-plugin/, UPSTREAM.lock. Skip .git, node_modules, dist (rebuilt).
  for (const item of ["src", "targets", "package.json", ".claude-plugin", "UPSTREAM.lock"]) {
    const s = path.join(REPO, item);
    if (fs.existsSync(s)) fs.cpSync(s, path.join(dst, item), { recursive: true });
  }
  return dst;
}

function rm(d) {
  fs.rmSync(d, { recursive: true, force: true });
}

// A drift case: mutate(dir) simulates the drift; expect is a string the failing
// build output must contain. CLAUDE_BIN points nowhere so the claude-validate gate
// WARN-skips (hermetic + offline), and we FORCE AIDLC_REQUIRE_CLAUDE_VALIDATE=0 so
// a release-CI parent env (which may set =1) can't turn the skip into a failure and
// break these structural tests.
const HERMETIC = { CLAUDE_BIN: "/nonexistent/claude", AIDLC_REQUIRE_CLAUDE_VALIDATE: "0" };

const CASES = [
  {
    name: "clean build passes",
    mutate: () => {},
    expectPass: true,
  },
  {
    name: "unexpected top-level src/ dir → fail",
    mutate: (d) => fs.mkdirSync(path.join(d, "src", "newthing")),
    expect: "unexpected top-level dir",
  },
  {
    name: "unexpected top-level src/ file → fail",
    mutate: (d) => fs.writeFileSync(path.join(d, "src", "STRAY.txt"), "x"),
    expect: "unexpected top-level file",
  },
  {
    name: "missing required src/ dir (skills) → fail",
    mutate: (d) => rm(path.join(d, "src", "skills")),
    expect: "missing required dir",
  },
  {
    name: "agent unknown key → fail",
    mutate: (d) => {
      const f = path.join(d, "src", "agents", "aidlc-builder-agent.json");
      const a = JSON.parse(fs.readFileSync(f, "utf-8"));
      a.newField = "surprise";
      fs.writeFileSync(f, JSON.stringify(a, null, 2));
    },
    expect: "unknown key",
  },
  {
    name: "agent unmapped tool → fail",
    mutate: (d) => {
      const f = path.join(d, "src", "agents", "aidlc-builder-agent.json");
      const a = JSON.parse(fs.readFileSync(f, "utf-8"));
      a.tools = ["read", "mcp__weird"];
      fs.writeFileSync(f, JSON.stringify(a, null, 2));
    },
    expect: "unmapped tool",
  },
  {
    name: "agent non-array tools → fail",
    mutate: (d) => {
      const f = path.join(d, "src", "agents", "aidlc-builder-agent.json");
      const a = JSON.parse(fs.readFileSync(f, "utf-8"));
      a.tools = "read";
      fs.writeFileSync(f, JSON.stringify(a, null, 2));
    },
    expect: "not an array",
  },
  {
    name: "agent missing name → fail",
    mutate: (d) => {
      const f = path.join(d, "src", "agents", "aidlc-builder-agent.json");
      const a = JSON.parse(fs.readFileSync(f, "utf-8"));
      delete a.name;
      fs.writeFileSync(f, JSON.stringify(a, null, 2));
    },
    expect: "no valid string 'name'",
  },
  {
    name: "required skill renamed (orchestrator gone) → fail",
    mutate: (d) =>
      fs.renameSync(
        path.join(d, "src", "skills", "aidlc-orchestrator"),
        path.join(d, "src", "skills", "aidlc-conductor")
      ),
    expect: "required skill 'aidlc-orchestrator' missing",
  },
  {
    name: "required skill's SKILL.md renamed (dir stays) → fail",
    // The dir existing isn't enough — the entry-point SKILL.md must be present.
    mutate: (d) =>
      fs.renameSync(
        path.join(d, "src", "skills", "aidlc-orchestrator", "SKILL.md"),
        path.join(d, "src", "skills", "aidlc-orchestrator", "RENAMED.md")
      ),
    expect: "has no SKILL.md",
  },
  {
    name: "required agent renamed (name field) → fail",
    // The dist filename derives from the JSON `name` field, and the orchestrator
    // invokes the agent by that name — so renaming the FILE alone is harmless
    // (dist still emits aidlc-builder-agent.md). The meaningful drift is a renamed
    // `name` field, which breaks invocation; that is what must fail the build.
    mutate: (d) => {
      const f = path.join(d, "src", "agents", "aidlc-builder-agent.json");
      const a = JSON.parse(fs.readFileSync(f, "utf-8"));
      a.name = "aidlc-maker-agent";
      fs.writeFileSync(f, JSON.stringify(a, null, 2));
    },
    expect: "required agent 'aidlc-builder-agent' missing",
  },
  {
    name: "reworded invokeSubAgent survives into dist → invariant fail",
    mutate: (d) => {
      const f = path.join(d, "src", "aidlc-common", "protocols", "aidlc-orchestrator-protocol.md");
      let t = fs.readFileSync(f, "utf-8");
      // Reword so kiroToClaude's regexes miss it, but the forbidden token remains.
      t = t.replace(/Use `invokeSubAgent` with name `aidlc-builder-agent`\./, "Call invokeSubAgent for aidlc-builder-agent now:");
      fs.writeFileSync(f, t);
    },
    expect: "still contains Kiro invokeSubAgent",
  },
  {
    name: "process-checker .kiro rewrite missed (path form changed) → fail",
    mutate: (d) => {
      const f = path.join(d, "src", "aidlc-common", "scripts", "aidlc-process-checker.js");
      let t = fs.readFileSync(f, "utf-8");
      t = t.replace(/path\.join\(\s*"\.kiro"/, 'path.resolve(".kiro"');
      fs.writeFileSync(f, t);
    },
    expect: "still has a quoted",
  },
  {
    name: "interaction flag as bare YAML boolean → fail",
    // The process-checker only recognises quoted "true"/"false". A bare boolean
    // (flag: true) would silently default the gate ON — must fail the build.
    mutate: (d) => {
      const f = path.join(d, "src", "skills", "aidlc-requirements-analysis", "SKILL.md");
      const t = fs.readFileSync(f, "utf-8").replace(/human-clarification:\s*"true"/, "human-clarification: true");
      fs.writeFileSync(f, t);
    },
    expect: "not the quoted-string",
  },
  {
    name: "marketplace.json version skew → fail",
    mutate: (d) => {
      const f = path.join(d, ".claude-plugin", "marketplace.json");
      const m = JSON.parse(fs.readFileSync(f, "utf-8"));
      m.plugins[0].version = "9.9.9";
      fs.writeFileSync(f, JSON.stringify(m, null, 2));
    },
    expect: "marketplace.json",
  },
];

console.log("Drift-injection meta-tests (each gate must catch its target drift):");
for (const c of CASES) {
  const dir = freshCopy();
  try {
    c.mutate(dir);
    const { code, out } = runBuild(dir, HERMETIC);
    if (c.expectPass) {
      record(code === 0, c.name, `expected exit 0, got ${code}\n${out.slice(0, 300)}`);
    } else {
      const caught = code !== 0 && out.includes(c.expect);
      record(
        caught,
        c.name,
        code === 0
          ? "build PASSED but should have failed (gate is dead!)"
          : `failed but message missing "${c.expect}"\n${out.slice(0, 400)}`
      );
    }
  } finally {
    rm(dir);
  }
}

// Validate-gate wiring: a fake `claude` that REJECTS (exit 1) must fail the build.
// Proves the claude-validate gate is actually wired, not dead. (The 14 cases above
// run with claude absent, so none exercise it.)
{
  const dir = freshCopy();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "fakeclaude-"));
  const fake = path.join(fakeDir, "claude");
  // Reject `plugin validate`, accept `--version` (so the gate runs, then fails).
  fs.writeFileSync(
    fake,
    '#!/usr/bin/env bash\ncase "$1" in\n  --version) echo "fake 0.0.0"; exit 0;;\n  plugin) echo "FAKE: plugin rejected" >&2; exit 1;;\nesac\nexit 0\n'
  );
  fs.chmodSync(fake, 0o755);
  try {
    const { code, out } = runBuild(dir, {
      CLAUDE_BIN: fake,
      AIDLC_REQUIRE_CLAUDE_VALIDATE: "0",
    });
    const caught = code !== 0 && out.includes("claude plugin validate");
    record(
      caught,
      "claude-validate gate: rejecting CLI fails the build",
      code === 0 ? "build PASSED but fake claude rejected (gate is dead!)" : `failed but message missing\n${out.slice(0, 300)}`
    );
  } finally {
    rm(dir);
    rm(fakeDir);
  }
}

// Idempotency: build twice in a fresh copy, dist/ must be byte-identical.
{
  const dir = freshCopy();
  try {
    runBuild(dir, HERMETIC);
    const h1 = execSync(`find dist/claude -type f -exec shasum {} + | sort | shasum`, { cwd: dir, encoding: "utf-8" }).trim();
    runBuild(dir, HERMETIC);
    const h2 = execSync(`find dist/claude -type f -exec shasum {} + | sort | shasum`, { cwd: dir, encoding: "utf-8" }).trim();
    record(h1 === h2, "idempotency: two builds → identical dist/", `${h1} != ${h2}`);
  } finally {
    rm(dir);
  }
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) {
  console.error("\nGate(s) not behaving as designed:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("All contract gates catch their target drift. ✓");
