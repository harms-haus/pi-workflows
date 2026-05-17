import { readdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { parse as yamlParse } from "yaml";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { WorkflowDefinition, PhaseDefinition, PhaseToolConfig, PhaseEntry } from "../types";
import { isSubworkflowRef } from "../types";
import { validateWorkflowDefinition } from "./validation";
import { detectCycles } from "./validation";

// ── Typed interface for raw YAML parse result ──

/** Shape of the raw YAML workflow data before validation. */
interface RawWorkflowYaml {
  name?: unknown;
  commandName?: unknown;
  initialMessage?: unknown;
  show?: unknown;
  phases?: unknown;
  loopable?: unknown;
  sessionNamePrefix?: unknown;
  sessionNameMaxLength?: unknown;
  roleInstruction?: unknown;
  advanceReminder?: unknown;
  blockReasonTemplate?: unknown;
  completionMessage?: unknown;
  notDoneReminder?: unknown;
}

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

// ── Helpers for loadWorkflowFromDir ──

/** Validate the YAML object and return it typed, or null if invalid. */
function validateYamlObject(yamlContent: string, dirPath: string): RawWorkflowYaml | null {
  const parsed: unknown = yamlParse(yamlContent);
  if (!parsed || typeof parsed !== "object") {
    console.warn(`[pi-workflows] Invalid workflow.yaml in ${dirPath}: not a valid YAML object`);
    return null;
  }
  return parsed;
}

/** Extract the show field from parsed YAML. */
function parseShowField(raw: RawWorkflowYaml): "workflows" | undefined {
  return raw.show === "workflows" ? "workflows" : undefined;
}

/** Validate and extract required fields (name, commandName, initialMessage). */
function extractRequiredFields(
  raw: RawWorkflowYaml,
  yamlPath: string,
  show: "workflows" | undefined,
): { name: string; commandName: string; initialMessage: string } | null {
  if (typeof raw.name !== "string" || !raw.name) {
    console.warn(`[pi-workflows] Missing or invalid "name" in ${yamlPath}`);
    return null;
  }

  let commandName: string;
  let initialMessage: string;

  if (show === "workflows") {
    commandName = typeof raw.commandName === "string" ? raw.commandName : "";
    initialMessage = typeof raw.initialMessage === "string" ? raw.initialMessage : "";
  } else {
    if (typeof raw.commandName !== "string" || !raw.commandName) {
      console.warn(`[pi-workflows] Missing or invalid "commandName" in ${yamlPath}`);
      return null;
    }
    if (typeof raw.initialMessage !== "string" || !raw.initialMessage) {
      console.warn(`[pi-workflows] Missing or invalid "initialMessage" in ${yamlPath}`);
      return null;
    }
    commandName = raw.commandName;
    initialMessage = raw.initialMessage;
  }

  return { name: raw.name, commandName, initialMessage };
}

/** Set optional string/number/boolean fields on the workflow definition. */
function setOptionalFields(raw: RawWorkflowYaml, workflow: WorkflowDefinition): void {
  if (typeof raw.loopable === "boolean") workflow.loopable = raw.loopable;
  if (typeof raw.sessionNamePrefix === "string") workflow.sessionNamePrefix = raw.sessionNamePrefix;
  if (typeof raw.sessionNameMaxLength === "number")
    workflow.sessionNameMaxLength = raw.sessionNameMaxLength;
  if (typeof raw.roleInstruction === "string") workflow.roleInstruction = raw.roleInstruction;
  if (typeof raw.advanceReminder === "string") workflow.advanceReminder = raw.advanceReminder;
  if (typeof raw.blockReasonTemplate === "string")
    workflow.blockReasonTemplate = raw.blockReasonTemplate;
  if (typeof raw.completionMessage === "string")
    workflow.completionMessage = raw.completionMessage;
  if (typeof raw.notDoneReminder === "string") workflow.notDoneReminder = raw.notDoneReminder;
}

/** Check that a phase file path does not escape the workflows root. */
function checkPathSafety(
  phaseEntry: string,
  dirPath: string,
  workflowsRoot: string,
  yamlPath: string,
): boolean {
  const canonicalRoot = realpathSync(resolve(workflowsRoot));
  const phaseFilePath = resolve(dirPath, phaseEntry);
  try {
    const canonicalPhase = realpathSync(phaseFilePath);
    if (!canonicalPhase.startsWith(canonicalRoot + sep)) {
      console.warn(
        `[pi-workflows] Phase file path escapes workflows root: ${phaseEntry} in ${yamlPath}`,
      );
      return false;
    }
  } catch {
    const resolvedPath = resolve(dirPath, phaseEntry);
    if (!resolvedPath.startsWith(canonicalRoot + sep)) {
      console.warn(
        `[pi-workflows] Phase file path escapes workflows root: ${phaseEntry} in ${yamlPath}`,
      );
      return false;
    }
  }
  return true;
}

/** Load a phase from a .md file with frontmatter. */
function loadPhaseFromMarkdown(phasePath: string): PhaseDefinition | null {
  const phaseContent = readFileSync(phasePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(phaseContent);

  if (typeof frontmatter.id !== "string" || !frontmatter.id) {
    console.warn(`[pi-workflows] Missing or invalid "id" in ${phasePath}`);
    return null;
  }
  if (typeof frontmatter.name !== "string" || !frontmatter.name) {
    console.warn(`[pi-workflows] Missing or invalid "name" in ${phasePath}`);
    return null;
  }
  if (typeof frontmatter.emoji !== "string" || !frontmatter.emoji) {
    console.warn(`[pi-workflows] Missing or invalid "emoji" in ${phasePath}`);
    return null;
  }

  const phase: PhaseDefinition = {
    id: frontmatter.id,
    name: frontmatter.name,
    emoji: frontmatter.emoji,
    instructions: body.trim(),
  };

  // Extract optional tools config
  if (
    frontmatter.tools &&
    typeof frontmatter.tools === "object" &&
    !Array.isArray(frontmatter.tools)
  ) {
    const toolsConfig = frontmatter.tools as Record<string, unknown>;
    const tools: PhaseToolConfig = {};

    if (Array.isArray(toolsConfig.blacklist)) {
      tools.blacklist = toolsConfig.blacklist.map(String);
    }
    if (Array.isArray(toolsConfig.whitelist)) {
      tools.whitelist = toolsConfig.whitelist.map(String);
    }

    if (tools.blacklist || tools.whitelist) {
      phase.tools = tools;
    }
  }

  // Extract optional availableProfiles
  if (Array.isArray(frontmatter.availableProfiles)) {
    phase.availableProfiles = frontmatter.availableProfiles.map(String);
  }

  return phase;
}

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

/** Load all phase entries from the parsed YAML. */
function loadPhases(
  raw: RawWorkflowYaml,
  yamlPath: string,
  dirPath: string,
  workflowsRoot: string,
): PhaseEntry[] | null {
  if (!Array.isArray(raw.phases) || raw.phases.length < 1) {
    console.warn(`[pi-workflows] Missing or invalid "phases" array in ${yamlPath}`);
    return null;
  }

  const phases: PhaseEntry[] = [];
  for (const entry of raw.phases) {
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
    const raw = validateYamlObject(yamlContent, dirPath);
    if (!raw) return null;

    const show = parseShowField(raw);
    const required = extractRequiredFields(raw, yamlPath, show);
    if (!required) return null;

    const phases = loadPhases(raw, yamlPath, dirPath, workflowsRoot);
    if (!phases) return null;

    const workflow: WorkflowDefinition = {
      ...required,
      phases,
    };

    if (show !== undefined) workflow.show = show;
    setOptionalFields(raw, workflow);

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

// ── Helpers for loadWorkflows ──

/** Remove entries with given keys from the record, returning a new record. */
function removeKeys(
  record: Record<string, WorkflowDefinition>,
  keys: Iterable<string>,
): Record<string, WorkflowDefinition> {
  const keySet = new Set(keys);
  return Object.fromEntries(Object.entries(record).filter(([k]) => !keySet.has(k)));
}

/** Detect and remove workflow definitions with cyclic subworkflow references. */
function removeCycles(valid: Record<string, WorkflowDefinition>): Record<string, WorkflowDefinition> {
  const cycleErrors = detectCycles(valid);
  if (cycleErrors.length === 0) return valid;

  const cycleKeys = new Set<string>();
  for (const msg of cycleErrors) {
    console.warn(`[pi-workflows] ${msg}`);
    const match = msg.match(/^Cycle detected: (.+?)\. /);
    if (match) {
      for (const k of match[1].split(" → ")) {
        cycleKeys.add(k);
      }
    }
  }
  return removeKeys(valid, cycleKeys);
}

/** Resolve subworkflow references, removing definitions with broken references. */
function resolveSubworkflowRefs(
  valid: Record<string, WorkflowDefinition>,
): Record<string, WorkflowDefinition> {
  let current = valid;
  let changed = true;
  while (changed) {
    changed = false;
    const keysToRemove: string[] = [];
    for (const [key, def] of Object.entries(current)) {
      for (const phase of def.phases) {
        if (isSubworkflowRef(phase) && phase.resolved === null) {
          const targetDef = current[phase.workflowKey];
          if (!(phase.workflowKey in current)) {
            console.warn(
              `[pi-workflows] Workflow "${key}" references non-existent subworkflow "${phase.workflowKey}". Skipping.`,
            );
            keysToRemove.push(key);
            break;
          }
          phase.resolved = targetDef;
        }
      }
    }
    if (keysToRemove.length > 0) {
      current = removeKeys(current, keysToRemove);
      changed = true;
    }
  }
  return current;
}

/** Warn about duplicate commandNames across workflows. */
function checkDuplicateCommandNames(valid: Record<string, WorkflowDefinition>): void {
  const commandNameMap = new Map<string, string>();
  for (const [key, def] of Object.entries(valid)) {
    if (!def.commandName) continue;
    const existing = commandNameMap.get(def.commandName);
    if (existing) {
      console.warn(
        `[pi-workflows] Duplicate commandName "${def.commandName}" in workflows "${existing}" and "${key}". The first one found will be used.`,
      );
    } else {
      commandNameMap.set(def.commandName, key);
    }
  }
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
