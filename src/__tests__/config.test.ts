import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowDefinition, PhaseDefinition } from "../types";
import type { Dirent } from "node:fs";

// ── Module mocks for filesystem-loading tests ──
// vi.hoisted ensures these are available when hoisted vi.mock factories execute.
const {
  mockExistsSync,
  mockReadFileSync,
  mockReaddirSync,
  mockRealpathSync,
  mockHomedir,
  mockParseFrontmatterFn,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockReaddirSync: vi.fn(),
  mockRealpathSync: vi.fn(),
  mockHomedir: vi.fn(() => "/mock-home"),
  mockParseFrontmatterFn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  readdirSync: mockReaddirSync,
  realpathSync: mockRealpathSync,
}));

vi.mock("node:path", () => ({
  join: (...args: string[]) => args.join("/"),
  resolve: (...args: string[]) => "/" + args.join("/"),
  sep: "/",
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    parseFrontmatter: mockParseFrontmatterFn,
  };
});

// Now import the SUT (config functions) — they'll use the mocked modules
import {
  resolveTemplate,
  validateWorkflowDefinition,
  detectCycles,
  findWorkflowByCommandName,
  getBlockedTools,
  getWhitelist,
  loadWorkflowFromDir,
  loadWorkflowsFromDir,
  loadWorkflows,
} from "../config";

// ── Helpers ──

/** Build a minimal valid user-visible workflow definition. */
function makeUserDef(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: "Test Workflow",
    commandName: "test",
    initialMessage: "Let's go",
    phases: [
      {
        id: "p1",
        name: "Phase 1",
        emoji: "1️⃣",
        instructions: "Do phase 1",
      },
    ],
    ...overrides,
  } as WorkflowDefinition;
}

/** Build a minimal valid internal (show: "workflows") workflow definition. */
function makeInternalDef(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: "Internal",
    show: "workflows",
    phases: [
      {
        id: "ip1",
        name: "Internal Phase",
        emoji: "🔧",
        instructions: "Do work",
      },
    ],
    ...overrides,
  } as WorkflowDefinition;
}

/** Reset all fs mocks between filesystem-loading tests */
function resetFsMocks() {
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockReaddirSync.mockReset();
  mockRealpathSync.mockReset();
  mockParseFrontmatterFn.mockReset();
}

// ── resolveTemplate ──

describe("resolveTemplate", () => {
  it("replaces {varName} placeholders", () => {
    expect(resolveTemplate("Hello {name}!", { name: "World" })).toBe("Hello World!");
  });

  it("leaves unknown vars as-is", () => {
    expect(resolveTemplate("Hello {unknown}!", { name: "World" })).toBe("Hello {unknown}!");
  });

  it("handles multiple vars", () => {
    expect(resolveTemplate("{a} and {b} and {c}", { a: "1", b: "2", c: "3" })).toBe(
      "1 and 2 and 3",
    );
  });

  it("empty template returns empty string", () => {
    expect(resolveTemplate("", { a: "1" })).toBe("");
  });
});

// ── validateWorkflowDefinition ──

describe("validateWorkflowDefinition", () => {
  it("valid show:'user' workflow → null", () => {
    expect(validateWorkflowDefinition("test", makeUserDef())).toBeNull();
  });

  it("show:'user' missing commandName → error", () => {
    const def = makeUserDef({ commandName: "" });
    const result = validateWorkflowDefinition("test", def);
    expect(result).not.toBeNull();
    expect(result).toContain("commandName");
  });

  it("show:'user' missing initialMessage → error", () => {
    const def = makeUserDef({ initialMessage: "" });
    const result = validateWorkflowDefinition("test", def);
    expect(result).not.toBeNull();
    expect(result).toContain("initialMessage");
  });

  it("show:'workflows' missing commandName → null", () => {
    const def = makeInternalDef({ commandName: "" });
    expect(validateWorkflowDefinition("test", def)).toBeNull();
  });

  it("show:'workflows' missing initialMessage → null", () => {
    const def = makeInternalDef({ initialMessage: "" });
    expect(validateWorkflowDefinition("test", def)).toBeNull();
  });

  it("show:'workflows' with commandName → null", () => {
    const def = makeInternalDef({ commandName: "mycmd" });
    expect(validateWorkflowDefinition("test", def)).toBeNull();
  });

  it("loopable: false → null", () => {
    const def = makeUserDef({ loopable: false });
    expect(validateWorkflowDefinition("test", def)).toBeNull();
  });

  it("loopable: 'not-a-bool' → error", () => {
    const def = makeUserDef({ loopable: "not-a-bool" as unknown as boolean });
    const result = validateWorkflowDefinition("test", def);
    expect(result).not.toBeNull();
    expect(result).toContain("loopable");
  });

  it("SubworkflowRef entry with valid workflowKey → null", () => {
    const def = makeUserDef({
      phases: [{ subworkflow: true, workflowKey: "sub", resolved: null }],
    });
    expect(validateWorkflowDefinition("test", def)).toBeNull();
  });

  it("SubworkflowRef entry with empty workflowKey → error", () => {
    const def = makeUserDef({
      phases: [{ subworkflow: true, workflowKey: "", resolved: null }],
    });
    const result = validateWorkflowDefinition("test", def);
    expect(result).not.toBeNull();
    expect(result).toContain("workflowKey");
  });

  it("duplicate phase IDs → error", () => {
    const phase: PhaseDefinition = {
      id: "dup",
      name: "Phase",
      emoji: "⚡",
      instructions: "Do stuff",
    };
    const def = makeUserDef({ phases: [phase, { ...phase }] });
    const result = validateWorkflowDefinition("test", def);
    expect(result).not.toBeNull();
    expect(result).toContain("duplicate");
  });

  it("empty phases array → error", () => {
    const def = makeUserDef({ phases: [] });
    const result = validateWorkflowDefinition("test", def);
    expect(result).not.toBeNull();
    expect(result).toContain("phases");
  });

  it("no phases (undefined) → error", () => {
    const def = makeUserDef({ phases: undefined as unknown as PhaseDefinition[] });
    const result = validateWorkflowDefinition("test", def);
    expect(result).not.toBeNull();
    expect(result).toContain("phases");
  });

  it("invalid show value → error", () => {
    const def = makeUserDef({ show: "invalid" as unknown as "user" });
    const result = validateWorkflowDefinition("test", def);
    expect(result).not.toBeNull();
    expect(result).toContain("show");
  });
});

// ── detectCycles ──

describe("detectCycles", () => {
  it("no subworkflow refs → empty array", () => {
    const defs: Record<string, WorkflowDefinition> = {
      a: makeUserDef(),
      b: makeUserDef(),
    };
    expect(detectCycles(defs)).toEqual([]);
  });

  it("A → B (no cycle) → empty array", () => {
    const defs: Record<string, WorkflowDefinition> = {
      a: makeUserDef({
        phases: [{ subworkflow: true, workflowKey: "b", resolved: null }],
      }),
      b: makeUserDef(),
    };
    expect(detectCycles(defs)).toEqual([]);
  });

  it("A → A (self-ref) → cycle found", () => {
    const defs: Record<string, WorkflowDefinition> = {
      a: makeUserDef({
        phases: [{ subworkflow: true, workflowKey: "a", resolved: null }],
      }),
    };
    const errors = detectCycles(defs);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("Cycle detected");
  });

  it("A → B → A → cycle found", () => {
    const defs: Record<string, WorkflowDefinition> = {
      a: makeUserDef({
        phases: [{ subworkflow: true, workflowKey: "b", resolved: null }],
      }),
      b: makeUserDef({
        phases: [{ subworkflow: true, workflowKey: "a", resolved: null }],
      }),
    };
    const errors = detectCycles(defs);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("Cycle detected");
  });

  it("A → B → C → A → cycle found", () => {
    const defs: Record<string, WorkflowDefinition> = {
      a: makeUserDef({
        phases: [{ subworkflow: true, workflowKey: "b", resolved: null }],
      }),
      b: makeUserDef({
        phases: [{ subworkflow: true, workflowKey: "c", resolved: null }],
      }),
      c: makeUserDef({
        phases: [{ subworkflow: true, workflowKey: "a", resolved: null }],
      }),
    };
    const errors = detectCycles(defs);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("Cycle detected");
  });

  it("DAG with multiple paths → empty array", () => {
    // A → B, A → C, B → D, C → D (no cycles)
    const defs: Record<string, WorkflowDefinition> = {
      a: makeUserDef({
        phases: [
          { subworkflow: true, workflowKey: "b", resolved: null },
          { subworkflow: true, workflowKey: "c", resolved: null },
        ],
      }),
      b: makeUserDef({
        phases: [{ subworkflow: true, workflowKey: "d", resolved: null }],
      }),
      c: makeUserDef({
        phases: [{ subworkflow: true, workflowKey: "d", resolved: null }],
      }),
      d: makeUserDef(),
    };
    expect(detectCycles(defs)).toEqual([]);
  });
});

// ── findWorkflowByCommandName ──

describe("findWorkflowByCommandName", () => {
  it("finds workflow by command name", () => {
    const defs: Record<string, WorkflowDefinition> = {
      wf1: makeUserDef({ commandName: "build" }),
      wf2: makeUserDef({ commandName: "review" }),
    };
    const result = findWorkflowByCommandName(defs, "review");
    expect(result).not.toBeNull();
    expect(result?.[0]).toBe("wf2");
  });

  it("returns null for unknown name", () => {
    const defs: Record<string, WorkflowDefinition> = {
      wf1: makeUserDef({ commandName: "build" }),
    };
    expect(findWorkflowByCommandName(defs, "nonexistent")).toBeNull();
  });
});

// ── getBlockedTools / getWhitelist ──

describe("getBlockedTools", () => {
  it("phase with blacklist → returns blocked tools", () => {
    const phase: PhaseDefinition = {
      id: "p1",
      name: "P1",
      emoji: "⚡",
      instructions: "Do stuff",
      tools: { blacklist: ["edit_file", "write_file"] },
    };
    expect(getBlockedTools(phase)).toEqual(["edit_file", "write_file"]);
  });

  it("phase without tools → returns []", () => {
    const phase: PhaseDefinition = {
      id: "p1",
      name: "P1",
      emoji: "⚡",
      instructions: "Do stuff",
    };
    expect(getBlockedTools(phase)).toEqual([]);
  });

  it("phase with whitelist (no blacklist) → returns []", () => {
    const phase: PhaseDefinition = {
      id: "p1",
      name: "P1",
      emoji: "⚡",
      instructions: "Do stuff",
      tools: { whitelist: ["read_file"] },
    };
    expect(getBlockedTools(phase)).toEqual([]);
  });
});

describe("getWhitelist", () => {
  it("phase with whitelist → returns whitelisted tools", () => {
    const phase: PhaseDefinition = {
      id: "p1",
      name: "P1",
      emoji: "⚡",
      instructions: "Do stuff",
      tools: { whitelist: ["read_file", "search"] },
    };
    expect(getWhitelist(phase)).toEqual(["read_file", "search"]);
  });

  it("phase without tools → returns null", () => {
    const phase: PhaseDefinition = {
      id: "p1",
      name: "P1",
      emoji: "⚡",
      instructions: "Do stuff",
    };
    expect(getWhitelist(phase)).toBeNull();
  });

  it("phase with blacklist (no whitelist) → returns null", () => {
    const phase: PhaseDefinition = {
      id: "p1",
      name: "P1",
      emoji: "⚡",
      instructions: "Do stuff",
      tools: { blacklist: ["edit_file"] },
    };
    expect(getWhitelist(phase)).toBeNull();
  });
});

// ── Filesystem Loading: loadWorkflowFromDir, loadWorkflowsFromDir, loadWorkflows ──

describe("loadWorkflowFromDir", () => {
  beforeEach(() => {
    resetFsMocks();
  });

  it("returns null when workflow.yaml does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    const result = loadWorkflowFromDir("/some/dir", "/workflows");
    expect(result).toBeNull();
  });

  it("loads a valid workflow with phases from .md files", () => {
    const dirPath = "/workflows/my-wf";
    const yamlPath = "/workflows/my-wf/workflow.yaml";
    const phasePath = "/workflows/my-wf/phase1.md";

    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: string) => p);

    mockReadFileSync.mockImplementation((p: string) => {
      if (p === yamlPath) {
        return [
          "name: My Workflow",
          "commandName: my-workflow",
          "initialMessage: Start the workflow",
          "phases:",
          "  - phase1.md",
        ].join("\n");
      }
      if (p === phasePath) {
        return '---\nid: p1\nname: Phase 1\nemoji: "🔍"\n---\nDo the first thing.';
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    mockParseFrontmatterFn.mockReturnValue({
      frontmatter: { id: "p1", name: "Phase 1", emoji: "🔍" },
      body: "Do the first thing.",
    });

    const result = loadWorkflowFromDir(dirPath, "/workflows");

    expect(result).not.toBeNull();
    expect(result!.name).toBe("My Workflow");
    expect(result!.commandName).toBe("my-workflow");
    expect(result!.initialMessage).toBe("Start the workflow");
    expect(result!.phases).toHaveLength(1);
    expect(result!.phases[0]).toEqual({
      id: "p1",
      name: "Phase 1",
      emoji: "🔍",
      instructions: "Do the first thing.",
    });
  });

  it("parses tool config (blacklist/whitelist) from frontmatter", () => {
    const dirPath = "/workflows/tool-wf";
    const yamlPath = "/workflows/tool-wf/workflow.yaml";
    const phasePath = "/workflows/tool-wf/phase.md";

    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: string) => p);

    mockReadFileSync.mockImplementation((p: string) => {
      if (p === yamlPath) {
        return [
          "name: Tool Workflow",
          "commandName: tool-wf",
          "initialMessage: Start",
          "phases:",
          "  - phase.md",
        ].join("\n");
      }
      if (p === phasePath) {
        return "---\nid: p1\n---\nRestricted.";
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    mockParseFrontmatterFn.mockReturnValue({
      frontmatter: {
        id: "p1",
        name: "Restricted Phase",
        emoji: "🔒",
        tools: { blacklist: ["edit_file", "write_file"] },
      },
      body: "Restricted instructions.",
    });

    const result = loadWorkflowFromDir(dirPath, "/workflows");

    expect(result).not.toBeNull();
    const phase = result!.phases[0] as PhaseDefinition;
    expect(phase.tools).toEqual({ blacklist: ["edit_file", "write_file"] });
  });

  it("handles subworkflow reference entries", () => {
    const dirPath = "/workflows/sub-wf";
    const yamlPath = "/workflows/sub-wf/workflow.yaml";

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === yamlPath) {
        return [
          "name: Sub Workflow",
          "commandName: sub-wf",
          "initialMessage: Start",
          "phases:",
          "  - subworkflow: inner-wf",
        ].join("\n");
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    const result = loadWorkflowFromDir(dirPath, "/workflows");

    expect(result).not.toBeNull();
    expect(result!.phases).toHaveLength(1);
    expect(result!.phases[0]).toEqual({
      subworkflow: true,
      workflowKey: "inner-wf",
      resolved: null,
    });
  });

  it("returns null for invalid phase entry type", () => {
    const dirPath = "/workflows/bad-wf";
    const yamlPath = "/workflows/bad-wf/workflow.yaml";

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === yamlPath) {
        return [
          "name: Bad Workflow",
          "commandName: bad-wf",
          "initialMessage: Start",
          "phases:",
          "  - 123",
        ].join("\n");
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    const result = loadWorkflowFromDir(dirPath, "/workflows");
    expect(result).toBeNull();
  });

  it("returns null when name is missing", () => {
    const dirPath = "/workflows/no-name";
    const yamlPath = "/workflows/no-name/workflow.yaml";

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === yamlPath) {
        return ["commandName: test", "initialMessage: Start", "phases:", "  - phase1.md"].join(
          "\n",
        );
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    const result = loadWorkflowFromDir(dirPath, "/workflows");
    expect(result).toBeNull();
  });

  it("returns null when commandName is missing (user workflow)", () => {
    const dirPath = "/workflows/no-cmd";
    const yamlPath = "/workflows/no-cmd/workflow.yaml";

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === yamlPath) {
        return ["name: No Cmd", "initialMessage: Start", "phases:", "  - phase1.md"].join("\n");
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    const result = loadWorkflowFromDir(dirPath, "/workflows");
    expect(result).toBeNull();
  });

  it("returns null for path traversal outside workflows root", () => {
    const dirPath = "/workflows/escape-wf";
    const yamlPath = "/workflows/escape-wf/workflow.yaml";

    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: string) => p);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === yamlPath) {
        return [
          "name: Escape Workflow",
          "commandName: escape",
          "initialMessage: Start",
          "phases:",
          "  - ../../etc/passwd",
        ].join("\n");
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    const result = loadWorkflowFromDir(dirPath, "/workflows");
    expect(result).toBeNull();
  });

  it("loads internal (show: workflows) workflow without commandName", () => {
    const dirPath = "/workflows/internal-wf";
    const yamlPath = "/workflows/internal-wf/workflow.yaml";
    const phasePath = "/workflows/internal-wf/phase1.md";

    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: string) => p);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === yamlPath) {
        return ["name: Internal Workflow", "show: workflows", "phases:", "  - phase1.md"].join(
          "\n",
        );
      }
      if (p === phasePath) {
        return '---\nid: ip1\nname: Internal Phase\nemoji: "🔧"\n---\nDo internal work.';
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    mockParseFrontmatterFn.mockReturnValue({
      frontmatter: { id: "ip1", name: "Internal Phase", emoji: "🔧" },
      body: "Do internal work.",
    });

    const result = loadWorkflowFromDir(dirPath, "/workflows");

    expect(result).not.toBeNull();
    expect(result!.show).toBe("workflows");
    expect(result!.commandName).toBe("");
  });

  it("extracts optional fields like loopable, roleInstruction, etc.", () => {
    const dirPath = "/workflows/opts-wf";
    const yamlPath = "/workflows/opts-wf/workflow.yaml";
    const phasePath = "/workflows/opts-wf/phase1.md";

    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: string) => p);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === yamlPath) {
        return [
          "name: Options Workflow",
          "commandName: opts",
          "initialMessage: Start",
          "loopable: true",
          "roleInstruction: Custom role",
          "advanceReminder: Custom reminder",
          "blockReasonTemplate: Custom block {toolName}",
          "completionMessage: Custom completion",
          "notDoneReminder: Custom not done",
          "sessionNamePrefix: 'WF: '",
          "sessionNameMaxLength: 30",
          "phases:",
          "  - phase1.md",
        ].join("\n");
      }
      if (p === phasePath) {
        return '---\nid: p1\nname: Phase 1\nemoji: "🔍"\n---\nInstructions.';
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    mockParseFrontmatterFn.mockReturnValue({
      frontmatter: { id: "p1", name: "Phase 1", emoji: "🔍" },
      body: "Instructions.",
    });

    const result = loadWorkflowFromDir(dirPath, "/workflows");

    expect(result).not.toBeNull();
    expect(result!.loopable).toBe(true);
    expect(result!.roleInstruction).toBe("Custom role");
    expect(result!.advanceReminder).toBe("Custom reminder");
    expect(result!.blockReasonTemplate).toBe("Custom block {toolName}");
    expect(result!.completionMessage).toBe("Custom completion");
    expect(result!.notDoneReminder).toBe("Custom not done");
    expect(result!.sessionNamePrefix).toBe("WF: ");
    expect(result!.sessionNameMaxLength).toBe(30);
  });

  it("returns null when phase .md file has missing id", () => {
    const dirPath = "/workflows/bad-phase";
    const yamlPath = "/workflows/bad-phase/workflow.yaml";
    const phasePath = "/workflows/bad-phase/phase1.md";

    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: string) => p);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === yamlPath) {
        return [
          "name: Bad Phase WF",
          "commandName: bad-phase",
          "initialMessage: Start",
          "phases:",
          "  - phase1.md",
        ].join("\n");
      }
      if (p === phasePath) {
        return '---\nname: Phase 1\nemoji: "🔍"\n---\nNo ID.';
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    mockParseFrontmatterFn.mockReturnValue({
      frontmatter: { name: "Phase 1", emoji: "🔍" },
      body: "No ID.",
    });

    const result = loadWorkflowFromDir(dirPath, "/workflows");
    expect(result).toBeNull();
  });
});

// ── loadWorkflowsFromDir ──

describe("loadWorkflowsFromDir", () => {
  beforeEach(() => {
    resetFsMocks();
  });

  it("returns empty object for non-existent directory", () => {
    mockExistsSync.mockReturnValue(false);
    const result = loadWorkflowsFromDir("/nonexistent");
    expect(result).toEqual({});
  });

  it("returns all workflows found in subdirectories", () => {
    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: string) => p);

    mockReaddirSync.mockReturnValue([
      { name: "wf-a", isDirectory: () => true, isFile: () => false },
      { name: "wf-b", isDirectory: () => true, isFile: () => false },
      { name: "not-a-dir.txt", isDirectory: () => false, isFile: () => true },
    ] as Dirent[]);

    mockReadFileSync.mockImplementation((p: string) => {
      if (p === "/parent/wf-a/workflow.yaml") {
        return "name: WF A\ncommandName: wf-a\ninitialMessage: Start A\nphases:\n  - phase1.md";
      }
      if (p === "/parent/wf-a/phase1.md") {
        return '---\nid: p1\nname: P1\nemoji: "1"\n---\nDo A.';
      }
      if (p === "/parent/wf-b/workflow.yaml") {
        return "name: WF B\ncommandName: wf-b\ninitialMessage: Start B\nphases:\n  - phase1.md";
      }
      if (p === "/parent/wf-b/phase1.md") {
        return '---\nid: p1\nname: P1\nemoji: "2"\n---\nDo B.';
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    mockParseFrontmatterFn.mockImplementation((_content: string) => ({
      frontmatter: { id: "p1", name: "P1", emoji: "1" },
      body: "Do work.",
    }));

    const result = loadWorkflowsFromDir("/parent");

    expect(Object.keys(result)).toHaveLength(2);
    expect(result["wf-a"]).toBeDefined();
    expect(result["wf-b"]).toBeDefined();
    expect(result["wf-a"].name).toBe("WF A");
    expect(result["wf-b"].name).toBe("WF B");
  });
});

// ── loadWorkflows (main loading function) ──

describe("loadWorkflows", () => {
  beforeEach(() => {
    resetFsMocks();
  });

  it("loads from global pi dir", async () => {
    mockHomedir.mockReturnValue("/test-home");
    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: string) => p);

    mockReaddirSync.mockReturnValue([
      { name: "global-wf", isDirectory: () => true, isFile: () => false },
    ] as Dirent[]);

    mockReadFileSync.mockImplementation((p: string) => {
      if (p.toString().includes("global-wf/workflow.yaml")) {
        return "name: Global WF\ncommandName: global\ninitialMessage: Start\nphases:\n  - phase1.md";
      }
      if (p.toString().includes("global-wf/phase1.md")) {
        return '---\nid: p1\nname: P1\nemoji: "🔍"\n---\nDo work.';
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    mockParseFrontmatterFn.mockReturnValue({
      frontmatter: { id: "p1", name: "P1", emoji: "🔍" },
      body: "Do work.",
    });

    const result = await loadWorkflows();

    expect(result["global-wf"]).toBeDefined();
    expect(result["global-wf"].name).toBe("Global WF");
  });

  it("merges project-local definitions over global", async () => {
    mockHomedir.mockReturnValue("/test-home");
    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: string) => p);

    mockReaddirSync.mockImplementation(() => {
      return [{ name: "my-wf", isDirectory: () => true, isFile: () => false }] as Dirent[];
    });

    mockReadFileSync.mockImplementation((p: string) => {
      const path = p.toString();
      if (path.includes("test-home") && path.includes("my-wf/workflow.yaml")) {
        return "name: Global Version\ncommandName: my-wf\ninitialMessage: Start\nphases:\n  - phase1.md";
      }
      if (path.includes("test-project") && path.includes("my-wf/workflow.yaml")) {
        return "name: Project Version\ncommandName: my-wf\ninitialMessage: Start\nphases:\n  - phase1.md";
      }
      if (path.includes("phase1.md")) {
        return '---\nid: p1\nname: P1\nemoji: "🔍"\n---\nDo work.';
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    mockParseFrontmatterFn.mockReturnValue({
      frontmatter: { id: "p1", name: "P1", emoji: "🔍" },
      body: "Do work.",
    });

    const result = await loadWorkflows("/test-project");

    // Project version should override global
    expect(result["my-wf"]).toBeDefined();
    expect(result["my-wf"].name).toBe("Project Version");
  });

  it("deduplicates by commandName", async () => {
    mockHomedir.mockReturnValue("/test-home");
    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: string) => p);

    mockReaddirSync.mockReturnValue([
      { name: "wf-a", isDirectory: () => true, isFile: () => false },
      { name: "wf-b", isDirectory: () => true, isFile: () => false },
    ] as Dirent[]);

    mockReadFileSync.mockImplementation((p: string) => {
      const path = p.toString();
      if (path.includes("wf-a/workflow.yaml")) {
        return "name: WF A\ncommandName: same-cmd\ninitialMessage: Start A\nphases:\n  - phase1.md";
      }
      if (path.includes("wf-b/workflow.yaml")) {
        return "name: WF B\ncommandName: same-cmd\ninitialMessage: Start B\nphases:\n  - phase1.md";
      }
      if (path.includes("phase1.md")) {
        return '---\nid: p1\nname: P1\nemoji: "🔍"\n---\nDo work.';
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    mockParseFrontmatterFn.mockReturnValue({
      frontmatter: { id: "p1", name: "P1", emoji: "🔍" },
      body: "Do work.",
    });

    // Should not throw, just warn about duplicates
    const result = await loadWorkflows();

    // Both workflows should still be present (first one wins for commandName)
    expect(result["wf-a"]).toBeDefined();
    expect(result["wf-b"]).toBeDefined();
  });

  it("resolves subworkflow references", async () => {
    mockHomedir.mockReturnValue("/test-home");
    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: string) => p);

    mockReaddirSync.mockReturnValue([
      { name: "outer", isDirectory: () => true, isFile: () => false },
      { name: "inner", isDirectory: () => true, isFile: () => false },
    ] as Dirent[]);

    mockReadFileSync.mockImplementation((p: string) => {
      const path = p.toString();
      if (path.includes("outer/workflow.yaml")) {
        return "name: Outer\ncommandName: outer\ninitialMessage: Start\nphases:\n  - subworkflow: inner";
      }
      if (path.includes("inner/workflow.yaml")) {
        return "name: Inner\ncommandName: inner\ninitialMessage: Start\nphases:\n  - phase1.md";
      }
      if (path.includes("inner/phase1.md")) {
        return '---\nid: ip1\nname: Inner Phase\nemoji: "⚙️"\n---\nDo inner work.';
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    mockParseFrontmatterFn.mockReturnValue({
      frontmatter: { id: "ip1", name: "Inner Phase", emoji: "⚙️" },
      body: "Do inner work.",
    });

    const result = await loadWorkflows();

    // Both should exist
    expect(result["outer"]).toBeDefined();
    expect(result["inner"]).toBeDefined();

    // Outer's subworkflow ref should be resolved
    const outerPhase = result["outer"].phases[0];
    if ("subworkflow" in outerPhase) {
      expect(outerPhase.resolved).toBe(result["inner"]);
    }
  });

  it("removes workflows involved in cycles", async () => {
    mockHomedir.mockReturnValue("/test-home");
    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: string) => p);

    mockReaddirSync.mockReturnValue([
      { name: "wf-a", isDirectory: () => true, isFile: () => false },
      { name: "wf-b", isDirectory: () => true, isFile: () => false },
    ] as Dirent[]);

    mockReadFileSync.mockImplementation((p: string) => {
      const path = p.toString();
      if (path.includes("wf-a/workflow.yaml")) {
        return "name: WF A\ncommandName: wf-a\ninitialMessage: Start\nphases:\n  - subworkflow: wf-b";
      }
      if (path.includes("wf-b/workflow.yaml")) {
        return "name: WF B\ncommandName: wf-b\ninitialMessage: Start\nphases:\n  - subworkflow: wf-a";
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    const result = await loadWorkflows();

    // Both should be removed due to cycle
    expect(result["wf-a"]).toBeUndefined();
    expect(result["wf-b"]).toBeUndefined();
  });

  it("removes workflows referencing non-existent subworkflows", async () => {
    mockHomedir.mockReturnValue("/test-home");
    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: string) => p);

    mockReaddirSync.mockReturnValue([
      { name: "ref-wf", isDirectory: () => true, isFile: () => false },
    ] as Dirent[]);

    mockReadFileSync.mockImplementation((p: string) => {
      const path = p.toString();
      if (path.includes("ref-wf/workflow.yaml")) {
        return "name: Ref WF\ncommandName: ref-wf\ninitialMessage: Start\nphases:\n  - subworkflow: nonexistent";
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    const result = await loadWorkflows();

    // Should be removed because it references a non-existent subworkflow
    expect(result["ref-wf"]).toBeUndefined();
  });
});
