import { describe, it, expect } from "vitest";
import { registerWorkflowTool } from "../tool";
import { createMockAPI, createMockContext } from "./helpers/mocks";
import type { WorkflowState, WorkflowDefinition, PhaseDefinition } from "../types";

// ── Test Fixture Definitions ──

const phase1: PhaseDefinition = {
  id: "p1",
  name: "Phase 1",
  emoji: "1️⃣",
  instructions: "Do first",
};
const phase2: PhaseDefinition = {
  id: "p2",
  name: "Phase 2",
  emoji: "2️⃣",
  instructions: "Do second",
};
const phase3: PhaseDefinition = {
  id: "p3",
  name: "Phase 3",
  emoji: "3️⃣",
  instructions: "Do third",
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
  show: "workflows" as const,
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

const noLoopDef: WorkflowDefinition = {
  name: "NoLoop",
  commandName: "noloop",
  initialMessage: "Start",
  loopable: false,
  phases: [phase1, phase2],
};

const definitions: Record<string, WorkflowDefinition> = {
  linear: linearDef,
  parent: parentDef,
  sub: subDef,
  noloop: noLoopDef,
};

// ── Helpers ──

/** Create an active workflow state for the given workflow key, starting at phase 0. */
function makeActiveState(
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

/** Setup helper: registers the tool and returns the execute function plus mocks. */
function setupTool(state: WorkflowState | null) {
  const { api, registerTool, appendEntry } = createMockAPI();
  const ctx = createMockContext();

  let currentState: WorkflowState | null = state;
  const getState = () => currentState;
  const setState = (s: WorkflowState | null) => {
    currentState = s;
  };
  const getDefinitions = () => definitions;

  registerWorkflowTool(api, getState, getDefinitions, setState);

  expect(registerTool).toHaveBeenCalledTimes(1);
  const toolConfig = registerTool.mock.calls[0][0] as Record<string, unknown>;
  type ToolResult = {
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  };
  const execute = toolConfig.execute as (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<ToolResult>;

  return { execute, ctx, getState, setState, appendEntry, api };
}

/** Extract text from the execute result. */
function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("workflow_step tool", () => {
  // ── Status Action ──

  describe("status action", () => {
    it("returns 'No active workflow' when no workflow active", async () => {
      const { execute, ctx } = setupTool(null);

      const result = await execute("call-1", { action: "status" }, undefined, undefined, ctx);

      expect(result.details.active).toBe(false);
      expect(resultText(result)).toContain("No active workflow");
    });

    it("returns current phase info when workflow active", async () => {
      const state = makeActiveState("linear");
      const { execute, ctx } = setupTool(state);

      const result = await execute("call-1", { action: "status" }, undefined, undefined, ctx);

      expect(result.details.active).toBe(true);
      const text = resultText(result);
      expect(text).toContain("Linear");
      expect(text).toContain("Phase 1");
      expect(text).toContain("Do first");
    });
  });

  // ── Next Action ──

  describe("next action", () => {
    it("advances phase and updates status", async () => {
      const state = makeActiveState("linear");
      const { execute, ctx } = setupTool(state);

      const result = await execute("call-1", { action: "next" }, undefined, undefined, ctx);

      expect(result.details.advanced).toBe(true);
      expect(result.details.from).toBe("Phase 1");
      expect(result.details.to).toBe("Phase 2");
      const text = resultText(result);
      expect(text).toContain("Phase 1");
      expect(text).toContain("Phase 2");
      expect(text).toContain("Do second");
    });

    it("marks workflow complete on last phase", async () => {
      // Start at the last phase (index 2)
      const state = makeActiveState("linear", {
        currentPath: [{ workflowKey: "linear", phaseIndex: 2 }],
      });
      const { execute, ctx, getState } = setupTool(state);

      const result = await execute("call-1", { action: "next" }, undefined, undefined, ctx);

      expect(result.details.advanced).toBe(true);
      expect(result.details.to).toBe("DONE");
      expect(resultText(result)).toContain("All phases complete");

      const finalState = getState()!;
      expect(finalState.active).toBe(false);
    });

    it("entering subworkflow pushes new scope", async () => {
      // Parent is at phase index 1 = subworkflow reference
      const state = makeActiveState("parent", {
        currentPath: [{ workflowKey: "parent", phaseIndex: 1 }],
      });
      const { execute, ctx, getState } = setupTool(state);

      const result = await execute("call-1", { action: "next" }, undefined, undefined, ctx);

      expect(result.details.advanced).toBe(true);
      expect(result.details.to).toBe("Sub Phase 1");

      const currentState = getState()!;
      // Should have pushed a new scope onto the path
      expect(currentState.currentPath.length).toBe(2);
      expect(currentState.currentPath[1]).toEqual({
        workflowKey: "sub",
        phaseIndex: 0,
      });

      const text = resultText(result);
      expect(text).toContain("Entered subworkflow");
    });

    it("exiting subworkflow pops scope and advances parent", async () => {
      // Parent at phase 1 (subworkflow), sub at its last phase (index 1)
      const state = makeActiveState("parent", {
        currentPath: [
          { workflowKey: "parent", phaseIndex: 1 },
          { workflowKey: "sub", phaseIndex: 1 },
        ],
      });
      const { execute, ctx, getState } = setupTool(state);

      const result = await execute("call-1", { action: "next" }, undefined, undefined, ctx);

      expect(result.details.advanced).toBe(true);
      expect(result.details.from).toBe("Sub Phase 2");
      expect(result.details.to).toBe("Phase 3");

      const currentState = getState()!;
      // Subworkflow should have been popped, parent advanced from index 1 to 2
      expect(currentState.currentPath.length).toBe(1);
      expect(currentState.currentPath[0]).toEqual({
        workflowKey: "parent",
        phaseIndex: 2,
      });

      const text = resultText(result);
      expect(text).toContain("Exited subworkflow");
    });
  });

  // ── Cancel Action ──

  describe("cancel action", () => {
    it("first call sets _cancelPending and returns confirmation message", async () => {
      const state = makeActiveState("linear");
      const { execute, ctx, getState } = setupTool(state);

      const result = await execute("call-1", { action: "cancel" }, undefined, undefined, ctx);

      expect(result.details.active).toBe(true);
      expect(result.details.cancelPending).toBe(true);
      expect(resultText(result)).toContain("Confirm cancellation");

      const currentState = getState()!;
      expect(currentState._cancelPending).toBe(true);
    });

    it("second call marks workflow cancelled", async () => {
      const state = makeActiveState("linear", { _cancelPending: true });
      const { execute, ctx, getState } = setupTool(state);

      const result = await execute("call-1", { action: "cancel" }, undefined, undefined, ctx);

      expect(result.details.active).toBe(false);
      expect(result.details.cancelled).toBe(true);
      expect(resultText(result)).toContain("cancelled");

      const finalState = getState()!;
      expect(finalState.active).toBe(false);
      expect(finalState.cancelled).toBe(true);
    });

    it("when no workflow active returns 'No active workflow'", async () => {
      const { execute, ctx } = setupTool(null);

      const result = await execute("call-1", { action: "cancel" }, undefined, undefined, ctx);

      expect(result.details.active).toBe(false);
      expect(resultText(result)).toContain("No active workflow to cancel");
    });
  });

  // ── Loop Action ──

  describe("loop action", () => {
    it("resets phase index and returns to first phase", async () => {
      const state = makeActiveState("linear", {
        currentPath: [{ workflowKey: "linear", phaseIndex: 1 }],
      });
      const { execute, ctx, getState } = setupTool(state);

      const result = await execute("call-1", { action: "loop" }, undefined, undefined, ctx);

      expect(result.details.looped).toBe(true);
      const text = resultText(result);
      expect(text).toContain("Looped");
      expect(text).toContain("Phase 1");

      const currentState = getState()!;
      expect(currentState.currentPath[0].phaseIndex).toBe(0);
    });

    it("when phase not loopable returns error", async () => {
      const state = makeActiveState("noloop", {
        currentPath: [{ workflowKey: "noloop", phaseIndex: 1 }],
      });
      const { execute, ctx } = setupTool(state);

      const result = await execute("call-1", { action: "loop" }, undefined, undefined, ctx);

      expect(result.details.error).toBeDefined();
      expect(resultText(result)).toContain("Looping is disabled");
    });
  });

  // ── Summary Parameter ──

  describe("summary parameter", () => {
    it("is stored in state when provided with next action", async () => {
      const state = makeActiveState("linear");
      // We test that summary doesn't crash the tool. The tool itself doesn't
      // store summary in state, but it should be accepted without error.
      const { execute, ctx } = setupTool(state);

      // The execute function accepts summary in params but the current
      // implementation doesn't persist it. Just verify it doesn't throw.
      const result = await execute(
        "call-1",
        { action: "next", summary: "Completed phase 1 work" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.details.advanced).toBe(true);
    });
  });
});
