#!/usr/bin/env bun
// aidlc-install.ts — install or update the AI-DLC framework into a project.
//
// Ships inside the aidlc-v2 Claude Code plugin next to framework/, which is a
// VERBATIM copy of upstream awslabs/aidlc-workflows' own built Claude target
// (dist/claude: .claude/, .mcp.json, .gitignore, aidlc/). Upstream's engine
// requires that tree at the PROJECT root (its hooks and tools resolve framework
// paths under the project dir), so this installer performs upstream's
// documented "copy the workspace shell into your project root" — with merge
// rules that make it safe for projects that already have .claude/settings.json,
// .mcp.json or .gitignore, and idempotent on re-run.
//
// Placement rules:
//   .claude/**      framework-owned, EXCEPT settings.json → deep-merge.
//                   FRESH INSTALL: an existing file that differs is a CONFLICT —
//                   left untouched, reported, exit 3 (never silently replaced).
//                   UPDATE (a version marker proves an AI-DLC install): payload
//                   files are refreshed; every differing overwrite is listed.
//   .mcp.json       copy if absent; else add missing mcpServers entries only
//   .gitignore      copy if absent; else append the AI-DLC block if its marker is absent
//   aidlc/**        seed only — copy files that do not exist; NEVER overwrite user state
//   (never touches .claude/settings.local.json; never deletes anything)
//
// Write safety: the installer never writes through a symlink — a symlinked
// target file, or a path whose real directory resolves outside the project, is
// reported as a conflict and left untouched.
//
// Exit codes: 0 = success; 1 = error; 3 = completed with CONFLICTS (install
// incomplete until the listed files are resolved and the installer re-run).
//
// Usage:  bun aidlc-install.ts [--project <dir>] [--check]
//   --project <dir>  target project root (default: cwd)
//   --check          report what would change, write nothing

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PAYLOAD = path.resolve(SCRIPT_DIR, "..", "framework");

// Must match GITIGNORE_BLOCK_MARKER in the plugin build — the first line of the
// AI-DLC section of upstream's .gitignore.
const GITIGNORE_BLOCK_MARKER = "# AI-DLC —";

function die(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// --- args ---
let projectDir = process.cwd();
let checkOnly = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--project") {
    projectDir = path.resolve(argv[++i] ?? die("--project needs a value"));
  } else if (argv[i] === "--check") {
    checkOnly = true;
  } else {
    die(`unknown argument '${argv[i]}' (usage: bun aidlc-install.ts [--project <dir>] [--check])`);
  }
}

if (!fs.existsSync(PAYLOAD)) die(`payload not found at ${PAYLOAD} — broken plugin install?`);
if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
  die(`project dir does not exist: ${projectDir}`);
}
// Refuse to install into the plugin itself (or the payload) — a plugin cache
// directory is not a project.
const resolvedProject = fs.realpathSync(projectDir);
const resolvedPluginRoot = fs.realpathSync(path.resolve(SCRIPT_DIR, ".."));
if (resolvedProject === resolvedPluginRoot || resolvedProject.startsWith(resolvedPluginRoot + path.sep)) {
  die("refusing to install into the plugin's own directory — pass --project <your project root>");
}

// --- version detection ---
const VERSION_MARKER_REL = path.join(".claude", "tools", "aidlc-version.ts");
function readVersion(root: string): string | null {
  const file = path.join(root, VERSION_MARKER_REL);
  if (!fs.existsSync(file)) return null;
  const m = fs.readFileSync(file, "utf-8").match(/export const AIDLC_VERSION = "([^"]+)"/);
  return m ? m[1] : null;
}
const payloadVersion = readVersion(PAYLOAD) ?? die("cannot read framework version from payload");
const installedVersion = readVersion(projectDir);
// Fresh install = no AI-DLC version marker in the project. This gates the
// overwrite policy: only an UPDATE may refresh existing framework files. The
// marker is therefore the COMPLETION SEAL: it is written/advanced LAST, and only
// by a conflict-free run — otherwise a conflicted fresh install would mint the
// marker, and the next run would masquerade as an update and silently overwrite
// the very files the conflict protection had refused to touch.
const freshInstall = installedVersion === null;

// --- plan/apply plumbing ---
const stats = { created: 0, updated: 0, seeded: 0, merged: 0, unchanged: 0, skipped: 0 };
const notes: string[] = [];
const conflicts: { rel: string; why: string }[] = [];
const refreshed: string[] = []; // update-mode overwrites of DIFFERING files — never silent
let settingsTouched = false;

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

// Write-safety guard. Returns null when it is safe to write `to`, else the
// reason it is not. Never writes through a symlink: a symlinked target file, or
// a parent directory whose realpath escapes the project (a symlinked dir), is
// refused. In --check mode parent dirs may not exist yet — the check walks the
// nearest existing ancestor instead of creating anything.
function unsafeToWrite(to: string): string | null {
  try {
    if (fs.lstatSync(to).isSymbolicLink()) return "target is a symlink — refusing to write through it";
  } catch {
    /* target does not exist — fine */
  }
  let dir = path.dirname(to);
  while (!fs.existsSync(dir)) dir = path.dirname(dir); // nearest existing ancestor
  const rp = fs.realpathSync(dir);
  if (rp !== resolvedProject && !rp.startsWith(resolvedProject + path.sep)) {
    return `parent directory resolves outside the project (${rp}) — symlinked directory?`;
  }
  return null;
}

// Perform a guarded write. Returns false (and records a conflict) if unsafe.
function guardedWrite(rel: string, write: () => void): boolean {
  const to = path.join(projectDir, rel);
  const unsafe = unsafeToWrite(to);
  if (unsafe) {
    conflicts.push({ rel, why: unsafe });
    return false;
  }
  if (!checkOnly) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    write();
  }
  return true;
}

// Copy a payload file to the project. mode: "own" = framework-owned (created
// freely; on UPDATE an existing differing file is refreshed; on FRESH INSTALL
// an existing differing file is a CONFLICT), "seed" = write only when absent.
function place(rel: string, mode: "own" | "seed") {
  const from = path.join(PAYLOAD, rel);
  const to = path.join(projectDir, rel);
  let exists = false;
  let isSymlink = false;
  try {
    const st = fs.lstatSync(to);
    exists = true;
    isSymlink = st.isSymbolicLink();
  } catch {
    /* absent */
  }
  if (exists) {
    if (mode === "seed") {
      stats.skipped++;
      return;
    }
    if (isSymlink) {
      conflicts.push({ rel, why: "existing file is a symlink — refusing to write through it" });
      return;
    }
    if (fs.readFileSync(from).equals(fs.readFileSync(to))) {
      stats.unchanged++;
      return;
    }
    if (freshInstall) {
      // A file we did not install differs from the framework's — the user's
      // data. Never replace it silently; surface and let the human resolve.
      conflicts.push({ rel, why: "existing file differs from the framework's (pre-existing user file)" });
      return;
    }
    if (guardedWrite(rel, () => fs.copyFileSync(from, to))) {
      stats.updated++;
      refreshed.push(rel);
    }
  } else {
    if (guardedWrite(rel, () => fs.copyFileSync(from, to))) {
      if (mode === "seed") stats.seeded++;
      else stats.created++;
    }
  }
}

// --- settings.json deep-merge ---
// Additive and user-preserving: hooks/permission entries are ADDED if missing;
// scalar keys (model, effortLevel, statusLine, env vars, announcements) are set
// only when the user has no value. Nothing the user wrote is changed.
function mergeSettings() {
  const rel = path.join(".claude", "settings.json");
  const from = path.join(PAYLOAD, rel);
  const to = path.join(projectDir, rel);
  const payloadSettings = JSON.parse(fs.readFileSync(from, "utf-8"));
  let exists = false;
  let isSymlink = false;
  try {
    const st = fs.lstatSync(to);
    exists = true;
    isSymlink = st.isSymbolicLink();
  } catch {
    /* absent */
  }
  if (isSymlink) {
    conflicts.push({ rel, why: "settings.json is a symlink — refusing to merge through it" });
    return;
  }
  if (!exists) {
    if (guardedWrite(rel, () => fs.copyFileSync(from, to))) {
      stats.created++;
      settingsTouched = true;
    }
    return;
  }
  let user: any;
  try {
    user = JSON.parse(fs.readFileSync(to, "utf-8"));
  } catch {
    die(`${to} is not valid JSON — fix it (or move it aside) and re-run; refusing to overwrite it`);
  }
  const added: string[] = [];

  // hooks: per event, per matcher-group, per command — add what's missing.
  user.hooks ??= {};
  for (const [event, groups] of Object.entries(payloadSettings.hooks ?? {}) as [string, any[]][]) {
    if (!Array.isArray(user.hooks[event])) user.hooks[event] = [];
    for (const group of groups) {
      const existing = user.hooks[event].find((g: any) => (g.matcher ?? "") === (group.matcher ?? ""));
      if (!existing) {
        user.hooks[event].push(group);
        added.push(`hooks.${event}[matcher=${JSON.stringify(group.matcher ?? "")}]`);
        continue;
      }
      existing.hooks ??= [];
      for (const h of group.hooks ?? []) {
        if (!existing.hooks.some((eh: any) => eh.command === h.command)) {
          existing.hooks.push(h);
          added.push(`hooks.${event}: ${h.command}`);
        }
      }
    }
  }

  // permissions.allow: union.
  const payloadAllow: string[] = payloadSettings.permissions?.allow ?? [];
  user.permissions ??= {};
  user.permissions.allow ??= [];
  for (const p of payloadAllow) {
    if (!user.permissions.allow.includes(p)) {
      user.permissions.allow.push(p);
      added.push(`permissions.allow: ${p}`);
    }
  }

  // env: per-key set-if-absent.
  user.env ??= {};
  for (const [k, v] of Object.entries(payloadSettings.env ?? {})) {
    if (!(k in user.env)) {
      user.env[k] = v;
      added.push(`env.${k}`);
    }
  }

  // Scalars/objects: set only if the user has none.
  for (const key of ["companyAnnouncements", "statusLine", "model", "effortLevel"]) {
    if (payloadSettings[key] !== undefined && user[key] === undefined) {
      user[key] = payloadSettings[key];
      added.push(key);
    }
  }

  if (added.length) {
    if (guardedWrite(rel, () => fs.writeFileSync(to, JSON.stringify(user, null, 2) + "\n"))) {
      stats.merged++;
      settingsTouched = true;
      notes.push(`settings.json: merged ${added.length} entr${added.length === 1 ? "y" : "ies"} (${added.slice(0, 4).join("; ")}${added.length > 4 ? "; …" : ""})`);
    }
  } else {
    stats.unchanged++;
  }
}

// --- .mcp.json: add missing servers only ---
function mergeMcp() {
  const rel = ".mcp.json";
  const from = path.join(PAYLOAD, rel);
  const to = path.join(projectDir, rel);
  const payloadMcp = JSON.parse(fs.readFileSync(from, "utf-8"));
  let exists = false;
  let isSymlink = false;
  try {
    const st = fs.lstatSync(to);
    exists = true;
    isSymlink = st.isSymbolicLink();
  } catch {
    /* absent */
  }
  if (isSymlink) {
    conflicts.push({ rel, why: ".mcp.json is a symlink — refusing to merge through it" });
    return;
  }
  if (!exists) {
    if (guardedWrite(rel, () => fs.copyFileSync(from, to))) {
      stats.created++;
      settingsTouched = true;
    }
    return;
  }
  let user: any;
  try {
    user = JSON.parse(fs.readFileSync(to, "utf-8"));
  } catch {
    notes.push(".mcp.json exists but is not valid JSON — left untouched; add upstream's servers by hand");
    stats.skipped++;
    return;
  }
  user.mcpServers ??= {};
  const added: string[] = [];
  for (const [name, cfg] of Object.entries(payloadMcp.mcpServers ?? {})) {
    if (!(name in user.mcpServers)) {
      user.mcpServers[name] = cfg;
      added.push(name);
    }
  }
  if (added.length) {
    if (guardedWrite(rel, () => fs.writeFileSync(to, JSON.stringify(user, null, 2) + "\n"))) {
      stats.merged++;
      settingsTouched = true;
      notes.push(`.mcp.json: added server(s) ${added.join(", ")}`);
    }
  } else {
    stats.unchanged++;
  }
}

// --- .gitignore: append the AI-DLC block if absent ---
function mergeGitignore() {
  const rel = ".gitignore";
  const from = path.join(PAYLOAD, rel);
  const to = path.join(projectDir, rel);
  const payloadText = fs.readFileSync(from, "utf-8");
  let exists = false;
  let isSymlink = false;
  try {
    const st = fs.lstatSync(to);
    exists = true;
    isSymlink = st.isSymbolicLink();
  } catch {
    /* absent */
  }
  if (isSymlink) {
    conflicts.push({ rel, why: ".gitignore is a symlink — refusing to write through it" });
    return;
  }
  if (!exists) {
    if (guardedWrite(rel, () => fs.copyFileSync(from, to))) stats.created++;
    return;
  }
  const userText = fs.readFileSync(to, "utf-8");
  if (userText.includes(GITIGNORE_BLOCK_MARKER)) {
    stats.unchanged++;
    return;
  }
  const idx = payloadText.indexOf(GITIGNORE_BLOCK_MARKER);
  if (idx < 0) die("payload .gitignore lost its AI-DLC marker — plugin build contract should have caught this");
  const block = payloadText.slice(idx);
  if (guardedWrite(rel, () => fs.writeFileSync(to, userText.replace(/\n*$/, "\n\n") + block))) {
    stats.merged++;
    notes.push(".gitignore: appended the AI-DLC ignore block");
  }
}

// --- run ---
const mode = freshInstall ? "install" : installedVersion === payloadVersion ? "verify" : "update";
console.log(`AI-DLC ${payloadVersion} ${checkOnly ? "(check only) " : ""}→ ${projectDir}`);
if (mode === "update") console.log(`Updating existing install: ${installedVersion} → ${payloadVersion}`);
if (mode === "verify") console.log(`Already at ${payloadVersion} — verifying files.`);

for (const rel of listFiles(path.join(PAYLOAD, ".claude"), PAYLOAD)) {
  if (rel === path.join(".claude", "settings.json")) continue; // merged below
  if (rel === VERSION_MARKER_REL) continue; // completion seal — written last, see below
  place(rel, "own");
}
mergeSettings();
mergeMcp();
mergeGitignore();
for (const rel of listFiles(path.join(PAYLOAD, "aidlc"), PAYLOAD)) {
  place(rel, "seed");
}
// The completion seal: write/advance the version marker ONLY when this run had
// no conflicts, so a conflicted install keeps re-running in its original mode
// (and keeps protecting the same files) until the human resolves the conflicts.
if (conflicts.length === 0) {
  place(VERSION_MARKER_REL, "own");
}

console.log(
  `${checkOnly ? "Would change" : "Done"}: ${stats.created} created, ${stats.updated} updated, ` +
    `${stats.merged} merged, ${stats.seeded} seeded, ${stats.unchanged} unchanged, ${stats.skipped} kept (user-owned)`
);
for (const n of notes) console.log(`  - ${n}`);
if (refreshed.length) {
  console.log(`Refreshed framework files that had local differences (framework files are not meant to be hand-edited;`);
  console.log(`method/rules belong in aidlc/spaces/<space>/memory/):`);
  for (const r of refreshed) console.log(`  ~ ${r}`);
}

if (conflicts.length) {
  console.log(`\nCONFLICTS — ${checkOnly ? "would be " : ""}left untouched (${conflicts.length}):`);
  for (const c of conflicts) console.log(`  ! ${c.rel} — ${c.why}`);
  console.log(`
The install is INCOMPLETE until these are resolved: for each file, either move it
aside (the framework needs its own version at that path) or keep yours knowingly.
Then re-run the installer. Nothing was deleted or overwritten, and the framework
version marker was withheld — re-runs keep protecting these same files until the
conflicts are resolved.`);
  process.exit(3);
}

if (checkOnly) process.exit(0);

if (mode === "install") {
  console.log(`
Next steps:
  1. RESTART your Claude Code session — .claude/settings.json (hooks, permissions,
     model/env defaults) loads at session start.
  2. Then run /aidlc followed by what you want to build (scope is auto-detected),
     or /aidlc --doctor to validate the setup.
  3. Commit the aidlc/ workspace tree and .claude/ — they are designed to be
     version-controlled (per-user cursors are already gitignored).
Personal overrides (model, AWS_REGION, …): copy .claude/settings.local.json.example
to .claude/settings.local.json (gitignored).`);
} else if (stats.created + stats.updated + stats.merged > 0) {
  console.log(
    settingsTouched
      ? "\nRestart your Claude Code session to pick up settings changes, then run /aidlc."
      : "\nFramework files refreshed. Run /aidlc to continue."
  );
} else {
  console.log("\nEverything up to date. Run /aidlc to start or resume a workflow.");
}
