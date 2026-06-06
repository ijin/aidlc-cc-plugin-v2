#!/usr/bin/env node
// targets/claude/build.mjs — Build the Claude Code plugin distribution from src/.
//
// Output: dist/claude/   (a Claude Code plugin, installable via a marketplace)
//
// Sources:
//   src/skills/        → dist/claude/skills/        (auto-discovered, namespaced /aidlc-v2:<name>)
//   src/aidlc-common/  → dist/claude/aidlc-common/  (bundled support files, referenced via ${CLAUDE_PLUGIN_ROOT})
//   src/agents/*.json  → dist/claude/agents/*.md    (Kiro agent JSON converted to Claude subagent markdown)
//   (generated)        → dist/claude/.claude-plugin/plugin.json
//
// Why a transform (not a verbatim copy):
//   Upstream content is install-root-relative — it says framework paths like
//   `aidlc-common/...` and `skills/...` resolve against the install root, which is
//   `.kiro/` for Kiro. For a Claude Code plugin the install root is the plugin root,
//   exposed to skill/agent/hook content as the env var ${CLAUDE_PLUGIN_ROOT}, which
//   Claude Code substitutes inline before the model reads it. So this build anchors
//   those framework paths to ${CLAUDE_PLUGIN_ROOT} and converts the Kiro agent format
//   to Claude's.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PLUGIN_NAME = "aidlc-v2";
const PLUGIN_DESCRIPTION =
  "AI-DLC v2 (alpha) — agent-orchestrated AI-Driven Development Lifecycle for Claude Code. Ported from awslabs/aidlc-workflows v2.";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const SRC = path.join(ROOT, "src");
// Output dir. Overridable via AIDLC_OUT_DIR so the dist-drift check can build to a
// throwaway dir and diff it against the committed dist/claude without mutating it.
const OUT = process.env.AIDLC_OUT_DIR
  ? path.resolve(process.env.AIDLC_OUT_DIR)
  : path.join(ROOT, "dist", "claude");

// Single source of truth for the plugin version: package.json. dist/plugin.json
// is generated from it, and validate() asserts marketplace.json agrees — so the
// version lives in exactly one editable place and can't silently diverge.
// Read LAZILY (not at module load) so importing build.mjs for its exported
// constants/transform has no filesystem side-effect (the T1 triage tool imports it
// from contexts without a package.json).
function pluginVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).version;
}

// Kiro agent tool name → Claude Code tool name.
const TOOL_MAP = { read: "Read", write: "Write", shell: "Bash", edit: "Edit" };

const PLUGIN_ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}";

// --- Upstream-shape contract ---
// The build hardcodes assumptions about upstream's layout and formats. When
// upstream (a moving, tagless dev branch) drifts, these assumptions can silently
// stop holding and the build would otherwise ship half-translated output. The
// contract below turns each assumption into a loud failure. Design principle (see
// README "The upstream-shape contract"): assert the source→dist invariant, not
// that every rewrite regex fired.

// src/ must contain exactly these top-level entries. A NEW dir means upstream
// added something the transform doesn't handle; a MISSING one means a rename.
// (Exported so the T1 sync-triage tool anchors to the SAME canonical knowledge the
// build uses, rather than re-deriving "what the adapter handles".)
export const REQUIRED_SRC_DIRS = ["agents", "aidlc-common", "skills"];

// Keys we know how to translate in a Kiro agent JSON. An unknown key means the
// agent schema changed and buildAgents() may be dropping meaningful config.
export const KNOWN_AGENT_KEYS = new Set(["name", "description", "prompt", "tools"]);

// Runtime entry points that MUST exist in the built plugin. If upstream renames
// or removes one of these, every "does the output parse" check still passes but
// the plugin is missing the component that drives it — so assert them explicitly.
export const REQUIRED_SKILLS = ["aidlc-orchestrator"];
export const REQUIRED_AGENTS = ["aidlc-builder-agent", "aidlc-validator-agent"];
// A floor on skill count: upstream ships ~14; a sudden drop signals upstream
// restructured the catalogue (or a copy failed) even if the orchestrator survived.
const MIN_SKILLS = 10;

// Per-skill interaction flags. The process-checker parses these as QUOTED strings
// ("true"/"false"); the build asserts that format so an upstream switch to bare
// YAML booleans can't silently flip a gate's default.
export const INTERACTION_FLAGS = [
  "human-clarification",
  "plan-verification",
  "artefact-verification",
  "plan-creation",
  "per-unit",
];

// Kiro-specific constructs that must NEVER survive into the Claude dist as
// operational text. If src/ still contains one of these and dist/ also does, the
// adapter failed to rewrite it. (Plain code comments mentioning these are fine;
// we scan shipped skill/agent/protocol markdown, not provenance comments.)
export const DIST_FORBIDDEN = [
  { label: "Kiro invokeSubAgent primitive", re: /invokeSubAgent/ },
  { label: "Kiro askAgent hook primitive", re: /\baskAgent\b/ },
];

// Soft signals: tokens that often accompany Kiro-only features. Found in src/ →
// emit a WARNING so a human eyeballs them during sync review. Not a failure: many
// are legitimate (e.g. a comment), and we don't want false stops on every sync.
// The broad /\bkiro\b/i catch-all is the safety net for a genuinely NEW Kiro
// primitive (one not in DIST_FORBIDDEN): it won't fail the build, but it surfaces
// "upstream mentions kiro somewhere new" to the sync reviewer.
export const KIRO_SMELLS = [
  /\.kiro\.hook/,
  /invokeSubAgent/,
  /\baskAgent\b/,
  /#\[\[file:/,
  /\bkiro\b/i,
];

// Build report counters, surfaced at the end of a build.
const STATS = {
  pathsAnchored: 0,
  kiroPrimitivesRewritten: 0,
  kiroJoinsRewritten: 0,
};

// --- Helpers ---

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function cpR(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

function findFiles(dir, predicate) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findFiles(full, predicate));
    else if (predicate(entry.name)) out.push(full);
  }
  return out;
}

// Anchor install-root-relative framework paths to ${CLAUDE_PLUGIN_ROOT}.
//
// Framework paths in upstream content come in three forms, all install-root
// relative and all needing the anchor:
//   - `aidlc-common/...`         (protocols, conventions, scripts)
//   - `skills/aidlc-<name>/...`  (concrete skill paths)
//   - `skills/<skill-name>/...`  (TEMPLATE paths the orchestrator substitutes
//                                 at runtime, then passes to a sub-agent — these
//                                 must stay anchored so the substituted path is
//                                 plugin-rooted, not resolved against the cwd)
// Project paths (`aidlc-docs/...`) are intentionally left untouched. The guard
// `(^|[^/\w}])` avoids double-prefixing a path that already carries the var or a
// slash. The template rule requires a filename char AFTER the trailing slash
// (`skills/<skill-name>/SKILL.md`, `.../scripts/`) so it anchors only operational
// paths the orchestrator passes to sub-agents — not the bare directory-convention
// references in CATALOGUE prose/diagrams (`skills/<skill-name>/` then a backtick or
// newline), which describe layout rather than name a file to read.
function anchorFrameworkPaths(text) {
  const root = PLUGIN_ROOT_VAR;
  // Build a single pass that skips matches already preceded by the var or by a slash.
  const rewrite = (s, needle) =>
    s.replace(new RegExp(`(^|[^/\\w}])(${needle})`, "g"), (m, pre, p) => {
      STATS.pathsAnchored++;
      return `${pre}${root}/${p}`;
    });
  let t = text;
  t = rewrite(t, "aidlc-common/");
  t = rewrite(t, "skills/aidlc-");
  t = rewrite(t, "skills/<[a-z-]+>/\\w");
  return t;
}

// Rewrite Kiro-specific execution primitives to their Claude Code equivalents.
// `invokeSubAgent` is Kiro's sub-agent call; on Claude Code sub-agents are
// invoked via the Agent tool (named `Task` before Claude Code v2.1.63, where it
// still works as an alias). The process-check reminder — a Kiro hook upstream —
// ships here as a Claude `SubagentStop` hook (see targets/claude/hooks/).
function kiroToClaude(text) {
  const count = (s, re) => {
    const m = s.match(re);
    return m ? m.length : 0;
  };
  STATS.kiroPrimitivesRewritten +=
    count(text, /invokeSubAgent/g);
  STATS.kiroJoinsRewritten +=
    count(text, /On Kiro, a hook reminds you to run `process_checker`/g);
  return text
    .replace(
      /Use `invokeSubAgent` with name `([^`]+)`\./g,
      "Use the Agent tool to invoke the `$1` subagent."
    )
    .replace(
      /The actual `invokeSubAgent` call still uses/g,
      "The actual Agent tool sub-agent call still targets"
    )
    .replace(
      /On Kiro, a hook reminds you to run `process_checker`/g,
      "A SubagentStop hook (bundled with this plugin) reminds you to run `process_checker`"
    )
    .replace(/`invokeSubAgent`/g, "the Agent tool");
}

// Full content transform applied to every shipped markdown file.
// Exported so T1 triage can ask "does the adapter fully neutralize this changed
// line?" using the exact same transform the build applies.
export function transformContent(text) {
  return kiroToClaude(anchorFrameworkPaths(text));
}

// --- Build steps ---

function buildSkills() {
  const skillsOut = path.join(OUT, "skills");
  cpR(path.join(SRC, "skills"), skillsOut);
  // Rewrite framework paths inside every markdown file under skills/.
  for (const md of findFiles(skillsOut, (n) => n.endsWith(".md"))) {
    fs.writeFileSync(md, transformContent(fs.readFileSync(md, "utf-8")));
  }
  return findFiles(skillsOut, (n) => n === "SKILL.md").length;
}

function buildCommon() {
  const commonOut = path.join(OUT, "aidlc-common");
  cpR(path.join(SRC, "aidlc-common"), commonOut);

  // Rewrite framework paths in the common markdown (protocols, conventions).
  for (const md of findFiles(commonOut, (n) => n.endsWith(".md"))) {
    fs.writeFileSync(md, transformContent(fs.readFileSync(md, "utf-8")));
  }

  // The process-checker resolves its own install root from __dirname, but two
  // path.join() calls hardcode the literal ".kiro". Repoint them at the
  // self-resolved INSTALL_ROOT so the script is install-root-agnostic.
  const checker = path.join(commonOut, "scripts", "aidlc-process-checker.js");
  if (fs.existsSync(checker)) {
    const src = fs.readFileSync(checker, "utf-8");
    const fixed = src.replace(/path\.join\(\s*"\.kiro"/g, 'path.join(\n  INSTALL_ROOT');
    fs.writeFileSync(checker, fixed);
  }
}

function buildAgents() {
  const agentsSrc = path.join(SRC, "agents");
  if (!fs.existsSync(agentsSrc)) return 0;
  const agentsOut = path.join(OUT, "agents");
  fs.mkdirSync(agentsOut, { recursive: true });

  let count = 0;
  for (const file of fs.readdirSync(agentsSrc)) {
    if (!file.endsWith(".json")) continue;
    const agent = JSON.parse(fs.readFileSync(path.join(agentsSrc, file), "utf-8"));

    // Contract: a usable name is required — without it we'd write `undefined.md`
    // with `name: undefined` frontmatter, which slips past the name validator.
    if (typeof agent.name !== "string" || !agent.name.trim()) {
      throw new Error(`agent ${file} has no valid string 'name' field`);
    }
    // Contract: an unknown key means upstream changed the agent schema and we may
    // be dropping config silently. Fail loudly so the adapter gets updated.
    const unknownKeys = Object.keys(agent).filter((k) => !KNOWN_AGENT_KEYS.has(k));
    if (unknownKeys.length) {
      throw new Error(
        `agent ${file} has unknown key(s) [${unknownKeys.join(", ")}] — upstream ` +
          `agent schema changed; update KNOWN_AGENT_KEYS and the conversion in buildAgents()`
      );
    }
    // Contract: `tools` (if present) must be an array, and every Kiro tool must
    // map to a Claude tool. A non-array or unmapped value means an upstream
    // schema change — fail rather than throw a raw TypeError or pass an unknown
    // token into the agent's `tools` frontmatter.
    if (agent.tools !== undefined && !Array.isArray(agent.tools)) {
      throw new Error(
        `agent ${file} 'tools' is not an array (got ${typeof agent.tools}) — upstream agent schema changed`
      );
    }
    const unmapped = (agent.tools || []).filter((t) => !TOOL_MAP[t]);
    if (unmapped.length) {
      throw new Error(
        `agent ${file} uses unmapped tool(s) [${unmapped.join(", ")}] — add them to TOOL_MAP`
      );
    }
    const tools = (agent.tools || []).map((t) => TOOL_MAP[t]).join(", ");
    const body = transformContent(agent.prompt || "");
    const md =
      "---\n" +
      `name: ${agent.name}\n` +
      `description: ${JSON.stringify(agent.description || "")}\n` +
      (tools ? `tools: ${tools}\n` : "") +
      "---\n\n" +
      body +
      "\n";
    fs.writeFileSync(path.join(agentsOut, `${agent.name}.md`), md);
    count++;
  }
  return count;
}

function buildHooks() {
  // Hooks are Claude-specific and authored under targets/claude/hooks/ (they
  // have no upstream src/ equivalent — upstream ships a Kiro .kiro.hook).
  const hooksSrc = path.join(SCRIPT_DIR, "hooks");
  if (!fs.existsSync(hooksSrc)) return 0;
  const hooksOut = path.join(OUT, "hooks");
  cpR(hooksSrc, hooksOut);
  // Ensure hook scripts stay executable after the copy.
  for (const sh of findFiles(hooksOut, (n) => n.endsWith(".sh"))) {
    fs.chmodSync(sh, 0o755);
  }
  return findFiles(hooksOut, (n) => n === "hooks.json").length;
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
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );
}

// --- Contract checks ---

// Precondition on src/: the layout must be exactly what the transform expects.
// Runs BEFORE any copy so a surprise stops the build before it produces output.
function checkSrcContract() {
  if (!fs.existsSync(SRC)) {
    throw new Error(`src/ not found at ${SRC} — run targets/claude/sync-upstream.sh first`);
  }
  const top = fs.readdirSync(SRC, { withFileTypes: true });
  const dirs = top.filter((e) => e.isDirectory()).map((e) => e.name);
  const files = top.filter((e) => e.isFile()).map((e) => e.name);
  const missing = REQUIRED_SRC_DIRS.filter((d) => !dirs.includes(d));
  const unexpectedDirs = dirs.filter((d) => !REQUIRED_SRC_DIRS.includes(d));
  if (missing.length) {
    throw new Error(
      `src/ is missing required dir(s) [${missing.join(", ")}] — upstream layout ` +
        `changed (rename?); update REQUIRED_SRC_DIRS and the build steps`
    );
  }
  if (unexpectedDirs.length) {
    throw new Error(
      `src/ has unexpected top-level dir(s) [${unexpectedDirs.join(", ")}] — upstream added ` +
        `content the adapter does not handle; decide whether to ship it, then update ` +
        `REQUIRED_SRC_DIRS and the build steps`
    );
  }
  // A new top-level FILE is just as much "unhandled" as a new dir — the build
  // steps only copy the three known dirs, so a stray file would be silently
  // dropped. Fail rather than ignore it.
  if (files.length) {
    throw new Error(
      `src/ has unexpected top-level file(s) [${files.join(", ")}] — the adapter only ` +
        `vendors the known dirs; decide how to handle these, then update the build steps`
    );
  }

  // Soft signals: warn (don't fail) on Kiro-only smells in src/ so a human looks.
  const smelt = new Set();
  for (const f of findFiles(SRC, (n) => n.endsWith(".md") || n.endsWith(".json"))) {
    const text = fs.readFileSync(f, "utf-8");
    for (const re of KIRO_SMELLS) {
      if (re.test(text)) smelt.add(`${path.relative(ROOT, f)} ~ ${re}`);
    }
  }
  if (smelt.size) {
    console.warn("  WARN: Kiro-specific markers present in src/ (review they are handled):");
    for (const s of smelt) console.warn(`        - ${s}`);
  }
}

// Postcondition invariant on dist/: if a forbidden Kiro construct still exists in
// src/, it must NOT appear in the shipped dist/ markdown. This is the key check —
// it catches the case where upstream rewords a construct and our regex silently
// stops matching, which would otherwise pass every output-shape check.
function checkDistInvariant() {
  let failures = 0;
  const distMd = findFiles(OUT, (n) => n.endsWith(".md"));
  for (const { label, re } of DIST_FORBIDDEN) {
    // Only enforce for constructs upstream still uses; if upstream dropped it
    // cleanly, absence in dist is correct and we don't demand a rewrite fired.
    const inSrc = findFiles(SRC, (n) => n.endsWith(".md") || n.endsWith(".json")).some(
      (f) => re.test(fs.readFileSync(f, "utf-8"))
    );
    if (!inSrc) continue;
    for (const f of distMd) {
      if (re.test(fs.readFileSync(f, "utf-8"))) {
        console.error(
          `  FAIL: ${path.relative(ROOT, f)} still contains ${label} — the adapter did ` +
            `not rewrite it (upstream wording likely changed). Update kiroToClaude().`
        );
        failures++;
      }
    }
  }
  return failures;
}

// Postcondition: the built plugin must actually CONTAIN its runtime entry points.
// Every "does it parse" check passes on whatever components happen to exist, so a
// rename/removal upstream could ship a plugin missing its orchestrator or agents
// while the build stays green. Assert the required components are present.
function checkRequiredComponents() {
  let failures = 0;
  const skillDirs = fs.existsSync(path.join(OUT, "skills"))
    ? fs.readdirSync(path.join(OUT, "skills"), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];
  for (const s of REQUIRED_SKILLS) {
    if (!skillDirs.includes(s)) {
      console.error(`  FAIL: required skill '${s}' missing from dist (upstream rename/removal?)`);
      failures++;
    } else if (!fs.existsSync(path.join(OUT, "skills", s, "SKILL.md"))) {
      // The directory existing isn't enough — a skill is invoked via its SKILL.md.
      // A renamed/removed SKILL.md leaves the dir present but the skill broken, so
      // assert the entry-point file itself (this is also what makes the T1 triage
      // t0Covers() claim honest for `skills/<required>/SKILL.md`).
      console.error(`  FAIL: required skill '${s}' has no SKILL.md (upstream renamed/removed the entry point?)`);
      failures++;
    }
  }
  if (skillDirs.length < MIN_SKILLS) {
    console.error(
      `  FAIL: only ${skillDirs.length} skills built (< ${MIN_SKILLS}) — upstream catalogue ` +
        `shrank or a copy failed; verify before shipping`
    );
    failures++;
  }
  const agentFiles = fs.existsSync(path.join(OUT, "agents"))
    ? fs.readdirSync(path.join(OUT, "agents")).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))
    : [];
  for (const a of REQUIRED_AGENTS) {
    if (!agentFiles.includes(a)) {
      console.error(`  FAIL: required agent '${a}' missing from dist (upstream rename/removal?)`);
      failures++;
    }
  }
  return failures;
}

// Postcondition for the process-checker JS: the .kiro→INSTALL_ROOT rewrite lives
// in buildCommon() and is NOT covered by checkDistInvariant (which scans only
// markdown). If upstream changes the .kiro path form (e.g. path.resolve(".kiro"),
// single quotes, a new path), the rewrite silently misses and a broken checker
// ships green. Enforce: if src/ has an operational .kiro path, dist/ must not.
function checkProcessCheckerKiro() {
  const rel = path.join("aidlc-common", "scripts", "aidlc-process-checker.js");
  const srcFile = path.join(SRC, rel);
  const distFile = path.join(OUT, rel);
  if (!fs.existsSync(srcFile) || !fs.existsSync(distFile)) return 0;
  // Operational .kiro path = ".kiro" used as a path segment in code (quoted),
  // not the word ".kiro/" inside an explanatory comment. Match a quoted ".kiro".
  const opKiro = /["']\.kiro["']/;
  if (!opKiro.test(fs.readFileSync(srcFile, "utf-8"))) return 0; // upstream dropped it cleanly
  if (opKiro.test(fs.readFileSync(distFile, "utf-8"))) {
    console.error(
      `  FAIL: ${path.relative(ROOT, distFile)} still has a quoted ".kiro" path — the ` +
        `.kiro→INSTALL_ROOT rewrite missed it (upstream changed the path form). ` +
        `Update the rewrite in buildCommon().`
    );
    return 1;
  }
  return 0;
}

// --- Validation ---

function validate() {
  let failures = 0;

  // The core source→dist invariant + presence of runtime entry points + the
  // process-checker .kiro rewrite postcondition.
  failures += checkDistInvariant();
  failures += checkRequiredComponents();
  failures += checkProcessCheckerKiro();

  // Every JSON file must parse.
  for (const f of findFiles(OUT, (n) => n.endsWith(".json"))) {
    try {
      JSON.parse(fs.readFileSync(f, "utf-8"));
    } catch {
      console.error(`  FAIL: invalid JSON: ${path.relative(ROOT, f)}`);
      failures++;
    }
  }

  // Every SKILL.md needs `name`; non-orchestrator stage skills also need
  // `phase` and `stage` (the orchestrator is a meta-skill, exempt).
  for (const f of findFiles(path.join(OUT, "skills"), (n) => n === "SKILL.md")) {
    const content = fs.readFileSync(f, "utf-8");
    const isOrchestrator = f.includes("aidlc-orchestrator");
    const required = isOrchestrator ? ["name"] : ["name", "phase", "stage"];
    for (const field of required) {
      if (!new RegExp(`^\\s*${field}:`, "m").test(content)) {
        console.error(`  FAIL: ${path.relative(ROOT, f)} missing frontmatter '${field}'`);
        failures++;
      }
    }

    // Interaction-flag FORMAT contract: the process-checker only recognises the
    // QUOTED-STRING form (`flag: "true"` / `flag: "false"` — see its regex). If
    // upstream switches to bare YAML booleans (`flag: true`), the checker silently
    // defaults the gate ON and runtime semantics change with a green build. Fail
    // here if any interaction flag is present but not quoted-string.
    for (const flag of INTERACTION_FLAGS) {
      const present = new RegExp(`^\\s*${flag}:`, "m").test(content);
      if (!present) continue;
      const valid = new RegExp(`^\\s*${flag}:\\s*"(true|false)"\\s*$`, "m").test(content);
      if (!valid) {
        console.error(
          `  FAIL: ${path.relative(ROOT, f)} flag '${flag}' is not the quoted-string ` +
            `form ("true"/"false") the process-checker requires — upstream changed the ` +
            `flag value format; update the checker's parser + this contract`
        );
        failures++;
      }
    }
  }

  // Every agent .md needs a name field.
  for (const f of findFiles(path.join(OUT, "agents"), (n) => n.endsWith(".md"))) {
    if (!/^\s*name:/m.test(fs.readFileSync(f, "utf-8"))) {
      console.error(`  FAIL: ${path.relative(ROOT, f)} missing frontmatter 'name'`);
      failures++;
    }
  }

  // Version single-source: the marketplace manifest must agree with package.json
  // (the source of truth) so the two never silently diverge after a release bump.
  const mkPath = path.join(ROOT, ".claude-plugin", "marketplace.json");
  if (fs.existsSync(mkPath)) {
    try {
      const mk = JSON.parse(fs.readFileSync(mkPath, "utf-8"));
      const entry = (mk.plugins || []).find((p) => p.name === PLUGIN_NAME);
      const ver = pluginVersion();
      if (entry && entry.version !== ver) {
        console.error(
          `  FAIL: marketplace.json ${PLUGIN_NAME} version '${entry.version}' != ` +
            `package.json '${ver}' — bump both together`
        );
        failures++;
      }
    } catch {
      console.error(`  FAIL: cannot parse ${path.relative(ROOT, mkPath)}`);
      failures++;
    }
  }

  // The process-checker must still syntax-check after the .kiro rewrite.
  const checker = path.join(OUT, "aidlc-common", "scripts", "aidlc-process-checker.js");
  if (fs.existsSync(checker)) {
    try {
      execFileSync("node", ["--check", checker], { stdio: "pipe" });
    } catch (e) {
      console.error(`  FAIL: process-checker syntax error: ${e.stderr || e.message}`);
      failures++;
    }
  }

  // `claude plugin validate` on the generated plugin manifest — wired as a real
  // gate, not a manual step. The Claude Code CLI validates plugin.json structure.
  // Resolution order: $CLAUDE_BIN, then `claude` on PATH. If neither resolves
  // (e.g. CI without Claude Code installed), SKIP with a WARN rather than fail —
  // the deterministic JSON/frontmatter checks above already cover structure; this
  // is an extra gate when the tool is available. Set AIDLC_REQUIRE_CLAUDE_VALIDATE=1
  // to turn a missing CLI into a hard failure (use in release CI that installs it).
  const claudeBin = process.env.CLAUDE_BIN || "claude";
  const requireValidate = process.env.AIDLC_REQUIRE_CLAUDE_VALIDATE === "1";
  let claudeAvailable = true;
  try {
    execFileSync(claudeBin, ["--version"], { stdio: "pipe" });
  } catch {
    claudeAvailable = false;
  }
  if (claudeAvailable) {
    // Validate BOTH manifests: the generated plugin (dist/claude/.claude-plugin/
    // plugin.json) AND the repo's marketplace manifest (./.claude-plugin/
    // marketplace.json). `claude plugin validate <dir>` picks whichever manifest
    // the dir contains, so we run it against both OUT and ROOT.
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
      `  FAIL: 'claude' CLI not found (CLAUDE_BIN or PATH) and ` +
        `AIDLC_REQUIRE_CLAUDE_VALIDATE=1 — cannot run 'claude plugin validate'`
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

  // Precondition: src/ must match the shape the transform expects. Throws (and
  // aborts the build) on any surprise, before producing output.
  checkSrcContract();

  rmrf(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  const skillCount = buildSkills();
  buildCommon();
  const agentCount = buildAgents();
  const hookCount = buildHooks();
  buildManifest();

  console.log("Validating ...");
  const failures = validate();
  if (failures > 0) {
    console.error(`\n${failures} validation failure(s). Build aborted.`);
    process.exit(1);
  }

  // Build report — surfaces transform coverage so a sync reviewer can sanity-check
  // that the adapter actually did work (e.g. 0 primitives rewritten when src/ has
  // Kiro text is a red flag worth a look, even if the invariant check passed).
  console.log("Build report:");
  console.log(`  skills copied .............. ${skillCount}`);
  console.log(`  agents converted ........... ${agentCount}`);
  console.log(`  hook configs ............... ${hookCount}`);
  console.log(`  framework paths anchored ... ${STATS.pathsAnchored}`);
  console.log(`  Kiro primitives rewritten .. ${STATS.kiroPrimitivesRewritten}`);
  console.log(`  Kiro hook notes rewritten .. ${STATS.kiroJoinsRewritten}`);
  console.log(`  → dist/claude/  (plugin '${PLUGIN_NAME}' v${pluginVersion()})`);
}

// Only run the build when executed directly (node build.mjs ...), NOT when this
// module is imported for its exported constants/transform (e.g. by the T1 triage
// tool). Compares the entrypoint to this module's path.
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
