import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockAPI, createMockContext } from "./helpers/mocks";
import type { WorkflowState, WorkflowDefinition } from "../types";

// ── Mock all modules that index.ts imports ──

const mockLoadWorkflows = vi.fn();
const mockReconstructState = vi.fn();
const mockPersistState = vi.fn();
const mockUpdateStatus = vi.fn();
const mockHandleToolCall = vi.fn();
const mockHandleBeforeAgentStart = vi.fn();
const mockHandleAgentEnd = vi.fn();
const mockClearActiveCountdown = vi.fn();
const mockRegisterWorkflowTool = vi.fn();
const mockRegisterWorkflowCommand = vi.fn();
const mockRegisterCancelWorkflowCommand = vi.fn();
const mockRegisterRenderers = vi.fn();

vi.mock("../config", () => ({
  loadWorkflows: (...args: unknown[]) => mockLoadWorkflows(...args),
}));

vi.mock("../state", () => ({
  persistState: (...args: unknown[]) => mockPersistState(...args),
  reconstructState: (...args: unknown[]) => mockReconstructState(...args),
}));

vi.mock("../hooks", () => ({
  updateStatus: (...args: unknown[]) => mockUpdateStatus(...args),
  handleToolCall: (...args: unknown[]) => mockHandleToolCall(...args),
  handleBeforeAgentStart: (...args: unknown[]) => mockHandleBeforeAgentStart(...args),
  handleAgentEnd: (...args: unknown[]) => mockHandleAgentEnd(...args),
  clearActiveCountdown: (...args: unknown[]) => mockClearActiveCountdown(...args),
}));

vi.mock("../tool", () => ({
  registerWorkflowTool: (...args: unknown[]) => mockRegisterWorkflowTool(...args),
}));

vi.mock("../command", () => ({
  registerWorkflowCommand: (...args: unknown[]) => mockRegisterWorkflowCommand(...args),
  registerCancelWorkflowCommand: (...args: unknown[]) => mockRegisterCancelWorkflowCommand(...args),
}));

vi.mock("../renderers", () => ({
  registerRenderers: (...args: unknown[]) => mockRegisterRenderers(...args),
}));

// Import after mocks are set up
import indexModule from "../index";

// ── Helpers ──

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

function makeActiveState(): WorkflowState {
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
  };
}

/** Initialize the extension and return a map of eventName → handler callback. */
function initAndGetHandlers() {
  const { api, on } = createMockAPI();
  const ctx = createMockContext();

  mockLoadWorkflows.mockResolvedValue(makeDefinition());
  mockReconstructState.mockReturnValue(makeActiveState());
  mockHandleAgentEnd.mockReturnValue({ unload: false, persist: false });

  indexModule(api);

  // Extract handlers from on.mock.calls
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  for (const [eventName, handler] of on.mock.calls as [string, (...args: unknown[]) => unknown][]) {
    handlers[eventName] = handler;
  }
  return { api, ctx, on, handlers };
}

// ── Tests ──

beforeEach(() => {
  vi.clearAllMocks();
});

describe("index module", () => {
  it("exports a default function", () => {
    expect(typeof indexModule).toBe("function");
  });

  it("registers all 6 event handlers via pi.on", () => {
    const { on } = initAndGetHandlers();
    expect(on).toHaveBeenCalledTimes(6);
    const eventNames = (on.mock.calls as [string, unknown][]).map(([name]) => name);
    expect(eventNames).toContain("session_start");
    expect(eventNames).toContain("session_tree");
    expect(eventNames).toContain("tool_call");
    expect(eventNames).toContain("before_agent_start");
    expect(eventNames).toContain("agent_end");
    expect(eventNames).toContain("turn_end");
  });

  it("registers the workflow tool via registerWorkflowTool", () => {
    initAndGetHandlers();
    expect(mockRegisterWorkflowTool).toHaveBeenCalledTimes(1);
    expect(mockRegisterWorkflowTool).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function), // getState
      expect.any(Function), // getDefinitions
      expect.any(Function), // setState
    );
  });

  it("registers commands via registerWorkflowCommand and registerCancelWorkflowCommand", () => {
    initAndGetHandlers();
    expect(mockRegisterWorkflowCommand).toHaveBeenCalledTimes(1);
    expect(mockRegisterCancelWorkflowCommand).toHaveBeenCalledTimes(1);
  });

  it("registers renderers via registerRenderers", () => {
    initAndGetHandlers();
    expect(mockRegisterRenderers).toHaveBeenCalledTimes(1);
  });
});

describe("session_start handler", () => {
  it("loads workflows, reconstructs state, and updates status", async () => {
    const { handlers, ctx } = initAndGetHandlers();
    const defs = makeDefinition();
    const state = makeActiveState();

    mockLoadWorkflows.mockResolvedValue(defs);
    mockReconstructState.mockReturnValue(state);

    await handlers["session_start"]({}, ctx);

    expect(mockClearActiveCountdown).toHaveBeenCalledWith(ctx);
    expect(mockLoadWorkflows).toHaveBeenCalledWith(ctx.cwd);
    expect(mockReconstructState).toHaveBeenCalledWith(ctx);
    expect(mockUpdateStatus).toHaveBeenCalledWith(ctx, state, defs);
  });

  it("catches and swallows stale errors", async () => {
    const { handlers, ctx } = initAndGetHandlers();
    mockLoadWorkflows.mockRejectedValue(new Error("stale context"));

    // Should NOT throw
    await expect(handlers["session_start"]({}, ctx)).resolves.toBeUndefined();
  });

  it("re-throws non-stale errors", async () => {
    const { handlers, ctx } = initAndGetHandlers();
    mockLoadWorkflows.mockRejectedValue(new Error("disk failure"));

    await expect(handlers["session_start"]({}, ctx)).rejects.toThrow("disk failure");
  });
});

describe("session_tree handler", () => {
  it("loads workflows, reconstructs state, and updates status", async () => {
    const { handlers, ctx } = initAndGetHandlers();
    const defs = makeDefinition();
    const state = makeActiveState();

    mockLoadWorkflows.mockResolvedValue(defs);
    mockReconstructState.mockReturnValue(state);

    await handlers["session_tree"]({}, ctx);

    expect(mockClearActiveCountdown).toHaveBeenCalledWith(ctx);
    expect(mockLoadWorkflows).toHaveBeenCalledWith(ctx.cwd);
    expect(mockReconstructState).toHaveBeenCalledWith(ctx);
    expect(mockUpdateStatus).toHaveBeenCalledWith(ctx, state, defs);
  });

  it("catches and swallows stale errors", async () => {
    const { handlers, ctx } = initAndGetHandlers();
    mockLoadWorkflows.mockRejectedValue(new Error("stale context"));

    await expect(handlers["session_tree"]({}, ctx)).resolves.toBeUndefined();
  });

  it("re-throws non-stale errors", async () => {
    const { handlers, ctx } = initAndGetHandlers();
    mockLoadWorkflows.mockRejectedValue(new Error("filesystem error"));

    await expect(handlers["session_tree"]({}, ctx)).rejects.toThrow("filesystem error");
  });
});

describe("tool_call handler", () => {
  it("delegates to handleToolCall", async () => {
    const { handlers } = initAndGetHandlers();
    const event = { toolName: "some_tool" };
    const ctx = {};

    mockHandleToolCall.mockReturnValue(undefined);

    const result = await handlers["tool_call"](event, ctx);

    expect(mockHandleToolCall).toHaveBeenCalledWith(event, null, {});
    expect(result).toBeUndefined();
  });

  it("returns handleToolCall result when blocking", async () => {
    const { handlers } = initAndGetHandlers();
    const event = { toolName: "bash" };
    const blockResult = { block: true as const, reason: "blocked" };
    mockHandleToolCall.mockReturnValue(blockResult);

    const result = await handlers["tool_call"](event, {});

    expect(result).toEqual(blockResult);
  });
});

describe("before_agent_start handler", () => {
  it("delegates to handleBeforeAgentStart", async () => {
    const { handlers } = initAndGetHandlers();
    const msgResult = {
      message: { customType: "workflow:context", content: "prompt", display: false },
    };
    mockHandleBeforeAgentStart.mockReturnValue(msgResult);

    const result = await handlers["before_agent_start"]({}, {});

    expect(mockHandleBeforeAgentStart).toHaveBeenCalledWith(null, {});
    expect(result).toEqual(msgResult);
  });

  it("returns undefined when handleBeforeAgentStart returns void", async () => {
    const { handlers } = initAndGetHandlers();
    mockHandleBeforeAgentStart.mockReturnValue(undefined);

    const result = await handlers["before_agent_start"]({}, {});

    expect(result).toBeUndefined();
  });
});

describe("agent_end handler", () => {
  it("delegates to handleAgentEnd and persists when mutation.persist is true", async () => {
    const { api, handlers, ctx } = initAndGetHandlers();
    const state = makeActiveState();
    const event = { type: "agent_end", messages: [] };

    // Need to set state via session_start first, so the internal state is non-null
    mockLoadWorkflows.mockResolvedValue(makeDefinition());
    mockReconstructState.mockReturnValue(state);
    await handlers["session_start"]({}, ctx);

    const mutatedState = { ...state, completionNotified: true };
    mockHandleAgentEnd.mockReturnValue({ unload: false, persist: true, state: mutatedState });

    await handlers["agent_end"](event, ctx);

    expect(mockHandleAgentEnd).toHaveBeenCalledWith(api, state, makeDefinition(), ctx, event);
    expect(mockPersistState).toHaveBeenCalled();
  });

  it("sets state to null when mutation.unload is true", async () => {
    const { handlers, ctx } = initAndGetHandlers();
    const state = makeActiveState();

    // Initialize state
    mockLoadWorkflows.mockResolvedValue(makeDefinition());
    mockReconstructState.mockReturnValue(state);
    await handlers["session_start"]({}, ctx);

    mockHandleAgentEnd.mockReturnValue({ unload: true, persist: false });

    // agent_end with unload
    await handlers["agent_end"]({ type: "agent_end", messages: [] }, ctx);

    // Verify state was unloaded — next handleAgentEnd call should receive null state
    mockHandleAgentEnd.mockReturnValue({ unload: false, persist: false });
    await handlers["agent_end"]({ type: "agent_end", messages: [] }, ctx);

    expect(mockHandleAgentEnd).toHaveBeenLastCalledWith(
      expect.anything(),
      null, // state should be null after unload
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("updates state when mutation.state is provided", async () => {
    const { handlers, ctx } = initAndGetHandlers();
    const state = makeActiveState();

    // Initialize state
    mockLoadWorkflows.mockResolvedValue(makeDefinition());
    mockReconstructState.mockReturnValue(state);
    await handlers["session_start"]({}, ctx);

    const newState: WorkflowState = { ...state, globalStepCount: 5 };
    mockHandleAgentEnd.mockReturnValue({ unload: false, persist: false, state: newState });

    await handlers["agent_end"]({ type: "agent_end", messages: [] }, ctx);

    // Next handleAgentEnd call should receive newState
    mockHandleAgentEnd.mockReturnValue({ unload: false, persist: false });
    await handlers["agent_end"]({ type: "agent_end", messages: [] }, ctx);

    expect(mockHandleAgentEnd).toHaveBeenLastCalledWith(
      expect.anything(),
      newState,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("catches and swallows stale errors", async () => {
    const { handlers, ctx } = initAndGetHandlers();
    mockHandleAgentEnd.mockImplementation(() => {
      throw new Error("stale context");
    });

    await expect(
      handlers["agent_end"]({ type: "agent_end", messages: [] }, ctx),
    ).resolves.toBeUndefined();
  });

  it("re-throws non-stale errors", async () => {
    const { handlers, ctx } = initAndGetHandlers();
    mockHandleAgentEnd.mockImplementation(() => {
      throw new Error("something broke");
    });

    await expect(handlers["agent_end"]({ type: "agent_end", messages: [] }, ctx)).rejects.toThrow(
      "something broke",
    );
  });
});

describe("turn_end handler", () => {
  it("delegates to updateStatus", async () => {
    const { handlers, ctx } = initAndGetHandlers();

    await handlers["turn_end"]({}, ctx);

    expect(mockUpdateStatus).toHaveBeenCalledWith(ctx, null, {});
  });

  it("catches and swallows stale errors from updateStatus", async () => {
    const { handlers, ctx } = initAndGetHandlers();
    mockUpdateStatus.mockImplementation(() => {
      throw new Error("stale context");
    });

    await expect(handlers["turn_end"]({}, ctx)).resolves.toBeUndefined();
  });

  it("re-throws non-stale errors from updateStatus", async () => {
    const { handlers, ctx } = initAndGetHandlers();
    mockUpdateStatus.mockImplementation(() => {
      throw new Error("render error");
    });

    await expect(handlers["turn_end"]({}, ctx)).rejects.toThrow("render error");
  });
});
