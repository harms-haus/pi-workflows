import type { WorkflowDefinition } from "../types";
import { isSubworkflowRef } from "../types";
import { detectCycles } from "./validation";

// ── Post-processing helpers for loadWorkflows ──

/** Remove entries with given keys from the record, returning a new record. */
export function removeKeys(
  record: Record<string, WorkflowDefinition>,
  keys: Iterable<string>,
): Record<string, WorkflowDefinition> {
  const keySet = new Set(keys);
  return Object.fromEntries(Object.entries(record).filter(([k]) => !keySet.has(k)));
}

/** Detect and remove workflow definitions with cyclic subworkflow references. */
export function removeCycles(
  valid: Record<string, WorkflowDefinition>,
): Record<string, WorkflowDefinition> {
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
export function resolveSubworkflowRefs(
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
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard: Record values can be undefined at runtime
          if (!(phase.workflowKey in current) || !targetDef) {
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
export function checkDuplicateCommandNames(valid: Record<string, WorkflowDefinition>): void {
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
