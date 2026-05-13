import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as yamlParse } from "yaml";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { WorkflowDefinition, PhaseDefinition, PhaseToolConfig } from "./types";

// ── Constants ──
const VALID_COMMAND_NAME_RE = /^[a-zA-Z0-9_-]+$/;

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

// ── Loading from Directory ──

/**
 * Load a single workflow from a directory containing workflow.yaml and phase .md files.
 * Returns null if the directory is not a valid workflow directory.
 */
function loadWorkflowFromDir(dirPath: string): WorkflowDefinition | null {
  const yamlPath = join(dirPath, "workflow.yaml");
  if (!existsSync(yamlPath)) return null;

  try {
    const yamlContent = readFileSync(yamlPath, "utf-8");
    const parsed = yamlParse(yamlContent);

    if (!parsed || typeof parsed !== "object") {
      console.warn(`[pi-workflows] Invalid workflow.yaml in ${dirPath}: not a valid YAML object`);
      return null;
    }

    // Extract required fields
    if (typeof parsed.name !== "string" || !parsed.name) {
      console.warn(`[pi-workflows] Missing or invalid "name" in ${yamlPath}`);
      return null;
    }
    if (typeof parsed.commandName !== "string" || !parsed.commandName) {
      console.warn(`[pi-workflows] Missing or invalid "commandName" in ${yamlPath}`);
      return null;
    }
    if (typeof parsed.initialMessage !== "string" || !parsed.initialMessage) {
      console.warn(`[pi-workflows] Missing or invalid "initialMessage" in ${yamlPath}`);
      return null;
    }
    if (!Array.isArray(parsed.phases) || parsed.phases.length < 1) {
      console.warn(`[pi-workflows] Missing or invalid "phases" array in ${yamlPath}`);
      return null;
    }

    const workflow: WorkflowDefinition = {
      name: parsed.name,
      commandName: parsed.commandName,
      initialMessage: parsed.initialMessage,
      phases: [],
    };

    // Extract optional string fields
    if (typeof parsed.sessionNamePrefix === "string") workflow.sessionNamePrefix = parsed.sessionNamePrefix;
    if (typeof parsed.sessionNameMaxLength === "number") workflow.sessionNameMaxLength = parsed.sessionNameMaxLength;
    if (typeof parsed.roleInstruction === "string") workflow.roleInstruction = parsed.roleInstruction;
    if (typeof parsed.advanceReminder === "string") workflow.advanceReminder = parsed.advanceReminder;
    if (typeof parsed.blockReasonTemplate === "string") workflow.blockReasonTemplate = parsed.blockReasonTemplate;
    if (typeof parsed.completionMessage === "string") workflow.completionMessage = parsed.completionMessage;
    if (typeof parsed.notDoneReminder === "string") workflow.notDoneReminder = parsed.notDoneReminder;

    // Load each phase from its .md file
    for (const phaseFile of parsed.phases) {
      if (typeof phaseFile !== "string") {
        console.warn(`[pi-workflows] Invalid phase filename in ${yamlPath}: expected string, got ${typeof phaseFile}`);
        return null;
      }

      const phasePath = join(dirPath, phaseFile);
      try {
        const phaseContent = readFileSync(phasePath, "utf-8");
        const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(phaseContent);

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
        if (frontmatter.tools && typeof frontmatter.tools === "object" && !Array.isArray(frontmatter.tools)) {
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

        workflow.phases.push(phase);
      } catch (phaseErr) {
        console.warn(
          `[pi-workflows] Failed to load phase file ${phasePath}: ${phaseErr instanceof Error ? phaseErr.message : phaseErr}`,
        );
        return null;
      }
    }

    return workflow;
  } catch (err) {
    console.warn(
      `[pi-workflows] Failed to load workflow from ${dirPath}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Scan a parent directory for workflow subdirectories and load each one.
 * Returns a record keyed by directory name.
 */
function loadWorkflowsFromDir(parentDir: string): Record<string, WorkflowDefinition> {
  const definitions: Record<string, WorkflowDefinition> = {};

  if (!existsSync(parentDir)) return definitions;

  try {
    const entries = readdirSync(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      try {
        const workflow = loadWorkflowFromDir(join(parentDir, entry.name));
        if (workflow) {
          definitions[entry.name] = workflow;
        }
      } catch (err) {
        console.warn(
          `[pi-workflows] Error loading workflow from ${entry.name}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[pi-workflows] Failed to read workflow directory ${parentDir}: ${err instanceof Error ? err.message : err}`,
    );
  }

  return definitions;
}

// ── Loading ──
/**
 * Load workflow definitions from global and project-local workflow directories.
 * Project definitions override global definitions with the same key.
 * Invalid definitions are excluded with a console.warn.
 */
export async function loadWorkflows(
  cwd?: string,
): Promise<Record<string, WorkflowDefinition>> {
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
