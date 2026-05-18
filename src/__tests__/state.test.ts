import { describe, it, expect } from "vitest";
import {
  createInitialState,
  advancePhase,
  loopPhase,
  resolveActive,
  reconstructState,
  isActive,
} from "../state";
import type { WorkflowDefinition } from "../types";
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

// ── advancePhase — breakout when subworkflow is parent's last phase ──

describe("advancePhase — breakout when subworkflow is parent's last phase", () => {
  // Parent whose last (and only trailing) phase is a subworkflow
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
    const state = createInitialState("psl", "desc");

    // Step 1: advance from phase1 → auto-enters sub → sub[0]
    const r1 = advancePhase(state, pslDefs);
    expect(r1.advanced).toBe(true);
    expect(r1.from).toBe("Phase 1");
    expect(r1.to).toBe("Sub Phase 1");
    expect(state.currentPath).toHaveLength(2);

    // Step 2: advance within sub → sub[1]
    const r2 = advancePhase(state, pslDefs);
    expect(r2.advanced).toBe(true);
    expect(r2.from).toBe("Sub Phase 1");
    expect(r2.to).toBe("Sub Phase 2");

    // Step 3: breakout from sub, parent has no more phases → DONE
    const r3 = advancePhase(state, pslDefs);
    expect(r3.advanced).toBe(true);
    expect(r3.from).toBe("Sub Phase 2");
    expect(r3.to).toBeNull();
    expect(state.active).toBe(false);
    expect(state.currentPath).toHaveLength(1);
    expect(state.currentPath[0].phaseIndex).toBe(2); // past end
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

    const state = createInitialState("pos", "desc");
    // Phase 0 is a subworkflow ref — Case 1: auto-enter
    // But first, we need to advance FROM the subworkflow ref. Actually,
    // the initial state is at index 0 which is the subworkflow ref.
    // advancePhase Case 1 handles this by pushing the sub.
    // Wait — the initial state starts at index 0 which IS the subworkflow ref.
    // Let me think: the state starts at {workflowKey: "pos", phaseIndex: 0}.
    // Phase 0 of pos is a SubworkflowRef. So calling advancePhase will hit Case 1
    // and enter the sub. Then we advance within sub, and on last phase of sub,
    // we break out.
    // Actually, Case 1 enters sub but it doesn't consume a step from the user's
    // perspective — it's an auto-enter. Let's re-read Case 1.
    // Case 1 is: if currentEntry is a subworkflowRef, push new segment and return.
    // This means the user's first advance enters the sub. Let me simulate:

    // First advance: current is subworkflow ref → Case 1 → enter sub[0]
    const r1 = advancePhase(state, posDefs);
    expect(r1.advanced).toBe(true);
    expect(state.currentPath).toHaveLength(2);
    expect(state.currentPath[1]).toEqual({ workflowKey: "sub", phaseIndex: 0 });

    // Second advance: sub[0] → sub[1]
    const r2 = advancePhase(state, posDefs);
    expect(r2.advanced).toBe(true);
    expect(r2.from).toBe("Sub Phase 1");
    expect(r2.to).toBe("Sub Phase 2");

    // Third advance: sub[1] is last → breakout. Parent has no more phases → DONE
    const r3 = advancePhase(state, posDefs);
    expect(r3.advanced).toBe(true);
    expect(r3.from).toBe("Sub Phase 2");
    expect(r3.to).toBeNull();
    expect(state.active).toBe(false);
  });
});

// ── advancePhase — multi-level breakout (nested last-phase subworkflows) ──

describe("advancePhase — multi-level breakout", () => {
  // grandchild: a tiny subworkflow with 1 phase
  const grandchildDef: WorkflowDefinition = {
    name: "Grandchild",
    commandName: "gc",
    initialMessage: "Start",
    show: "workflows",
    phases: [{ id: "gc1", name: "GC Phase 1", emoji: "🧒", instructions: "gc" }],
  };

  // child: its only/last phase is a subworkflow ref to grandchild
  const childDef: WorkflowDefinition = {
    name: "Child",
    commandName: "child",
    initialMessage: "Start",
    show: "workflows",
    phases: [{ subworkflow: true, workflowKey: "grandchild", resolved: grandchildDef }],
  };

  // grandparent: its only/last phase is a subworkflow ref to child
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
    const state = createInitialState("gp", "desc");

    // Step 1: advance from phase1 → auto-enters child → child[0] (which is a subworkflow ref)
    // But child[0] is a SubworkflowRef to grandchild.
    // Case 2 or auto-enter handles this? Let's trace:
    // advancePhase: top is gp, phaseIndex 0, entry is phase1 (normal phase)
    // Not subworkflowRef (Case 1), not last phase (Case 2 check: 0 < 2-1=1 → yes)
    // So Case 2: advance to index 1, which is subworkflowRef to child
    // autoEnterSubworkflowRefs is called, which pushes child segment at [0]
    // child's first phase is grandchild ref → recurse → pushes grandchild at [0]
    // Returns "GC Phase 1"
    const r1 = advancePhase(state, nestedDefs);
    expect(r1.advanced).toBe(true);
    expect(r1.from).toBe("Phase 1");
    expect(r1.to).toBe("GC Phase 1");
    expect(state.currentPath).toHaveLength(3);
    expect(state.currentPath).toEqual([
      { workflowKey: "gp", phaseIndex: 1 },
      { workflowKey: "child", phaseIndex: 0 },
      { workflowKey: "grandchild", phaseIndex: 0 },
    ]);

    // Step 2: advance from grandchild[0] (last phase of grandchild)
    // → breakout to child. child has no more phases (grandchild was its last).
    // → breakout to grandparent. grandparent has no more phases (child was its last).
    // → DONE
    const r2 = advancePhase(state, nestedDefs);
    expect(r2.advanced).toBe(true);
    expect(r2.from).toBe("GC Phase 1");
    expect(r2.to).toBeNull();
    expect(state.active).toBe(false);
    expect(state.currentPath).toHaveLength(1);
    expect(state.currentPath[0].phaseIndex).toBe(2); // past end of grandparent phases
  });
});
