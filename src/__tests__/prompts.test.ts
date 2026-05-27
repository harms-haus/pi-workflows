import { describe, it, expect } from "vitest";
import {
  buildContextPrompt,
  flattenAllPhases,
  DEFAULT_NOT_DONE_REMINDER,
  DEFAULT_COMPLETION_MESSAGE,
  DEFAULT_CANCELLED_MESSAGE,
} from "../prompts";
import type {
  PhaseDefinition,
  SubworkflowReference,
  WorkflowDefinition,
  ActiveWorkflow,
  WorkflowState,
  PathSegment,
  PhaseEntry,
} from "../types";
import {
  PROMPTS_PHASE_1 as phase1,
  PROMPTS_PHASE_2 as phase2,
  PROMPTS_PHASE_WITH_PROFILES as phaseWithProfiles,
  makePromptsLinearDef,
} from "./helpers/fixtures";

// ── Test Fixture Definitions (from shared helpers) ──

const linearDef = makePromptsLinearDef();

// ── Helpers ──

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
  const top = state.currentPath[state.currentPath.length - 1]!;
  const topDef = defs[top.workflowKey] ?? def;
  const currentEntry = topDef.phases[top.phaseIndex]!;
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
    const innerSegment = state.currentPath[state.currentPath.length - 1]!;
    const innerDef = defs[innerSegment.workflowKey]!;
    const currentEntry = innerDef.phases[innerSegment.phaseIndex]!;
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
      currentPhaseEntry: defWithPrev.phases[1]!,
      nextPhase: null,
    };
    const prompt = buildContextPrompt(correctedActive);

    expect(prompt).toContain("Previous was: Phase 1");
  });
});

// ── Nested progress with SubworkflowRef ──

describe("buildContextPrompt — nested progress with SubworkflowRef", () => {
  it("shows inner phase count from resolved subworkflow when currentPhaseEntry is resolved SubworkflowRef", () => {
    const subPhase1: PhaseDefinition = {
      id: "sp1",
      name: "Sub Phase 1",
      emoji: "🔧",
      instructions: "Sub work 1",
    };
    const subPhase2: PhaseDefinition = {
      id: "sp2",
      name: "Sub Phase 2",
      emoji: "🔩",
      instructions: "Sub work 2",
    };
    const subDef: WorkflowDefinition = {
      name: "Sub",
      commandName: "sub",
      initialMessage: "Start",
      show: "workflows",
      phases: [subPhase1, subPhase2],
    };
    const parentDef: WorkflowDefinition = {
      name: "Parent",
      commandName: "par",
      initialMessage: "Start",
      phases: [phase1, { subworkflow: true, workflowKey: "sub", resolved: subDef }],
    };

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

    const defs: Record<string, WorkflowDefinition> = { parent: parentDef, sub: subDef };
    const innerSegment = state.currentPath[state.currentPath.length - 1]!;
    const innerDef = defs[innerSegment.workflowKey]!;
    const currentEntry = innerDef.phases[innerSegment.phaseIndex]!;
    const currentPhase = currentEntry as PhaseDefinition;
    const nextPhase: PhaseEntry | null = innerDef.phases[innerSegment.phaseIndex + 1] ?? null;

    const active: ActiveWorkflow = {
      definition: parentDef,
      state,
      currentPhase,
      currentPhaseEntry: { subworkflow: true, workflowKey: "sub", resolved: subDef },
      nextPhase,
      breadcrumb: [
        { workflowKey: "parent", name: parentDef.name, phaseName: parentDef.name, emoji: "" },
        {
          workflowKey: "sub",
          name: subDef.name,
          phaseName: subPhase1.name,
          emoji: subPhase1.emoji,
        },
      ],
    };

    const prompt = buildContextPrompt(active);
    // Should show progress from the resolved subworkflow's phases.length (2)
    expect(prompt).toContain("1/2 in current scope");
  });
});

// ── Blocked tools ──

describe("buildContextPrompt — blocked tools", () => {
  it("shows blocked tools when phase has a blacklist", () => {
    const phaseWithBlacklist: PhaseDefinition = {
      id: "p1",
      name: "Restricted Phase",
      emoji: "🔒",
      instructions: "Blocked: {blockedToolsList}",
      tools: { blacklist: ["edit", "write"] },
    };
    const defWithBlacklist: WorkflowDefinition = {
      name: "Restricted",
      commandName: "restricted",
      initialMessage: "Start",
      phases: [phaseWithBlacklist],
    };
    const active = makeActive(defWithBlacklist);
    const prompt = buildContextPrompt(active);
    expect(prompt).toContain("Blocked: edit, write");
  });
});

// ── collectAllProfiles with unresolved subworkflow ref ──

describe("collectAllProfiles — unresolved subworkflow ref", () => {
  it("skips unresolved subworkflow refs in profile collection", () => {
    const parentDef: WorkflowDefinition = {
      name: "Parent",
      commandName: "par",
      initialMessage: "Start",
      phases: [phaseWithProfiles, { subworkflow: true, workflowKey: "missing", resolved: null }],
    };
    const active = makeActive(parentDef);
    const prompt = buildContextPrompt(active);
    // Should still show parent profiles without crashing
    expect(prompt).toContain("All profiles:");
    expect(prompt).toContain("coder");
    expect(prompt).toContain("reviewer");
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

// ── flattenAllPhases ──

describe("flattenAllPhases", () => {
  it("flattens a simple linear workflow", () => {
    const result = flattenAllPhases([phase1, phase2]);
    expect(result.length).toBe(2);
    expect(result[0]!.name).toBe("Phase 1");
    expect(result[1]!.name).toBe("Phase 2");
  });

  it("flattens subworkflow phases inline", () => {
    const innerPhase1: PhaseDefinition = {
      id: "sp1",
      name: "Sub 1",
      emoji: "🔧",
      instructions: "sub 1",
    };
    const innerPhase2: PhaseDefinition = {
      id: "sp2",
      name: "Sub 2",
      emoji: "🔩",
      instructions: "sub 2",
    };
    const subRef: SubworkflowReference = {
      subworkflow: true,
      workflowKey: "inner",
      resolved: {
        name: "Inner",
        commandName: "inner",
        initialMessage: "Start",
        phases: [innerPhase1, innerPhase2],
      },
    };
    const result = flattenAllPhases([phase1, subRef, phase2]);
    expect(result.length).toBe(4);
    expect(result.map((p) => p.name)).toEqual(["Phase 1", "Sub 1", "Sub 2", "Phase 2"]);
  });

  it("skips unresolved subworkflow refs", () => {
    const result = flattenAllPhases([
      phase1,
      { subworkflow: true, workflowKey: "missing", resolved: null },
    ]);
    expect(result.length).toBe(1);
    expect(result[0]!.name).toBe("Phase 1");
  });

  it("handles nested subworkflows", () => {
    const deepPhase1: PhaseDefinition = {
      id: "dp1",
      name: "Deep 1",
      emoji: "🎯",
      instructions: "deep 1",
    };
    const deepPhase2: PhaseDefinition = {
      id: "dp2",
      name: "Deep 2",
      emoji: "🎪",
      instructions: "deep 2",
    };
    const innerPhase: PhaseDefinition = {
      id: "ip1",
      name: "Inner",
      emoji: "🔮",
      instructions: "inner",
    };
    const outerPhase: PhaseDefinition = {
      id: "op1",
      name: "Outer",
      emoji: "🌍",
      instructions: "outer",
    };

    const deepSubRef: SubworkflowReference = {
      subworkflow: true,
      workflowKey: "deep",
      resolved: {
        name: "Deep",
        commandName: "deep",
        initialMessage: "Start",
        phases: [deepPhase1, deepPhase2],
      },
    };
    const subRefA: SubworkflowReference = {
      subworkflow: true,
      workflowKey: "subA",
      resolved: {
        name: "SubA",
        commandName: "subA",
        initialMessage: "Start",
        phases: [deepSubRef, innerPhase],
      },
    };

    const result = flattenAllPhases([outerPhase, subRefA]);
    expect(result.map((p) => p.name)).toEqual(["Outer", "Deep 1", "Deep 2", "Inner"]);
  });
});

// ── buildContextPrompt — all steps list ──

describe("buildContextPrompt — all steps list", () => {
  it("includes numbered step list with all phases", () => {
    const phase3: PhaseDefinition = {
      id: "p3",
      name: "Phase 3",
      emoji: "3️⃣",
      instructions: "Do 3",
    };
    const def: WorkflowDefinition = {
      name: "Three",
      commandName: "three",
      initialMessage: "Start",
      phases: [phase1, phase2, phase3],
    };
    const active = makeActive(def);
    const prompt = buildContextPrompt(active);

    expect(prompt).toContain("**All Steps:**");
    expect(prompt).toContain("Phase 1");
    expect(prompt).toContain("Phase 2");
    expect(prompt).toContain("Phase 3");
    expect(prompt).toMatch(/1\./);
    expect(prompt).toMatch(/2\./);
    expect(prompt).toMatch(/3\./);
  });

  it("marks current phase with ▶ arrow marker", () => {
    const def = makePromptsLinearDef();

    // Phase index 0 — phase 1 should be marked
    const activeAt0 = makeActive(def);
    const prompt0 = buildContextPrompt(activeAt0);
    const stepLines0 = prompt0.split("\n").slice(prompt0.split("\n").findIndex((l) => l.includes("**All Steps:**")) + 1);
    const phase1Line = stepLines0.find((l) => l.includes("Phase 1"))!;
    const phase2Line = stepLines0.find((l) => l.includes("Phase 2"))!;
    expect(phase1Line).toContain("▶");
    expect(phase2Line).not.toContain("▶");

    // Phase index 1 — phase 2 should be marked
    const activeAt1 = makeActive(def, {}, [{ workflowKey: "test", phaseIndex: 1 }]);
    const correctedAt1: ActiveWorkflow = {
      ...activeAt1,
      currentPhase: def.phases[1] as PhaseDefinition,
      currentPhaseEntry: def.phases[1]!,
      nextPhase: null,
    };
    const prompt1 = buildContextPrompt(correctedAt1);
    const stepLines1 = prompt1.split("\n").slice(prompt1.split("\n").findIndex((l) => l.includes("**All Steps:**")) + 1);
    const phase1Line1 = stepLines1.find((l) => l.includes("Phase 1"))!;
    const phase2Line1 = stepLines1.find((l) => l.includes("Phase 2"))!;
    expect(phase1Line1).not.toContain("▶");
    expect(phase2Line1).toContain("▶");
  });

  it("flattens subworkflow phases into step list", () => {
    const innerPhase1: PhaseDefinition = {
      id: "sp1",
      name: "Sub 1",
      emoji: "🔧",
      instructions: "sub 1",
    };
    const innerPhase2: PhaseDefinition = {
      id: "sp2",
      name: "Sub 2",
      emoji: "🔩",
      instructions: "sub 2",
    };
    const subDef: WorkflowDefinition = {
      name: "Sub",
      commandName: "sub",
      initialMessage: "Start",
      show: "workflows",
      phases: [innerPhase1, innerPhase2],
    };
    const parentDef: WorkflowDefinition = {
      name: "Parent",
      commandName: "par",
      initialMessage: "Start",
      phases: [phase1, { subworkflow: true, workflowKey: "sub", resolved: subDef }, phase2],
    };

    // Build active inside the subworkflow at phase index 0
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
    const defs: Record<string, WorkflowDefinition> = { parent: parentDef, sub: subDef };
    const innerSegment = state.currentPath[state.currentPath.length - 1]!;
    const innerDef = defs[innerSegment.workflowKey]!;
    const currentEntry = innerDef.phases[innerSegment.phaseIndex]!;
    const currentPhase = currentEntry as PhaseDefinition;
    const nextPhase: PhaseEntry | null = innerDef.phases[innerSegment.phaseIndex + 1] ?? null;

    const active: ActiveWorkflow = {
      definition: parentDef,
      state,
      currentPhase,
      currentPhaseEntry: currentEntry,
      nextPhase,
      breadcrumb: [
        { workflowKey: "parent", name: parentDef.name, phaseName: parentDef.name, emoji: "" },
        { workflowKey: "sub", name: subDef.name, phaseName: innerPhase1.name, emoji: innerPhase1.emoji },
      ],
    };

    const prompt = buildContextPrompt(active);
    expect(prompt).toContain("**All Steps:**");

    // All 4 concrete phases should be numbered 1-4
    expect(prompt).toMatch(/1\..*Phase 1/);
    expect(prompt).toMatch(/2\..*Sub 1/);
    expect(prompt).toMatch(/3\..*Sub 2/);
    expect(prompt).toMatch(/4\..*Phase 2/);

    // The current phase (Sub 1) should be marked with ▶
    const stepLines = prompt.split("\n").slice(prompt.split("\n").findIndex((l) => l.includes("**All Steps:**")) + 1);
    const sub1Line = stepLines.find((l) => l.includes("Sub 1"))!;
    expect(sub1Line).toContain("▶");
  });

  it("shows correct count in step list", () => {
    const phase3: PhaseDefinition = {
      id: "p3",
      name: "Phase 3",
      emoji: "3️⃣",
      instructions: "Do 3",
    };
    const innerPhase1: PhaseDefinition = {
      id: "sp1",
      name: "Sub 1",
      emoji: "🔧",
      instructions: "sub 1",
    };
    const innerPhase2: PhaseDefinition = {
      id: "sp2",
      name: "Sub 2",
      emoji: "🔩",
      instructions: "sub 2",
    };
    const subRef: SubworkflowReference = {
      subworkflow: true,
      workflowKey: "inner",
      resolved: {
        name: "Inner",
        commandName: "inner",
        initialMessage: "Start",
        phases: [innerPhase1, innerPhase2],
      },
    };
    const def: WorkflowDefinition = {
      name: "Mixed",
      commandName: "mixed",
      initialMessage: "Start",
      phases: [phase1, subRef, phase2, phase3],
    };

    // Total flattened phases: phase1 + innerPhase1 + innerPhase2 + phase2 + phase3 = 5
    const active = makeActive(def);
    const prompt = buildContextPrompt(active);

    // Extract the All Steps section
    const stepsStart = prompt.indexOf("**All Steps:**");
    expect(stepsStart).toBeGreaterThan(-1);
    const stepsSection = prompt.slice(stepsStart);
    // Count lines matching numbered items like "  1." or "▶ 1."
    const numberedLines = stepsSection.split("\n").filter((l) => /\d+\./.test(l));
    expect(numberedLines.length).toBe(5);
  });
});
