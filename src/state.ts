import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  WorkflowState,
  WorkflowDefinition,
  ActiveWorkflow,
  PhaseEntry,
  PhaseDefinition,
  SubworkflowReference,
} from "./types";
import { isSubworkflowRef, isPhaseDefinition } from "./types";

// ── Constants ──
const STATE_ENTRY_TYPE = "workflow:state";
const TASK_ID_PREFIX = "wf-";

// ── State Creation ──
/**
 * Create a fresh workflow state for a new workflow instance.
 */
export function createInitialState(workflowKey: string, description: string): WorkflowState {
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
  return isSubworkflowRef(entry) ? (entry.resolved?.name ?? entry.workflowKey) : entry.name;
}

/**
 * Auto-enter one or more nested SubworkflowRefs until a concrete PhaseDefinition is reached.
 * Pushes segments onto state.currentPath and returns the first concrete phase name,
 * or null if the subworkflow chain cannot be resolved.
 */
export function autoEnterSubworkflowRefs(
  state: WorkflowState,
  entry: SubworkflowReference,
): string | null {
  if (!entry.resolved) return null;

  state.currentPath.push({ workflowKey: entry.workflowKey, phaseIndex: 0 });

  const firstEntry = entry.resolved.phases[0];

  if (isSubworkflowRef(firstEntry)) {
    return autoEnterSubworkflowRefs(state, firstEntry);
  }

  return firstEntry.name;
}

/**
 * Resolve the first concrete PhaseDefinition from a phases array,
 * drilling through any nested SubworkflowReferences.
 * Returns null if the chain cannot be resolved (e.g. empty phases or unresolved refs).
 */
export function resolveFirstPhase(phases: PhaseEntry[]): PhaseDefinition | null {
  const first = phases[0];
  if (isPhaseDefinition(first)) return first;
  if (isSubworkflowRef(first)) {
    if (!first.resolved) return null;
    return resolveFirstPhase(first.resolved.phases);
  }
  return null;
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

  const topDef = definitions[top.workflowKey];

  const currentEntry = topDef.phases[top.phaseIndex];

  // Case 1: Entering a subworkflow
  if (isSubworkflowRef(currentEntry)) {
    state.currentPath.push({ workflowKey: currentEntry.workflowKey, phaseIndex: 0 });
    state.globalStepCount++;
    const subDef = definitions[currentEntry.workflowKey];
    const firstPhaseName = subDef.phases[0]
      ? phaseEntryName(subDef.phases[0])
      : currentEntry.workflowKey;
    return { advanced: true, from: phaseEntryName(currentEntry), to: firstPhaseName };
  }

  // Case 2: Normal phase, not the last one — advance within current scope
  if (top.phaseIndex < topDef.phases.length - 1) {
    top.phaseIndex += 1;
    state.globalStepCount++;
    const nextEntry = topDef.phases[top.phaseIndex];
    if (isSubworkflowRef(nextEntry)) {
      const concreteName = autoEnterSubworkflowRefs(state, nextEntry);
      return {
        advanced: true,
        from: currentEntry.name,
        to: concreteName ?? phaseEntryName(nextEntry),
      };
    }
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

  const nextEntry = newTopDef.phases[newTop.phaseIndex];
  if (isSubworkflowRef(nextEntry)) {
    const concreteName = autoEnterSubworkflowRefs(state, nextEntry);
    return {
      advanced: true,
      from: currentEntry.name,
      to: concreteName ?? phaseEntryName(nextEntry),
    };
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
    if (!(segment.workflowKey in definitions)) {
      console.warn(
        `[pi-workflows] Path segment references missing workflow '${segment.workflowKey}'`,
      );
      return null;
    }
  }

  // Get the innermost scope
  const top = state.currentPath[state.currentPath.length - 1];
  if (!(top.workflowKey in definitions)) return null;
  const topDef = definitions[top.workflowKey];

  if (top.phaseIndex >= topDef.phases.length) return null;
  const currentEntry = topDef.phases[top.phaseIndex];

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
    const firstPhase = resolveFirstPhase(currentEntry.resolved.phases);
    if (!firstPhase) {
      console.warn(
        `[pi-workflows] Could not resolve first phase of subworkflow "${currentEntry.workflowKey}".`,
      );
      return null;
    }
    currentPhase = firstPhase;
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
      emoji: isInnermost ? currentPhase.emoji : "",
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
  data?: unknown;
}

/**
 * Migrate old state format (currentPhaseIndex) to new format (currentPath).
 */
function migrateStateData(data: Record<string, unknown>): void {
  if (data.currentPhaseIndex !== undefined && !data.currentPath) {
    data.currentPath = [
      { workflowKey: data.workflowKey as string, phaseIndex: data.currentPhaseIndex as number },
    ];
    delete data.currentPhaseIndex;
  }
  if (data.currentPath && data.globalStepCount === undefined) {
    data.globalStepCount = (data.currentPath as Array<{ phaseIndex: number }>)[0]?.phaseIndex ?? 0;
  }
}

/**
 * Validate that reconstructed state has a valid currentPath.
 * Returns true if valid, false if the state should be discarded.
 */
function validateReconstructedState(data: Record<string, unknown>): boolean {
  if (!Array.isArray(data.currentPath) || (data.currentPath as unknown[]).length === 0) {
    console.warn("[pi-workflows] Invalid persisted state: empty currentPath. Discarding.");
    return false;
  }
  for (const seg of data.currentPath as Array<unknown>) {
    if (
      typeof seg !== "object" ||
      seg === null ||
      typeof (seg as Record<string, unknown>).workflowKey !== "string" ||
      typeof (seg as Record<string, unknown>).phaseIndex !== "number"
    ) {
      console.warn("[pi-workflows] Invalid persisted state: malformed path segment. Discarding.");
      return false;
    }
  }
  return true;
}

/**
 * Reconstruct workflow state from the session branch.
 * Scans entries in reverse order and finds the most recent state entry.
 */
export function reconstructState(ctx: {
  sessionManager: { getBranch: () => SessionEntry[] };
}): WorkflowState | null {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
      const rawData = entry.data as Record<string, unknown> | undefined;
      if (rawData?.workflowKey == null) continue;
      const data = { ...rawData };
      migrateStateData(data);
      if (!validateReconstructedState(data)) return null;
      return data as unknown as WorkflowState;
    }
  }
  return null;
}

// ── isActive Check ──
/**
 * Check if the workflow state is active.
 */
export function isActive(state: WorkflowState | null): state is WorkflowState {
  return state?.active === true;
}
