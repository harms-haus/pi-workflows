import { describe, it, expect } from "vitest";
import {
  buildContextPrompt,
  DEFAULT_NOT_DONE_REMINDER,
  DEFAULT_COMPLETION_MESSAGE,
  DEFAULT_CANCELLED_MESSAGE,
} from "../prompts";
import type {
  PhaseDefinition,
  WorkflowDefinition,
  ActiveWorkflow,
  WorkflowState,
  PathSegment,
  PhaseEntry,
} from "../types";

// ── Helpers ──

const phase1: PhaseDefinition = {
  id: "p1",
  name: "Phase 1",
  emoji: "1️⃣",
  instructions: "Do phase 1 stuff",
};
const phase2: PhaseDefinition = {
  id: "p2",
  name: "Phase 2",
  emoji: "2️⃣",
  instructions: "Do phase 2 stuff",
};
const phaseWithProfiles: PhaseDefinition = {
  id: "pp",
  name: "Profile Phase",
  emoji: "👤",
  instructions: "Use profiles",
  availableProfiles: ["coder", "reviewer"],
};

const linearDef: WorkflowDefinition = {
  name: "Linear",
  commandName: "lin",
  initialMessage: "Start",
  phases: [phase1, phase2],
};

function makeActive(
  def: WorkflowDefinition,
  stateOverrides: Partial<WorkflowState> = {},
  pathOverrides?: PathSegment[],
): ActiveWorkflow {
  const state: WorkflowState = {
    active: true,
    workflowKey: "test",
    currentPath: pathOverrides ?? [{ workflowKey: "test", phaseIndex: 0 }],
    globalStepCount: 0,
    taskId: "wf-123",
    taskDescription: "test task",
    startedAt: 1000,
    completionNotified: false,
    cancelled: false,
    ...stateOverrides,
  };
  const defs: Record<string, WorkflowDefinition> = { test: def };
  // Use resolveActive-like logic to build the ActiveWorkflow
  const top = state.currentPath[state.currentPath.length - 1];
  const topDef = defs[top.workflowKey] ?? def;
  const currentEntry = topDef.phases[top.phaseIndex];
  const currentPhase = currentEntry as PhaseDefinition;
  const nextPhase: PhaseEntry | null = topDef.phases[top.phaseIndex + 1] ?? null;

  return {
    definition: def,
    state,
    currentPhase,
    currentPhaseEntry: currentEntry,
    nextPhase,
    breadcrumb: state.currentPath.map((seg, idx) => {
      const segDef = defs[seg.workflowKey] ?? def;
      const isInnermost = idx === state.currentPath.length - 1;
      return {
        workflowKey: seg.workflowKey,
        name: segDef.name,
        phaseName: isInnermost ? currentPhase.name : segDef.name,
        emoji: isInnermost ? currentPhase.emoji : "",
      };
    }),
  };
}

// ── buildContextPrompt ──

describe("buildContextPrompt", () => {
  it("linear workflow: includes phase name, instructions, progress", () => {
    const active = makeActive(linearDef);
    const prompt = buildContextPrompt(active);

    expect(prompt).toContain("Phase 1");
    expect(prompt).toContain("Do phase 1 stuff");
    expect(prompt).toContain("Progress");
    expect(prompt).toContain("1/2 phases");
  });

  it("nested workflow: includes breadcrumb path line", () => {
    const subPhase: PhaseDefinition = {
      id: "sp1",
      name: "Sub Phase",
      emoji: "🔧",
      instructions: "Sub work",
    };
    const subDef: WorkflowDefinition = {
      name: "Sub",
      commandName: "sub",
      initialMessage: "Start",
      show: "workflows",
      phases: [subPhase],
    };
    const parentDef: WorkflowDefinition = {
      name: "Parent",
      commandName: "par",
      initialMessage: "Start",
      phases: [phase1, { subworkflow: true, workflowKey: "sub", resolved: subDef }],
    };

    // Simulate being inside the subworkflow at sub[0]
    const state: WorkflowState = {
      active: true,
      workflowKey: "parent",
      currentPath: [
        { workflowKey: "parent", phaseIndex: 1 },
        { workflowKey: "sub", phaseIndex: 0 },
      ],
      globalStepCount: 3,
      taskId: "wf-123",
      taskDescription: "test task",
      startedAt: 1000,
      completionNotified: false,
      cancelled: false,
    };

    const defs: Record<string, WorkflowDefinition> = {
      parent: parentDef,
      sub: subDef,
    };

    // Resolve active properly using the state module logic
    const innerSegment = state.currentPath[state.currentPath.length - 1];
    const innerDef = defs[innerSegment.workflowKey];
    const currentEntry = innerDef.phases[innerSegment.phaseIndex];
    const currentPhase = currentEntry as PhaseDefinition;
    const nextPhase: PhaseEntry | null = innerDef.phases[innerSegment.phaseIndex + 1] ?? null;

    const active: ActiveWorkflow = {
      definition: parentDef,
      state,
      currentPhase,
      currentPhaseEntry: currentEntry,
      nextPhase,
      breadcrumb: [
        {
          workflowKey: "parent",
          name: parentDef.name,
          phaseName: parentDef.name,
          emoji: "",
        },
        {
          workflowKey: "sub",
          name: subDef.name,
          phaseName: subPhase.name,
          emoji: subPhase.emoji,
        },
      ],
    };

    const prompt = buildContextPrompt(active);
    expect(prompt).toContain("[Workflow path:");
    expect(prompt).toContain("Parent");
    expect(prompt).toContain("Sub");
    expect(prompt).toContain("Sub Phase");
  });

  it("all template variables resolved", () => {
    const active = makeActive(linearDef);
    const prompt = buildContextPrompt(active);

    // No unresolved {varName} should remain
    const unresolved = prompt.match(/\{[a-zA-Z_]+\}/g);
    expect(unresolved).toBeNull();
  });

  it("available profiles shown", () => {
    const defWithProfiles: WorkflowDefinition = {
      name: "Profiled",
      commandName: "prof",
      initialMessage: "Start",
      phases: [phaseWithProfiles, phase2],
    };
    const active = makeActive(defWithProfiles);
    const prompt = buildContextPrompt(active);

    expect(prompt).toContain("coder");
    expect(prompt).toContain("reviewer");
    expect(prompt).toContain("Available subagent profiles");
  });
});

// ── collectAllProfiles (tested via prompt output) ──

describe("collectAllProfiles (via buildContextPrompt)", () => {
  it("includes profiles from subworkflow phases", () => {
    const subWithProfile: PhaseDefinition = {
      id: "sp",
      name: "Sub Phase",
      emoji: "🔧",
      instructions: "Sub work",
      availableProfiles: ["builder"],
    };
    const subDef: WorkflowDefinition = {
      name: "Sub",
      commandName: "sub",
      initialMessage: "Start",
      show: "workflows",
      phases: [subWithProfile],
    };
    const parentDef: WorkflowDefinition = {
      name: "Parent",
      commandName: "par",
      initialMessage: "Start",
      phases: [phaseWithProfiles, { subworkflow: true, workflowKey: "sub", resolved: subDef }],
    };

    // Active at phase 0 (phaseWithProfiles) of parent
    const active = makeActive(parentDef);
    const prompt = buildContextPrompt(active);

    // "All profiles" should include both parent and subworkflow profiles
    expect(prompt).toContain("All profiles:");
    expect(prompt).toContain("coder");
    expect(prompt).toContain("reviewer");
    expect(prompt).toContain("builder");
  });
});

// ── getPreviousPhaseName (tested via buildContextPrompt output) ──

describe("getPreviousPhaseName (via buildContextPrompt)", () => {
  it("first phase shows (start)", () => {
    // Use instructions that reference {previousPhaseName}
    const defWithPrev: WorkflowDefinition = {
      name: "Prev",
      commandName: "prev",
      initialMessage: "Start",
      phases: [
        {
          id: "p1",
          name: "Phase 1",
          emoji: "1️⃣",
          instructions: "Previous was: {previousPhaseName}",
        },
        {
          id: "p2",
          name: "Phase 2",
          emoji: "2️⃣",
          instructions: "Previous was: {previousPhaseName}",
        },
      ],
    };
    const active = makeActive(defWithPrev); // at phase index 0
    const prompt = buildContextPrompt(active);
    expect(prompt).toContain("Previous was: (start)");
  });

  it("later phase shows previous phase name", () => {
    const defWithPrev: WorkflowDefinition = {
      name: "Prev",
      commandName: "prev",
      initialMessage: "Start",
      phases: [
        {
          id: "p1",
          name: "Phase 1",
          emoji: "1️⃣",
          instructions: "Previous was: {previousPhaseName}",
        },
        {
          id: "p2",
          name: "Phase 2",
          emoji: "2️⃣",
          instructions: "Previous was: {previousPhaseName}",
        },
      ],
    };
    // At phase index 1 (Phase 2), previous should be Phase 1
    const active = makeActive(defWithPrev, {}, [{ workflowKey: "test", phaseIndex: 1 }]);
    // Fix the currentPhase and nextPhase manually for index 1
    const correctedActive: ActiveWorkflow = {
      ...active,
      currentPhase: defWithPrev.phases[1] as PhaseDefinition,
      currentPhaseEntry: defWithPrev.phases[1],
      nextPhase: null,
    };
    const prompt = buildContextPrompt(correctedActive);

    expect(prompt).toContain("Previous was: Phase 1");
  });
});

// ── Default Messages ──

describe("default message constants", () => {
  it("DEFAULT_NOT_DONE_REMINDER contains template variables", () => {
    expect(DEFAULT_NOT_DONE_REMINDER).toContain("{workflowName}");
    expect(DEFAULT_NOT_DONE_REMINDER).toContain("{phaseName}");
  });

  it("DEFAULT_COMPLETION_MESSAGE contains template variables", () => {
    expect(DEFAULT_COMPLETION_MESSAGE).toContain("{workflowName}");
    expect(DEFAULT_COMPLETION_MESSAGE).toContain("{taskDescription}");
  });

  it("DEFAULT_CANCELLED_MESSAGE contains template variables", () => {
    expect(DEFAULT_CANCELLED_MESSAGE).toContain("{workflowName}");
    expect(DEFAULT_CANCELLED_MESSAGE).toContain("{taskDescription}");
  });
});
