import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleAgentEnd,
  clearActiveCountdown,
  updateStatus,
  handleToolCall,
  handleBeforeAgentStart,
} from "../hooks";
import { createMockAPI, createMockContext } from "./helpers/mocks";
import type { WorkflowState, WorkflowDefinition } from "../types";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

// Use fake timers for countdown tests
beforeEach(() => {
  vi.useFakeTimers();
  // Reset module-level countdown state between tests
  clearActiveCountdown({ hasUI: false } as any);
});
afterEach(() => {
  vi.useRealTimers();
});

// Helper to create minimal mock AgentMessage
function mockMsg(stopReason: "stop" | "aborted"): AgentMessage {
  return { role: "assistant", stopReason } as AgentMessage;
}

// Minimal active workflow state fixture
function makeActiveState(): WorkflowState {
  return {
    active: true,
    workflowKey: "test-wf",
    currentPath: [{ workflowKey: "test-wf", phaseIndex: 0 }],
    globalStepCount: 0,
    taskId: "test-task",
    taskDescription: "Test task",
    startedAt: Date.now(),
    completionNotified: false,
    cancelled: false,
  };
}

// Minimal workflow definition fixture
function makeDefinition(): Record<string, WorkflowDefinition> {
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

describe("clearActiveCountdown", () => {
  it("clears widget when interval is active", () => {
    const ctx = createMockContext();
    const { api } = createMockAPI();
    const state = makeActiveState();
    const defs = makeDefinition();

    // Trigger countdown by calling handleAgentEnd
    handleAgentEnd(api, state, defs, ctx, {
      type: "agent_end" as const,
      messages: [mockMsg("stop")],
    });

    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "workflow-countdown",
      expect.arrayContaining([expect.stringContaining("3s")]),
      { placement: "aboveEditor" },
    );

    // Clear it
    clearActiveCountdown(ctx);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("workflow-countdown", undefined);

    vi.advanceTimersByTime(5000);
    expect(api.sendUserMessage).not.toHaveBeenCalled();
  });

  it("is safe to call when no countdown is active", () => {
    const ctx = createMockContext();
    expect(() => clearActiveCountdown(ctx)).not.toThrow();
  });

  it("is safe when ctx.hasUI is false", () => {
    const ctx = createMockContext({ hasUI: false } as any);
    expect(() => clearActiveCountdown(ctx)).not.toThrow();
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });
});

describe("handleAgentEnd — countdown widget", () => {
  it("does not auto-continue when agent was aborted (user interrupt)", () => {
    const { api } = createMockAPI();
    const ctx = createMockContext();
    const state = makeActiveState();
    const defs = makeDefinition();

    handleAgentEnd(api, state, defs, ctx, {
      type: "agent_end" as const,
      messages: [mockMsg("aborted")],
    });

    expect(api.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });

  it("shows countdown widget before auto-continue", () => {
    const { api } = createMockAPI();
    const ctx = createMockContext();
    const state = makeActiveState();
    const defs = makeDefinition();

    handleAgentEnd(api, state, defs, ctx, {
      type: "agent_end" as const,
      messages: [mockMsg("stop")],
    });

    // Widget should appear immediately with 3s
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "workflow-countdown",
      expect.arrayContaining([expect.stringContaining("3s")]),
      { placement: "aboveEditor" },
    );

    // Advance 1s → widget updated to 2s
    vi.advanceTimersByTime(1000);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "workflow-countdown",
      expect.arrayContaining([expect.stringContaining("2s")]),
      { placement: "aboveEditor" },
    );

    // Advance 1s → widget updated to 1s
    vi.advanceTimersByTime(1000);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "workflow-countdown",
      expect.arrayContaining([expect.stringContaining("1s")]),
      { placement: "aboveEditor" },
    );

    // Advance 1s → widget cleared and sendUserMessage called
    vi.advanceTimersByTime(1000);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("workflow-countdown", undefined);
    expect(api.sendUserMessage).toHaveBeenCalled();
  });

  it("clears widget and handles gracefully when sendUserMessage throws during countdown", () => {
    const { api, sendUserMessage } = createMockAPI();
    const ctx = createMockContext();
    const state = makeActiveState();
    const defs = makeDefinition();
    sendUserMessage.mockImplementation(() => {
      throw new Error("Agent already processing");
    });

    handleAgentEnd(api, state, defs, ctx, {
      type: "agent_end" as const,
      messages: [mockMsg("stop")],
    });

    // Widget shows 3s immediately
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "workflow-countdown",
      expect.arrayContaining([expect.stringContaining("3s")]),
      { placement: "aboveEditor" },
    );

    // Advance 3s to trigger the sendUserMessage throw
    vi.advanceTimersByTime(3000);

    // Widget should be cleared even though sendUserMessage threw
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("workflow-countdown", undefined);
    expect(api.sendUserMessage).toHaveBeenCalled();
  });

  it("prevents stacked intervals when agent_end fires during active countdown", () => {
    const { api } = createMockAPI();
    const ctx = createMockContext();
    const state = makeActiveState();
    const defs = makeDefinition();

    // First agent_end starts countdown
    handleAgentEnd(api, state, defs, ctx, {
      type: "agent_end" as const,
      messages: [mockMsg("stop")],
    });

    // Second agent_end before countdown finishes
    handleAgentEnd(api, state, defs, ctx, {
      type: "agent_end" as const,
      messages: [mockMsg("stop")],
    });

    // Widget should be reset to 3s (not continuing from previous countdown)
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(
      "workflow-countdown",
      expect.arrayContaining([expect.stringContaining("3s")]),
      { placement: "aboveEditor" },
    );

    // Advance 3s from the second countdown
    vi.advanceTimersByTime(3000);
    // sendUserMessage should only be called once (from the second countdown)
    expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
  });
});

describe("handleAgentEnd — null state", () => {
  it("does not show widget when state is null", () => {
    const { api } = createMockAPI();
    const ctx = createMockContext();
    const defs = makeDefinition();

    handleAgentEnd(api, null, defs, ctx, {
      type: "agent_end" as const,
      messages: [mockMsg("stop")],
    });

    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
    expect(api.sendUserMessage).not.toHaveBeenCalled();
  });

  it("returns noOp for active state", () => {
    const { api } = createMockAPI();
    const ctx = createMockContext();
    const state = makeActiveState();
    const defs = makeDefinition();

    const result = handleAgentEnd(api, state, defs, ctx, {
      type: "agent_end" as const,
      messages: [mockMsg("stop")],
    });

    expect(result).toEqual({ unload: false, persist: false });
  });
});

describe("handleAgentEnd — no-UI fallback", () => {
  it("uses sendMessage + setTimeout when hasUI is false", () => {
    const { api, sendMessage } = createMockAPI();
    const ctx = createMockContext({ hasUI: false } as any);
    const state = makeActiveState();
    const defs = makeDefinition();

    handleAgentEnd(api, state, defs, ctx, {
      type: "agent_end" as const,
      messages: [mockMsg("stop")],
    });

    // Should use sendMessage for countdown (not setWidget)
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: "workflow:countdown",
        content: expect.stringContaining("3s"),
        display: true,
      },
      { triggerTurn: false },
    );
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();

    // Advance 3s
    vi.advanceTimersByTime(3000);
    expect(api.sendUserMessage).toHaveBeenCalled();
  });
});

// ── updateStatus ──

describe("updateStatus", () => {
  it("clears status when state is null", () => {
    const setStatus = vi.fn();
    const ctx = { ui: { setStatus } };

    updateStatus(ctx, null, {});

    expect(setStatus).toHaveBeenCalledWith("workflow", undefined);
  });

  it("clears status when state.active is false", () => {
    const setStatus = vi.fn();
    const ctx = { ui: { setStatus } };
    const state: WorkflowState = {
      active: false,
      workflowKey: "test-wf",
      currentPath: [{ workflowKey: "test-wf", phaseIndex: 0 }],
      globalStepCount: 0,
      taskId: "task-1",
      taskDescription: "desc",
      startedAt: Date.now(),
      completionNotified: false,
      cancelled: false,
    };

    updateStatus(ctx, state, makeDefinition());

    expect(setStatus).toHaveBeenCalledWith("workflow", undefined);
  });

  it("shows phase name for linear workflow (single path segment)", () => {
    const setStatus = vi.fn();
    const ctx = { ui: { setStatus } };
    const defs: Record<string, WorkflowDefinition> = {
      "test-wf": {
        name: "My Workflow",
        commandName: "test",
        initialMessage: "Start",
        phases: [
          { id: "p1", name: "Phase 1", emoji: "🔍", instructions: "Do it" },
          { id: "p2", name: "Phase 2", emoji: "✅", instructions: "Done" },
        ],
      },
    };
    const state: WorkflowState = {
      active: true,
      workflowKey: "test-wf",
      currentPath: [{ workflowKey: "test-wf", phaseIndex: 0 }],
      globalStepCount: 0,
      taskId: "task-1",
      taskDescription: "desc",
      startedAt: Date.now(),
      completionNotified: false,
      cancelled: false,
    };

    updateStatus(ctx, state, defs);

    expect(setStatus).toHaveBeenCalledWith("workflow", "My Workflow — 🔍 Phase 1 [1/2]");
  });

  it("shows breadcrumb format for nested subworkflow", () => {
    const setStatus = vi.fn();
    const ctx = { ui: { setStatus } };
    const innerDef: WorkflowDefinition = {
      name: "Inner Workflow",
      commandName: "inner",
      initialMessage: "Go",
      phases: [
        { id: "ip1", name: "Inner Phase", emoji: "⚙️", instructions: "Inner work" },
        { id: "ip2", name: "Inner Phase 2", emoji: "🔧", instructions: "More" },
      ],
    };
    const defs: Record<string, WorkflowDefinition> = {
      "outer-wf": {
        name: "Outer Workflow",
        commandName: "outer",
        initialMessage: "Start",
        phases: [
          {
            subworkflow: true,
            workflowKey: "inner-wf",
            resolved: innerDef,
          },
        ],
      },
      "inner-wf": innerDef,
    };
    const state: WorkflowState = {
      active: true,
      workflowKey: "outer-wf",
      currentPath: [
        { workflowKey: "outer-wf", phaseIndex: 0 },
        { workflowKey: "inner-wf", phaseIndex: 0 },
      ],
      globalStepCount: 1,
      taskId: "task-1",
      taskDescription: "desc",
      startedAt: Date.now(),
      completionNotified: false,
      cancelled: false,
    };

    updateStatus(ctx, state, defs);

    expect(setStatus).toHaveBeenCalledWith(
      "workflow",
      "Outer Workflow > Inner Workflow — ⚙️ Inner Phase [1/2]",
    );
  });

  it("clears status when resolveActive returns null (missing definition)", () => {
    const setStatus = vi.fn();
    const ctx = { ui: { setStatus } };
    const state: WorkflowState = {
      active: true,
      workflowKey: "nonexistent",
      currentPath: [{ workflowKey: "nonexistent", phaseIndex: 0 }],
      globalStepCount: 0,
      taskId: "task-1",
      taskDescription: "desc",
      startedAt: Date.now(),
      completionNotified: false,
      cancelled: false,
    };

    updateStatus(ctx, state, {});

    expect(setStatus).toHaveBeenCalledWith("workflow", undefined);
  });
});

// ── handleToolCall ──

describe("handleToolCall", () => {
  function makeToolCallEvent(toolName: string): ToolCallEvent {
    return { toolName } as ToolCallEvent;
  }

  it("allows all tools when state is null", () => {
    const result = handleToolCall(makeToolCallEvent("bash"), null, makeDefinition());
    expect(result).toBeUndefined();
  });

  it("allows all tools when state.active is false", () => {
    const state: WorkflowState = {
      active: false,
      workflowKey: "test-wf",
      currentPath: [{ workflowKey: "test-wf", phaseIndex: 0 }],
      globalStepCount: 0,
      taskId: "task-1",
      taskDescription: "desc",
      startedAt: Date.now(),
      completionNotified: false,
      cancelled: false,
    };
    const result = handleToolCall(makeToolCallEvent("bash"), state, makeDefinition());
    expect(result).toBeUndefined();
  });

  it("blocks blacklisted tools with reason", () => {
    const defs: Record<string, WorkflowDefinition> = {
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
            tools: { blacklist: ["edit_file", "write_file"] },
          },
        ],
      },
    };
    const state = makeActiveState();

    const result = handleToolCall(makeToolCallEvent("edit_file"), state, defs);

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("edit_file"),
    });
    expect(result!.reason).toContain("blocked");
  });

  it("blocks non-whitelisted tools when whitelist is set", () => {
    const defs: Record<string, WorkflowDefinition> = {
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
            tools: { whitelist: ["read_file", "search"] },
          },
        ],
      },
    };
    const state = makeActiveState();

    const result = handleToolCall(makeToolCallEvent("edit_file"), state, defs);

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("edit_file"),
    });
  });

  it("allows whitelisted tools", () => {
    const defs: Record<string, WorkflowDefinition> = {
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
            tools: { whitelist: ["read_file", "search"] },
          },
        ],
      },
    };
    const state = makeActiveState();

    const result = handleToolCall(makeToolCallEvent("read_file"), state, defs);
    expect(result).toBeUndefined();
  });

  it("allows all tools when no tool config on phase", () => {
    const state = makeActiveState();
    const defs = makeDefinition();

    const result = handleToolCall(makeToolCallEvent("anything"), state, defs);
    expect(result).toBeUndefined();
  });

  it("always allows workflow_step tool", () => {
    const defs: Record<string, WorkflowDefinition> = {
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
            tools: { blacklist: ["workflow_step"] },
          },
        ],
      },
    };
    const state = makeActiveState();

    const result = handleToolCall(makeToolCallEvent("workflow_step"), state, defs);
    expect(result).toBeUndefined();
  });

  it("allows non-blacklisted tools", () => {
    const defs: Record<string, WorkflowDefinition> = {
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
            tools: { blacklist: ["edit_file"] },
          },
        ],
      },
    };
    const state = makeActiveState();

    const result = handleToolCall(makeToolCallEvent("bash"), state, defs);
    expect(result).toBeUndefined();
  });
});

// ── handleBeforeAgentStart ──

describe("handleBeforeAgentStart", () => {
  it("returns undefined when state is null", () => {
    const result = handleBeforeAgentStart(null, makeDefinition());
    expect(result).toBeUndefined();
  });

  it("returns undefined when state.active is false", () => {
    const state: WorkflowState = {
      active: false,
      workflowKey: "test-wf",
      currentPath: [{ workflowKey: "test-wf", phaseIndex: 0 }],
      globalStepCount: 0,
      taskId: "task-1",
      taskDescription: "desc",
      startedAt: Date.now(),
      completionNotified: false,
      cancelled: false,
    };
    const result = handleBeforeAgentStart(state, makeDefinition());
    expect(result).toBeUndefined();
  });

  it("returns context prompt message when state is active", () => {
    const state = makeActiveState();
    const defs = makeDefinition();

    const result = handleBeforeAgentStart(state, defs);

    expect(result).toEqual({
      message: {
        customType: "workflow:context",
        content: expect.any(String),
        display: false,
      },
    });
    // Content should contain the task description and phase info
    expect(result!.message.content).toContain("Test task");
    expect(result!.message.content).toContain("Phase 1");
  });
});
