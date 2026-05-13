import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowState, WorkflowDefinition, ActiveWorkflow, PhaseEntry, PhaseDefinition } from "./types";
import { isSubworkflowRef, isPhaseDefinition } from "./types";

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
    currentPath: [{ workflowKey, phaseIndex: 0 }],
    globalStepCount: 0,
    taskId: `${TASK_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskDescription: description,
    startedAt: Date.now(),
    completionNotified: false,
    cancelled: false,
  };
}

// ── Helpers ──

/** Get a display name from a PhaseEntry (handles both PhaseDefinition and SubworkflowReference). */
function phaseEntryName(entry: PhaseEntry): string {
  return isSubworkflowRef(entry)
    ? (entry.resolved?.name ?? entry.workflowKey)
    : entry.name;
}

// ── State Advancement ──

/**
 * Advance to the next phase using stack-based navigation.
 * Handles subworkflow entry, normal advancement, subworkflow breakout,
 * and top-level completion.
 */
export function advancePhase(
  state: WorkflowState,
  definitions: Record<string, WorkflowDefinition>,
): { advanced: boolean; from: string; to: string | null } {
  const top = state.currentPath[state.currentPath.length - 1];
  if (!top) return { advanced: false, from: "", to: null };

  const topDef = definitions[top.workflowKey];
  if (!topDef) {
    console.warn(
      `[pi-workflows] Workflow definition "${top.workflowKey}" not found.`,
    );
    return { advanced: false, from: "", to: null };
  }

  const currentEntry = topDef.phases[top.phaseIndex];
  if (!currentEntry) {
    console.warn(
      `[pi-workflows] Phase index ${top.phaseIndex} out of bounds for workflow "${top.workflowKey}".`,
    );
    return { advanced: false, from: "", to: null };
  }

  // Case 1: Entering a subworkflow
  if (isSubworkflowRef(currentEntry)) {
    state.currentPath.push({ workflowKey: currentEntry.workflowKey, phaseIndex: 0 });
    state.globalStepCount++;
    const subDef = definitions[currentEntry.workflowKey];
    const firstPhaseName = subDef?.phases[0]
      ? phaseEntryName(subDef.phases[0])
      : currentEntry.workflowKey;
    return { advanced: true, from: phaseEntryName(currentEntry), to: firstPhaseName };
  }

  // Case 2: Normal phase, not the last one — advance within current scope
  if (top.phaseIndex < topDef.phases.length - 1) {
    top.phaseIndex += 1;
    state.globalStepCount++;
    const nextEntry = topDef.phases[top.phaseIndex];
    return { advanced: true, from: currentEntry.name, to: phaseEntryName(nextEntry) };
  }

  // Case 3: Last phase in current scope — top-level done
  if (state.currentPath.length === 1) {
    state.active = false;
    state.completionNotified = false;
    state.globalStepCount++;
    return { advanced: true, from: currentEntry.name, to: null };
  }

  // Case 4: Last phase in subworkflow — breakout to parent
  state.currentPath.pop();
  const newTop = state.currentPath[state.currentPath.length - 1];
  const newTopDef = definitions[newTop.workflowKey];
  newTop.phaseIndex += 1;
  state.globalStepCount++;

  const nextEntry = newTopDef?.phases[newTop.phaseIndex];
  if (!nextEntry) {
    // Parent is now past its last phase — next advancePhase call will handle it
    return { advanced: true, from: currentEntry.name, to: null };
  }
  return { advanced: true, from: currentEntry.name, to: phaseEntryName(nextEntry) };
}

// ── Loop Phase ──

/**
 * Loop (restart) the current innermost workflow from phase 0.
 * Respects the workflow's `loopable` setting.
 */
export function loopPhase(
  state: WorkflowState,
  definitions: Record<string, WorkflowDefinition>,
): { looped: boolean; to: string } | { error: string } {
  const top = state.currentPath[state.currentPath.length - 1];
  const topDef = definitions[top.workflowKey];

  if (topDef.loopable === false) {
    return { error: "Looping is disabled for this workflow." };
  }

  top.phaseIndex = 0;
  state.globalStepCount++;

  const firstEntry = topDef.phases[0];
  const firstPhaseName = phaseEntryName(firstEntry);
  return { looped: true, to: firstPhaseName };
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

  // Walk the path stack to validate all segments
  for (const segment of state.currentPath) {
    if (!definitions[segment.workflowKey]) {
      console.warn(
        `[pi-workflows] Workflow definition "${segment.workflowKey}" not found.`,
      );
      return null;
    }
  }

  // Get the innermost scope
  const top = state.currentPath[state.currentPath.length - 1];
  const topDef = definitions[top.workflowKey];

  const currentEntry = topDef.phases[top.phaseIndex];
  if (!currentEntry) {
    console.warn(
      `[pi-workflows] Phase index ${top.phaseIndex} out of bounds for workflow "${top.workflowKey}".`,
    );
    return null;
  }

  // Resolve the concrete PhaseDefinition (drill into subworkflow refs)
  let currentPhase: PhaseDefinition;
  if (isSubworkflowRef(currentEntry)) {
    // Drill into the subworkflow's first phase (which may itself be a subworkflow ref)
    if (!currentEntry.resolved) {
      console.warn(
        `[pi-workflows] Unresolved subworkflow reference at phase index ${top.phaseIndex} in "${top.workflowKey}".`,
      );
      return null;
    }
    const firstEntry = currentEntry.resolved.phases[0];
    currentPhase = isPhaseDefinition(firstEntry)
      ? firstEntry
      : (firstEntry as unknown as PhaseDefinition);
  } else {
    currentPhase = currentEntry;
  }

  const nextPhase: PhaseEntry | null = topDef.phases[top.phaseIndex + 1] ?? null;

  // Build breadcrumb from top-level to innermost
  const breadcrumb = state.currentPath.map((seg, idx) => {
    const segDef = definitions[seg.workflowKey];
    const isInnermost = idx === state.currentPath.length - 1;
    return {
      workflowKey: seg.workflowKey,
      name: segDef.name,
      phaseName: isInnermost ? currentPhase.name : segDef.name,
      emoji: isInnermost ? currentPhase.emoji : '',
    };
  });

  return {
    definition: definitions[state.currentPath[0].workflowKey],
    state,
    currentPhase,
    currentPhaseEntry: currentEntry,
    nextPhase,
    breadcrumb,
  };
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
      // Migration: old state has currentPhaseIndex, new state has currentPath
      const data = entry.data as Record<string, unknown>;
      if (data.currentPhaseIndex !== undefined && !data.currentPath) {
        data.currentPath = [{ workflowKey: data.workflowKey as string, phaseIndex: data.currentPhaseIndex as number }];
        delete data.currentPhaseIndex;
      }
      if (data.currentPath && data.globalStepCount === undefined) {
        data.globalStepCount = ((data.currentPath as Array<{phaseIndex: number}>)[0]?.phaseIndex) ?? 0;
      }

      // Validate reconstructed state to prevent crashes from tampered data
      if (!Array.isArray(data.currentPath) || (data.currentPath as unknown[]).length === 0) {
        console.warn('[pi-workflows] Invalid persisted state: empty currentPath. Discarding.');
        return null;
      }
      for (const seg of data.currentPath as Array<unknown>) {
        if (typeof seg !== 'object' || seg === null ||
            typeof (seg as Record<string, unknown>).workflowKey !== 'string' ||
            typeof (seg as Record<string, unknown>).phaseIndex !== 'number') {
          console.warn('[pi-workflows] Invalid persisted state: malformed path segment. Discarding.');
          return null;
        }
      }

      return data as unknown as WorkflowState;
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
