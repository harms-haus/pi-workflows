import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleAgentEnd, clearActiveCountdown } from "../hooks";
import { createMockAPI, createMockContext } from "./helpers/mocks";
import type { WorkflowState, WorkflowDefinition } from "../types";

// Use fake timers for countdown tests
beforeEach(() => {
  vi.useFakeTimers();
  // Reset module-level countdown state between tests
  clearActiveCountdown({ hasUI: false } as any);
});
afterEach(() => {
  vi.useRealTimers();
});

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
      messages: [{ role: "assistant", stopReason: "stop" }],
    });

    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "workflow-countdown",
      expect.arrayContaining([expect.stringContaining("3s")]),
      { placement: "aboveEditor" },
    );

    // Clear it
    clearActiveCountdown(ctx);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "workflow-countdown",
      undefined,
    );

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
      messages: [{ role: "assistant", stopReason: "aborted" }],
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
      messages: [{ role: "assistant", stopReason: "stop" }],
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
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "workflow-countdown",
      undefined,
    );
    expect(api.sendUserMessage).toHaveBeenCalled();
  });

  it("clears widget and handles gracefully when sendUserMessage throws during countdown", () => {
    const { api } = createMockAPI();
    const ctx = createMockContext();
    const state = makeActiveState();
    const defs = makeDefinition();
    api.sendUserMessage.mockImplementation(() => {
      throw new Error("Agent already processing");
    });

    handleAgentEnd(api, state, defs, ctx, {
      messages: [{ role: "assistant", stopReason: "stop" }],
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
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "workflow-countdown",
      undefined,
    );
    expect(api.sendUserMessage).toHaveBeenCalled();
  });

  it("prevents stacked intervals when agent_end fires during active countdown", () => {
    const { api } = createMockAPI();
    const ctx = createMockContext();
    const state = makeActiveState();
    const defs = makeDefinition();

    // First agent_end starts countdown
    handleAgentEnd(api, state, defs, ctx, {
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    const firstCallCount = ctx.ui.setWidget.mock.calls.length;

    // Second agent_end before countdown finishes
    handleAgentEnd(api, state, defs, ctx, {
      messages: [{ role: "assistant", stopReason: "stop" }],
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
      messages: [{ role: "assistant", stopReason: "stop" }],
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
      messages: [{ role: "assistant", stopReason: "stop" }],
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
      messages: [{ role: "assistant", stopReason: "stop" }],
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
