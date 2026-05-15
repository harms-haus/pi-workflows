import { readdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { parse as yamlParse } from "yaml";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { WorkflowDefinition, PhaseDefinition, PhaseToolConfig } from "./types";
import { isSubworkflowRef } from "./types";

// ── Constants ──
const VALID_COMMAND_NAME_RE = /^[a-zA-Z0-9_-]+$/;

// ── Template Resolution ──
/**
 * Replaces {varName} occurrences in template with values from vars.
 * Unknown variables are left as-is.
 */
export function resolveTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    return vars[key] !== undefined ? vars[key] : `{${key}}`;
  });
}

// ── Validation ──
/**
 * Validates a workflow definition.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateWorkflowDefinition(key: string, def: WorkflowDefinition): string | null {
  const show = def.show ?? "user";

  if (!def.name || typeof def.name !== "string" || def.name.trim() === "") {
    return `Workflow "${key}": name must be a non-empty string.`;
  }

  // commandName and initialMessage are required only for user-visible workflows
  if (show === "user") {
    if (!def.commandName || typeof def.commandName !== "string") {
      return `Workflow "${key}": commandName must be a non-empty string.`;
    }
    if (!VALID_COMMAND_NAME_RE.test(def.commandName)) {
      return `Workflow "${key}": commandName must match /^[a-zA-Z0-9_-]+$. Got: "${def.commandName}"`;
    }
    if (
      !def.initialMessage ||
      typeof def.initialMessage !== "string" ||
      def.initialMessage.trim() === ""
    ) {
      return `Workflow "${key}": initialMessage must be a non-empty string.`;
    }
  }

  if (!Array.isArray(def.phases) || def.phases.length < 1) {
    return `Workflow "${key}": phases must be an array with at least 1 element.`;
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < def.phases.length; i++) {
    const phase = def.phases[i];

    if (isSubworkflowRef(phase)) {
      // Subworkflow reference: only validate workflowKey
      if (
        !phase.workflowKey ||
        typeof phase.workflowKey !== "string" ||
        phase.workflowKey.trim() === ""
      ) {
        return `Workflow "${key}", phase[${i}]: workflowKey must be a non-empty string.`;
      }
      // Skip id/name/emoji/instructions validation — those live on the resolved definition
    } else {
      // Concrete phase definition
      if (!phase.id || typeof phase.id !== "string" || phase.id.trim() === "") {
        return `Workflow "${key}", phase[${i}]: id must be a non-empty string.`;
      }
      if (!phase.name || typeof phase.name !== "string" || phase.name.trim() === "") {
        return `Workflow "${key}", phase[${i}]: name must be a non-empty string.`;
      }
      if (!phase.emoji || typeof phase.emoji !== "string" || phase.emoji.trim() === "") {
        return `Workflow "${key}", phase[${i}]: emoji must be a non-empty string.`;
      }
      if (
        !phase.instructions ||
        typeof phase.instructions !== "string" ||
        phase.instructions.trim() === ""
      ) {
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
  }

  if (def.loopable !== undefined && typeof def.loopable !== "boolean") {
    return `Workflow "${key}" has invalid loopable: must be a boolean`;
  }

  if (def.show !== undefined && def.show !== "user" && def.show !== "workflows") {
    return `Workflow "${key}" has invalid show: must be "user" or "workflows"`;
  }

  return null;
}

// ── Cycle Detection ──
/**
 * Validates that the subworkflow reference graph is a DAG (no cycles).
 * Uses iterative DFS with 3-state coloring (WHITE/GRAY/BLACK).
 * Returns an array of error messages (empty = no cycles).
 */
export function detectCycles(definitions: Record<string, WorkflowDefinition>): string[] {
  const errors: string[] = [];
  const keys = Object.keys(definitions);

  // 1. Build adjacency list
  const adj = new Map<string, string[]>();
  for (const key of keys) {
    const neighbors: string[] = [];
    for (const phase of definitions[key].phases) {
      if (isSubworkflowRef(phase)) {
        // Only add edges for workflowKeys that exist in definitions
        if (phase.workflowKey in definitions) {
          neighbors.push(phase.workflowKey);
        }
      }
    }
    adj.set(key, neighbors);
  }

  // 2. Initialize all nodes as WHITE (0)
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const key of keys) {
    color.set(key, WHITE);
  }

  // 3. Iterative DFS for each WHITE node
  for (const startKey of keys) {
    if (color.get(startKey) !== WHITE) continue;

    const parent = new Map<string, string>();
    // Stack entries: { key, neighborIdx, phase }
    const stack: Array<{ key: string; neighborIdx: number; phase: "enter" | "exit" }> = [
      { key: startKey, neighborIdx: 0, phase: "enter" },
    ];

    while (stack.length > 0) {
      const top = stack[stack.length - 1];

      if (top.phase === "enter") {
        color.set(top.key, GRAY);
        top.phase = "exit";
        top.neighborIdx = 0;
        continue; // Re-process as 'exit' to iterate neighbors
      }

      // phase === 'exit': iterate neighbors
      const neighbors = adj.get(top.key) ?? [];
      if (top.neighborIdx < neighbors.length) {
        const neighbor = neighbors[top.neighborIdx];
        top.neighborIdx++;

        const neighborColor = color.get(neighbor) ?? WHITE;

        if (neighborColor === GRAY) {
          // Cycle found! Reconstruct the cycle path
          parent.set(neighbor, top.key); // back edge

          // Reconstruct: start from top.key, follow parent back to neighbor
          const cycleKeys: string[] = [];
          let cur: string = top.key;
          cycleKeys.push(cur);
          while (cur !== neighbor) {
            const p = parent.get(cur);
            if (p === undefined) break;
            cur = p;
            cycleKeys.push(cur);
          }
          cycleKeys.reverse();

          errors.push(
            `Cycle detected: ${cycleKeys.join(" → ")} → ${cycleKeys[0]}. Skipping workflow "${cycleKeys[0]}".`,
          );
        } else if (neighborColor === WHITE) {
          parent.set(neighbor, top.key);
          stack.push({ key: neighbor, neighborIdx: 0, phase: "enter" });
        }
        // BLACK → skip
        continue;
      }

      // All neighbors processed: mark BLACK and pop
      color.set(top.key, BLACK);
      stack.pop();
    }
  }

  return errors;
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
export function loadWorkflowFromDir(
  dirPath: string,
  workflowsRoot: string,
): WorkflowDefinition | null {
  const yamlPath = join(dirPath, "workflow.yaml");
  if (!existsSync(yamlPath)) return null;

  try {
    const yamlContent = readFileSync(yamlPath, "utf-8");
    const parsed = yamlParse(yamlContent);

    if (!parsed || typeof parsed !== "object") {
      console.warn(`[pi-workflows] Invalid workflow.yaml in ${dirPath}: not a valid YAML object`);
      return null;
    }

    // Parse show field
    const show: "user" | "workflows" | undefined =
      parsed.show === "workflows" ? "workflows" : undefined;

    // Extract required fields
    if (typeof parsed.name !== "string" || !parsed.name) {
      console.warn(`[pi-workflows] Missing or invalid "name" in ${yamlPath}`);
      return null;
    }

    // commandName and initialMessage are required for user workflows, optional for subworkflow-only
    let commandName: string;
    let initialMessage: string;
    if (show === "workflows") {
      commandName = typeof parsed.commandName === "string" ? parsed.commandName : "";
      initialMessage = typeof parsed.initialMessage === "string" ? parsed.initialMessage : "";
    } else {
      if (typeof parsed.commandName !== "string" || !parsed.commandName) {
        console.warn(`[pi-workflows] Missing or invalid "commandName" in ${yamlPath}`);
        return null;
      }
      if (typeof parsed.initialMessage !== "string" || !parsed.initialMessage) {
        console.warn(`[pi-workflows] Missing or invalid "initialMessage" in ${yamlPath}`);
        return null;
      }
      commandName = parsed.commandName;
      initialMessage = parsed.initialMessage;
    }

    if (!Array.isArray(parsed.phases) || parsed.phases.length < 1) {
      console.warn(`[pi-workflows] Missing or invalid "phases" array in ${yamlPath}`);
      return null;
    }

    const workflow: WorkflowDefinition = {
      name: parsed.name,
      commandName,
      initialMessage,
      phases: [],
    };

    // Set show if parsed as 'workflows'
    if (show !== undefined) workflow.show = show;

    // Set loopable if explicitly boolean
    if (typeof parsed.loopable === "boolean") workflow.loopable = parsed.loopable;

    // Extract optional string fields
    if (typeof parsed.sessionNamePrefix === "string")
      workflow.sessionNamePrefix = parsed.sessionNamePrefix;
    if (typeof parsed.sessionNameMaxLength === "number")
      workflow.sessionNameMaxLength = parsed.sessionNameMaxLength;
    if (typeof parsed.roleInstruction === "string")
      workflow.roleInstruction = parsed.roleInstruction;
    if (typeof parsed.advanceReminder === "string")
      workflow.advanceReminder = parsed.advanceReminder;
    if (typeof parsed.blockReasonTemplate === "string")
      workflow.blockReasonTemplate = parsed.blockReasonTemplate;
    if (typeof parsed.completionMessage === "string")
      workflow.completionMessage = parsed.completionMessage;
    if (typeof parsed.notDoneReminder === "string")
      workflow.notDoneReminder = parsed.notDoneReminder;

    // Load each phase entry (string filename or subworkflow reference object)
    for (const phaseEntry of parsed.phases) {
      if (typeof phaseEntry === "string") {
        // String entry: load phase from .md file with path safety check

        // Path safety: always canonicalize to prevent traversal via symlinks or ../
        const canonicalRoot = realpathSync(resolve(workflowsRoot));
        const phaseFilePath = resolve(dirPath, phaseEntry);
        try {
          const canonicalPhase = realpathSync(phaseFilePath);
          if (!canonicalPhase.startsWith(canonicalRoot + sep)) {
            console.warn(
              `[pi-workflows] Phase file path escapes workflows root: ${phaseEntry} in ${yamlPath}`,
            );
            return null;
          }
        } catch {
          // File doesn't exist yet on disk; do a deterministic prefix check instead
          const resolvedPath = resolve(dirPath, phaseEntry);
          if (!resolvedPath.startsWith(canonicalRoot + sep)) {
            console.warn(
              `[pi-workflows] Phase file path escapes workflows root: ${phaseEntry} in ${yamlPath}`,
            );
            return null;
          }
        }

        const phasePath = join(dirPath, phaseEntry);
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

          workflow.phases.push(phase);
        } catch (phaseErr) {
          console.warn(
            `[pi-workflows] Failed to load phase file ${phasePath}: ${phaseErr instanceof Error ? phaseErr.message : phaseErr}`,
          );
          return null;
        }
      } else if (
        typeof phaseEntry === "object" &&
        phaseEntry !== null &&
        typeof phaseEntry.subworkflow === "string"
      ) {
        // Subworkflow reference placeholder — will be resolved in two-pass loading
        workflow.phases.push({
          subworkflow: true,
          workflowKey: String(phaseEntry.subworkflow),
          resolved: null, // Will be resolved in two-pass loading (Step 5)
        });
      } else {
        console.warn(
          `[pi-workflows] Invalid phase entry in ${yamlPath}: expected string or { subworkflow: key } object`,
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
export async function loadWorkflows(cwd?: string): Promise<Record<string, WorkflowDefinition>> {
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

  // Detect cycles in subworkflow references
  const cycleErrors = detectCycles(valid);
  if (cycleErrors.length > 0) {
    // Parse cycle keys from error messages
    // Messages are of the form: "Cycle detected: A → B → C → A. Skipping workflow \"A\"."
    const cycleKeys = new Set<string>();
    for (const msg of cycleErrors) {
      console.warn(`[pi-workflows] ${msg}`);
      // Extract keys between "Cycle detected: " and the period
      const match = msg.match(/^Cycle detected: (.+?)\. /);
      if (match) {
        const keys = match[1].split(" → ");
        for (const k of keys) {
          cycleKeys.add(k);
        }
      }
    }
    for (const key of cycleKeys) {
      delete valid[key];
    }
  }

  // Resolve subworkflow references
  // Repeat until no more deletions occur (handles cascading broken references)
  let changed = true;
  while (changed) {
    changed = false;
    const keysToRemove: string[] = [];
    for (const [key, def] of Object.entries(valid)) {
      for (const phase of def.phases) {
        if (isSubworkflowRef(phase) && phase.resolved === null) {
          const targetDef = valid[phase.workflowKey];
          if (!targetDef) {
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
    for (const key of keysToRemove) {
      delete valid[key];
      changed = true;
    }
  }

  // Check for duplicate commandNames
  const commandNameMap = new Map<string, string>();
  for (const [key, def] of Object.entries(valid)) {
    // Skip internal-only workflows (no commandName)
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
