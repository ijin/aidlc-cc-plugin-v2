#!/usr/bin/env node
// targets/claude/build.mjs — Build the Claude Code plugin distribution from src/.
//
// Output: dist/claude/   (a Claude Code plugin, installable via a marketplace)
//
// Sources:
//   src/                      → dist/claude/framework/   (VERBATIM — upstream's built
//                               dist/claude tree: .claude/, .mcp.json, .gitignore, aidlc/)
//   targets/claude/plugin/    → dist/claude/skills/, dist/claude/installer/
//                               (authored: the /aidlc-v2:aidlc entry skill + installer)
//   (generated)               → dist/claude/.claude-plugin/plugin.json
//
// Why an INSTALLER plugin (not a run-in-place re-wrap):
//   Upstream's v2 engine hard-assumes it lives at <project>/.claude/ — its hooks
//   and tools join framework paths under the project dir, and its own `doctor`
//   prescribes "copy the workspace shell into your project root". Running it from
//   a plugin directory would mean forking upstream TypeScript on every sync. So
//   the plugin ships upstream's tree VERBATIM as a payload plus a small installer
//   that copies/updates it into the user's project (merging settings.json,
//   .mcp.json and .gitignore, never touching user state). Zero upstream patches;
//   every documented upstream command (/aidlc, /aidlc-<stage>, ...) works exactly
//   as shipped after install.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import os from "node:os";

const PLUGIN_NAME = "aidlc-v2";
const PLUGIN_DESCRIPTION =
  "AI-DLC v2 for Claude Code — installer plugin for the AI-Driven Development Lifecycle. " +
  "Ships awslabs/aidlc-workflows' own Claude Code target (verbatim, at a pinned release) " +
  "and installs/updates it in your project via /aidlc-v2:aidlc.";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const SRC = path.join(ROOT, "src");
const PLUGIN_SRC = path.join(SCRIPT_DIR, "plugin");
// Output dir. Overridable via AIDLC_OUT_DIR so the dist-drift check can build to a
// throwaway dir and diff it against the committed dist/claude without mutating it.
const OUT = process.env.AIDLC_OUT_DIR
  ? path.resolve(process.env.AIDLC_OUT_DIR)
  : path.join(ROOT, "dist", "claude");

// Single source of truth for the plugin version: package.json. dist/plugin.json
// is generated from it, and validate() asserts marketplace.json agrees — so the
// version lives in exactly one editable place and can't silently diverge.
// Read LAZILY (not at module load) so importing build.mjs for its exported
// constants has no filesystem side-effect (the T1 triage tool imports it from
// contexts without a package.json).
function pluginVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).version;
}

// --- Upstream-shape contract ---
// The build hardcodes assumptions about the shape of upstream's built dist/claude
// tree. When upstream drifts, these assumptions can silently stop holding — most
// importantly the ones the INSTALLER's merge logic depends on (settings.json,
// .mcp.json, .gitignore, the root layout). The contract below turns each
// assumption into a loud failure. Design principle (see README): assert the
// source→dist invariant, not that a rewrite fired.

// The vendored tree must contain exactly these top-level entries. A NEW entry
// means upstream added something the installer doesn't place; a MISSING one
// means a rename/restructure. (Exported so the T1 sync-triage tool anchors to
// the SAME canonical knowledge the build uses.)
export const REQUIRED_SRC_ROOT = [".claude", ".gitignore", ".mcp.json", "aidlc"];

// Exact child set of the vendored .claude/. Everything here is installer-copied;
// a new child would be silently shipped-but-undocumented, a missing one breaks
// the engine.
export const REQUIRED_CLAUDE_CHILDREN = [
  "CLAUDE.md",
  "agents",
  "aidlc-common",
  "hooks",
  "knowledge",
  "rules",
  "scopes",
  "sensors",
  "settings.json",
  "settings.local.json.example",
  "skills",
  "tools",
];

// settings.json top-level keys the installer's merge logic understands. An
// unknown key means upstream added configuration the installer would silently
// drop on merge-into-existing-settings — decide how to merge it, then extend
// BOTH this list and the installer.
export const SETTINGS_KNOWN_KEYS = new Set([
  "companyAnnouncements",
  "permissions",
  "statusLine",
  "env",
  "model",
  "effortLevel",
  "hooks",
]);

// Every hook command in upstream settings.json must match this exact shape.
// The installer copies settings.json verbatim/merged into the project, so this
// is not rewritten — but the shape IS what upstream's docs and permissions
// pre-approval assume; a change means the runtime contract moved.
export const HOOK_CMD_RE = /^bun \$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/(aidlc-[\w-]+\.ts)$/;

// MCP servers upstream ships. A NEW server means a new credentials/prereq story
// the README must document — review it, then extend the list.
export const MCP_KNOWN_SERVERS = new Set([
  "context7",
  "aws-mcp",
  "aws-pricing",
  "aws-iac",
  "aws-serverless",
]);

// Floors on content counts (v2.1.4 observed: 38 skills, 13 agents, 32 stages,
// 26 tools, 58 knowledge md). A sudden drop signals an upstream restructure or
// a broken copy even when everything present still parses.
export const MIN_SKILLS = 30;
export const MIN_AGENTS = 10;
export const MIN_STAGES = 25;
export const MIN_TOOLS = 15;
export const MIN_KNOWLEDGE = 40;

// The runtime entry points the entry skill and README point users at.
export const REQUIRED_FRAMEWORK_SKILLS = ["aidlc"];

// Authored plugin surface (relative to targets/claude/plugin/). The build fails
// if one is missing — a plugin without its entry skill or installer is dead.
export const AUTHORED_FILES = [
  "skills/aidlc/SKILL.md",
  "installer/aidlc-install.ts",
];

// Distinctive first line of the AI-DLC section of upstream's .gitignore. The
// installer locates the block by this marker to append it to an existing
// project .gitignore; if upstream rewords it, the installer's append logic and
// this constant must move together.
export const GITIGNORE_BLOCK_MARKER = "# AI-DLC —";

// --- Helpers ---

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function cpR(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

function listFiles(dir, base = dir) {
  // Recursive file list as sorted relative paths (symlinks would be a fidelity
  // problem — upstream ships none; fail loudly if one appears).
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`unexpected symlink in tree: ${full} — fidelity of the copy is not guaranteed`);
    }
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

// Extract the framework version from the vendored aidlc-version.ts. Exported so
// the release flow and triage can anchor to the same parse.
export function frameworkVersion(srcDir = SRC) {
  const file = path.join(srcDir, ".claude", "tools", "aidlc-version.ts");
  if (!fs.existsSync(file)) {
    throw new Error(
      `cannot parse AIDLC_VERSION — ${path.relative(ROOT, file)} does not exist; upstream ` +
        `moved/renamed the version constant; update frameworkVersion() in build.mjs`
    );
  }
  const text = fs.readFileSync(file, "utf-8");
  const m = text.match(/export const AIDLC_VERSION = "([^"]+)"/);
  if (!m) {
    throw new Error(
      `cannot parse AIDLC_VERSION from ${path.relative(ROOT, file)} — upstream moved/renamed ` +
        `the version constant; update frameworkVersion() in build.mjs`
    );
  }
  return m[1];
}

// --- Contract: preconditions on the vendored tree ---
// Runs BEFORE any copy so a surprise stops the build before it produces output.

function checkSrcContract() {
  if (!fs.existsSync(SRC)) {
    throw new Error(`src/ not found at ${SRC} — run targets/claude/sync-upstream.sh first`);
  }

  // P1: exact top-level entry set.
  const rootEntries = fs.readdirSync(SRC).sort();
  const expectedRoot = [...REQUIRED_SRC_ROOT].sort();
  if (JSON.stringify(rootEntries) !== JSON.stringify(expectedRoot)) {
    throw new Error(
      `src/ top-level is [${rootEntries.join(", ")}], expected exactly [${expectedRoot.join(", ")}] — ` +
        `upstream restructured its dist/claude; update REQUIRED_SRC_ROOT and the installer's placement rules`
    );
  }

  // P2: exact .claude child set.
  const claudeChildren = fs.readdirSync(path.join(SRC, ".claude")).sort();
  const expectedChildren = [...REQUIRED_CLAUDE_CHILDREN].sort();
  if (JSON.stringify(claudeChildren) !== JSON.stringify(expectedChildren)) {
    throw new Error(
      `src/.claude children are [${claudeChildren.join(", ")}], expected exactly ` +
        `[${expectedChildren.join(", ")}] — upstream changed the framework layout; update ` +
        `REQUIRED_CLAUDE_CHILDREN and review the installer`
    );
  }

  // P3: settings.json — the installer's merge logic depends on this shape.
  const settings = JSON.parse(fs.readFileSync(path.join(SRC, ".claude", "settings.json"), "utf-8"));
  const unknownKeys = Object.keys(settings).filter((k) => !SETTINGS_KNOWN_KEYS.has(k));
  if (unknownKeys.length) {
    throw new Error(
      `src/.claude/settings.json has unknown top-level key(s) [${unknownKeys.join(", ")}] — the ` +
        `installer's settings merge would drop them; extend SETTINGS_KNOWN_KEYS AND the installer's mergeSettings()`
    );
  }
  if (!settings.hooks || typeof settings.hooks !== "object" || !Object.keys(settings.hooks).length) {
    throw new Error("src/.claude/settings.json has no hooks — upstream changed hook wiring; review the installer and docs");
  }
  const referencedHookScripts = new Set();
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) throw new Error(`settings.json hooks.${event} is not an array — schema changed`);
    for (const group of groups) {
      for (const h of group.hooks || []) {
        const m = HOOK_CMD_RE.exec(h.command || "");
        if (!m) {
          throw new Error(
            `settings.json hook command ${JSON.stringify(h.command)} does not match the expected ` +
              `'bun $CLAUDE_PROJECT_DIR/.claude/hooks/aidlc-*.ts' shape — upstream changed hook invocation; ` +
              `update HOOK_CMD_RE and re-check the README's permissions guidance`
          );
        }
        referencedHookScripts.add(m[1]);
      }
    }
  }
  const statusCmd = settings.statusLine && settings.statusLine.command;
  if (statusCmd) {
    const m = HOOK_CMD_RE.exec(statusCmd);
    if (!m) {
      throw new Error(
        `settings.json statusLine command ${JSON.stringify(statusCmd)} does not match the expected shape — update HOOK_CMD_RE`
      );
    }
    referencedHookScripts.add(m[1]);
  }
  // P4: hooks/ file set == exactly the scripts settings.json references. An
  // unreferenced hook file is an unhandled surface; a missing one is a broken wiring.
  const hookFiles = fs.readdirSync(path.join(SRC, ".claude", "hooks")).filter((f) => f.endsWith(".ts")).sort();
  const referenced = [...referencedHookScripts].sort();
  if (JSON.stringify(hookFiles) !== JSON.stringify(referenced)) {
    throw new Error(
      `src/.claude/hooks/*.ts [${hookFiles.join(", ")}] != scripts referenced by settings.json ` +
        `[${referenced.join(", ")}] — upstream changed hook wiring; review, then update this check if legitimate`
    );
  }

  // P5: .mcp.json — server-name allowlist (a new server = a new credentials story to document).
  const mcp = JSON.parse(fs.readFileSync(path.join(SRC, ".mcp.json"), "utf-8"));
  const servers = Object.keys(mcp.mcpServers || {});
  if (!servers.length) throw new Error("src/.mcp.json has no mcpServers — upstream changed MCP config shape");
  const unknownServers = servers.filter((s) => !MCP_KNOWN_SERVERS.has(s));
  if (unknownServers.length) {
    throw new Error(
      `src/.mcp.json declares unknown MCP server(s) [${unknownServers.join(", ")}] — review their ` +
        `credentials/prereq story, document it in the README, then extend MCP_KNOWN_SERVERS`
    );
  }

  // P6: .gitignore must contain the AI-DLC block marker the installer appends by.
  const gitignore = fs.readFileSync(path.join(SRC, ".gitignore"), "utf-8");
  if (!gitignore.includes(GITIGNORE_BLOCK_MARKER)) {
    throw new Error(
      `src/.gitignore no longer contains the '${GITIGNORE_BLOCK_MARKER}' marker — the installer's ` +
        `append-block logic keys on it; update GITIGNORE_BLOCK_MARKER and the installer together`
    );
  }

  // P7: framework version must parse (release flow mirrors it into package.json).
  const fw = frameworkVersion();

  // P8: entry points + compiled data + count floors.
  for (const s of REQUIRED_FRAMEWORK_SKILLS) {
    if (!fs.existsSync(path.join(SRC, ".claude", "skills", s, "SKILL.md"))) {
      throw new Error(`src/.claude/skills/${s}/SKILL.md missing — upstream renamed/removed the entry skill`);
    }
  }
  const skillDirs = fs.readdirSync(path.join(SRC, ".claude", "skills"), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  for (const s of skillDirs) {
    if (!fs.existsSync(path.join(SRC, ".claude", "skills", s, "SKILL.md"))) {
      throw new Error(`src/.claude/skills/${s}/ has no SKILL.md — upstream skill layout changed`);
    }
  }
  const agentCount = fs.readdirSync(path.join(SRC, ".claude", "agents")).filter((f) => f.endsWith(".md")).length;
  const stageCount = listFiles(path.join(SRC, ".claude", "aidlc-common", "stages")).filter((f) => f.endsWith(".md")).length;
  const toolCount = fs.readdirSync(path.join(SRC, ".claude", "tools")).filter((f) => f.endsWith(".ts")).length;
  const knowledgeCount = listFiles(path.join(SRC, ".claude", "knowledge")).filter((f) => f.endsWith(".md")).length;
  const floors = [
    ["skills", skillDirs.length, MIN_SKILLS],
    ["agents", agentCount, MIN_AGENTS],
    ["stage files", stageCount, MIN_STAGES],
    ["tools", toolCount, MIN_TOOLS],
    ["knowledge files", knowledgeCount, MIN_KNOWLEDGE],
  ];
  for (const [label, n, min] of floors) {
    if (n < min) {
      throw new Error(`only ${n} ${label} in src/ (< ${min}) — upstream catalogue shrank or the copy failed; verify before shipping`);
    }
  }
  for (const dataFile of ["stage-graph.json", "scope-grid.json", "harness.json"]) {
    const p = path.join(SRC, ".claude", "tools", "data", dataFile);
    try {
      JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch (e) {
      throw new Error(
        `cannot parse compiled data ${path.relative(ROOT, p)} (${e.message}) — upstream ` +
          `moved/renamed/broke its compiled engine data; the installed engine would be dead`
      );
    }
  }

  return { fw, skills: skillDirs.length, agents: agentCount, stages: stageCount, hooks: hookFiles.length };
}

// --- Build steps ---

function buildFramework() {
  // The payload: upstream's built dist/claude tree, verbatim. NO transforms —
  // the postcondition below asserts byte-equality with src/.
  cpR(SRC, path.join(OUT, "framework"));
}

function buildAuthored() {
  for (const rel of AUTHORED_FILES) {
    const from = path.join(PLUGIN_SRC, rel);
    if (!fs.existsSync(from)) {
      throw new Error(`authored plugin file missing: targets/claude/plugin/${rel}`);
    }
    const to = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function buildManifest() {
  const dir = path.join(OUT, ".claude-plugin");
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    name: PLUGIN_NAME,
    description: PLUGIN_DESCRIPTION,
    version: pluginVersion(),
    author: { name: "ijin" },
    homepage: "https://github.com/ijin/aidlc-cc-plugin-v2",
    repository: "https://github.com/ijin/aidlc-cc-plugin-v2",
    license: "MIT-0",
    keywords: ["aidlc", "ai-driven", "development-lifecycle", "claude-code", "plugin", "v2"],
  };
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
}

// --- Contract: postconditions on dist ---

// Q1: framework/ must be byte-identical to src/. This is the core invariant of
// the installer model — we ship upstream VERBATIM, so any difference means the
// build mutated the payload.
function checkFrameworkVerbatim() {
  let failures = 0;
  const srcFiles = listFiles(SRC);
  const outDir = path.join(OUT, "framework");
  const outFiles = listFiles(outDir);
  if (JSON.stringify(srcFiles) !== JSON.stringify(outFiles)) {
    const missing = srcFiles.filter((f) => !outFiles.includes(f));
    const extra = outFiles.filter((f) => !srcFiles.includes(f));
    console.error(
      `  FAIL: framework/ file set != src/ (missing: [${missing.join(", ")}] extra: [${extra.join(", ")}])`
    );
    failures++;
  } else {
    for (const f of srcFiles) {
      if (!fs.readFileSync(path.join(SRC, f)).equals(fs.readFileSync(path.join(outDir, f)))) {
        console.error(`  FAIL: framework/${f} differs from src/${f} — the payload must ship verbatim`);
        failures++;
      }
    }
  }
  return failures;
}

// Q2: the authored surface + manifest must exist and the entry skill must carry
// the frontmatter Claude Code needs.
function checkAuthoredSurface() {
  let failures = 0;
  for (const rel of AUTHORED_FILES) {
    if (!fs.existsSync(path.join(OUT, rel))) {
      console.error(`  FAIL: dist missing authored file ${rel}`);
      failures++;
    }
  }
  const skill = path.join(OUT, "skills", "aidlc", "SKILL.md");
  if (fs.existsSync(skill)) {
    const text = fs.readFileSync(skill, "utf-8");
    if (!/^\s*name:\s*aidlc\s*$/m.test(text)) {
      console.error("  FAIL: entry skill SKILL.md missing 'name: aidlc' frontmatter");
      failures++;
    }
    // The skill must reference the installer via the plugin-root var, which
    // Claude Code substitutes in skill text at runtime.
    if (!text.includes("${CLAUDE_PLUGIN_ROOT}/installer/aidlc-install.ts")) {
      console.error("  FAIL: entry skill does not invoke ${CLAUDE_PLUGIN_ROOT}/installer/aidlc-install.ts");
      failures++;
    }
  }
  return failures;
}

// --- Validation ---

function validate() {
  let failures = 0;

  failures += checkFrameworkVerbatim();
  failures += checkAuthoredSurface();

  // Every JSON file in dist must parse.
  const jsonWalk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) jsonWalk(full);
      else if (entry.name.endsWith(".json")) {
        try {
          JSON.parse(fs.readFileSync(full, "utf-8"));
        } catch {
          console.error(`  FAIL: invalid JSON: ${path.relative(ROOT, full)}`);
          failures++;
        }
      }
    }
  };
  jsonWalk(OUT);

  // Version discipline: package.json is the source of truth; marketplace.json
  // must agree; and (mirror-upstream policy) the plugin version must equal the
  // framework version or be a plugin-only patch of it ("2.1.4", "2.1.4-p1").
  const ver = pluginVersion();
  const fw = frameworkVersion();
  if (!(ver === fw || ver.startsWith(fw + "-"))) {
    console.error(
      `  FAIL: plugin version '${ver}' does not mirror framework version '${fw}' ` +
        `(policy: equal, or '${fw}-pN' for plugin-only patches) — update package.json + marketplace.json`
    );
    failures++;
  }
  const mkPath = path.join(ROOT, ".claude-plugin", "marketplace.json");
  if (fs.existsSync(mkPath)) {
    try {
      const mk = JSON.parse(fs.readFileSync(mkPath, "utf-8"));
      const entry = (mk.plugins || []).find((p) => p.name === PLUGIN_NAME);
      if (entry && entry.version !== ver) {
        console.error(
          `  FAIL: marketplace.json ${PLUGIN_NAME} version '${entry.version}' != package.json '${ver}' — bump both together`
        );
        failures++;
      }
    } catch {
      console.error(`  FAIL: cannot parse ${path.relative(ROOT, mkPath)}`);
      failures++;
    }
  }

  // The installer must parse under bun (it is the one piece of OUR code users
  // execute). SKIP with a WARN when bun is absent (CI without bun); set
  // AIDLC_REQUIRE_BUN_CHECK=1 to make absence a hard failure in release CI.
  const installer = path.join(OUT, "installer", "aidlc-install.ts");
  let bunAvailable = true;
  try {
    execFileSync("bun", ["--version"], { stdio: "pipe" });
  } catch {
    bunAvailable = false;
  }
  if (bunAvailable && fs.existsSync(installer)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-bun-check-"));
    try {
      execFileSync("bun", ["build", installer, "--outdir", tmp], { stdio: "pipe" });
    } catch (e) {
      console.error(`  FAIL: installer does not parse under bun:\n${e.stderr || e.message}`);
      failures++;
    } finally {
      rmrf(tmp);
    }
  } else if (process.env.AIDLC_REQUIRE_BUN_CHECK === "1") {
    console.error("  FAIL: bun not found and AIDLC_REQUIRE_BUN_CHECK=1 — cannot syntax-check the installer");
    failures++;
  } else if (!bunAvailable) {
    console.warn("  WARN: bun not found — skipping installer syntax check");
  }

  // `claude plugin validate` on the generated plugin manifest AND the repo's
  // marketplace manifest — wired as a real gate when the CLI is available.
  // Resolution order: $CLAUDE_BIN, then `claude` on PATH. If neither resolves,
  // SKIP with a WARN (the deterministic checks above already cover structure);
  // AIDLC_REQUIRE_CLAUDE_VALIDATE=1 turns a missing CLI into a hard failure.
  const claudeBin = process.env.CLAUDE_BIN || "claude";
  const requireValidate = process.env.AIDLC_REQUIRE_CLAUDE_VALIDATE === "1";
  let claudeAvailable = true;
  try {
    execFileSync(claudeBin, ["--version"], { stdio: "pipe" });
  } catch {
    claudeAvailable = false;
  }
  if (claudeAvailable) {
    for (const [label, dir] of [["dist/claude (plugin)", OUT], ["marketplace", ROOT]]) {
      try {
        execFileSync(claudeBin, ["plugin", "validate", dir], { stdio: "pipe" });
      } catch (e) {
        const out = (e.stdout || "") + (e.stderr || "");
        console.error(`  FAIL: 'claude plugin validate' rejected ${label}:\n${out}`);
        failures++;
      }
    }
  } else if (requireValidate) {
    console.error(
      "  FAIL: 'claude' CLI not found (CLAUDE_BIN or PATH) and AIDLC_REQUIRE_CLAUDE_VALIDATE=1 — cannot run 'claude plugin validate'"
    );
    failures++;
  } else {
    console.warn(
      "  WARN: 'claude' CLI not found — skipping 'claude plugin validate' " +
        "(set CLAUDE_BIN, or AIDLC_REQUIRE_CLAUDE_VALIDATE=1 to require it)"
    );
  }

  return failures;
}

// --- Main ---

function build() {
  console.log("Building dist/claude/ ...");

  // Preconditions: the vendored tree must match the shape the installer expects.
  // Throws (aborting the build) on any surprise, before producing output.
  const report = checkSrcContract();

  rmrf(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  buildFramework();
  buildAuthored();
  buildManifest();

  console.log("Validating ...");
  const failures = validate();
  if (failures > 0) {
    console.error(`\n${failures} validation failure(s). Build aborted.`);
    process.exit(1);
  }

  console.log("Build report:");
  console.log(`  framework version .......... ${report.fw}`);
  console.log(`  framework skills ........... ${report.skills}`);
  console.log(`  framework agents ........... ${report.agents}`);
  console.log(`  framework stage files ...... ${report.stages}`);
  console.log(`  framework hooks ............ ${report.hooks}`);
  console.log(`  → dist/claude/  (plugin '${PLUGIN_NAME}' v${pluginVersion()}, installer model)`);
}

// Only run the build when executed directly (node build.mjs ...), NOT when this
// module is imported for its exported constants (e.g. by the T1 triage tool).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = process.argv[2] || "build";
  try {
    if (cmd === "clean") {
      rmrf(path.join(ROOT, "dist"));
      console.log("Cleaned dist/");
    } else if (cmd === "build") {
      build();
    } else {
      console.error(`Unknown command: ${cmd}. Use 'build' or 'clean'.`);
      process.exit(1);
    }
  } catch (e) {
    // Contract violations and other build errors throw — present them as a clean
    // one-line failure rather than a Node stack trace.
    console.error(`\nBuild failed: ${e.message}`);
    process.exit(1);
  }
}
