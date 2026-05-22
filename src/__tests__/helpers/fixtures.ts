import type {
  WorkflowState,
  WorkflowDefinition,
  PhaseDefinition,
  SubworkflowReference,
} from "../../types";

// ── Shared Builder Functions ──

let _phaseCounter = 0;

/**
 * Builds a valid phase definition with sensible defaults.
 * Auto-increments id/name if not provided.
 */
export function makePhaseDef(overrides: Partial<PhaseDefinition> = {}): PhaseDefinition {
  const n = ++_phaseCounter;
  return {
    id: `p${n}`,
    name: `Phase ${n}`,
    emoji: "1️⃣",
    instructions: `Do phase ${n}`,
    ...overrides,
  };
}

/**
 * Resets the auto-increment counter for makePhaseDef.
 * Call in beforeEach if your test relies on deterministic phase ids.
 */
export function resetPhaseCounter(): void {
  _phaseCounter = 0;
}

/**
 * Builds a valid workflow definition with sensible defaults.
 * Creates a single default phase if none provided.
 */
export function makeWorkflowDef(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: "Test Workflow",
    commandName: "test",
    initialMessage: "Start",
    phases: [makePhaseDef()],
    ...overrides,
  };
}

/**
 * Builds a subworkflow reference to another workflow.
 */
export function makeSubworkflowRef(
  overrides: Partial<SubworkflowReference> = {},
): SubworkflowReference {
  return {
    subworkflow: true,
    workflowKey: "sub",
    resolved: null,
    ...overrides,
  };
}

/**
 * Builds a valid workflow state with sensible defaults.
 */
export function makeWorkflowState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    active: true,
    workflowKey: "test-wf",
    currentPath: [{ workflowKey: "test-wf", phaseIndex: 0 }],
    globalStepCount: 0,
    taskId: "wf-test-123",
    taskDescription: "Test task",
    startedAt: Date.now(),
    completionNotified: false,
    cancelled: false,
    ...overrides,
  };
}

// ── Shared Phase Instances ──
// Used by both STATE_* and TOOL_* families (identical definitions).

const PHASE_1: PhaseDefinition = {
  id: "p1",
  name: "Phase 1",
  emoji: "1️⃣",
  instructions: "Do phase 1",
};
const PHASE_2: PhaseDefinition = {
  id: "p2",
  name: "Phase 2",
  emoji: "2️⃣",
  instructions: "Do phase 2",
};
const PHASE_3: PhaseDefinition = {
  id: "p3",
  name: "Phase 3",
  emoji: "3️⃣",
  instructions: "Do phase 3",
};
const SUB_PHASE_1: PhaseDefinition = {
  id: "sp1",
  name: "Sub Phase 1",
  emoji: "🔨",
  instructions: "Build",
};
const SUB_PHASE_2: PhaseDefinition = {
  id: "sp2",
  name: "Sub Phase 2",
  emoji: "👁️",
  instructions: "Review",
};

// ── Shared Workflow Builders ──

/** Creates a subworkflow definition (show: "workflows"). */
function _makeSubDef(): WorkflowDefinition {
  return {
    name: "Sub",
    commandName: "sub",
    initialMessage: "Start",
    show: "workflows",
    phases: [SUB_PHASE_1, SUB_PHASE_2],
  };
}

/** Creates a linear 3-phase workflow definition. */
function _makeLinearDef(): WorkflowDefinition {
  return {
    name: "Linear",
    commandName: "lin",
    initialMessage: "Start",
    phases: [PHASE_1, PHASE_2, PHASE_3],
  };
}

/** Creates a parent workflow definition with a subworkflow in the middle. */
function _makeParentDef(): WorkflowDefinition {
  const subDef = _makeSubDef();
  return {
    name: "Parent",
    commandName: "par",
    initialMessage: "Start",
    phases: [PHASE_1, { subworkflow: true, workflowKey: "sub", resolved: subDef }, PHASE_3],
  };
}

/**
 * Builds a definitions map with common test workflows.
 * Pass a partial map to add/override entries, or omit for the full default set.
 */
export function makeDefinitionsMap(
  workflows?: Record<string, WorkflowDefinition>,
): Record<string, WorkflowDefinition> {
  return {
    linear: _makeLinearDef(),
    parent: _makeParentDef(),
    sub: _makeSubDef(),
    ...workflows,
  };
}

// ── state.test.ts Fixtures ──

export const STATE_PHASE_1 = PHASE_1;
export const STATE_PHASE_2 = PHASE_2;
export const STATE_PHASE_3 = PHASE_3;
export const STATE_SUB_PHASE_1 = SUB_PHASE_1;
export const STATE_SUB_PHASE_2 = SUB_PHASE_2;

export function makeStateSubDef(): WorkflowDefinition {
  return _makeSubDef();
}

export function makeStateLinearDef(): WorkflowDefinition {
  return _makeLinearDef();
}

export function makeStateParentDef(): WorkflowDefinition {
  return _makeParentDef();
}

export function makeStateAllDefs(): Record<string, WorkflowDefinition> {
  return makeDefinitionsMap();
}

// ── tool.test.ts Fixtures ──

// NOTE: TOOL_PHASE_* constants intentionally have different instructions
// text from STATE_PHASE_*. Tests may assert on the exact instructions string,
// so we keep distinct objects for backward compatibility.
const _TOOL_PHASE_1: PhaseDefinition = { ...PHASE_1, instructions: "Do first" };
const _TOOL_PHASE_2: PhaseDefinition = { ...PHASE_2, instructions: "Do second" };
const _TOOL_PHASE_3: PhaseDefinition = { ...PHASE_3, instructions: "Do third" };

export const TOOL_PHASE_1 = _TOOL_PHASE_1;
export const TOOL_PHASE_2 = _TOOL_PHASE_2;
export const TOOL_PHASE_3 = _TOOL_PHASE_3;
export const TOOL_SUB_PHASE_1 = SUB_PHASE_1;
export const TOOL_SUB_PHASE_2 = SUB_PHASE_2;

export function makeToolSubDef(): WorkflowDefinition {
  return {
    name: "Sub",
    commandName: "sub",
    initialMessage: "Start",
    show: "workflows" as const,
    phases: [TOOL_SUB_PHASE_1, TOOL_SUB_PHASE_2],
  };
}

export function makeToolLinearDef(): WorkflowDefinition {
  return {
    name: "Linear",
    commandName: "lin",
    initialMessage: "Start",
    phases: [TOOL_PHASE_1, TOOL_PHASE_2, TOOL_PHASE_3],
  };
}

export function makeToolParentDef(): WorkflowDefinition {
  const subDef = makeToolSubDef();
  return {
    name: "Parent",
    commandName: "par",
    initialMessage: "Start",
    phases: [
      TOOL_PHASE_1,
      { subworkflow: true, workflowKey: "sub", resolved: subDef },
      TOOL_PHASE_3,
    ],
  };
}

export function makeToolNoLoopDef(): WorkflowDefinition {
  return {
    name: "NoLoop",
    commandName: "noloop",
    initialMessage: "Start",
    loopable: false,
    phases: [TOOL_PHASE_1, TOOL_PHASE_2],
  };
}

export function makeToolAllDefs(): Record<string, WorkflowDefinition> {
  return {
    linear: makeToolLinearDef(),
    parent: makeToolParentDef(),
    sub: makeToolSubDef(),
    noloop: makeToolNoLoopDef(),
  };
}

export function makeToolActiveState(
  workflowKey: string,
  overrides: Partial<WorkflowState> = {},
): WorkflowState {
  return makeWorkflowState({
    workflowKey,
    currentPath: [{ workflowKey, phaseIndex: 0 }],
    ...overrides,
  });
}

// ── prompts.test.ts Fixtures ──

const _PROMPTS_PHASE_1: PhaseDefinition = { ...PHASE_1, instructions: "Do phase 1 stuff" };
const _PROMPTS_PHASE_2: PhaseDefinition = { ...PHASE_2, instructions: "Do phase 2 stuff" };

export const PROMPTS_PHASE_1 = _PROMPTS_PHASE_1;
export const PROMPTS_PHASE_2 = _PROMPTS_PHASE_2;
export const PROMPTS_PHASE_WITH_PROFILES: PhaseDefinition = {
  id: "pp",
  name: "Profile Phase",
  emoji: "👤",
  instructions: "Use profiles",
  availableProfiles: ["coder", "reviewer"],
};

export function makePromptsLinearDef(): WorkflowDefinition {
  return {
    name: "Linear",
    commandName: "lin",
    initialMessage: "Start",
    phases: [PROMPTS_PHASE_1, PROMPTS_PHASE_2],
  };
}

// ── command.test.ts Fixtures ──

const _CMD_PHASE_1: PhaseDefinition = { ...PHASE_1, instructions: "Do stuff" };
const _CMD_SUB_PHASE_1: PhaseDefinition = { ...SUB_PHASE_1 };

export const CMD_PHASE_1 = _CMD_PHASE_1;
export const CMD_SUB_PHASE_1 = _CMD_SUB_PHASE_1;

export const CMD_TEST_DEFINITION: WorkflowDefinition = {
  name: "Test",
  commandName: "test-cmd",
  initialMessage: "Starting {workflowName}",
  show: "user",
  phases: [CMD_PHASE_1],
};

export const CMD_SUB_DEFINITION: WorkflowDefinition = {
  name: "Sub",
  commandName: "sub-cmd",
  initialMessage: "Sub start",
  show: "workflows",
  phases: [CMD_SUB_PHASE_1],
};

export function makeCommandDefs(): Record<string, WorkflowDefinition> {
  return {
    "test-workflow": CMD_TEST_DEFINITION,
    "sub-workflow": CMD_SUB_DEFINITION,
  };
}

// ── Legacy Fixtures ──

/** Creates a minimal workflow definition map for testing. */
export function makeDefinition(): Record<string, WorkflowDefinition> {
  return {
    "test-wf": {
      name: "Test Workflow",
      commandName: "test",
      initialMessage: "Start",
      phases: [
        {
          id: "p1",
          name: "Phase 1",
          emoji: "🔍",
          instructions: "Do something",
        },
      ],
    },
  };
}

/** Creates a minimal active workflow state for testing. */
export function makeActiveState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return makeWorkflowState(overrides);
}
