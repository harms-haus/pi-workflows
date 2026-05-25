import type { WorkflowDefinition, PhaseDefinition, PhaseEntry } from "../types";
import { isSubworkflowRef } from "../types";

// ── Constants ──
export const VALID_COMMAND_NAME_RE = /^[a-zA-Z0-9_-]+$/;

// ── Validation helpers ──

function validateName(key: string, def: WorkflowDefinition): string | null {
  if (!def.name || typeof def.name !== "string" || def.name.trim() === "") {
    return `Workflow "${key}": name must be a non-empty string.`;
  }
  return null;
}

function validateUserFields(key: string, def: WorkflowDefinition): string | null {
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
  return null;
}

function validatePhaseTools(key: string, phase: PhaseDefinition): string | null {
  if (!phase.tools) return null;
  if (phase.tools.blacklist && !Array.isArray(phase.tools.blacklist)) {
    return `Workflow "${key}", phase "${phase.id}": blacklist must be an array.`;
  }
  if (phase.tools.whitelist && !Array.isArray(phase.tools.whitelist)) {
    return `Workflow "${key}", phase "${phase.id}": whitelist must be an array.`;
  }
  if (phase.tools.blacklist && phase.tools.whitelist) {
    return `Workflow "${key}", phase "${phase.id}": cannot set both blacklist and whitelist.`;
  }
  return null;
}

function validateConcretePhase(
  key: string,
  phase: PhaseDefinition,
  index: number,
  seenIds: Set<string>,
): string | null {
  if (!phase.id || typeof phase.id !== "string" || phase.id.trim() === "") {
    return `Workflow "${key}", phase[${index}]: id must be a non-empty string.`;
  }
  if (!phase.name || typeof phase.name !== "string" || phase.name.trim() === "") {
    return `Workflow "${key}", phase[${index}]: name must be a non-empty string.`;
  }
  if (!phase.emoji || typeof phase.emoji !== "string" || phase.emoji.trim() === "") {
    return `Workflow "${key}", phase[${index}]: emoji must be a non-empty string.`;
  }
  if (
    !phase.instructions ||
    typeof phase.instructions !== "string" ||
    phase.instructions.trim() === ""
  ) {
    return `Workflow "${key}", phase[${index}]: instructions must be a non-empty string.`;
  }
  if (seenIds.has(phase.id)) {
    return `Workflow "${key}", phase[${index}]: duplicate phase id "${phase.id}".`;
  }
  seenIds.add(phase.id);
  return validatePhaseTools(key, phase);
}

function validatePhaseEntry(
  key: string,
  phase: PhaseEntry,
  index: number,
  seenIds: Set<string>,
): string | null {
  if (isSubworkflowRef(phase)) {
    if (
      !phase.workflowKey ||
      typeof phase.workflowKey !== "string" ||
      phase.workflowKey.trim() === ""
    ) {
      return `Workflow "${key}", phase[${index}]: workflowKey must be a non-empty string.`;
    }
    return null;
  }
  return validateConcretePhase(key, phase, index, seenIds);
}

function validatePhases(key: string, def: WorkflowDefinition): string | null {
  if (!Array.isArray(def.phases) || def.phases.length < 1) {
    return `Workflow "${key}": phases must be an array with at least 1 element.`;
  }
  const seenIds = new Set<string>();
  for (let i = 0; i < def.phases.length; i++) {
    const phase = def.phases[i];
    if (!phase) continue;
    const err = validatePhaseEntry(key, phase, i, seenIds);
    if (err) return err;
  }
  return null;
}

// ── Validation ──

/**
 * Validates a workflow definition.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateWorkflowDefinition(key: string, def: WorkflowDefinition): string | null {
  const show = def.show ?? "user";

  let err = validateName(key, def);
  if (err) return err;

  if (show === "user") {
    err = validateUserFields(key, def);
    if (err) return err;
  }

  err = validatePhases(key, def);
  if (err) return err;

  if (def.loopable !== undefined && typeof def.loopable !== "boolean") {
    return `Workflow "${key}" has invalid loopable: must be a boolean`;
  }

  // Runtime check for show (type may be wider at runtime due to YAML parsing)
  const showValue = def.show as string | undefined;
  if (showValue !== undefined && showValue !== "user" && showValue !== "workflows") {
    return `Workflow "${key}" has invalid show: must be "user" or "workflows"`;
  }

  return null;
}

// ── Cycle Detection ──

/** Reconstruct the cycle path from a back edge. */
function reconstructCycle(
  startKey: string,
  neighbor: string,
  parent: Map<string, string>,
): string[] {
  const cycleKeys: string[] = [startKey];
  let cur: string = startKey;
  while (cur !== neighbor) {
    const p = parent.get(cur);
    if (p === undefined) break;
    cur = p;
    cycleKeys.push(cur);
  }
  cycleKeys.reverse();
  return cycleKeys;
}

/** Build an adjacency list from the workflow definitions. */
function buildAdjacencyList(
  definitions: Record<string, WorkflowDefinition>,
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const key of Object.keys(definitions)) {
    const neighbors: string[] = [];
    const def = definitions[key];
    if (!def) continue;
    for (const phase of def.phases) {
      if (isSubworkflowRef(phase) && phase.workflowKey in definitions) {
        neighbors.push(phase.workflowKey);
      }
    }
    adj.set(key, neighbors);
  }
  return adj;
}

/** Process a single neighbor in the DFS — returns true if a cycle was found. */
function processNeighbor(
  neighbor: string,
  topKey: string,
  parent: Map<string, string>,
  color: Map<string, number>,
  stack: Array<{ key: string; neighborIdx: number; phase: "enter" | "exit" }>,
  errors: string[],
): void {
  const WHITE = 0,
    GRAY = 1;
  const neighborColor = color.get(neighbor) ?? WHITE;

  if (neighborColor === GRAY) {
    parent.set(neighbor, topKey);
    const cycleKeys = reconstructCycle(topKey, neighbor, parent);
    errors.push(
      `Cycle detected: ${cycleKeys.join(" → ")} → ${cycleKeys[0]}. Skipping workflow "${cycleKeys[0]}".`,
    );
  } else if (neighborColor === WHITE) {
    parent.set(neighbor, topKey);
    stack.push({ key: neighbor, neighborIdx: 0, phase: "enter" });
  }
}

/**
 * Validates that the subworkflow reference graph is a DAG (no cycles).
 * Uses iterative DFS with 3-state coloring (WHITE/GRAY/BLACK).
 * Returns an array of error messages (empty = no cycles).
 */
export function detectCycles(definitions: Record<string, WorkflowDefinition>): string[] {
  const errors: string[] = [];
  const keys = Object.keys(definitions);
  const adj = buildAdjacencyList(definitions);

  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const key of keys) {
    color.set(key, WHITE);
  }

  for (const startKey of keys) {
    if (color.get(startKey) !== WHITE) continue;

    const parent = new Map<string, string>();
    const stack: Array<{ key: string; neighborIdx: number; phase: "enter" | "exit" }> = [
      { key: startKey, neighborIdx: 0, phase: "enter" },
    ];

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;

      if (top.phase === "enter") {
        color.set(top.key, GRAY);
        top.phase = "exit";
        top.neighborIdx = 0;
        continue;
      }

      const neighbors = adj.get(top.key) ?? [];
      if (top.neighborIdx < neighbors.length) {
        const neighbor = neighbors[top.neighborIdx];
        if (!neighbor) continue;
        top.neighborIdx++;
        processNeighbor(neighbor, top.key, parent, color, stack, errors);
        continue;
      }

      color.set(top.key, BLACK);
      stack.pop();
    }
  }

  return errors;
}
