#!/usr/bin/env node
// test/drift-injection.mjs — Meta-verification: prove each build contract gate
// actually FAILS on the upstream-drift it is meant to catch (and that a clean
// build PASSES). Without this, a contract check could silently degrade and we'd
// never know until a bad sync shipped.
//
// Strategy: copy the whole repo into a throwaway temp dir, mutate src/ (or an
// authored/manifest file) to simulate one drift class, run the build there, and
// assert it exits non-zero AND the output contains the expected message
// fragment. The real repo is never mutated.
//
// Also runs positive checks: a clean build PASSES, and building twice yields
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
  for (const item of ["src", "targets", "package.json", ".claude-plugin", "UPSTREAM.lock"]) {
    const s = path.join(REPO, item);
    if (fs.existsSync(s)) fs.cpSync(s, path.join(dst, item), { recursive: true });
  }
  return dst;
}

function rm(d) {
  fs.rmSync(d, { recursive: true, force: true });
}

function editJson(file, mutate) {
  const o = JSON.parse(fs.readFileSync(file, "utf-8"));
  mutate(o);
  fs.writeFileSync(file, JSON.stringify(o, null, 2) + "\n");
}

// CLAUDE_BIN points nowhere so the claude-validate gate WARN-skips (hermetic +
// offline), and AIDLC_REQUIRE_CLAUDE_VALIDATE=0 so a release-CI parent env can't
// turn the skip into a failure and break these structural tests.
const HERMETIC = { CLAUDE_BIN: "/nonexistent/claude", AIDLC_REQUIRE_CLAUDE_VALIDATE: "0" };

const bunAvailable = (() => {
  try { execFileSync("bun", ["--version"], { stdio: "pipe" }); return true; }
  catch { return false; }
})();

const CASES = [
  {
    name: "clean build passes",
    mutate: () => {},
    expectPass: true,
  },
  {
    name: "unexpected top-level src/ entry → fail (exact root set)",
    mutate: (d) => fs.writeFileSync(path.join(d, "src", "STRAY.txt"), "x"),
    expect: "expected exactly",
  },
  {
    name: "missing top-level src/.mcp.json → fail (exact root set)",
    mutate: (d) => fs.rmSync(path.join(d, "src", ".mcp.json")),
    expect: "expected exactly",
  },
  {
    name: "unexpected .claude child → fail (exact children set)",
    mutate: (d) => fs.mkdirSync(path.join(d, "src", ".claude", "newthing")),
    expect: "expected exactly",
  },
  {
    name: "missing .claude child (settings.local.json.example) → fail",
    mutate: (d) => fs.rmSync(path.join(d, "src", ".claude", "settings.local.json.example")),
    expect: "expected exactly",
  },
  {
    name: "settings.json unknown top-level key → fail (installer merge would drop it)",
    mutate: (d) => editJson(path.join(d, "src", ".claude", "settings.json"), (s) => { s.surpriseKey = {}; }),
    expect: "unknown top-level key",
  },
  {
    name: "settings.json hook command shape changed → fail",
    mutate: (d) => editJson(path.join(d, "src", ".claude", "settings.json"), (s) => {
      s.hooks.Stop[0].hooks[0].command = "node .claude/hooks/aidlc-stop.js";
    }),
    expect: "does not match the expected",
  },
  {
    name: "stray unreferenced hook script → fail (exact hook set)",
    mutate: (d) => fs.writeFileSync(path.join(d, "src", ".claude", "hooks", "aidlc-extra.ts"), "// stray\n"),
    expect: "scripts referenced by settings.json",
  },
  {
    name: "unknown MCP server → fail (undocumented credentials story)",
    mutate: (d) => editJson(path.join(d, "src", ".mcp.json"), (m) => {
      m.mcpServers["surprise-server"] = { command: "uvx", args: ["x"] };
    }),
    expect: "unknown MCP server",
  },
  {
    name: ".gitignore AI-DLC marker gone → fail (installer append logic keys on it)",
    mutate: (d) => {
      const f = path.join(d, "src", ".gitignore");
      fs.writeFileSync(f, fs.readFileSync(f, "utf-8").replace(/# AI-DLC —/g, "# AIDLC:"));
    },
    expect: "no longer contains",
  },
  {
    name: "version constant unparseable → fail",
    mutate: (d) => {
      const f = path.join(d, "src", ".claude", "tools", "aidlc-version.ts");
      fs.writeFileSync(f, fs.readFileSync(f, "utf-8").replace("export const AIDLC_VERSION", "export const VERSION"));
    },
    expect: "cannot parse AIDLC_VERSION",
  },
  {
    name: "entry skill gone (skills/aidlc renamed) → fail",
    mutate: (d) =>
      fs.renameSync(path.join(d, "src", ".claude", "skills", "aidlc"), path.join(d, "src", ".claude", "skills", "aidlc-renamed")),
    expect: "entry skill",
  },
  {
    name: "a skill dir without SKILL.md → fail",
    mutate: (d) => fs.rmSync(path.join(d, "src", ".claude", "skills", "aidlc-feature", "SKILL.md")),
    expect: "has no SKILL.md",
  },
  {
    name: "skill catalogue shrinks below the floor → fail",
    mutate: (d) => {
      const dir = path.join(d, "src", ".claude", "skills");
      const skills = fs.readdirSync(dir).filter((s) => s !== "aidlc");
      // Delete enough skill dirs to fall under MIN_SKILLS (30).
      for (const s of skills.slice(0, skills.length - 25)) rm(path.join(dir, s));
    },
    expect: "catalogue shrank",
  },
  {
    name: "compiled stage-graph.json corrupted → fail",
    mutate: (d) => fs.writeFileSync(path.join(d, "src", ".claude", "tools", "data", "stage-graph.json"), "{not json"),
    expect: "cannot parse compiled data",
  },
  {
    name: "marketplace.json version skew → fail",
    mutate: (d) => editJson(path.join(d, ".claude-plugin", "marketplace.json"), (m) => {
      m.plugins[0].version = "9.9.9";
    }),
    expect: "marketplace.json",
  },
  {
    name: "plugin version does not mirror framework version → fail",
    mutate: (d) => {
      editJson(path.join(d, "package.json"), (p) => { p.version = "9.9.9"; });
      editJson(path.join(d, ".claude-plugin", "marketplace.json"), (m) => { m.plugins[0].version = "9.9.9"; });
    },
    expect: "does not mirror framework version",
  },
  {
    name: "authored installer missing → fail",
    mutate: (d) => fs.rmSync(path.join(d, "targets", "claude", "plugin", "installer", "aidlc-install.ts")),
    expect: "authored plugin file missing",
  },
  {
    name: "entry skill lost its installer invocation → fail",
    mutate: (d) => {
      const f = path.join(d, "targets", "claude", "plugin", "skills", "aidlc", "SKILL.md");
      fs.writeFileSync(f, fs.readFileSync(f, "utf-8").replaceAll("${CLAUDE_PLUGIN_ROOT}/installer/aidlc-install.ts", "the installer"));
    },
    expect: "does not invoke",
  },
];

if (bunAvailable) {
  CASES.push({
    name: "installer that does not parse → fail (bun syntax gate)",
    mutate: (d) => fs.writeFileSync(
      path.join(d, "targets", "claude", "plugin", "installer", "aidlc-install.ts"),
      "const oops: = broken(;\n"
    ),
    expect: "does not parse under bun",
  });
} else {
  console.log("  (skipping bun syntax-gate case — bun not on PATH)");
}

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
// Proves the claude-validate gate is actually wired, not dead.
{
  const dir = freshCopy();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "fakeclaude-"));
  const fake = path.join(fakeDir, "claude");
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
