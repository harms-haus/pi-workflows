import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowState, WorkflowDefinition, SetState, ReloadDefinitions } from "../types";

// ── Mock the config module ──
// loadWorkflows reads from the filesystem so we must mock it.
const mockLoadWorkflows = vi.fn();
const mockFindWorkflowByCommandName = vi.fn();

vi.mock("../config", () => ({
  loadWorkflows: (...args: unknown[]) => mockLoadWorkflows(...(args as [cwd?: string])),
  findWorkflowByCommandName: (...args: unknown[]) =>
    mockFindWorkflowByCommandName(...(args as [Record<string, WorkflowDefinition>, string])),
  resolveTemplate: (template: string, vars: Record<string, string>) =>
    template.replace(/\{(\w+)\}/g, (_: string, key: string) => vars[key] ?? `{${key}}`),
}));

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type * as StateNS from "../state";

// Mock persistState so we don't need a full pi.appendEntry for state persistence
vi.mock("../state", async (importOriginal) => {
  const orig = await importOriginal<typeof StateNS>();
  return {
    ...orig,
    persistState: vi.fn(),
  };
});

import { registerWorkflowCommand, registerCancelWorkflowCommand } from "../command";
import {
  CMD_TEST_DEFINITION as testDefinition,
  CMD_SUB_DEFINITION as subDefinition,
  makeCommandDefs,
} from "./helpers/fixtures";

// ── Fixtures (from shared helpers) ──

const definitions = makeCommandDefs();

// ── Mock helpers ──

interface CapturedCommand {
  handler: (args: string, ctx: any) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => Promise<any>;
  description: string;
}

function createMockPI() {
  const commands = new Map<string, CapturedCommand>();

  return {
    commands,
    api: {
      registerCommand: vi.fn((_name: string, options: CapturedCommand) => {
        commands.set(_name, {
          handler: options.handler,
          getArgumentCompletions: options.getArgumentCompletions,
          description: options.description,
        });
      }),
      setSessionName: vi.fn(),
      sendUserMessage: vi.fn(),
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
      registerTool: vi.fn(),
      on: vi.fn(),
      registerMessageRenderer: vi.fn(),
      ui: { setWidget: vi.fn() },
    } as unknown as ExtensionAPI,
  };
}

function createMockCtx(overrides: Record<string, unknown> = {}) {
  return {
    hasUI: true,
    cwd: "/test/project",
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
      confirm: vi.fn(),
    },
    sessionManager: {
      getBranch: vi.fn(() => []),
    },
    ...overrides,
  } as any;
}

// ── Tests ──

describe("registerWorkflowCommand", () => {
  let mockPI: ReturnType<typeof createMockPI>;
  let state: WorkflowState | null;
  let setState: SetState;
  let reloadDefinitions: ReloadDefinitions;
  let handler: CapturedCommand["handler"];
  let ctx: ReturnType<typeof createMockCtx>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPI = createMockPI();
    state = null;
    setState = vi.fn((s: WorkflowState | null) => {
      state = s;
    });
    reloadDefinitions = vi.fn(() => Promise.resolve({ ...definitions }));
    ctx = createMockCtx();

    // Default mocks
    mockLoadWorkflows.mockReturnValue({ ...definitions });
    mockFindWorkflowByCommandName.mockImplementation(
      (workflows: Record<string, WorkflowDefinition>, commandName: string) => {
        for (const [key, def] of Object.entries(workflows)) {
          if (def.commandName === commandName) return [key, def];
        }
        return null;
      },
    );

    registerWorkflowCommand(mockPI.api, () => state, reloadDefinitions, setState);
    handler = mockPI.commands.get("workflow")!.handler;
  });

  it("registers the /workflow command", () => {
    expect(mockPI.api.registerCommand).toHaveBeenCalledWith("workflow", expect.any(Object));
    expect(mockPI.commands.has("workflow")).toBe(true);
  });

  describe("no arguments", () => {
    it("shows available workflows info notification", async () => {
      await handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Usage: /workflow {name} {description}"),
        "info",
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("test-cmd"), "info");
    });

    it("shows available workflows when args is undefined", async () => {
      await handler(undefined as any, ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Usage: /workflow {name} {description}"),
        "info",
      );
    });
  });

  describe("valid workflow invocation", () => {
    it("creates state and sends initial message", async () => {
      await handler("test-cmd my description", ctx);

      // setState should have been called with new state
      expect(setState).toHaveBeenCalledTimes(1);
      // We can inspect via our state variable since setState writes to it
      expect(state).not.toBeNull();
      expect(state!.active).toBe(true);
      expect(state!.workflowKey).toBe("test-workflow");
      expect(state!.taskDescription).toBe("my description");
      expect(state!.currentPath).toEqual([{ workflowKey: "test-workflow", phaseIndex: 0 }]);

      // sendUserMessage should have been called with resolved template
      expect(mockPI.api.sendUserMessage).toHaveBeenCalledWith("Starting Test");
    });

    it("sets session name with prefix and description", async () => {
      await handler("test-cmd build the thing", ctx);

      expect(mockPI.api.setSessionName).toHaveBeenCalledWith("Workflow: build the thing");
    });

    it("respects sessionNamePrefix from definition", async () => {
      const customDef: WorkflowDefinition = {
        ...testDefinition,
        sessionNamePrefix: "🔧 ",
      };
      (reloadDefinitions as ReturnType<typeof vi.fn>).mockResolvedValue({
        "test-workflow": customDef,
      });

      await handler("test-cmd build it", ctx);

      expect(mockPI.api.setSessionName).toHaveBeenCalledWith("🔧 build it");
    });

    it("truncates long description in session name", async () => {
      const longDesc = "a".repeat(60);
      const customDef: WorkflowDefinition = {
        ...testDefinition,
        sessionNameMaxLength: 50,
      };
      (reloadDefinitions as ReturnType<typeof vi.fn>).mockResolvedValue({
        "test-workflow": customDef,
      });

      await handler(`test-cmd ${longDesc}`, ctx);

      expect(mockPI.api.setSessionName).toHaveBeenCalledWith(`Workflow: ${"a".repeat(50)}…`);
    });

    it("calls persistState for the new state", async () => {
      const { persistState } = await import("../state");
      await handler("test-cmd my task", ctx);

      expect(persistState).toHaveBeenCalledTimes(1);
    });
  });

  describe("unknown commandName", () => {
    it("shows error notification", async () => {
      mockFindWorkflowByCommandName.mockReturnValue(null);

      await handler("nonexistent some desc", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Unknown workflow: "nonexistent"'),
        "error",
      );
      expect(setState).not.toHaveBeenCalled();
    });

    it("lists available workflows in the error message", async () => {
      mockFindWorkflowByCommandName.mockReturnValue(null);

      await handler("nonexistent some desc", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("test-cmd"), "error");
    });
  });

  describe("already active workflow", () => {
    it("shows confirm dialog when workflow is already active", async () => {
      state = {
        active: true,
        workflowKey: "test-workflow",
        currentPath: [{ workflowKey: "test-workflow", phaseIndex: 0 }],
        globalStepCount: 0,
        taskId: "wf-existing",
        taskDescription: "existing task",
        startedAt: Date.now(),
        completionNotified: false,
        cancelled: false,
      };
      ctx.ui.confirm.mockResolvedValue(false);

      await handler("test-cmd new task", ctx);

      expect(ctx.ui.confirm).toHaveBeenCalledWith(
        "Workflow already active",
        expect.stringContaining("Phase: Phase 1"),
      );
      // Should NOT have started a new workflow since user declined
      expect(setState).not.toHaveBeenCalled();
    });

    it("starts new workflow when user confirms", async () => {
      state = {
        active: true,
        workflowKey: "test-workflow",
        currentPath: [{ workflowKey: "test-workflow", phaseIndex: 0 }],
        globalStepCount: 0,
        taskId: "wf-existing",
        taskDescription: "existing task",
        startedAt: Date.now(),
        completionNotified: false,
        cancelled: false,
      };
      ctx.ui.confirm.mockResolvedValue(true);

      await handler("test-cmd new task", ctx);

      expect(setState).toHaveBeenCalledTimes(1);
      // state should now be the new workflow (via our setState impl)
      expect(state.taskDescription).toBe("new task");
    });
  });

  describe("subworkflow first phase handling", () => {
    it("rejects subworkflow-only workflows started directly", async () => {
      mockFindWorkflowByCommandName.mockReturnValue(["sub-workflow", subDefinition]);

      await handler("sub-cmd some desc", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("subworkflow that can only run as part of another workflow"),
        "error",
      );
      expect(setState).not.toHaveBeenCalled();
    });
  });

  describe("workflow with subworkflow as first phase (auto-enter)", () => {
    it("auto-enters subworkflow when first phase is a SubworkflowRef", async () => {
      const parentWithSubFirst: WorkflowDefinition = {
        name: "ParentSubFirst",
        commandName: "psf",
        initialMessage: "Start {workflowName}",
        phases: [
          { subworkflow: true, workflowKey: "sub-workflow", resolved: subDefinition },
          { id: "p2", name: "Phase 2", emoji: "2️⃣", instructions: "Do second" },
        ],
      };
      (reloadDefinitions as ReturnType<typeof vi.fn>).mockResolvedValue({
        "psf-wf": parentWithSubFirst,
        "sub-workflow": subDefinition,
      });
      mockFindWorkflowByCommandName.mockReturnValue(["psf-wf", parentWithSubFirst]);

      await handler("psf my task", ctx);

      expect(setState).toHaveBeenCalledTimes(1);
      // State should have 2 path segments (auto-entered subworkflow)
      expect(state).not.toBeNull();
      expect(state!.currentPath).toHaveLength(2);
      expect(state!.currentPath[0]).toEqual({ workflowKey: "psf-wf", phaseIndex: 0 });
      expect(state!.currentPath[1]).toEqual({ workflowKey: "sub-workflow", phaseIndex: 0 });
    });
  });

  describe("already active workflow with unresolvable state", () => {
    it("shows 'unknown' phase when resolveActive returns null", async () => {
      state = {
        active: true,
        workflowKey: "nonexistent",
        currentPath: [{ workflowKey: "nonexistent", phaseIndex: 0 }],
        globalStepCount: 0,
        taskId: "wf-old",
        taskDescription: "old task",
        startedAt: Date.now(),
        completionNotified: false,
        cancelled: false,
      };
      ctx.ui.confirm.mockResolvedValue(false);

      await handler("test-cmd new task", ctx);

      expect(ctx.ui.confirm).toHaveBeenCalledWith(
        "Workflow already active",
        expect.stringContaining("Phase: unknown"),
      );
    });
  });

  describe("missing description", () => {
    it("shows usage warning when description is empty", async () => {
      await handler("test-cmd", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Usage: /workflow test-cmd {description}",
        "warning",
      );
    });

    it("shows usage warning when description is whitespace only", async () => {
      await handler("test-cmd   ", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Usage: /workflow test-cmd {description}",
        "warning",
      );
    });
  });

  describe("unknown commandName with no workflows", () => {
    it("shows (none) when no workflows available", async () => {
      mockFindWorkflowByCommandName.mockReturnValue(null);
      (reloadDefinitions as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await handler("nonexistent some desc", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("(none)"),
        "error",
      );
    });
  });

  describe("workflow without show field", () => {
    it("is treated as user-visible (show defaults to user)", async () => {
      const defNoShow: WorkflowDefinition = {
        name: "NoShow",
        commandName: "noshow",
        initialMessage: "Start",
        phases: [{ id: "p1", name: "P1", emoji: "1️⃣", instructions: "Do" }],
      };
      (reloadDefinitions as ReturnType<typeof vi.fn>).mockResolvedValue({ "noshow-wf": defNoShow });
      mockFindWorkflowByCommandName.mockReturnValue(["noshow-wf", defNoShow]);

      await handler("noshow my task", ctx);

      expect(setState).toHaveBeenCalledTimes(1);
      expect(state).not.toBeNull();
      expect(state!.workflowKey).toBe("noshow-wf");
    });

    it("appears in tab completion when no show field", async () => {
      const defNoShow: WorkflowDefinition = {
        name: "NoShow",
        commandName: "noshow",
        initialMessage: "Start",
        phases: [{ id: "p1", name: "P1", emoji: "1️⃣", instructions: "Do" }],
      };
      mockLoadWorkflows.mockReturnValue({ "noshow-wf": defNoShow });
      const cmd = mockPI.commands.get("workflow")!;
      const completions = await cmd.getArgumentCompletions!("noshow");

      expect(completions).toEqual([{ value: "noshow", label: "noshow" }]);
    });

    it("appears in available workflows list when no show field", async () => {
      const defNoShow: WorkflowDefinition = {
        name: "NoShow",
        commandName: "noshow",
        initialMessage: "Start",
        phases: [{ id: "p1", name: "P1", emoji: "1️⃣", instructions: "Do" }],
      };
      mockLoadWorkflows.mockReturnValue({ "noshow-wf": defNoShow });

      await handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("noshow"),
        "info",
      );
    });
  });

  describe("tab completion", () => {
    it("returns matching workflow names for user-visible workflows", async () => {
      mockLoadWorkflows.mockReturnValue(definitions);
      const cmd = mockPI.commands.get("workflow")!;
      const completions = await cmd.getArgumentCompletions!("test");

      expect(completions).toEqual([{ value: "test-cmd", label: "test-cmd" }]);
    });

    it("excludes subworkflow-only workflows from completions", async () => {
      mockLoadWorkflows.mockReturnValue(definitions);
      const cmd = mockPI.commands.get("workflow")!;
      const completions = await cmd.getArgumentCompletions!("sub");

      // sub-cmd has show: "workflows", so it should not appear
      expect(completions).toBeNull();
    });

    it("returns null when no workflows match the prefix", async () => {
      mockLoadWorkflows.mockReturnValue(definitions);
      const cmd = mockPI.commands.get("workflow")!;
      const completions = await cmd.getArgumentCompletions!("zzz");

      expect(completions).toBeNull();
    });

    it("returns all user-visible workflows when prefix is empty", async () => {
      mockLoadWorkflows.mockReturnValue(definitions);
      const cmd = mockPI.commands.get("workflow")!;
      const completions = await cmd.getArgumentCompletions!("");

      expect(completions).toEqual([{ value: "test-cmd", label: "test-cmd" }]);
    });
  });
});

describe("registerCancelWorkflowCommand", () => {
  let mockPI: ReturnType<typeof createMockPI>;
  let state: WorkflowState | null;
  let setState: SetState;
  let handler: CapturedCommand["handler"];
  let ctx: ReturnType<typeof createMockCtx>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPI = createMockPI();
    state = null;
    setState = vi.fn((s: WorkflowState | null) => {
      state = s;
    });
    ctx = createMockCtx();

    registerCancelWorkflowCommand(mockPI.api, () => state, setState);
    handler = mockPI.commands.get("cancel-workflow")!.handler;
  });

  it("registers the /cancel-workflow command", () => {
    expect(mockPI.api.registerCommand).toHaveBeenCalledWith("cancel-workflow", expect.any(Object));
  });

  describe("when not active", () => {
    it("shows info notification when no active workflow", async () => {
      state = null;
      await handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("No active workflow to cancel.", "info");
      expect(setState).not.toHaveBeenCalled();
    });

    it("shows info notification when state exists but inactive", async () => {
      state = {
        active: false,
        workflowKey: "test-workflow",
        currentPath: [{ workflowKey: "test-workflow", phaseIndex: 0 }],
        globalStepCount: 1,
        taskId: "wf-done",
        taskDescription: "done task",
        startedAt: Date.now(),
        completionNotified: true,
        cancelled: false,
      };
      await handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("No active workflow to cancel.", "info");
    });
  });

  describe("when active", () => {
    let activeState: WorkflowState;

    beforeEach(() => {
      activeState = {
        active: true,
        workflowKey: "test-workflow",
        currentPath: [{ workflowKey: "test-workflow", phaseIndex: 0 }],
        globalStepCount: 0,
        taskId: "wf-abc123",
        taskDescription: "my active task",
        startedAt: Date.now(),
        completionNotified: false,
        cancelled: false,
      };
      state = activeState;
    });

    it("persists cancelled state", async () => {
      const { persistState } = await import("../state");
      await handler("", ctx);

      expect(persistState).toHaveBeenCalledTimes(1);
      const persistedState = (persistState as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as WorkflowState;
      expect(persistedState.active).toBe(false);
      expect(persistedState.cancelled).toBe(true);
    });

    it("clears the status bar", async () => {
      await handler("", ctx);

      expect(ctx.ui.setStatus).toHaveBeenCalledWith("workflow", undefined);
    });

    it("sends cancellation message", async () => {
      await handler("", ctx);

      expect(mockPI.api.sendMessage).toHaveBeenCalledWith(
        {
          customType: "workflow:complete",
          content: expect.stringContaining("Workflow Cancelled"),
          display: true,
        },
        { triggerTurn: false },
      );
    });

    it("includes task description and ID in cancellation message", async () => {
      await handler("", ctx);

      expect(mockPI.api.sendMessage).toHaveBeenCalledWith(
        {
          customType: "workflow:complete",
          content: expect.stringContaining("my active task"),
          display: true,
        },
        { triggerTurn: false },
      );
      expect(mockPI.api.sendMessage).toHaveBeenCalledWith(
        {
          customType: "workflow:complete",
          content: expect.stringContaining("wf-abc123"),
          display: true,
        },
        { triggerTurn: false },
      );
    });

    it("sets state to null", async () => {
      await handler("", ctx);

      expect(state).toBeNull();
    });

    it("shows cancellation notification", async () => {
      await handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("Workflow cancelled.", "info");
    });
  });
});
