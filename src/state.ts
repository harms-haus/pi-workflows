import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowState, WorkflowDefinition, ActiveWorkflow } from "./types";

// ── Constants ──
const STATE_ENTRY_TYPE = "workflow:state";
const TASK_ID_PREFIX = "wf-";

// ── State Creation ──
/**
 * Create a fresh workflow state for a new workflow instance.
 */
export function createInitialState(
  workflowKey: string,
  description: string,
): WorkflowState {
  return {
    active: true,
    workflowKey,
    currentPhaseIndex: 0,
    taskId: `${TASK_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskDescription: description,
    startedAt: Date.now(),
    completionNotified: false,
    cancelled: false,
  };
}

// ── State Advancement ──
/**
 * Advance to the next phase.
 * Returns { advanced: true, from, to } where to is null when advancing to DONE.
 * If already on the last phase, sets state.active = false and returns { to: null }.
 */
export function advancePhase(
  state: WorkflowState,
  definition: WorkflowDefinition,
): { advanced: boolean; from: string; to: string | null } {
  const phases = definition.phases;
  const fromPhase = phases[state.currentPhaseIndex];
  const from = fromPhase.name;

  if (state.currentPhaseIndex >= phases.length - 1) {
    // Already on the last phase — advancing to DONE
    state.active = false;
    state.completionNotified = false;
    return { advanced: true, from, to: null };
  }

  state.currentPhaseIndex += 1;
  return { advanced: true, from, to: phases[state.currentPhaseIndex].name };
}

// ── Active Workflow Resolution ──
/**
 * Resolve the active workflow from state + definitions.
 * Returns null if state is null/inactive, definition is missing, or phase index is out of bounds.
 */
export function resolveActive(
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
): ActiveWorkflow | null {
  if (!state || !state.active) return null;

  const definition = definitions[state.workflowKey];
  if (!definition) {
    console.warn(`[pi-workflows] Workflow definition "${state.workflowKey}" not found.`);
    return null;
  }

  const currentPhase = definition.phases[state.currentPhaseIndex];
  if (!currentPhase) {
    console.warn(
      `[pi-workflows] Phase index ${state.currentPhaseIndex} out of bounds for workflow "${state.workflowKey}".`,
    );
    return null;
  }

  const nextPhase = definition.phases[state.currentPhaseIndex + 1] ?? null;
  return { definition, state, currentPhase, nextPhase };
}

// ── State Persistence ──
/**
 * Persist state to session via pi.appendEntry.
 */
export function persistState(pi: ExtensionAPI, state: WorkflowState): void {
  pi.appendEntry(STATE_ENTRY_TYPE, { ...state });
}

// ── State Reconstruction ──
interface SessionEntry {
  type: string;
  customType?: string;
  data?: Record<string, unknown>;
}

/**
 * Reconstruct workflow state from the session branch.
 * Scans entries in reverse order and finds the most recent state entry.
 */
export function reconstructState(ctx: { sessionManager: { getBranch: () => SessionEntry[] } }): WorkflowState | null {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (
      entry.type === "custom" &&
      entry.customType === STATE_ENTRY_TYPE &&
      entry.data?.workflowKey != null
    ) {
      return entry.data as WorkflowState;
    }
  }
  return null;
}

// ── isActive Check ──
/**
 * Check if the workflow state is active.
 */
export function isActive(state: WorkflowState | null): boolean {
  return state?.active === true;
}
