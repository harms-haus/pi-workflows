import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { WorkflowDefinition, PhaseEntry } from "../types";
import { validateWorkflowDefinition } from "./validation";
import { parseWorkflowYaml } from "./loading-parse";
import { checkPathSafety, loadPhaseFromMarkdown } from "./loading-phases";
import {
  removeCycles,
  resolveSubworkflowRefs,
  checkDuplicateCommandNames,
} from "./loading-resolve";

// ── Lookup ──

/**
 * Find a workflow by its commandName.
 * Returns [key, definition] tuple or null.
 */
export function findWorkflowByCommandName(
  workflows: Record<string, WorkflowDefinition>,
  commandName: string,
): [string, WorkflowDefinition] | null {
  for (const [key, def] of Object.entries(workflows)) {
    if (def.commandName === commandName) {
      return [key, def];
    }
  }
  return null;
}

// ── Phase Entry Loading ──

/** Load a single phase entry (string filename or subworkflow reference). */
function loadPhaseEntry(
  phaseEntry: unknown,
  dirPath: string,
  workflowsRoot: string,
  yamlPath: string,
): PhaseEntry | null {
  if (typeof phaseEntry === "string") {
    if (!checkPathSafety(phaseEntry, dirPath, workflowsRoot, yamlPath)) return null;
    const phasePath = join(dirPath, phaseEntry);
    try {
      return loadPhaseFromMarkdown(phasePath);
    } catch (phaseErr) {
      const msg = phaseErr instanceof Error ? phaseErr.message : String(phaseErr);
      console.warn(`[pi-workflows] Failed to load phase file ${phasePath}: ${msg}`);
      return null;
    }
  }

  if (
    typeof phaseEntry === "object" &&
    phaseEntry !== null &&
    typeof (phaseEntry as Record<string, unknown>).subworkflow === "string"
  ) {
    return {
      subworkflow: true,
      workflowKey: String((phaseEntry as Record<string, unknown>).subworkflow),
      resolved: null,
    };
  }

  console.warn(
    `[pi-workflows] Invalid phase entry in ${yamlPath}: expected string or { subworkflow: key } object`,
  );
  return null;
}

/** Load all phase entries from raw phase data. */
function loadPhases(
  rawPhases: unknown[],
  yamlPath: string,
  dirPath: string,
  workflowsRoot: string,
): PhaseEntry[] | null {
  const phases: PhaseEntry[] = [];
  for (const entry of rawPhases) {
    const phase = loadPhaseEntry(entry, dirPath, workflowsRoot, yamlPath);
    if (phase === null) return null;
    phases.push(phase);
  }
  return phases;
}

// ── Loading from Directory ──

/**
 * Load a single workflow from a directory containing workflow.yaml and phase .md files.
 * Returns null if the directory is not a valid workflow directory.
 */
export function loadWorkflowFromDir(
  dirPath: string,
  workflowsRoot: string,
): WorkflowDefinition | null {
  const yamlPath = join(dirPath, "workflow.yaml");
  if (!existsSync(yamlPath)) return null;

  try {
    const yamlContent = readFileSync(yamlPath, "utf-8");
    const parsed = parseWorkflowYaml(yamlContent, dirPath);
    if (!parsed) return null;

    const phases = loadPhases(parsed.rawPhases, yamlPath, dirPath, workflowsRoot);
    if (!phases) return null;

    const workflow: WorkflowDefinition = {
      name: parsed.name,
      commandName: parsed.commandName,
      initialMessage: parsed.initialMessage,
      phases,
    };

    if (parsed.show !== undefined) workflow.show = parsed.show;
    if (parsed.loopable !== undefined) workflow.loopable = parsed.loopable;
    if (parsed.sessionNamePrefix !== undefined)
      workflow.sessionNamePrefix = parsed.sessionNamePrefix;
    if (parsed.sessionNameMaxLength !== undefined)
      workflow.sessionNameMaxLength = parsed.sessionNameMaxLength;
    if (parsed.roleInstruction !== undefined) workflow.roleInstruction = parsed.roleInstruction;
    if (parsed.advanceReminder !== undefined) workflow.advanceReminder = parsed.advanceReminder;
    if (parsed.blockReasonTemplate !== undefined)
      workflow.blockReasonTemplate = parsed.blockReasonTemplate;
    if (parsed.notDoneReminder !== undefined) workflow.notDoneReminder = parsed.notDoneReminder;

    return workflow;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-workflows] Failed to load workflow from ${dirPath}: ${msg}`);
    return null;
  }
}

/**
 * Scan a parent directory for workflow subdirectories and load each one.
 * Returns a record keyed by directory name.
 */
export function loadWorkflowsFromDir(parentDir: string): Record<string, WorkflowDefinition> {
  const definitions: Record<string, WorkflowDefinition> = {};

  if (!existsSync(parentDir)) return definitions;

  try {
    const entries = readdirSync(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      try {
        const workflow = loadWorkflowFromDir(join(parentDir, entry.name), parentDir);
        if (workflow) {
          definitions[entry.name] = workflow;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[pi-workflows] Error loading workflow from ${entry.name}: ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-workflows] Failed to read workflow directory ${parentDir}: ${msg}`);
  }

  return definitions;
}

// ── Loading ──

/**
 * Load workflow definitions from global and project-local workflow directories.
 * Project definitions override global definitions with the same key.
 * Invalid definitions are excluded with a console.warn.
 */
export function loadWorkflows(cwd?: string): Record<string, WorkflowDefinition> {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const globalDir = join(agentDir, "workflows");
  const projectDir = cwd ? join(cwd, ".pi", "workflows") : "";

  const globalDefs = loadWorkflowsFromDir(globalDir);
  const projectDefs = projectDir ? loadWorkflowsFromDir(projectDir) : {};

  const merged: Record<string, WorkflowDefinition> = { ...globalDefs, ...projectDefs };

  // Validate and filter
  const valid: Record<string, WorkflowDefinition> = {};
  for (const [key, def] of Object.entries(merged)) {
    const err = validateWorkflowDefinition(key, def);
    if (err) {
      console.warn(`[pi-workflows] Skipping invalid workflow definition "${key}": ${err}`);
    } else {
      valid[key] = def;
    }
  }

  let resolved = removeCycles(valid);
  resolved = resolveSubworkflowRefs(resolved);
  checkDuplicateCommandNames(resolved);

  return resolved;
}
