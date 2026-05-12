import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { WorkflowDefinition, WorkflowSettings, PhaseDefinition, } from "./types";

// ── Constants ──
const VALID_COMMAND_NAME_RE = /^[a-zA-Z0-9_-]+$/;

// ── Settings File Paths ──
function getGlobalSettingsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "settings.json");
}

function getProjectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

async function readSettingsFile(filePath: string): Promise<Record<string, unknown>> {
  if (!existsSync(filePath)) return {};
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

// ── Template Resolution ──
/**
 * Replaces {varName} occurrences in template with values from vars.
 * Unknown variables are left as-is.
 */
export function resolveTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    return vars[key] !== undefined ? vars[key] : `{${key}}`;
  });
}

// ── Validation ──
/**
 * Validates a workflow definition.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateWorkflowDefinition(
  key: string,
  def: WorkflowDefinition,
): string | null {
  if (!def.name || typeof def.name !== "string" || def.name.trim() === "") {
    return `Workflow "${key}": name must be a non-empty string.`;
  }
  if (!def.commandName || typeof def.commandName !== "string") {
    return `Workflow "${key}": commandName must be a non-empty string.`;
  }
  if (!VALID_COMMAND_NAME_RE.test(def.commandName)) {
    return `Workflow "${key}": commandName must match /^[a-zA-Z0-9_-]+$. Got: "${def.commandName}"`;
  }
  if (!def.initialMessage || typeof def.initialMessage !== "string" || def.initialMessage.trim() === "") {
    return `Workflow "${key}": initialMessage must be a non-empty string.`;
  }
  if (!Array.isArray(def.phases) || def.phases.length < 1) {
    return `Workflow "${key}": phases must be an array with at least 1 element.`;
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < def.phases.length; i++) {
    const phase = def.phases[i];
    if (!phase.id || typeof phase.id !== "string" || phase.id.trim() === "") {
      return `Workflow "${key}", phase[${i}]: id must be a non-empty string.`;
    }
    if (!phase.name || typeof phase.name !== "string" || phase.name.trim() === "") {
      return `Workflow "${key}", phase[${i}]: name must be a non-empty string.`;
    }
    if (!phase.emoji || typeof phase.emoji !== "string" || phase.emoji.trim() === "") {
      return `Workflow "${key}", phase[${i}]: emoji must be a non-empty string.`;
    }
    if (!phase.instructions || typeof phase.instructions !== "string" || phase.instructions.trim() === "") {
      return `Workflow "${key}", phase[${i}]: instructions must be a non-empty string.`;
    }
    if (seenIds.has(phase.id)) {
      return `Workflow "${key}", phase[${i}]: duplicate phase id "${phase.id}".`;
    }
    seenIds.add(phase.id);

    if (phase.tools) {
      if (phase.tools.blacklist && !Array.isArray(phase.tools.blacklist)) {
        return `Workflow "${key}", phase "${phase.id}": blacklist must be an array.`;
      }
      if (phase.tools.whitelist && !Array.isArray(phase.tools.whitelist)) {
        return `Workflow "${key}", phase "${phase.id}": whitelist must be an array.`;
      }
      if (phase.tools.blacklist && phase.tools.whitelist) {
        return `Workflow "${key}", phase "${phase.id}": cannot set both blacklist and whitelist.`;
      }
    }
  }

  return null;
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

// ── Loading ──
/**
 * Load workflow definitions from global and project-local settings.json.
 * Project definitions override global definitions with the same key.
 * Invalid definitions are excluded with a console.warn.
 */
export async function loadWorkflows(
  cwd?: string,
): Promise<Record<string, WorkflowDefinition>> {
  // Load global settings
  const globalSettings = await readSettingsFile(getGlobalSettingsPath());
  const globalDefs: Record<string, WorkflowDefinition> = (globalSettings.workflows as WorkflowSettings | undefined)?.definitions ?? {};
  let merged: Record<string, WorkflowDefinition> = { ...globalDefs };

  // Load and merge project-local settings
  if (cwd) {
    const projectSettings = await readSettingsFile(getProjectSettingsPath(cwd));
    const projectDefs: Record<string, WorkflowDefinition> = (projectSettings.workflows as WorkflowSettings | undefined)?.definitions ?? {};
    merged = { ...merged, ...projectDefs };
  }

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

  // Check for duplicate commandNames
  const commandNameMap = new Map<string, string>();
  for (const [key, def] of Object.entries(valid)) {
    const existing = commandNameMap.get(def.commandName);
    if (existing) {
      console.warn(
        `[pi-workflows] Duplicate commandName "${def.commandName}" in workflows "${existing}" and "${key}". The first one found will be used.`,
      );
    } else {
      commandNameMap.set(def.commandName, key);
    }
  }

  return valid;
}

// ── Utility: get blocked/allowed tools for a phase ──
export function getBlockedTools(phase: PhaseDefinition): string[] {
  if (phase.tools?.blacklist) return [...phase.tools.blacklist];
  return [];
}

export function getWhitelist(phase: PhaseDefinition): string[] | null {
  if (phase.tools?.whitelist) return [...phase.tools.whitelist];
  return null;
}
