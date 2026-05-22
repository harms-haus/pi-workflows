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

/** Deep-clone a WorkflowState (copies the mutable currentPath array with new segment objects). */
export function cloneState(state: WorkflowState): WorkflowState {
  return {
    ...state,
    currentPath: state.currentPath.map((s) => ({ ...s })),
  };
}

/** Get a display name from a PhaseEntry (handles both PhaseDefinition and SubworkflowReference). */
export function phaseEntryName(entry: PhaseEntry): string {
  return isSubworkflowRef(entry) ? (entry.resolved?.name ?? entry.workflowKey) : entry.name;
}

/**
 * Auto-enter one or more nested SubworkflowRefs until a concrete PhaseDefinition is reached.
 * Returns a new state with segments pushed onto currentPath and the first concrete phase name,
 * or null if the subworkflow chain cannot be resolved.
 * The original state is not mutated.
 */
export function autoEnterSubworkflowRefs(
  state: WorkflowState,
  entry: SubworkflowReference,
): { phaseName: string | null; newState: WorkflowState } {
  if (!entry.resolved) return { phaseName: null, newState: state };

  const cloned = cloneState(state);
  cloned.currentPath.push({ workflowKey: entry.workflowKey, phaseIndex: 0 });

  const firstEntry = entry.resolved.phases[0];

  if (isSubworkflowRef(firstEntry)) {
    return autoEnterSubworkflowRefs(cloned, firstEntry);
  }

  return { phaseName: firstEntry.name, newState: cloned };
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
 * Returns a new state object — the original state is not mutated.
 */
export function advancePhase(
  state: WorkflowState,
  definitions: Record<string, WorkflowDefinition>,
): { advanced: true; from: string; to: string | null; newState: WorkflowState } {
  const s = cloneState(state);
  const top = s.currentPath[s.currentPath.length - 1];

  const topDef = definitions[top.workflowKey];

  const currentEntry = topDef.phases[top.phaseIndex];

  // Case 1: Entering a subworkflow
  if (isSubworkflowRef(currentEntry)) {
    s.currentPath.push({ workflowKey: currentEntry.workflowKey, phaseIndex: 0 });
    s.globalStepCount++;
    const subDef = definitions[currentEntry.workflowKey];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!subDef) {
      console.warn(
        `[pi-workflows] Missing definition for subworkflow '${currentEntry.workflowKey}' during advance.`,
      );
      s.active = false;
      s.completionNotified = false;
      return { advanced: true, from: phaseEntryName(currentEntry), to: null, newState: s };
    }
    const firstPhaseName = subDef.phases[0]
      ? phaseEntryName(subDef.phases[0])
      : currentEntry.workflowKey;
    return { advanced: true, from: phaseEntryName(currentEntry), to: firstPhaseName, newState: s };
  }

  // Case 2: Normal phase, not the last one — advance within current scope
  if (top.phaseIndex < topDef.phases.length - 1) {
    top.phaseIndex += 1;
    s.globalStepCount++;
    const nextEntry = topDef.phases[top.phaseIndex];
    if (isSubworkflowRef(nextEntry)) {
      const { phaseName: concreteName, newState: entered } = autoEnterSubworkflowRefs(s, nextEntry);
      return {
        advanced: true,
        from: currentEntry.name,
        to: concreteName ?? phaseEntryName(nextEntry),
        newState: entered,
      };
    }
    return { advanced: true, from: currentEntry.name, to: phaseEntryName(nextEntry), newState: s };
  }

  // Case 3: Last phase in current scope — top-level done
  if (s.currentPath.length === 1) {
    s.active = false;
    s.completionNotified = false;
    s.globalStepCount++;
    return { advanced: true, from: currentEntry.name, to: null, newState: s };
  }

  // Case 4: Last phase in subworkflow — breakout to parent
  // The subworkflow was the parent's last phase, so we may need to
  // keep popping until we find a parent with a next phase or reach top-level completion.
  s.currentPath.pop();
  s.globalStepCount++;

  // Loop: increment the parent's phase index and check if it has a next phase.
  // If the parent is also exhausted, pop again and continue.
  let newTop = s.currentPath[s.currentPath.length - 1];
  let newTopDef: WorkflowDefinition | undefined = definitions[newTop.workflowKey];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!newTopDef) {
    console.warn(`[pi-workflows] Missing definition for '${newTop.workflowKey}' during breakout.`);
    s.active = false;
    s.completionNotified = false;
    return { advanced: true, from: currentEntry.name, to: null, newState: s };
  }
  newTop.phaseIndex += 1;

  while (newTop.phaseIndex >= newTopDef.phases.length) {
    // Parent has no more phases — check if top-level
    if (s.currentPath.length === 1) {
      s.active = false;
      s.completionNotified = false;
      return { advanced: true, from: currentEntry.name, to: null, newState: s };
    }
    // Nested parent also exhausted — pop again and continue
    s.currentPath.pop();
    newTop = s.currentPath[s.currentPath.length - 1];
    newTopDef = definitions[newTop.workflowKey];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!newTopDef) {
      console.warn(
        `[pi-workflows] Missing definition for '${newTop.workflowKey}' during breakout.`,
      );
      s.active = false;
      s.completionNotified = false;
      return { advanced: true, from: currentEntry.name, to: null, newState: s };
    }
    newTop.phaseIndex += 1;
  }

  const nextEntry = newTopDef.phases[newTop.phaseIndex];
  if (isSubworkflowRef(nextEntry)) {
    const { phaseName: concreteName, newState: entered } = autoEnterSubworkflowRefs(s, nextEntry);
    return {
      advanced: true,
      from: currentEntry.name,
      to: concreteName ?? phaseEntryName(nextEntry),
      newState: entered,
    };
  }
  return { advanced: true, from: currentEntry.name, to: phaseEntryName(nextEntry), newState: s };
}

// ── Loop Phase ──

/**
 * Loop (restart) the current innermost workflow from phase 0.
 * Respects the workflow's `loopable` setting.
 * Returns a new state object — the original state is not mutated.
 */
export function loopPhase(
  state: WorkflowState,
  definitions: Record<string, WorkflowDefinition>,
): { looped: true; to: string; newState: WorkflowState } | { looped: false; error: string } {
  const top = state.currentPath[state.currentPath.length - 1];
  const topDef = definitions[top.workflowKey];

  if (topDef.loopable === false) {
    return { looped: false, error: "Looping is disabled for this workflow." };
  }

  const s = cloneState(state);
  s.currentPath[s.currentPath.length - 1] = {
    ...s.currentPath[s.currentPath.length - 1],
    phaseIndex: 0,
  };
  s.globalStepCount++;

  const firstEntry = topDef.phases[0];
  const firstPhaseName = phaseEntryName(firstEntry);
  return { looped: true, to: firstPhaseName, newState: s };
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

/** Validate that each segment in currentPath has the correct shape. */
function isValidPath(currentPath: unknown): currentPath is WorkflowState["currentPath"] {
  if (!Array.isArray(currentPath) || currentPath.length === 0) {
    console.warn("[pi-workflows] Invalid persisted state: empty currentPath. Discarding.");
    return false;
  }
  for (const seg of currentPath) {
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

/** Validate required and optional scalar fields on reconstructed state. */
function isValidFields(d: Record<string, unknown>): boolean {
  if (typeof d.active !== "boolean") return false;
  if (typeof d.workflowKey !== "string") return false;
  if (typeof d.globalStepCount !== "number") return false;
  if (typeof d.startedAt !== "number") return false;
  if (d.taskId !== undefined && typeof d.taskId !== "string") return false;
  if (d.completionNotified !== undefined && typeof d.completionNotified !== "boolean") return false;
  if (d.cancelled !== undefined && typeof d.cancelled !== "boolean") return false;
  return true;
}

/**
 * Validate that reconstructed state has all required fields with correct types.
 * Acts as a type guard so the caller can safely use the value as WorkflowState.
 * Returns true if valid, false if the state should be discarded.
 */
function validateReconstructedState(data: unknown): data is WorkflowState {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return isValidPath(d.currentPath) && isValidFields(d);
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
      return data;
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
