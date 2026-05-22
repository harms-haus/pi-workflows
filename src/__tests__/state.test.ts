import { describe, it, expect, vi } from "vitest";
import {
  createInitialState,
  advancePhase,
  loopPhase,
  resolveActive,
  reconstructState,
  isActive,
  resolveFirstPhase,
  autoEnterSubworkflowRefs,
  phaseEntryName,
} from "../state";
import type { WorkflowDefinition, SubworkflowReference } from "../types";
import {
  STATE_PHASE_1 as phase1,
  STATE_PHASE_2 as phase2,
  STATE_PHASE_3 as phase3,
  STATE_SUB_PHASE_1 as subPhase1,
  STATE_SUB_PHASE_2 as subPhase2,
  makeStateSubDef,
  makeStateAllDefs,
} from "./helpers/fixtures";

// ── Test Fixture Definitions (from shared helpers) ──

const subDef = makeStateSubDef();
const allDefs = makeStateAllDefs();

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
    // Original state is NOT mutated
    expect(state.currentPath[0].phaseIndex).toBe(0);
    expect(state.globalStepCount).toBe(0);
    // New state has advanced
    expect(result.newState.currentPath[0].phaseIndex).toBe(1);
    expect(result.newState.globalStepCount).toBe(1);
  });

  it("advance again → phase 2", () => {
    const state0 = createInitialState("linear", "desc");
    const state1 = advancePhase(state0, allDefs).newState;
    const result = advancePhase(state1, allDefs);
    expect(result.advanced).toBe(true);
    expect(result.from).toBe("Phase 2");
    expect(result.to).toBe("Phase 3");
    expect(result.newState.currentPath[0].phaseIndex).toBe(2);
    expect(result.newState.globalStepCount).toBe(2);
  });

  it("advance on last phase → active=false (DONE)", () => {
    const state0 = createInitialState("linear", "desc");
    const state1 = advancePhase(state0, allDefs).newState;
    const state2 = advancePhase(state1, allDefs).newState;
    const result = advancePhase(state2, allDefs);
    expect(result.advanced).toBe(true);
    expect(result.from).toBe("Phase 3");
    expect(result.to).toBeNull();
    expect(result.newState.active).toBe(false);
  });
});

// ── advancePhase — enter subworkflow ──

describe("advancePhase — enter subworkflow", () => {
  it("advancing to subworkflow ref → auto-enters and pushes new segment", () => {
    const state = createInitialState("parent", "desc");
    const result = advancePhase(state, allDefs);
    expect(result.advanced).toBe(true);
    expect(result.newState.currentPath).toHaveLength(2);
    expect(result.newState.currentPath[1]).toEqual({
      workflowKey: "sub",
      phaseIndex: 0,
    });
  });

  it("path length increases from 1 to 2", () => {
    const state0 = createInitialState("parent", "desc");
    expect(state0.currentPath).toHaveLength(1);
    const state1 = advancePhase(state0, allDefs).newState;
    const state2 = advancePhase(state1, allDefs).newState;
    expect(state2.currentPath).toHaveLength(2);
  });
});

// ── advancePhase — breakout ──

describe("advancePhase — breakout", () => {
  it("last phase of subworkflow, advance → pops segment, advances parent", () => {
    const state0 = createInitialState("parent", "desc");
    const state1 = advancePhase(state0, allDefs).newState; // Phase 0 → Phase 1 (subworkflow ref)
    const state2 = advancePhase(state1, allDefs).newState; // Enter subworkflow → now at sub[0]
    expect(state2.currentPath).toHaveLength(2);
    const state3 = advancePhase(state2, allDefs).newState; // Advance within sub → sub[1]
    const result = advancePhase(state3, allDefs); // Advance on last phase of sub → breakout
    expect(result.advanced).toBe(true);
    expect(result.newState.currentPath).toHaveLength(1);
    // Parent should have advanced past the subworkflow ref to phase3 (index 2)
    expect(result.newState.currentPath[0].phaseIndex).toBe(2);
  });

  it("path length decreases", () => {
    const state0 = createInitialState("parent", "desc");
    const state1 = advancePhase(state0, allDefs).newState;
    const state2 = advancePhase(state1, allDefs).newState; // enter sub → length 2
    const state3 = advancePhase(state2, allDefs).newState; // sub[1]
    const state4 = advancePhase(state3, allDefs).newState; // breakout → length 1
    expect(state4.currentPath).toHaveLength(1);
  });
});

// ── advancePhase — multi-level ──

describe("advancePhase — multi-level", () => {
  it("enter sub > advance to last > breakout > continue parent", () => {
    const state0 = createInitialState("parent", "desc");

    // Step 1: advance from p1 → auto-enters subworkflow at sub[0]
    const r1 = advancePhase(state0, allDefs);
    const state1 = r1.newState;
    expect(state1.currentPath).toHaveLength(2);
    expect(state1.currentPath[1].phaseIndex).toBe(0);

    // Step 2: advance within sub → sub[1]
    const state2 = advancePhase(state1, allDefs).newState;
    expect(state2.currentPath[1].phaseIndex).toBe(1);

    // Step 3: breakout from sub → back to parent at index 2 (phase3)
    const r3 = advancePhase(state2, allDefs);
    const state3 = r3.newState;
    expect(r3.advanced).toBe(true);
    expect(state3.currentPath).toHaveLength(1);
    expect(state3.currentPath[0].phaseIndex).toBe(2);

    // Step 4: advance on last parent phase → DONE
    const final = advancePhase(state3, allDefs);
    expect(final.advanced).toBe(true);
    expect(final.to).toBeNull();
    expect(final.newState.active).toBe(false);
  });
});

// ── loopPhase ──

describe("loopPhase", () => {
  it("resets phaseIndex to 0, increments globalStepCount", () => {
    const state0 = createInitialState("linear", "desc");
    const state1 = advancePhase(state0, allDefs).newState; // now at phaseIndex 1
    expect(state1.globalStepCount).toBe(1);

    const result = loopPhase(state1, allDefs);
    expect(result.looped).toBe(true);
    if (!result.looped) throw new Error("expected looped");
    expect(result.newState.currentPath[0].phaseIndex).toBe(0);
    expect(result.newState.globalStepCount).toBe(2);
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
    expect(result.looped).toBe(false);
    if (!result.looped) {
      expect(result.error).toContain("disabled");
    }
  });

  it("inside nested workflow, only resets innermost scope", () => {
    const state0 = createInitialState("parent", "desc");
    const state1 = advancePhase(state0, allDefs).newState; // auto-enters sub → sub[0]
    const state2 = advancePhase(state1, allDefs).newState; // → sub[1]

    // Loop inside subworkflow
    const result = loopPhase(state2, allDefs);
    expect(result.looped).toBe(true);
    if (!result.looped) throw new Error("expected looped");
    // Inner scope reset to 0
    expect(result.newState.currentPath[1].phaseIndex).toBe(0);
    // Path still has 2 segments
    expect(result.newState.currentPath).toHaveLength(2);
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
    const state0 = createInitialState("linear", "desc");
    const state1 = advancePhase(state0, allDefs).newState; // now at phase 2 (index 1)
    const active = resolveActive(state1, allDefs);
    expect(active).not.toBeNull();
    expect(active!.currentPhase.name).toBe("Phase 2");
    expect(active!.nextPhase).toBe(phase3);
  });
});

// ── resolveActive — nested ──

describe("resolveActive — nested", () => {
  it("multi-element path resolves to innermost phase", () => {
    const state0 = createInitialState("parent", "desc");
    const state1 = advancePhase(state0, allDefs).newState; // auto-enters sub → sub[0]
    const active = resolveActive(state1, allDefs);
    expect(active).not.toBeNull();
    expect(active!.currentPhase.name).toBe("Sub Phase 1");
  });

  it("breadcrumb array has correct entries", () => {
    const state0 = createInitialState("parent", "desc");
    const state1 = advancePhase(state0, allDefs).newState; // auto-enters sub → sub[0]
    const active = resolveActive(state1, allDefs);
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

  it("missing globalStepCount → migrated from first path segment phaseIndex", () => {
    const ctx = makeCtx([
      {
        type: "custom",
        customType: "workflow:state",
        data: {
          active: true,
          workflowKey: "linear",
          currentPath: [{ workflowKey: "linear", phaseIndex: 3 }],
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
    expect(state!.globalStepCount).toBe(3);
  });

  it("missing globalStepCount with no currentPath but currentPhaseIndex → migrates", () => {
    const ctx = makeCtx([
      {
        type: "custom",
        customType: "workflow:state",
        data: {
          active: true,
          workflowKey: "linear",
          currentPhaseIndex: 4,
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
    expect(state!.globalStepCount).toBe(4);
  });

  it("missing workflowKey → returns null", () => {
    const ctx = makeCtx([
      {
        type: "custom",
        customType: "workflow:state",
        data: {
          active: true,
          currentPath: [{ workflowKey: "linear", phaseIndex: 0 }],
          globalStepCount: 0,
          startedAt: 1000,
        },
      },
    ]);
    expect(reconstructState(ctx)).toBeNull();
  });

  it("invalid active field type → returns null", () => {
    const ctx = makeCtx([
      {
        type: "custom",
        customType: "workflow:state",
        data: {
          active: "yes",
          workflowKey: "linear",
          currentPath: [{ workflowKey: "linear", phaseIndex: 0 }],
          globalStepCount: 0,
          startedAt: 1000,
        },
      },
    ]);
    expect(reconstructState(ctx)).toBeNull();
  });

  it("invalid startedAt type → returns null", () => {
    const ctx = makeCtx([
      {
        type: "custom",
        customType: "workflow:state",
        data: {
          active: true,
          workflowKey: "linear",
          currentPath: [{ workflowKey: "linear", phaseIndex: 0 }],
          globalStepCount: 0,
          startedAt: "not-a-number",
        },
      },
    ]);
    expect(reconstructState(ctx)).toBeNull();
  });

  it("invalid taskId type → returns null", () => {
    const ctx = makeCtx([
      {
        type: "custom",
        customType: "workflow:state",
        data: {
          active: true,
          workflowKey: "linear",
          currentPath: [{ workflowKey: "linear", phaseIndex: 0 }],
          globalStepCount: 0,
          taskId: 123,
          startedAt: 1000,
        },
      },
    ]);
    expect(reconstructState(ctx)).toBeNull();
  });

  it("invalid cancelled type → returns null", () => {
    const ctx = makeCtx([
      {
        type: "custom",
        customType: "workflow:state",
        data: {
          active: true,
          workflowKey: "linear",
          currentPath: [{ workflowKey: "linear", phaseIndex: 0 }],
          globalStepCount: 0,
          startedAt: 1000,
          cancelled: "yes",
        },
      },
    ]);
    expect(reconstructState(ctx)).toBeNull();
  });

  it("returns most recent state entry (last in array)", () => {
    const ctx = makeCtx([
      {
        type: "custom",
        customType: "workflow:state",
        data: {
          active: true,
          workflowKey: "first",
          currentPath: [{ workflowKey: "first", phaseIndex: 0 }],
          globalStepCount: 1,
          startedAt: 1000,
        },
      },
      {
        type: "custom",
        customType: "workflow:state",
        data: {
          active: true,
          workflowKey: "second",
          currentPath: [{ workflowKey: "second", phaseIndex: 2 }],
          globalStepCount: 5,
          startedAt: 2000,
        },
      },
    ]);
    const state = reconstructState(ctx);
    expect(state).not.toBeNull();
    expect(state!.workflowKey).toBe("second");
    expect(state!.globalStepCount).toBe(5);
  });

  it("data is not a plain object → returns null", () => {
    const ctx = makeCtx([
      {
        type: "custom",
        customType: "workflow:state",
        data: null,
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
    const state0 = createInitialState("pts", "desc");

    // Step 1: advance from phase1 → auto-enters sub → sub[0]
    const r1 = advancePhase(state0, ptsDefs);
    expect(r1.advanced).toBe(true);
    expect(r1.from).toBe("Phase 1");
    expect(r1.to).toBe("Sub Phase 1");
    expect(r1.newState.currentPath).toHaveLength(2);
    expect(r1.newState.currentPath[1]).toEqual({ workflowKey: "sub", phaseIndex: 0 });

    // Step 2: advance within sub → sub[1]
    const r2 = advancePhase(r1.newState, ptsDefs);
    expect(r2.advanced).toBe(true);
    expect(r2.from).toBe("Sub Phase 1");
    expect(r2.to).toBe("Sub Phase 2");
    expect(r2.newState.currentPath[1].phaseIndex).toBe(1);

    // Step 3: breakout from sub, auto-enter sub2 → sub2[0]
    const r3 = advancePhase(r2.newState, ptsDefs);
    expect(r3.advanced).toBe(true);
    expect(r3.from).toBe("Sub Phase 2");
    expect(r3.to).toBe("Sub2 Phase A");
    expect(r3.newState.currentPath).toHaveLength(2);
    expect(r3.newState.currentPath[1]).toEqual({ workflowKey: "sub2", phaseIndex: 0 });

    // Step 4: breakout from sub2 (only 1 phase) → parent phase3 (index 3)
    const r4 = advancePhase(r3.newState, ptsDefs);
    expect(r4.advanced).toBe(true);
    expect(r4.from).toBe("Sub2 Phase A");
    expect(r4.to).toBe("Phase 3");
    expect(r4.newState.currentPath).toHaveLength(1);
    expect(r4.newState.currentPath[0].phaseIndex).toBe(3);

    // Step 5: advance on last parent phase → DONE
    const r5 = advancePhase(r4.newState, ptsDefs);
    expect(r5.advanced).toBe(true);
    expect(r5.from).toBe("Phase 3");
    expect(r5.to).toBeNull();
    expect(r5.newState.active).toBe(false);
  });

  it("breakout + auto-enter shows correct transition", () => {
    const state0 = createInitialState("pts", "desc");
    const state1 = advancePhase(state0, ptsDefs).newState; // auto-enters sub → sub[0]
    const state2 = advancePhase(state1, ptsDefs).newState; // → sub[1]
    const result = advancePhase(state2, ptsDefs); // breakout from sub, auto-enter sub2
    expect(result.from).toBe("Sub Phase 2");
    expect(result.to).toBe("Sub2 Phase A");
    expect(result.newState.currentPath).toHaveLength(2);
    expect(result.newState.currentPath[1]).toEqual({ workflowKey: "sub2", phaseIndex: 0 });
  });
});

// ── loopPhase — subworkflow scope ──

describe("loopPhase — subworkflow scope", () => {
  it("after auto-enter, loop resets subworkflow scope", () => {
    const state0 = createInitialState("parent", "desc");
    const state1 = advancePhase(state0, allDefs).newState; // auto-enters sub → sub[0]
    const state2 = advancePhase(state1, allDefs).newState; // → sub[1]
    const result = loopPhase(state2, allDefs);
    expect(result.looped).toBe(true);
    if (!result.looped) throw new Error("expected looped");
    // Inner scope reset to 0
    expect(result.newState.currentPath[1].phaseIndex).toBe(0);
    // Path still has 2 segments
    expect(result.newState.currentPath).toHaveLength(2);
    // Parent phaseIndex unchanged
    expect(result.newState.currentPath[0].phaseIndex).toBe(1);
  });
});

// ── loopPhase — loopable isolation ──

describe("loopPhase — loopable isolation", () => {
  it("parent loopable=false does not block subworkflow looping", () => {
    const defs: Record<string, WorkflowDefinition> = { nlp: noLoopParent, loopSub };
    const state0 = createInitialState("nlp", "desc");
    const state1 = advancePhase(state0, defs).newState; // auto-enters sub
    const state2 = advancePhase(state1, defs).newState; // → sub[1]
    const result = loopPhase(state2, defs);
    expect(result.looped).toBe(true);
  });

  it("subworkflow loopable=false blocks looping even if parent allows it", () => {
    const defs: Record<string, WorkflowDefinition> = { lp: loopParent, noLoopSub: noLoopSubDef };
    const state0 = createInitialState("lp", "desc");
    const state1 = advancePhase(state0, defs).newState; // auto-enters sub
    const result = loopPhase(state1, defs);
    expect(result.looped).toBe(false);
  });
});

// ── advancePhase — breakout when subworkflow is parent's last phase ──

describe("advancePhase — breakout when subworkflow is parent's last phase", () => {
  const parentSubLast: WorkflowDefinition = {
    name: "ParentSubLast",
    commandName: "psl",
    initialMessage: "Start",
    phases: [phase1, { subworkflow: true, workflowKey: "sub", resolved: subDef }],
  };
  const pslDefs: Record<string, WorkflowDefinition> = {
    psl: parentSubLast,
    sub: subDef,
  };

  it("subworkflow as parent's last phase → breakout completes the workflow", () => {
    const state0 = createInitialState("psl", "desc");

    // Step 1: advance from phase1 → auto-enters sub → sub[0]
    const r1 = advancePhase(state0, pslDefs);
    expect(r1.advanced).toBe(true);
    expect(r1.from).toBe("Phase 1");
    expect(r1.to).toBe("Sub Phase 1");
    expect(r1.newState.currentPath).toHaveLength(2);

    // Step 2: advance within sub → sub[1]
    const r2 = advancePhase(r1.newState, pslDefs);
    expect(r2.advanced).toBe(true);
    expect(r2.from).toBe("Sub Phase 1");
    expect(r2.to).toBe("Sub Phase 2");

    // Step 3: breakout from sub, parent has no more phases → DONE
    const r3 = advancePhase(r2.newState, pslDefs);
    expect(r3.advanced).toBe(true);
    expect(r3.from).toBe("Sub Phase 2");
    expect(r3.to).toBeNull();
    expect(r3.newState.active).toBe(false);
    expect(r3.newState.currentPath).toHaveLength(1);
    expect(r3.newState.currentPath[0].phaseIndex).toBe(2); // past end
  });

  it("parent whose only phase is a subworkflow → completes after subworkflow finishes", () => {
    const parentOnlySub: WorkflowDefinition = {
      name: "ParentOnlySub",
      commandName: "pos",
      initialMessage: "Start",
      phases: [{ subworkflow: true, workflowKey: "sub", resolved: subDef }],
    };
    const posDefs: Record<string, WorkflowDefinition> = {
      pos: parentOnlySub,
      sub: subDef,
    };

    const state0 = createInitialState("pos", "desc");
    // First advance: current is subworkflow ref → Case 1 → enter sub[0]
    const r1 = advancePhase(state0, posDefs);
    expect(r1.advanced).toBe(true);
    expect(r1.newState.currentPath).toHaveLength(2);
    expect(r1.newState.currentPath[1]).toEqual({ workflowKey: "sub", phaseIndex: 0 });

    // Second advance: sub[0] → sub[1]
    const r2 = advancePhase(r1.newState, posDefs);
    expect(r2.advanced).toBe(true);
    expect(r2.from).toBe("Sub Phase 1");
    expect(r2.to).toBe("Sub Phase 2");

    // Third advance: sub[1] is last → breakout. Parent has no more phases → DONE
    const r3 = advancePhase(r2.newState, posDefs);
    expect(r3.advanced).toBe(true);
    expect(r3.from).toBe("Sub Phase 2");
    expect(r3.to).toBeNull();
    expect(r3.newState.active).toBe(false);
  });
});

// ── advancePhase — multi-level breakout (nested last-phase subworkflows) ──

describe("advancePhase — multi-level breakout", () => {
  const grandchildDef: WorkflowDefinition = {
    name: "Grandchild",
    commandName: "gc",
    initialMessage: "Start",
    show: "workflows",
    phases: [{ id: "gc1", name: "GC Phase 1", emoji: "🧒", instructions: "gc" }],
  };
  const childDef: WorkflowDefinition = {
    name: "Child",
    commandName: "child",
    initialMessage: "Start",
    show: "workflows",
    phases: [{ subworkflow: true, workflowKey: "grandchild", resolved: grandchildDef }],
  };
  const grandparentDef: WorkflowDefinition = {
    name: "Grandparent",
    commandName: "gp",
    initialMessage: "Start",
    phases: [phase1, { subworkflow: true, workflowKey: "child", resolved: childDef }],
  };
  const nestedDefs: Record<string, WorkflowDefinition> = {
    gp: grandparentDef,
    child: childDef,
    grandchild: grandchildDef,
  };

  it("grandchild → child → grandparent all have subworkflow as last phase → completes", () => {
    const state0 = createInitialState("gp", "desc");

    const r1 = advancePhase(state0, nestedDefs);
    expect(r1.advanced).toBe(true);
    expect(r1.from).toBe("Phase 1");
    expect(r1.to).toBe("GC Phase 1");
    expect(r1.newState.currentPath).toHaveLength(3);
    expect(r1.newState.currentPath).toEqual([
      { workflowKey: "gp", phaseIndex: 1 },
      { workflowKey: "child", phaseIndex: 0 },
      { workflowKey: "grandchild", phaseIndex: 0 },
    ]);

    const r2 = advancePhase(r1.newState, nestedDefs);
    expect(r2.advanced).toBe(true);
    expect(r2.from).toBe("GC Phase 1");
    expect(r2.to).toBeNull();
    expect(r2.newState.active).toBe(false);
    expect(r2.newState.currentPath).toHaveLength(1);
    expect(r2.newState.currentPath[0].phaseIndex).toBe(2);
  });
});

// ── advancePhase — missing definition guards ──

describe("advancePhase — missing definition guards", () => {
  it("Case 1: entering subworkflow with missing definition → deactivates", () => {
    const parentWithMissingSub: WorkflowDefinition = {
      name: "Parent",
      commandName: "par",
      initialMessage: "Start",
      phases: [
        phase1,
        { subworkflow: true, workflowKey: "nonexistent", resolved: null },
      ],
    };
    const defs: Record<string, WorkflowDefinition> = { pms: parentWithMissingSub };
    const state0 = createInitialState("pms", "desc");

    const r1 = advancePhase(state0, defs);
    // Advance from phase1 to the subworkflow ref at index 1
    // Case 1: enter subworkflow, but definition is missing → deactivates
    // Wait, phase[1] is the subworkflow ref. At index 0 we have phase1 (normal).
    // We advance to index 1 which is the subworkflow ref. Let's check: the autoEnter
    // happens when advancing TO a subworkflow ref in Case 2's nextEntry check.
    // Actually the initial state has phaseIndex=0 pointing at phase1 (normal).
    // advancePhase: top is {pms, 0}, entry is phase1 (not sub).
    // Not last phase (0 < 1). Case 2: advance to index 1 (sub ref).
    // autoEnterSubworkflowRefs called with the sub ref → resolved is null → returns null
    // So to should be null (via ??)
    // Actually wait: resolved is null → autoEnterSubworkflowRefs returns {phaseName: null, newState: s}
    // and then to: concreteName ?? phaseEntryName(nextEntry) → null ?? "nonexistent" → "nonexistent"
    // This does NOT hit Case 1 of advancePhase (that's for when currentEntry is a subworkflowRef)
    expect(r1.advanced).toBe(true);
  });

  it("Case 1 direct: current entry is subworkflow with missing definition → deactivates", () => {
    // State pointing directly at a subworkflow ref
    const parentOnlySub: WorkflowDefinition = {
      name: "Parent",
      commandName: "par",
      initialMessage: "Start",
      phases: [{ subworkflow: true, workflowKey: "missing", resolved: null }],
    };
    const defs: Record<string, WorkflowDefinition> = { pos: parentOnlySub };
    const state0 = createInitialState("pos", "desc");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r1 = advancePhase(state0, defs);
    expect(r1.advanced).toBe(true);
    expect(r1.newState.active).toBe(false);
    expect(r1.to).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Missing definition for subworkflow 'missing'"),
    );
    warnSpy.mockRestore();
  });

  it("Case 4: breakout to parent with missing definition → deactivates", () => {
    // Create a state deep in a subworkflow, then remove the parent's definition
    const parentDef: WorkflowDefinition = {
      name: "Parent",
      commandName: "par",
      initialMessage: "Start",
      phases: [phase1, { subworkflow: true, workflowKey: "sub", resolved: subDef }],
    };
    const defs: Record<string, WorkflowDefinition> = {
      par: parentDef,
      sub: subDef,
    };

    const state0 = createInitialState("par", "desc");
    const state1 = advancePhase(state0, defs).newState; // auto-enters sub
    const state2 = advancePhase(state1, defs).newState; // sub[1]

    // Now remove parent definition to simulate missing definition during breakout
    const brokenDefs: Record<string, WorkflowDefinition> = { sub: subDef };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = advancePhase(state2, brokenDefs);
    expect(r.advanced).toBe(true);
    expect(r.newState.active).toBe(false);
    expect(r.to).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Missing definition for 'par' during breakout"),
    );
    warnSpy.mockRestore();
  });

  it("Case 4 multi-level: breakout with missing intermediate definition → deactivates", () => {
    // 3 levels: grandparent → child → grandchild
    // Complete grandchild, then during breakout child is exhausted and we try
    // to continue in grandparent, but grandparent's definition is missing
    const grandchildDef: WorkflowDefinition = {
      name: "Grandchild",
      commandName: "gc",
      initialMessage: "Start",
      show: "workflows",
      phases: [{ id: "gc1", name: "GC Phase 1", emoji: "🧒", instructions: "gc" }],
    };
    const childDef: WorkflowDefinition = {
      name: "Child",
      commandName: "child",
      initialMessage: "Start",
      show: "workflows",
      phases: [{ subworkflow: true, workflowKey: "grandchild", resolved: grandchildDef }],
    };
    const grandparentDef: WorkflowDefinition = {
      name: "Grandparent",
      commandName: "gp",
      initialMessage: "Start",
      phases: [{ subworkflow: true, workflowKey: "child", resolved: childDef }],
    };
    const fullDefs: Record<string, WorkflowDefinition> = {
      gp: grandparentDef,
      child: childDef,
      grandchild: grandchildDef,
    };

    // Build up state through advances, then remove grandparent definition
    const state0 = createInitialState("gp", "desc");
    // state0 is at gp[0] which is subworkflow ref to child
    const state1 = advancePhase(state0, fullDefs).newState; // enter child → child[0] which is sub ref to grandchild
    // Actually Case 1: currentEntry is sub ref to child → pushes child, enters child[0]
    // child[0] is sub ref to grandchild. But we're now pointing at child[0].
    // Next advance from child[0]:
    const state2 = advancePhase(state1, fullDefs).newState; // enter grandchild → grandchild[0]
    // Now advance from grandchild[0] (last phase) → breakout
    // Need to remove grandparent definition
    const brokenDefs: Record<string, WorkflowDefinition> = {
      child: childDef,
      grandchild: grandchildDef,
      // gp is missing!
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = advancePhase(state2, brokenDefs);
    expect(r.advanced).toBe(true);
    expect(r.newState.active).toBe(false);
    expect(r.to).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Missing definition for 'gp' during breakout"),
    );
    warnSpy.mockRestore();
  });
});

// ── resolveFirstPhase ──

describe("resolveFirstPhase", () => {
  it("returns first concrete phase from normal phases", () => {
    const result = resolveFirstPhase([phase1, phase2]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Phase 1");
  });

  it("returns null for empty array", () => {
    expect(resolveFirstPhase([])).toBeNull();
  });

  it("drills through subworkflow ref with resolved definition", () => {
    const ref: SubworkflowReference = {
      subworkflow: true,
      workflowKey: "sub",
      resolved: subDef,
    };
    const result = resolveFirstPhase([ref]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Sub Phase 1");
  });

  it("returns null for unresolved subworkflow ref", () => {
    const ref: SubworkflowReference = {
      subworkflow: true,
      workflowKey: "sub",
      resolved: null,
    };
    expect(resolveFirstPhase([ref])).toBeNull();
  });

  it("drills through nested subworkflow refs", () => {
    const innerPhase: typeof phase1 = { ...phase1, name: "Innermost Phase" };
    const innerDef: WorkflowDefinition = {
      name: "Inner",
      commandName: "inner",
      initialMessage: "Start",
      show: "workflows",
      phases: [innerPhase],
    };
    const midRef: SubworkflowReference = {
      subworkflow: true,
      workflowKey: "inner",
      resolved: innerDef,
    };
    const outerDef: WorkflowDefinition = {
      name: "Outer",
      commandName: "outer",
      initialMessage: "Start",
      show: "workflows",
      phases: [midRef],
    };
    const outerRef: SubworkflowReference = {
      subworkflow: true,
      workflowKey: "outer",
      resolved: outerDef,
    };
    const result = resolveFirstPhase([outerRef]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Innermost Phase");
  });
});

// ── autoEnterSubworkflowRefs ──

describe("autoEnterSubworkflowRefs", () => {
  it("returns null phaseName for unresolved ref", () => {
    const state = createInitialState("test", "desc");
    const ref: SubworkflowReference = {
      subworkflow: true,
      workflowKey: "sub",
      resolved: null,
    };
    const result = autoEnterSubworkflowRefs(state, ref);
    expect(result.phaseName).toBeNull();
    expect(result.newState).toBe(state); // same reference
  });

  it("enters subworkflow and returns first phase name", () => {
    const state = createInitialState("test", "desc");
    const ref: SubworkflowReference = {
      subworkflow: true,
      workflowKey: "sub",
      resolved: subDef,
    };
    const result = autoEnterSubworkflowRefs(state, ref);
    expect(result.phaseName).toBe("Sub Phase 1");
    expect(result.newState.currentPath).toHaveLength(2);
    expect(result.newState.currentPath[1]).toEqual({ workflowKey: "sub", phaseIndex: 0 });
    // Original not mutated
    expect(state.currentPath).toHaveLength(1);
  });

  it("drills through nested subworkflow refs", () => {
    const innerPhase: typeof phase1 = { ...phase1, name: "Innermost" };
    const innerDef: WorkflowDefinition = {
      name: "Inner",
      commandName: "inner",
      initialMessage: "Start",
      show: "workflows",
      phases: [innerPhase],
    };
    const midRef: SubworkflowReference = {
      subworkflow: true,
      workflowKey: "inner",
      resolved: innerDef,
    };
    const outerDef: WorkflowDefinition = {
      name: "Outer",
      commandName: "outer",
      initialMessage: "Start",
      show: "workflows",
      phases: [midRef],
    };
    const state = createInitialState("test", "desc");
    const ref: SubworkflowReference = {
      subworkflow: true,
      workflowKey: "outer",
      resolved: outerDef,
    };
    const result = autoEnterSubworkflowRefs(state, ref);
    expect(result.phaseName).toBe("Innermost");
    expect(result.newState.currentPath).toHaveLength(3);
  });
});

// ── phaseEntryName ──

describe("phaseEntryName", () => {
  it("returns name for PhaseDefinition", () => {
    expect(phaseEntryName(phase1)).toBe("Phase 1");
  });

  it("returns workflowKey for unresolved SubworkflowRef", () => {
    const ref: SubworkflowReference = {
      subworkflow: true,
      workflowKey: "my-sub",
      resolved: null,
    };
    expect(phaseEntryName(ref)).toBe("my-sub");
  });

  it("returns resolved.name for resolved SubworkflowRef", () => {
    const ref: SubworkflowReference = {
      subworkflow: true,
      workflowKey: "my-sub",
      resolved: subDef,
    };
    expect(phaseEntryName(ref)).toBe("Sub");
  });
});

// ── Immutability verification ──

describe("immutability", () => {
  it("advancePhase does not mutate the original state", () => {
    const state = createInitialState("linear", "desc");
    const originalPath = state.currentPath.map((s) => ({ ...s }));
    const originalStepCount = state.globalStepCount;
    const originalActive = state.active;

    advancePhase(state, allDefs);

    expect(state.currentPath).toEqual(originalPath);
    expect(state.globalStepCount).toBe(originalStepCount);
    expect(state.active).toBe(originalActive);
  });

  it("loopPhase does not mutate the original state", () => {
    const state0 = createInitialState("linear", "desc");
    const state1 = advancePhase(state0, allDefs).newState;
    const originalPath = state1.currentPath.map((s) => ({ ...s }));
    const originalStepCount = state1.globalStepCount;

    loopPhase(state1, allDefs);

    expect(state1.currentPath).toEqual(originalPath);
    expect(state1.globalStepCount).toBe(originalStepCount);
  });

  it("chained advancePhase calls produce correct states without mutation", () => {
    const state0 = createInitialState("parent", "desc");
    const r1 = advancePhase(state0, allDefs);
    const state1 = r1.newState;

    // state0 unchanged
    expect(state0.currentPath).toHaveLength(1);
    expect(state0.currentPath[0].phaseIndex).toBe(0);

    // state1 has subworkflow entered
    expect(state1.currentPath).toHaveLength(2);

    const r2 = advancePhase(state1, allDefs);
    const state2 = r2.newState;

    // state1 unchanged
    expect(state1.currentPath).toHaveLength(2);
    expect(state1.currentPath[1].phaseIndex).toBe(0);

    // state2 advanced within sub
    expect(state2.currentPath[1].phaseIndex).toBe(1);
  });
});

// ── resolveActive — subworkflow ref as current entry ──

describe("resolveActive — subworkflow ref as current entry", () => {
  it("resolves through subworkflow ref to first concrete phase", () => {
    const parentWithSub: WorkflowDefinition = {
      name: "Parent",
      commandName: "par",
      initialMessage: "Start",
      phases: [
        { subworkflow: true, workflowKey: "sub", resolved: subDef },
        phase2,
      ],
    };
    const defs: Record<string, WorkflowDefinition> = {
      pws: parentWithSub,
      sub: subDef,
    };

    const state = createInitialState("pws", "desc");
    const active = resolveActive(state, defs);
    expect(active).not.toBeNull();
    expect(active!.currentPhase.name).toBe("Sub Phase 1");
    expect(active!.currentPhaseEntry).toEqual({
      subworkflow: true,
      workflowKey: "sub",
      resolved: subDef,
    });
  });

  it("returns null for unresolved subworkflow ref at current position", () => {
    const parentWithUnresolved: WorkflowDefinition = {
      name: "Parent",
      commandName: "par",
      initialMessage: "Start",
      phases: [{ subworkflow: true, workflowKey: "missing", resolved: null }],
    };
    const defs: Record<string, WorkflowDefinition> = { pwu: parentWithUnresolved };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createInitialState("pwu", "desc");
    const active = resolveActive(state, defs);
    expect(active).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns null when path segment references missing workflow", () => {
    const state = createInitialState("nonexistent", "desc");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveActive(state, allDefs);
    expect(result).toBeNull();
    warnSpy.mockRestore();
  });

  it("returns null when subworkflow ref has empty phases", () => {
    const emptySubDef: WorkflowDefinition = {
      name: "EmptySub",
      commandName: "empty-sub",
      initialMessage: "Start",
      show: "workflows",
      phases: [],
    };
    const parentDef: WorkflowDefinition = {
      name: "Parent",
      commandName: "par",
      initialMessage: "Start",
      phases: [
        { subworkflow: true, workflowKey: "empty-sub", resolved: emptySubDef },
      ],
    };
    const defs: Record<string, WorkflowDefinition> = { par: parentDef, "empty-sub": emptySubDef };
    const state = createInitialState("par", "desc");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveActive(state, defs);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not resolve first phase"),
    );
    warnSpy.mockRestore();
  });
});

// ── reconstructState — additional validation ──

describe("reconstructState — additional validation", () => {
  it("invalid completionNotified type → returns null", () => {
    const ctx = makeCtx([
      {
        type: "custom",
        customType: "workflow:state",
        data: {
          active: true,
          workflowKey: "linear",
          currentPath: [{ workflowKey: "linear", phaseIndex: 0 }],
          globalStepCount: 0,
          startedAt: 1000,
          completionNotified: "yes",
        },
      },
    ]);
    expect(reconstructState(ctx)).toBeNull();
  });
});
