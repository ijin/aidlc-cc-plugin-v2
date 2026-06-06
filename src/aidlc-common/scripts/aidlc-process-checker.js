#!/usr/bin/env node
/**
 * =============================================================================
 * aidlc-process-checker.js — Deterministic enforcement for agent-driven mode.
 * =============================================================================
 *
 * WHAT THIS DOES:
 *   Called by the orchestrator after every step. Inspects the filesystem to
 *   verify that the expected work actually happened. Returns structured JSON
 *   so the orchestrator can act on the result programmatically.
 *
 * WHY IT EXISTS:
 *   In agent-driven mode, the orchestrator LLM drives the flow directly.
 *   It could skip the validator, ignore a failure, or advance without
 *   completing a step. This script is the single enforcement point —
 *   it verifies what's on disk matches what should have happened.
 *
 *   For validation specifically, it cross-checks the validator's report:
 *   every script in the skill's scripts/ directory must appear in the
 *   report's TOOLS line, and every rule number in validation-spec.md must
 *   appear in the RULES line. The script execution itself is the validator's
 *   job — process_checker confirms coverage, not re-runs results.
 *
 * USAGE:
 *   node aidlc-process-checker.js --from-state <checkpoint-path>
 *
 *   checkpoint-path: path to process-checkpoint.json
 *                    Convention: <intent-dir>/state/process-checkpoint.json
 *
 *   On first run (no checkpoint exists), reads workflow.md from the intent
 *   directory to initialize the stage list and starts from setup.
 *   On subsequent runs, reads the checkpoint to know what to check next.
 *
 * EXIT CODES:
 *   0 — PASS (all checks passed)
 *   1 — FAIL (one or more checks failed)
 *   2 — ERROR (invalid arguments, missing paths)
 *
 * OUTPUT:
 *   JSON to stdout:
 *   {
 *     "skill": "requirements-analysis",
 *     "step": "validation",
 *     "status": "PASS" | "FAIL",
 *     "failures": ["description of each failure"],
 *     "details": ["description of each check that passed"]
 *   }
 *
 * =============================================================================
 */

const fs = require("fs");
const path = require("path");

// =============================================================================
// STEP SEQUENCE
// The valid step order within a skill. Process_checker uses this to infer
// what the next expected step should be when running in checkpoint mode.
// =============================================================================

const STEP_SEQUENCE = [
  "setup",
  "clarification",
  "planning",
  "execution",
  "validation",
  "verification",
  "skill-complete",
];

function nextStep(currentStep) {
  const idx = STEP_SEQUENCE.indexOf(currentStep);
  if (idx === -1 || idx >= STEP_SEQUENCE.length - 1) return null;
  return STEP_SEQUENCE[idx + 1];
}

// =============================================================================
// SKILL FLAG LOOKUP
// Reads a flag from the skill's SKILL.md frontmatter.
// Returns true if the flag is "true" or absent (default true per CATALOGUE.md);
// returns false only when the frontmatter explicitly says "false".
//
// Skills live at `<root>/skills/aidlc-<stage-name>/SKILL.md`, where `<root>`
// is the install root determined from this script's own location:
//   <root>/aidlc-common/scripts/aidlc-process-checker.js  ← this file
//   <root>/skills/aidlc-<stage-name>/SKILL.md             ← target
// This makes the lookup cwd-independent and tool-agnostic — Kiro installs at
// `.kiro/`, Claude at `.claude/`, etc., and the same code works for all.
// =============================================================================

const INSTALL_ROOT = path.resolve(__dirname, "..", "..");

function readSkillFrontmatterFlag(stageName, flagName) {
  const skillPath = path.join(
    INSTALL_ROOT,
    "skills",
    `aidlc-${stageName}`,
    "SKILL.md"
  );
  if (!fs.existsSync(skillPath)) return true; // default: keep the gate
  const content = fs.readFileSync(skillPath, "utf-8");
  // Match `<flagName>: "true"` or `<flagName>: "false"` inside the frontmatter.
  const re = new RegExp(`^\\s*${flagName}:\\s*"(true|false)"\\s*$`, "m");
  const m = content.match(re);
  if (!m) return true;
  return m[1] === "true";
}

/**
 * Step advancement that respects per-skill flags.
 * - When advancing from `clarification` and `plan-creation: "false"`,
 *   skip `planning` and jump straight to `execution`.
 * - When advancing from `validation` and `artefact-verification: "false"`,
 *   skip `verification` and jump straight to `skill-complete`.
 * - Otherwise behaves like nextStep().
 */
function nextStepForSkill(currentStep, stageName) {
  if (currentStep === "clarification") {
    const planCreation = readSkillFrontmatterFlag(stageName, "plan-creation");
    if (!planCreation) return "execution";
  }
  if (currentStep === "validation") {
    const artefactVerification = readSkillFrontmatterFlag(
      stageName,
      "artefact-verification"
    );
    if (!artefactVerification) return "skill-complete";
  }
  return nextStep(currentStep);
}

// =============================================================================
// CHECKPOINT READ/WRITE
// The checkpoint file tracks what process_checker last verified.
// Written only by process_checker. Read by the orchestrator.
// =============================================================================

function readCheckpoint(checkpointPath) {
  if (!fs.existsSync(checkpointPath)) return null;
  const content = fs.readFileSync(checkpointPath, "utf-8");
  return JSON.parse(content);
}

function writeCheckpoint(checkpointPath, data) {
  fs.writeFileSync(checkpointPath, JSON.stringify(data, null, 2) + "\n");
}

// =============================================================================
// WORKFLOW PARSING
// Reads the workflow file to get the ordered list of stages.
// Used by checkpoint mode to initialize on first run.
// =============================================================================

function parseWorkflowFile(workflowPath) {
  if (!fs.existsSync(workflowPath)) return [];
  const content = fs.readFileSync(workflowPath, "utf-8");
  const stages = [];
  for (const line of content.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const parts = line.trim().split(/\s+/);
    const stageName = parts[0];
    let unit = null;
    let scope = null;
    let phase = "inception";
    // --unit implies construction phase and sets the unit name
    if (parts.includes("--unit")) {
      const unitIdx = parts.indexOf("--unit");
      unit = parts[unitIdx + 1] || null;
      phase = "construction";
    }
    // --scope namespaces within the skill's phase (e.g. reverse-engineering per repo)
    if (parts.includes("--scope")) {
      const scopeIdx = parts.indexOf("--scope");
      scope = parts[scopeIdx + 1] || null;
    }
    // --phase explicitly sets the phase (e.g. bootstrap, operations).
    // Mutually exclusive with --unit; if both appear, --unit wins.
    if (parts.includes("--phase") && !unit) {
      const phaseIdx = parts.indexOf("--phase");
      phase = parts[phaseIdx + 1] || phase;
    }
    stages.push({ skill: stageName, phase, unit, scope });
  }
  return stages;
}

// =============================================================================
// ARGUMENT PARSING — CHECKPOINT MODE ONLY
// =============================================================================

const args = process.argv.slice(2);
let intentDir, stageName, expectedStep, rulesDir, phase, unitName, scopeName, stateKey;
let checkpointPath = null;

if (args[0] !== "--from-state" || !args[1]) {
  console.error("Usage: node aidlc-process-checker.js --from-state <checkpoint-path>");
  process.exit(2);
}

checkpointPath = args[1];
const checkpoint = readCheckpoint(checkpointPath);

if (!checkpoint) {
  // First run — no checkpoint exists yet.
  // Convention: checkpoint is at <intent-dir>/state/process-checkpoint.json
  // Workflow is at <intent-dir>/workflow.md
  const stateDir = path.dirname(checkpointPath);
  intentDir = path.dirname(stateDir);
  const workflowPath = path.join(intentDir, "workflow.md");
  rulesDir = "rules"; // default

  const workflowStages = parseWorkflowFile(workflowPath);
  if (workflowStages.length === 0) {
    console.error("No checkpoint and no workflow file found. Cannot initialize.");
    process.exit(2);
  }

  // Initialize: first skill, first step
  const first = workflowStages[0];
  stageName = first.skill;
  phase = first.phase;
  unitName = first.unit;
  scopeName = first.scope || null;
  expectedStep = "setup";
  stateKey = unitName ? `${stageName}:${unitName}` : scopeName ? `${stageName}:${scopeName}` : stageName;

  // Write initial checkpoint
  writeCheckpoint(checkpointPath, {
    workflow: workflowStages,
    intentDir,
    rulesDir,
    current: {
      skill: stageName,
      phase,
      unit: unitName,
      scope: scopeName,
      step: "setup",
      status: "pending",
    },
    next: { step: "setup" },
    error: null,
  });
} else {
  // Subsequent run — read from checkpoint
  intentDir = checkpoint.intentDir;
  rulesDir = checkpoint.rulesDir;

  // Re-read workflow.md from disk so any lines appended by
  // workflow-composition (or manual edits) are picked up. The workflow file
  // is the source of truth; the checkpoint just caches the intent/rules
  // paths and the current cursor.
  const workflowPath = path.join(intentDir, "workflow.md");
  const refreshedWorkflow = parseWorkflowFile(workflowPath);
  if (refreshedWorkflow.length > 0) {
    checkpoint.workflow = refreshedWorkflow;
  }

  const current = checkpoint.current;
  stageName = current.skill;
  phase = current.phase;
  unitName = current.unit;
  scopeName = current.scope || null;
  stateKey = unitName ? `${stageName}:${unitName}` : scopeName ? `${stageName}:${scopeName}` : stageName;

  // The step to check is whatever "next" says
  if (checkpoint.next && checkpoint.next.step) {
    expectedStep = checkpoint.next.step;
  } else {
    // Current skill is complete — find the next skill in the workflow
    const workflow = checkpoint.workflow || [];
    const currentIdx = workflow.findIndex(
      (s) => s.skill === stageName && s.unit === unitName && (s.scope || null) === scopeName
    );
    if (currentIdx >= 0 && currentIdx < workflow.length - 1) {
      const nextStage = workflow[currentIdx + 1];
      stageName = nextStage.skill;
      phase = nextStage.phase;
      unitName = nextStage.unit;
      scopeName = nextStage.scope || null;
      stateKey = unitName ? `${stageName}:${unitName}` : scopeName ? `${stageName}:${scopeName}` : stageName;
      expectedStep = "clarification";
    } else {
      // All skills complete
      console.log(JSON.stringify({
        skill: stageName,
        step: "all-complete",
        status: "PASS",
        failures: [],
        details: ["All skills in workflow are complete"],
      }, null, 2));
      process.exit(0);
    }
  }
}

// =============================================================================
// PATH RESOLUTION
// All paths derived from the arguments. Convention-based — matches the
// folder structure defined in aidlc-common/conventions/aidlc-folder-structure.md.
//
// inception:     inception/<skill>/
// construction:  construction/<unit>/<skill>/
// operations:    operations/<skill>/  (placeholder — not yet defined)
//
// The state key is <skill> for inception/operations, <skill>:<unit> for construction.
// (The variable name `stageName` is historical; today it holds the skill name.)
// =============================================================================

const stateFile = path.join(intentDir, "state", "intent-state.md");
const auditFile = path.join(intentDir, "audit", "intent-audit.md");

let stageOutputDir;
if (phase === "construction") {
  stageOutputDir = path.join(intentDir, "construction", unitName, stageName);
} else if (phase === "bootstrap") {
  stageOutputDir = path.join(intentDir, "bootstrap", stageName);
} else if (phase === "operations") {
  stageOutputDir = path.join(intentDir, "operations", stageName);
} else if (scopeName) {
  stageOutputDir = path.join(intentDir, "inception", stageName, scopeName);
} else {
  stageOutputDir = path.join(intentDir, "inception", stageName);
}
const questionsFile = path.join(stageOutputDir, `${stageName}-questions.md`);
const planFile = path.join(stageOutputDir, `${stageName}-plan.md`);
const validationResultFile = path.join(
  stageOutputDir,
  `${stageName}-validation-result.md`
);
// Skill folders are prefixed `aidlc-` while the state key uses the bare
// stage name. Translate here when constructing skill-folder paths.
const skillFolder = `aidlc-${stageName}`;
const toolsDir = path.join(".kiro", "skills", skillFolder, "scripts");
const validationSpecFile = path.join(
  ".kiro",
  "skills",
  skillFolder,
  "validation-spec.md"
);

// =============================================================================
// RESULT COLLECTORS
// Failures cause a FAIL exit. Details are informational (passed checks).
// =============================================================================

const failures = [];
const details = [];

function addDetail(msg) {
  details.push(msg);
}

function addFailure(msg) {
  failures.push(msg);
}

// =============================================================================
// FILE HELPERS
// =============================================================================

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

/** Returns true if the file exists AND has content (size > 0 bytes). */
function fileNonEmpty(filePath) {
  if (!fileExists(filePath)) return false;
  const stat = fs.statSync(filePath);
  return stat.size > 0;
}

// =============================================================================
// STATE FILE PARSING
// Reads intent-state.md and extracts the row for the current stage.
// The state table has columns: Stage | Step | Status | Attempt | Artifacts
// =============================================================================

function parseStateFile() {
  if (!fileExists(stateFile)) return null;
  const content = fs.readFileSync(stateFile, "utf-8");
  const lines = content.split("\n");
  for (const line of lines) {
    // Match using stateKey (e.g., "requirements-analysis" or "functional-design:auth-service")
    if (line.includes(`| ${stateKey} `)) {
      const cols = line
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cols.length >= 4) {
        return {
          stage: cols[0],
          step: cols[1],
          status: cols[2],
          attempt: parseInt(cols[3], 10),
          // Artifacts column: comma-separated paths, or "—" if none
          artifacts:
            cols[4] && cols[4] !== "—"
              ? cols[4].split(",").map((a) => a.trim())
              : [],
        };
      }
    }
  }
  return null;
}

// =============================================================================
// VALIDATION RESULT PARSING
// Reads the validator's report and extracts the machine-readable block at the
// end of the file. The block has fixed delimiters and plain text format:
//
//   ---PROCESS-CHECK-DATA---
//   STATUS: PASS
//   TOOLS: verify-structure.sh,check-coverage.py
//   RULES: 1,2,3,4,5
//   ---END-PROCESS-CHECK-DATA---
//
// This avoids fragile markdown parsing — the LLM can format the human-readable
// part however it wants.
// =============================================================================

function parseValidationResult() {
  if (!fileExists(validationResultFile)) return null;
  const content = fs.readFileSync(validationResultFile, "utf-8");
  const result = {
    status: null,
    rulesChecked: [],
    toolsInvoked: [],
    raw: content,
  };

  // Extract the machine-readable block between delimiters
  const blockMatch = content.match(
    /---PROCESS-CHECK-DATA---([\s\S]*?)---END-PROCESS-CHECK-DATA---/
  );

  if (blockMatch) {
    const block = blockMatch[1].trim();
    const lines = block.split("\n").map((l) => l.trim());

    for (const line of lines) {
      if (line.startsWith("STATUS:")) {
        result.status = line.replace("STATUS:", "").trim().toLowerCase();
      } else if (line.startsWith("TOOLS:")) {
        const toolsStr = line.replace("TOOLS:", "").trim();
        if (toolsStr !== "none") {
          result.toolsInvoked = toolsStr.split(",").map((t) => t.trim());
        }
      } else if (line.startsWith("RULES:")) {
        const rulesStr = line.replace("RULES:", "").trim();
        result.rulesChecked = rulesStr
          .split(",")
          .map((r) => parseInt(r.trim(), 10))
          .filter((r) => !isNaN(r));
      }
    }
  } else {
    // Fallback: try to find status anywhere in the file (loose matching)
    const statusMatch = content.match(/\bstatus\b[:\s]*(pass|fail)/i);
    if (statusMatch) {
      result.status = statusMatch[1].toLowerCase();
    }
  }

  return result;
}

// =============================================================================
// TOOL AND RULE DISCOVERY
// Reads the skill's scripts/ directory and validation-spec.md to know what
// the validator should have run and checked.
// =============================================================================

/** Returns list of executable script filenames in the skill's scripts/ directory.
 *  Returns an empty list if the directory does not exist (scripts are optional). */
function getToolScripts() {
  if (!fileExists(toolsDir)) return [];
  const files = fs.readdirSync(toolsDir);
  return files.filter(
    (f) =>
      f !== ".gitkeep" &&
      (f.endsWith(".sh") || f.endsWith(".py") || f.endsWith(".js"))
  );
}

/** Counts numbered rules in validation-spec.md (lines starting with "N."). */
function getValidationRuleCount() {
  if (!fileExists(validationSpecFile)) return 0;
  const content = fs.readFileSync(validationSpecFile, "utf-8");
  const ruleMatches = content.match(/^\d+\./gm);
  return ruleMatches ? ruleMatches.length : 0;
}

// =============================================================================
// STEP-SPECIFIC CHECKS
// Each function verifies the expected state of the filesystem after a
// particular step has completed. Called based on the expected-step argument.
// =============================================================================

/**
 * SETUP CHECK
 * Verifies the initial setup is complete: state file and audit file exist.
 * Called once before the first stage begins.
 */
function checkSetup() {
  if (!fileNonEmpty(stateFile)) addFailure("State file missing or empty");
  else addDetail("State file exists");

  if (!fileNonEmpty(auditFile)) addFailure("Audit file missing or empty");
  else addDetail("Audit file exists");
}

/**
 * CLARIFICATION CHECK
 * Verifies the clarification step completed correctly:
 * - State shows a valid clarification status
 * - Questions file exists when it should (awaiting-human, follow-up, complete)
 * - Answers are present when status is "complete"
 */
function checkClarification() {
  const state = parseStateFile();
  if (!state) {
    addFailure("No state entry for stage " + stageName);
    return;
  }

  // The builder may transition directly from clarification to planning in a
  // single invocation (if answers are clear, it proceeds to create the plan).
  // So finding the state at planning:* is also valid — it means clarification
  // succeeded and the builder moved on.
  // When the skill has plan-creation: "false", the builder skips planning
  // entirely and goes from clarification:complete to execution:*. Accept that
  // too — it means clarification finished and execution is in progress.
  if (state.step === "planning") {
    addDetail(
      `Clarification complete — builder advanced to planning:${state.status}`
    );
    return;
  }
  if (state.step === "execution") {
    const planCreated = readSkillFrontmatterFlag(stageName, "plan-creation");
    if (!planCreated) {
      addDetail(
        `Clarification complete — plan-creation:false, builder advanced to execution:${state.status}`
      );
      return;
    }
    addFailure(
      `Expected step 'clarification' or 'planning', found 'execution' (plan-creation is true; builder should not have skipped planning)`
    );
    return;
  }

  if (state.step !== "clarification") {
    addFailure(`Expected step 'clarification' or 'planning', found '${state.step}'`);
    return;
  }

  const validStatuses = [
    "pending",
    "awaiting-human",
    "answered",
    "follow-up",
    "complete",
  ];
  if (!validStatuses.includes(state.status)) {
    addFailure(`Invalid clarification status: '${state.status}'`);
  } else {
    addDetail(`Clarification status: ${state.status}`);
  }

  // Questions file should exist once questions have been generated
  if (
    state.status === "awaiting-human" ||
    state.status === "follow-up" ||
    state.status === "complete"
  ) {
    if (!fileNonEmpty(questionsFile)) {
      addFailure("Questions file missing or empty");
    } else {
      addDetail("Questions file exists and non-empty");
    }
  }

  // When clarification is complete, answers must be filled in
  if (state.status === "complete") {
    const content = fs.readFileSync(questionsFile, "utf-8");
    const answerPattern = /\[Answer\]:\s*\S/;
    if (!answerPattern.test(content)) {
      addFailure("Questions file has no filled answers");
    } else {
      addDetail("Answers present in questions file");
    }
  }
}

/**
 * PLANNING CHECK
 * Verifies the planning step completed correctly:
 * - State shows a valid planning status
 * - Plan file exists when it should (any status except pending)
 */
function checkPlanning() {
  const state = parseStateFile();
  if (!state) {
    addFailure("No state entry for stage " + stageName);
    return;
  }

  if (state.step !== "planning") {
    addFailure(`Expected step 'planning', found '${state.step}'`);
    return;
  }

  const validStatuses = [
    "pending",
    "awaiting-human",
    "revision-requested",
    "approved",
  ];
  if (!validStatuses.includes(state.status)) {
    addFailure(`Invalid planning status: '${state.status}'`);
  } else {
    addDetail(`Planning status: ${state.status}`);
  }

  // Plan file should exist once the builder has generated it
  if (state.status !== "pending") {
    if (!fileNonEmpty(planFile)) {
      addFailure("Plan file missing or empty");
    } else {
      addDetail("Plan file exists and non-empty");
    }
  }
}

/**
 * EXECUTION CHECK
 * Verifies the builder produced artifacts:
 * - State shows execution:complete
 * - Artifacts are listed in the state's Artifacts column
 * - Every listed artifact exists on disk and is non-empty
 */
function checkExecution() {
  const state = parseStateFile();
  if (!state) {
    addFailure("No state entry for stage " + stageName);
    return;
  }

  if (state.step !== "execution" || state.status !== "complete") {
    addFailure(
      `Expected 'execution:complete', found '${state.step}:${state.status}'`
    );
    return;
  }

  if (!state.artifacts || state.artifacts.length === 0) {
    addFailure("No artifacts listed in state");
    return;
  }

  addDetail(`Artifacts listed: ${state.artifacts.length}`);

  // Verify each claimed artifact actually exists on disk
  // Artifacts can be filenames (resolved relative to stage output dir),
  // intent-root filenames (e.g. intent.md, workflow.md), or full relative
  // paths from the workspace root.
  for (const artifact of state.artifacts) {
    const inStageDir = path.join(stageOutputDir, artifact);
    const inIntentDir = path.join(intentDir, artifact);
    const asRelative = path.resolve(artifact);

    if (fileNonEmpty(inStageDir)) {
      addDetail(`Artifact exists: ${artifact}`);
    } else if (fileNonEmpty(inIntentDir)) {
      addDetail(`Artifact exists: ${artifact}`);
    } else if (fileNonEmpty(asRelative)) {
      addDetail(`Artifact exists: ${artifact}`);
    } else {
      addFailure(`Artifact missing or empty: ${artifact}`);
    }
  }
}

/**
 * VALIDATION CHECK — the most thorough check.
 * Verifies the validator did its job completely:
 * - Validation result file exists and has an explicit PASS/FAIL status
 * - State matches the result
 * - Every script in tools/ was reported as invoked in the result
 * - Re-runs each tool script independently to confirm the validator's results
 * - Every rule in validation-spec.md was reported as checked
 */
function checkValidation() {
  const state = parseStateFile();
  if (!state) {
    addFailure("No state entry for stage " + stageName);
    return;
  }

  if (state.step !== "validation") {
    addFailure(`Expected step 'validation', found '${state.step}'`);
    return;
  }

  if (state.status !== "pass" && state.status !== "fail") {
    addFailure(`Invalid validation status: '${state.status}'`);
    return;
  }

  addDetail(`Validation status in state: ${state.status}`);

  // --- Check validation result file exists and is parseable ---

  if (!fileNonEmpty(validationResultFile)) {
    addFailure("Validation result file missing or empty");
    return;
  }
  addDetail("Validation result file exists");

  const result = parseValidationResult();
  if (!result) {
    addFailure("Could not parse validation result file");
    return;
  }

  // --- Check status is explicit PASS or FAIL ---

  if (!result.status) {
    addFailure("Validation result has no explicit PASS/FAIL status");
  } else {
    addDetail(`Validation result status: ${result.status}`);
  }

  // --- Check state matches result (no contradictions) ---

  if (result.status && result.status !== state.status) {
    addFailure(
      `State says '${state.status}' but result says '${result.status}'`
    );
  }

  // --- Check all tool scripts were invoked ---
  // Cross-reference the scripts/ directory listing against the validator's
  // report. We trust the validator to actually run them (per validator
  // protocol §2 step 5); process_checker only verifies coverage.

  const expectedTools = getToolScripts();
  if (expectedTools.length > 0) {
    addDetail(`Expected tools: ${expectedTools.join(", ")}`);

    for (const tool of expectedTools) {
      const found = result.toolsInvoked.some(
        (t) => t.includes(tool) || path.basename(t) === tool
      );
      if (!found) {
        addFailure(`Tool not reported in validation result: ${tool}`);
      } else {
        addDetail(`Tool reported: ${tool}`);
      }
    }
  } else {
    addDetail("No tool scripts in scripts/ directory");
  }

  // --- Check all validation-spec rules were checked ---
  // Count the numbered rules in validation-spec.md and verify the validator
  // reported every rule number from 1..N (not just "at least N reported").

  const ruleCount = getValidationRuleCount();
  if (ruleCount > 0) {
    addDetail(`Expected rules: 1..${ruleCount}`);
    const reported = new Set(result.rulesChecked);
    const missing = [];
    for (let n = 1; n <= ruleCount; n++) {
      if (!reported.has(n)) missing.push(n);
    }
    if (missing.length > 0) {
      addFailure(
        `Validation result missing rule numbers: ${missing.join(", ")}`
      );
    } else {
      addDetail(`All ${ruleCount} rules reported`);
    }
  }
}

/**
 * VERIFICATION CHECK
 * Verifies the human review step:
 * - State shows a valid verification status
 * - If approved, confirms validation actually passed (no fake approvals)
 */
function checkVerification() {
  const state = parseStateFile();
  if (!state) {
    addFailure("No state entry for stage " + stageName);
    return;
  }

  if (state.step !== "verification") {
    addFailure(`Expected step 'verification', found '${state.step}'`);
    return;
  }

  if (state.status === "approved") {
    // Double-check: you can't approve verification without a passing validation
    const result = parseValidationResult();
    if (!result || result.status !== "pass") {
      addFailure("Verification approved but validation result is not PASS");
    } else {
      addDetail("Verification approved with validation PASS");
    }
  } else {
    addDetail(`Verification status: ${state.status}`);
  }
}

/**
 * STAGE COMPLETE CHECK — the final audit.
 * Verifies the entire stage completed correctly:
 * - State shows complete
 * - Validation result shows PASS
 * - All artifacts still exist on disk
 * - Audit trail has entries for every required step (no steps skipped)
 * - Attempt counter is valid
 */
function checkStageComplete() {
  const state = parseStateFile();
  if (!state) {
    addFailure("No state entry for stage " + stageName);
    return;
  }

  if (state.status !== "complete") {
    addFailure(`Expected status 'complete', found '${state.status}'`);
    return;
  }

  addDetail("State shows complete");

  // --- Validation must have passed ---

  const result = parseValidationResult();
  if (result && result.status === "pass") {
    addDetail("Validation result shows PASS");
  } else if (result) {
    addFailure("Stage complete but validation result is not PASS");
  }

  // --- All artifacts must still exist on disk ---

  if (state.artifacts && state.artifacts.length > 0) {
    for (const artifact of state.artifacts) {
      const inStageDir = path.join(stageOutputDir, artifact);
      const inIntentDir = path.join(intentDir, artifact);
      const asRelative = path.resolve(artifact);

      if (
        !fileNonEmpty(inStageDir) &&
        !fileNonEmpty(inIntentDir) &&
        !fileNonEmpty(asRelative)
      ) {
        addFailure(`Artifact missing at stage complete: ${artifact}`);
      }
    }
    addDetail(`All ${state.artifacts.length} artifacts verified on disk`);
  }

  // --- Audit trail must cover all required steps ---
  // Check that the audit file has entries for clarification, planning,
  // execution, and validation. This catches cases where a step was skipped.

  if (fileExists(auditFile)) {
    const auditContent = fs.readFileSync(auditFile, "utf-8");
    const stageAuditLines = auditContent
      .split("\n")
      .filter((l) => l.includes(`| ${stateKey} `));

    // Build the required step list, respecting per-skill flags.
    const planCreated = readSkillFrontmatterFlag(stageName, "plan-creation");
    const requiredSteps = ["clarification", "execution", "validation"];
    if (planCreated) requiredSteps.splice(1, 0, "plan");

    for (const step of requiredSteps) {
      const found = stageAuditLines.some((l) => l.includes(step));
      if (!found) {
        addFailure(`Audit trail missing step: ${step}`);
      }
    }
    addDetail(`Audit trail has ${stageAuditLines.length} entries for stage`);
  } else {
    addFailure("Audit file missing at stage complete");
  }

  // --- Attempt counter must be valid ---

  if (state.attempt < 1) {
    addFailure(`Invalid attempt counter: ${state.attempt}`);
  }
}

// =============================================================================
// MAIN
// Route to the correct step checker based on the expected-step argument.
// Always verify state and audit files exist (except during setup).
// Output structured JSON result.
// In checkpoint mode, update the checkpoint file after running checks.
// =============================================================================

const stepCheckers = {
  setup: checkSetup,
  clarification: checkClarification,
  planning: checkPlanning,
  execution: checkExecution,
  validation: checkValidation,
  verification: checkVerification,
  "skill-complete": checkStageComplete,
};

const checker = stepCheckers[expectedStep];
if (!checker) {
  console.error(`Unknown step: ${expectedStep}`);
  console.error(`Valid steps: ${Object.keys(stepCheckers).join(", ")}`);
  process.exit(2);
}

// State and audit files must exist for all steps except setup (which creates them)
if (expectedStep !== "setup") {
  if (!fileExists(stateFile)) {
    addFailure("State file does not exist");
  }
  if (!fileExists(auditFile)) {
    addFailure("Audit file does not exist");
  }
}

// Run the step-specific checks
checker();

// Build the result
const passed = failures.length === 0;
const result = {
  skill: stageName,
  unit: unitName || undefined,
  stateKey,
  step: expectedStep,
  status: passed ? "PASS" : "FAIL",
  failures,
  details,
};

// Update the checkpoint file
{
  // Re-parse workflow.md so any lines appended since the last run
  // (notably by workflow-composition) are reflected in the checkpoint.
  const workflowPath = path.join(intentDir, "workflow.md");
  const freshWorkflow = parseWorkflowFile(workflowPath);
  const existingCheckpoint = readCheckpoint(checkpointPath) || {};
  const updatedCheckpoint = {
    workflow:
      freshWorkflow.length > 0
        ? freshWorkflow
        : existingCheckpoint.workflow || [],
    intentDir,
    rulesDir,
    current: {
      skill: stageName,
      phase,
      unit: unitName,
      scope: scopeName || null,
      step: expectedStep,
      status: passed ? "verified" : "failed",
    },
    next: passed
      ? { step: nextStepForSkill(expectedStep, stageName) }
      : { step: expectedStep },
    error: passed
      ? null
      : {
          type: "check-failed",
          message: failures.join("; "),
          action: `Fix the following issues before proceeding: ${failures.join("; ")}`,
        },
  };

  // If the current step is skill-complete and passed, advance to next skill
  if (expectedStep === "skill-complete" && passed) {
    const workflow = updatedCheckpoint.workflow;
    const currentIdx = workflow.findIndex(
      (s) => s.skill === stageName && s.unit === unitName && (s.scope || null) === scopeName
    );
    if (currentIdx >= 0 && currentIdx < workflow.length - 1) {
      const ns = workflow[currentIdx + 1];
      updatedCheckpoint.next = { step: "clarification" };
      updatedCheckpoint.current = {
        skill: ns.skill,
        phase: ns.phase,
        unit: ns.unit,
        scope: ns.scope || null,
        step: "skill-complete",
        status: "verified",
      };
    } else if (currentIdx < 0 && workflow.length > 0) {
      // Current skill is not in workflow.md — typically because it is a
      // bootstrap skill that ran outside the workflow file. After it
      // completes, advance to the first skill listed in workflow.md.
      const ns = workflow[0];
      updatedCheckpoint.next = { step: "clarification" };
      updatedCheckpoint.current = {
        skill: ns.skill,
        phase: ns.phase,
        unit: ns.unit,
        scope: ns.scope || null,
        step: "skill-complete",
        status: "verified",
      };
    } else {
      updatedCheckpoint.next = null;
    }
  }

  writeCheckpoint(checkpointPath, updatedCheckpoint);
}

// Output result to stdout
console.log(JSON.stringify(result, null, 2));
process.exit(passed ? 0 : 1);
