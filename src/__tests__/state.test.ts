import { describe, it, expect } from "vitest";
import {
  createInitialState,
  advancePhase,
  loopPhase,
  resolveActive,
  reconstructState,
  isActive,
} from "../state";
import type { PhaseDefinition, WorkflowDefinition } from "../types";

// ── Test Fixture Definitions ──

const phase1: PhaseDefinition = {
  id: "p1",
  name: "Phase 1",
  emoji: "1️⃣",
  instructions: "Do phase 1",
};
const phase2: PhaseDefinition = {
  id: "p2",
  name: "Phase 2",
  emoji: "2️⃣",
  instructions: "Do phase 2",
};
const phase3: PhaseDefinition = {
  id: "p3",
  name: "Phase 3",
  emoji: "3️⃣",
  instructions: "Do phase 3",
};
const subPhase1: PhaseDefinition = {
  id: "sp1",
  name: "Sub Phase 1",
  emoji: "🔨",
  instructions: "Build",
};
const subPhase2: PhaseDefinition = {
  id: "sp2",
  name: "Sub Phase 2",
  emoji: "👁️",
  instructions: "Review",
};

const subDef: WorkflowDefinition = {
  name: "Sub",
  commandName: "sub",
  initialMessage: "Start",
  show: "workflows",
  phases: [subPhase1, subPhase2],
};
const linearDef: WorkflowDefinition = {
  name: "Linear",
  commandName: "lin",
  initialMessage: "Start",
  phases: [phase1, phase2, phase3],
};
const parentDef: WorkflowDefinition = {
  name: "Parent",
  commandName: "par",
  initialMessage: "Start",
  phases: [phase1, { subworkflow: true, workflowKey: "sub", resolved: subDef }, phase3],
};

const allDefs: Record<string, WorkflowDefinition> = {
  linear: linearDef,
  parent: parentDef,
  sub: subDef,
};

// Helper for reconstructState
interface MockSessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

function makeCtx(entries: MockSessionEntry[]) {
  return { sessionManager: { getBranch: () => entries } };
}

// ── createInitialState ──

describe("createInitialState", () => {
  it("returns state with currentPath (single element), globalStepCount 0, active true", () => {
    const state = createInitialState("test-wf", "do something");
    expect(state.active).toBe(true);
    expect(state.workflowKey).toBe("test-wf");
    expect(state.taskDescription).toBe("do something");
    expect(state.globalStepCount).toBe(0);
    expect(state.currentPath).toHaveLength(1);
    expect(state.currentPath[0]).toEqual({
      workflowKey: "test-wf",
      phaseIndex: 0,
    });
    expect(state.completionNotified).toBe(false);
    expect(state.cancelled).toBe(false);
    expect(state.taskId).toMatch(/^wf-/);
  });

  it("no currentPhaseIndex field", () => {
    const state = createInitialState("test-wf", "do something");
    expect("currentPhaseIndex" in (state as unknown as Record<string, unknown>)).toBe(false);
  });
});

// ── advancePhase — linear ──

describe("advancePhase — linear", () => {
  it("start at phase 0, advance → phase 1", () => {
    const state = createInitialState("linear", "desc");
    const result = advancePhase(state, allDefs);
    expect(result.advanced).toBe(true);
    expect(result.from).toBe("Phase 1");
    expect(result.to).toBe("Phase 2");
    expect(state.currentPath[0].phaseIndex).toBe(1);
    expect(state.globalStepCount).toBe(1);
  });

  it("advance again → phase 2", () => {
    const state = createInitialState("linear", "desc");
    advancePhase(state, allDefs);
    const result = advancePhase(state, allDefs);
    expect(result.advanced).toBe(true);
    expect(result.from).toBe("Phase 2");
    expect(result.to).toBe("Phase 3");
    expect(state.currentPath[0].phaseIndex).toBe(2);
    expect(state.globalStepCount).toBe(2);
  });

  it("advance on last phase → active=false (DONE)", () => {
    const state = createInitialState("linear", "desc");
    advancePhase(state, allDefs);
    advancePhase(state, allDefs);
    const result = advancePhase(state, allDefs);
    expect(result.advanced).toBe(true);
    expect(result.from).toBe("Phase 3");
    expect(result.to).toBeNull();
    expect(state.active).toBe(false);
  });
});

// ── advancePhase — enter subworkflow ──

describe("advancePhase — enter subworkflow", () => {
  it("advancing to subworkflow ref → auto-enters and pushes new segment", () => {
    // Start parent workflow; phase 0 is phase1, advance once to reach subworkflow ref at index 1
    const state = createInitialState("parent", "desc");
    // currentPath[0] = { workflowKey: "parent", phaseIndex: 0 } → phase1
    // advance to phase[1] which is the subworkflow ref; auto-enters sub → sub[0]
    const result = advancePhase(state, allDefs);
    expect(result.advanced).toBe(true);
    expect(state.currentPath).toHaveLength(2);
    expect(state.currentPath[1]).toEqual({
      workflowKey: "sub",
      phaseIndex: 0,
    });
  });

  it("path length increases from 1 to 2", () => {
    const state = createInitialState("parent", "desc");
    expect(state.currentPath).toHaveLength(1);
    advancePhase(state, allDefs);
    advancePhase(state, allDefs);
    expect(state.currentPath).toHaveLength(2);
  });
});

// ── advancePhase — breakout ──

describe("advancePhase — breakout", () => {
  it("last phase of subworkflow, advance → pops segment, advances parent", () => {
    const state = createInitialState("parent", "desc");
    // Phase 0 → Phase 1 (subworkflow ref)
    advancePhase(state, allDefs);
    // Enter subworkflow → now at sub[0]
    advancePhase(state, allDefs);
    expect(state.currentPath).toHaveLength(2);
    // Advance within sub → sub[1]
    advancePhase(state, allDefs);
    // Advance on last phase of sub → breakout
    const result = advancePhase(state, allDefs);
    expect(result.advanced).toBe(true);
    expect(state.currentPath).toHaveLength(1);
    // Parent should have advanced past the subworkflow ref to phase3 (index 2)
    expect(state.currentPath[0].phaseIndex).toBe(2);
  });

  it("path length decreases", () => {
    const state = createInitialState("parent", "desc");
    advancePhase(state, allDefs); // → subworkflow ref
    advancePhase(state, allDefs); // enter sub → length 2
    advancePhase(state, allDefs); // sub[1]
    advancePhase(state, allDefs); // breakout → length 1
    expect(state.currentPath).toHaveLength(1);
  });
});

// ── advancePhase — multi-level ──

describe("advancePhase — multi-level", () => {
  it("enter sub > advance to last > breakout > continue parent", () => {
    const state = createInitialState("parent", "desc");

    // Step 1: advance from p1 → auto-enters subworkflow at sub[0]
    advancePhase(state, allDefs);
    expect(state.currentPath).toHaveLength(2);
    expect(state.currentPath[1].phaseIndex).toBe(0);

    // Step 2: advance within sub → sub[1]
    advancePhase(state, allDefs);
    expect(state.currentPath[1].phaseIndex).toBe(1);

    // Step 3: breakout from sub → back to parent at index 2 (phase3)
    const result = advancePhase(state, allDefs);
    expect(result.advanced).toBe(true);
    expect(state.currentPath).toHaveLength(1);
    expect(state.currentPath[0].phaseIndex).toBe(2);

    // Step 4: advance on last parent phase → DONE
    const final = advancePhase(state, allDefs);
    expect(final.advanced).toBe(true);
    expect(final.to).toBeNull();
    expect(state.active).toBe(false);
  });
});

// ── loopPhase ──

describe("loopPhase", () => {
  it("resets phaseIndex to 0, increments globalStepCount", () => {
    const state = createInitialState("linear", "desc");
    advancePhase(state, allDefs); // now at phaseIndex 1
    expect(state.globalStepCount).toBe(1);

    const result = loopPhase(state, allDefs);
    expect("looped" in result && result.looped).toBe(true);
    expect(state.currentPath[0].phaseIndex).toBe(0);
    expect(state.globalStepCount).toBe(2);
  });

  it("on loopable: false → returns error", () => {
    const nonLoopDef: WorkflowDefinition = {
      name: "NoLoop",
      commandName: "noloop",
      initialMessage: "Start",
      loopable: false,
      phases: [phase1, phase2],
    };
    const defs = { noloop: nonLoopDef };
    const state = createInitialState("noloop", "desc");
    const result = loopPhase(state, defs);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("disabled");
    }
  });

  it("inside nested workflow, only resets innermost scope", () => {
    const state = createInitialState("parent", "desc");
    advancePhase(state, allDefs); // auto-enters sub → sub[0]
    advancePhase(state, allDefs); // → sub[1]

    // Loop inside subworkflow
    const result = loopPhase(state, allDefs);
    expect("looped" in result && result.looped).toBe(true);
    // Inner scope reset to 0
    expect(state.currentPath[1].phaseIndex).toBe(0);
    // Path still has 2 segments
    expect(state.currentPath).toHaveLength(2);
  });
});

// ── resolveActive — linear ──

describe("resolveActive — linear", () => {
  it("single-element path resolves correctly", () => {
    const state = createInitialState("linear", "desc");
    const active = resolveActive(state, allDefs);
    expect(active).not.toBeNull();
    expect(active!.currentPhase.name).toBe("Phase 1");
    expect(active!.currentPhaseEntry).toBe(phase1);
    expect(active!.nextPhase).toBe(phase2);
  });

  it("returns correct currentPhase and nextPhase", () => {
    const state = createInitialState("linear", "desc");
    advancePhase(state, allDefs); // now at phase 2 (index 1)
    const active = resolveActive(state, allDefs);
    expect(active).not.toBeNull();
    expect(active!.currentPhase.name).toBe("Phase 2");
    expect(active!.nextPhase).toBe(phase3);
  });
});

// ── resolveActive — nested ──

describe("resolveActive — nested", () => {
  it("multi-element path resolves to innermost phase", () => {
    const state = createInitialState("parent", "desc");
    advancePhase(state, allDefs); // auto-enters sub → sub[0]
    const active = resolveActive(state, allDefs);
    expect(active).not.toBeNull();
    expect(active!.currentPhase.name).toBe("Sub Phase 1");
  });

  it("breadcrumb array has correct entries", () => {
    const state = createInitialState("parent", "desc");
    advancePhase(state, allDefs); // auto-enters sub → sub[0]
    const active = resolveActive(state, allDefs);
    expect(active).not.toBeNull();
    expect(active!.breadcrumb).toHaveLength(2);
    // First entry is the top-level parent
    expect(active!.breadcrumb[0].workflowKey).toBe("parent");
    // Second entry is the innermost subworkflow
    expect(active!.breadcrumb[1].workflowKey).toBe("sub");
    // Innermost breadcrumb should have the current phase name and emoji
    expect(active!.breadcrumb[1].phaseName).toBe("Sub Phase 1");
    expect(active!.breadcrumb[1].emoji).toBe("🔨");
  });
});

// ── resolveActive — edge cases ──

describe("resolveActive — edge cases", () => {
  it("missing definition → returns null", () => {
    const state = createInitialState("nonexistent", "desc");
    const result = resolveActive(state, allDefs);
    expect(result).toBeNull();
  });

  it("out-of-bounds phaseIndex → returns null", () => {
    const state = createInitialState("linear", "desc");
    state.currentPath[0].phaseIndex = 999;
    const result = resolveActive(state, allDefs);
    expect(result).toBeNull();
  });

  it("null state → returns null", () => {
    expect(resolveActive(null, allDefs)).toBeNull();
  });

  it("inactive state → returns null", () => {
    const state = createInitialState("linear", "desc");
    state.active = false;
    expect(resolveActive(state, allDefs)).toBeNull();
  });
});

// ── reconstructState — migration ──

describe("reconstructState", () => {
  it("old state with currentPhaseIndex → migrated to currentPath", () => {
    const ctx = makeCtx([
      {
        type: "custom",
        customType: "workflow:state",
        data: {
          active: true,
          workflowKey: "linear",
          currentPhaseIndex: 2,
          globalStepCount: 5,
          taskId: "wf-test",
          taskDescription: "test",
          startedAt: 1000,
          completionNotified: false,
          cancelled: false,
        },
      },
    ]);
    const state = reconstructState(ctx);
    expect(state).not.toBeNull();
    expect(state!.currentPath).toEqual([{ workflowKey: "linear", phaseIndex: 2 }]);
    // Should not have currentPhaseIndex anymore
    expect("currentPhaseIndex" in (state as unknown as Record<string, unknown>)).toBe(false);
  });

  it("new state with currentPath → no migration", () => {
    const ctx = makeCtx([
      {
        type: "custom",
        customType: "workflow:state",
        data: {
          active: true,
          workflowKey: "linear",
          currentPath: [{ workflowKey: "linear", phaseIndex: 1 }],
          globalStepCount: 3,
          taskId: "wf-test",
          taskDescription: "test",
          startedAt: 1000,
          completionNotified: false,
          cancelled: false,
        },
      },
    ]);
    const state = reconstructState(ctx);
    expect(state).not.toBeNull();
    expect(state!.currentPath).toEqual([{ workflowKey: "linear", phaseIndex: 1 }]);
    expect(state!.globalStepCount).toBe(3);
  });

  it("no matching entry → returns null", () => {
    const ctx = makeCtx([
      { type: "other", data: { foo: "bar" } },
      { type: "custom", customType: "unrelated", data: {} },
    ]);
    expect(reconstructState(ctx)).toBeNull();
  });

  it("empty currentPath → returns null (tampered state)", () => {
    const ctx = makeCtx([
      {
        type: "custom",
        customType: "workflow:state",
        data: {
          active: true,
          workflowKey: "linear",
          currentPath: [],
          globalStepCount: 0,
          taskId: "wf-test",
          taskDescription: "test",
          startedAt: 1000,
          completionNotified: false,
          cancelled: false,
        },
      },
    ]);
    expect(reconstructState(ctx)).toBeNull();
  });

  it("malformed path segment → returns null (tampered state)", () => {
    const ctx = makeCtx([
      {
        type: "custom",
        customType: "workflow:state",
        data: {
          active: true,
          workflowKey: "linear",
          currentPath: [{ bad: "data" }],
          globalStepCount: 0,
          taskId: "wf-test",
          taskDescription: "test",
          startedAt: 1000,
          completionNotified: false,
          cancelled: false,
        },
      },
    ]);
    expect(reconstructState(ctx)).toBeNull();
  });
});

// ── New fixtures for additional tests ──

const sub2Def: WorkflowDefinition = {
  name: "Sub2",
  commandName: "sub2",
  initialMessage: "Start",
  show: "workflows",
  phases: [{ id: "sp2a", name: "Sub2 Phase A", emoji: "🅰️", instructions: "A" }],
};
const parentTwoSubs: WorkflowDefinition = {
  name: "ParentTwoSubs",
  commandName: "pts",
  initialMessage: "Start",
  phases: [
    phase1,
    { subworkflow: true, workflowKey: "sub", resolved: subDef },
    { subworkflow: true, workflowKey: "sub2", resolved: sub2Def },
    phase3,
  ],
};

const loopSub: WorkflowDefinition = {
  name: "LoopSub",
  commandName: "ls",
  initialMessage: "Start",
  show: "workflows",
  phases: [subPhase1, subPhase2],
  // loopable NOT set (defaults to allowed)
};
const noLoopParent: WorkflowDefinition = {
  name: "NoLoopParent",
  commandName: "nlp",
  initialMessage: "Start",
  loopable: false,
  phases: [phase1, { subworkflow: true, workflowKey: "loopSub", resolved: loopSub }],
};

const noLoopSubDef: WorkflowDefinition = {
  name: "NoLoopSub",
  commandName: "nls",
  initialMessage: "Start",
  show: "workflows",
  loopable: false,
  phases: [subPhase1, subPhase2],
};
const loopParent: WorkflowDefinition = {
  name: "LoopParent",
  commandName: "lp",
  initialMessage: "Start",
  phases: [phase1, { subworkflow: true, workflowKey: "noLoopSub", resolved: noLoopSubDef }],
};

// ── isActive ──

describe("isActive", () => {
  it("active state → true", () => {
    const state = createInitialState("linear", "desc");
    expect(isActive(state)).toBe(true);
  });

  it("inactive state → false", () => {
    const state = createInitialState("linear", "desc");
    state.active = false;
    expect(isActive(state)).toBe(false);
  });

  it("null → false", () => {
    expect(isActive(null)).toBe(false);
  });
});

// ── advancePhase — auto-enter concrete phase name ──

describe("advancePhase — auto-enter concrete phase name", () => {
  it("advancing to subworkflow ref returns concrete first phase name", () => {
    const state = createInitialState("parent", "desc");
    const result = advancePhase(state, allDefs); // auto-enters sub
    expect(result.from).toBe("Phase 1");
    expect(result.to).toBe("Sub Phase 1"); // concrete name, not subworkflow ref name
  });

  it("auto-enter return value has from=current phase, to=first concrete sub phase", () => {
    const state = createInitialState("parent", "desc");
    const result = advancePhase(state, allDefs);
    expect(result.from).toBe("Phase 1");
    expect(result.to).toBe("Sub Phase 1");
  });
});

// ── advancePhase — breakout + auto-enter (two subworkflows) ──

describe("advancePhase — breakout + auto-enter (two subworkflows)", () => {
  const ptsDefs: Record<string, WorkflowDefinition> = {
    pts: parentTwoSubs,
    sub: subDef,
    sub2: sub2Def,
  };

  it("advance through parent → sub → sub2 → phase3, verifying auto-enter at each transition", () => {
    const state = createInitialState("pts", "desc");

    // Step 1: advance from phase1 → auto-enters sub → sub[0]
    const r1 = advancePhase(state, ptsDefs);
    expect(r1.advanced).toBe(true);
    expect(r1.from).toBe("Phase 1");
    expect(r1.to).toBe("Sub Phase 1");
    expect(state.currentPath).toHaveLength(2);
    expect(state.currentPath[1]).toEqual({ workflowKey: "sub", phaseIndex: 0 });

    // Step 2: advance within sub → sub[1]
    const r2 = advancePhase(state, ptsDefs);
    expect(r2.advanced).toBe(true);
    expect(r2.from).toBe("Sub Phase 1");
    expect(r2.to).toBe("Sub Phase 2");
    expect(state.currentPath[1].phaseIndex).toBe(1);

    // Step 3: breakout from sub, auto-enter sub2 → sub2[0]
    const r3 = advancePhase(state, ptsDefs);
    expect(r3.advanced).toBe(true);
    expect(r3.from).toBe("Sub Phase 2");
    expect(r3.to).toBe("Sub2 Phase A");
    expect(state.currentPath).toHaveLength(2);
    expect(state.currentPath[1]).toEqual({ workflowKey: "sub2", phaseIndex: 0 });

    // Step 4: breakout from sub2 (only 1 phase) → parent phase3 (index 3)
    const r4 = advancePhase(state, ptsDefs);
    expect(r4.advanced).toBe(true);
    expect(r4.from).toBe("Sub2 Phase A");
    expect(r4.to).toBe("Phase 3");
    expect(state.currentPath).toHaveLength(1);
    expect(state.currentPath[0].phaseIndex).toBe(3);

    // Step 5: advance on last parent phase → DONE
    const r5 = advancePhase(state, ptsDefs);
    expect(r5.advanced).toBe(true);
    expect(r5.from).toBe("Phase 3");
    expect(r5.to).toBeNull();
    expect(state.active).toBe(false);
  });

  it("breakout + auto-enter shows correct transition", () => {
    const state = createInitialState("pts", "desc");
    advancePhase(state, ptsDefs); // auto-enters sub → sub[0]
    advancePhase(state, ptsDefs); // → sub[1]
    const result = advancePhase(state, ptsDefs); // breakout from sub, auto-enter sub2
    expect(result.from).toBe("Sub Phase 2");
    expect(result.to).toBe("Sub2 Phase A");
    expect(state.currentPath).toHaveLength(2);
    expect(state.currentPath[1]).toEqual({ workflowKey: "sub2", phaseIndex: 0 });
  });
});

// ── loopPhase — subworkflow scope ──

describe("loopPhase — subworkflow scope", () => {
  it("after auto-enter, loop resets subworkflow scope", () => {
    const state = createInitialState("parent", "desc");
    advancePhase(state, allDefs); // auto-enters sub → sub[0]
    advancePhase(state, allDefs); // → sub[1]
    const result = loopPhase(state, allDefs);
    expect("looped" in result && result.looped).toBe(true);
    // Inner scope reset to 0
    expect(state.currentPath[1].phaseIndex).toBe(0);
    // Path still has 2 segments
    expect(state.currentPath).toHaveLength(2);
    // Parent phaseIndex unchanged
    expect(state.currentPath[0].phaseIndex).toBe(1);
  });
});

// ── loopPhase — loopable isolation ──

describe("loopPhase — loopable isolation", () => {
  it("parent loopable=false does not block subworkflow looping", () => {
    const defs: Record<string, WorkflowDefinition> = { nlp: noLoopParent, loopSub };
    const state = createInitialState("nlp", "desc");
    advancePhase(state, defs); // auto-enters sub
    advancePhase(state, defs); // → sub[1]
    const result = loopPhase(state, defs);
    expect("looped" in result && result.looped).toBe(true);
  });

  it("subworkflow loopable=false blocks looping even if parent allows it", () => {
    const defs: Record<string, WorkflowDefinition> = { lp: loopParent, noLoopSub: noLoopSubDef };
    const state = createInitialState("lp", "desc");
    advancePhase(state, defs); // auto-enters sub
    const result = loopPhase(state, defs);
    expect("error" in result).toBe(true);
  });
});
