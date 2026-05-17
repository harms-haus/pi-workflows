import type { WorkflowState, WorkflowDefinition, PhaseDefinition } from "../../types";

// ── state.test.ts Fixtures ──

/** Phase 1 - state.test.ts specific. */
export const STATE_PHASE_1: PhaseDefinition = {
  id: "p1",
  name: "Phase 1",
  emoji: "1️⃣",
  instructions: "Do phase 1",
};

/** Phase 2 - state.test.ts specific. */
export const STATE_PHASE_2: PhaseDefinition = {
  id: "p2",
  name: "Phase 2",
  emoji: "2️⃣",
  instructions: "Do phase 2",
};

/** Phase 3 - state.test.ts specific. */
export const STATE_PHASE_3: PhaseDefinition = {
  id: "p3",
  name: "Phase 3",
  emoji: "3️⃣",
  instructions: "Do phase 3",
};

/** Subworkflow Phase 1 - state.test.ts specific. */
export const STATE_SUB_PHASE_1: PhaseDefinition = {
  id: "sp1",
  name: "Sub Phase 1",
  emoji: "🔨",
  instructions: "Build",
};

/** Subworkflow Phase 2 - state.test.ts specific. */
export const STATE_SUB_PHASE_2: PhaseDefinition = {
  id: "sp2",
  name: "Sub Phase 2",
  emoji: "👁️",
  instructions: "Review",
};

/** Creates a subworkflow definition for state.test.ts. */
export function makeStateSubDef(): WorkflowDefinition {
  return {
    name: "Sub",
    commandName: "sub",
    initialMessage: "Start",
    show: "workflows",
    phases: [STATE_SUB_PHASE_1, STATE_SUB_PHASE_2],
  };
}

/** Creates a linear workflow definition for state.test.ts. */
export function makeStateLinearDef(): WorkflowDefinition {
  return {
    name: "Linear",
    commandName: "lin",
    initialMessage: "Start",
    phases: [STATE_PHASE_1, STATE_PHASE_2, STATE_PHASE_3],
  };
}

/** Creates a parent workflow definition for state.test.ts. */
export function makeStateParentDef(): WorkflowDefinition {
  const subDef = makeStateSubDef();
  return {
    name: "Parent",
    commandName: "par",
    initialMessage: "Start",
    phases: [
      STATE_PHASE_1,
      { subworkflow: true, workflowKey: "sub", resolved: subDef },
      STATE_PHASE_3,
    ],
  };
}

/** Creates the complete definitions map for state.test.ts. */
export function makeStateAllDefs(): Record<string, WorkflowDefinition> {
  return {
    linear: makeStateLinearDef(),
    parent: makeStateParentDef(),
    sub: makeStateSubDef(),
  };
}

// ── tool.test.ts Fixtures ──

/** Phase 1 - tool.test.ts specific. */
export const TOOL_PHASE_1: PhaseDefinition = {
  id: "p1",
  name: "Phase 1",
  emoji: "1️⃣",
  instructions: "Do first",
};

/** Phase 2 - tool.test.ts specific. */
export const TOOL_PHASE_2: PhaseDefinition = {
  id: "p2",
  name: "Phase 2",
  emoji: "2️⃣",
  instructions: "Do second",
};

/** Phase 3 - tool.test.ts specific. */
export const TOOL_PHASE_3: PhaseDefinition = {
  id: "p3",
  name: "Phase 3",
  emoji: "3️⃣",
  instructions: "Do third",
};

/** Subworkflow Phase 1 - tool.test.ts specific. */
export const TOOL_SUB_PHASE_1: PhaseDefinition = {
  id: "sp1",
  name: "Sub Phase 1",
  emoji: "🔨",
  instructions: "Build",
};

/** Subworkflow Phase 2 - tool.test.ts specific. */
export const TOOL_SUB_PHASE_2: PhaseDefinition = {
  id: "sp2",
  name: "Sub Phase 2",
  emoji: "👁️",
  instructions: "Review",
};

/** Creates a subworkflow definition for tool.test.ts. */
export function makeToolSubDef(): WorkflowDefinition {
  return {
    name: "Sub",
    commandName: "sub",
    initialMessage: "Start",
    show: "workflows" as const,
    phases: [TOOL_SUB_PHASE_1, TOOL_SUB_PHASE_2],
  };
}

/** Creates a linear workflow definition for tool.test.ts. */
export function makeToolLinearDef(): WorkflowDefinition {
  return {
    name: "Linear",
    commandName: "lin",
    initialMessage: "Start",
    phases: [TOOL_PHASE_1, TOOL_PHASE_2, TOOL_PHASE_3],
  };
}

/** Creates a parent workflow definition for tool.test.ts. */
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

/** Creates a workflow definition with looping disabled for tool.test.ts. */
export function makeToolNoLoopDef(): WorkflowDefinition {
  return {
    name: "NoLoop",
    commandName: "noloop",
    initialMessage: "Start",
    loopable: false,
    phases: [TOOL_PHASE_1, TOOL_PHASE_2],
  };
}

/** Creates the complete definitions map for tool.test.ts. */
export function makeToolAllDefs(): Record<string, WorkflowDefinition> {
  return {
    linear: makeToolLinearDef(),
    parent: makeToolParentDef(),
    sub: makeToolSubDef(),
    noloop: makeToolNoLoopDef(),
  };
}

/** Creates an active workflow state for tool.test.ts. */
export function makeToolActiveState(
  workflowKey: string,
  overrides: Partial<WorkflowState> = {},
): WorkflowState {
  return {
    active: true,
    workflowKey,
    currentPath: [{ workflowKey, phaseIndex: 0 }],
    globalStepCount: 0,
    taskId: "wf-test-123",
    taskDescription: "Test task",
    startedAt: Date.now(),
    completionNotified: false,
    cancelled: false,
    ...overrides,
  };
}

// ── prompts.test.ts Fixtures ──

/** Phase 1 - prompts.test.ts specific. */
export const PROMPTS_PHASE_1: PhaseDefinition = {
  id: "p1",
  name: "Phase 1",
  emoji: "1️⃣",
  instructions: "Do phase 1 stuff",
};

/** Phase 2 - prompts.test.ts specific. */
export const PROMPTS_PHASE_2: PhaseDefinition = {
  id: "p2",
  name: "Phase 2",
  emoji: "2️⃣",
  instructions: "Do phase 2 stuff",
};

/** Phase with profiles - prompts.test.ts specific. */
export const PROMPTS_PHASE_WITH_PROFILES: PhaseDefinition = {
  id: "pp",
  name: "Profile Phase",
  emoji: "👤",
  instructions: "Use profiles",
  availableProfiles: ["coder", "reviewer"],
};

/** Creates a linear workflow definition for prompts.test.ts. */
export function makePromptsLinearDef(): WorkflowDefinition {
  return {
    name: "Linear",
    commandName: "lin",
    initialMessage: "Start",
    phases: [PROMPTS_PHASE_1, PROMPTS_PHASE_2],
  };
}

// ── command.test.ts Fixtures ──

/** Phase 1 - command.test.ts specific. */
export const CMD_PHASE_1: PhaseDefinition = {
  id: "p1",
  name: "Phase 1",
  emoji: "1️⃣",
  instructions: "Do stuff",
};

/** Subworkflow Phase 1 - command.test.ts specific. */
export const CMD_SUB_PHASE_1: PhaseDefinition = {
  id: "sp1",
  name: "Sub Phase 1",
  emoji: "🔨",
  instructions: "Build",
};

/** Test workflow definition for command.test.ts. */
export const CMD_TEST_DEFINITION: WorkflowDefinition = {
  name: "Test",
  commandName: "test-cmd",
  initialMessage: "Starting {workflowName}",
  show: "user",
  phases: [CMD_PHASE_1],
};

/** Subworkflow definition for command.test.ts. */
export const CMD_SUB_DEFINITION: WorkflowDefinition = {
  name: "Sub",
  commandName: "sub-cmd",
  initialMessage: "Sub start",
  show: "workflows",
  phases: [CMD_SUB_PHASE_1],
};

/** Creates command test definitions map. */
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
