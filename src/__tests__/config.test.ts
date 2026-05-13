import { describe, it, expect } from "vitest";
import {
  resolveTemplate,
  validateWorkflowDefinition,
  detectCycles,
  findWorkflowByCommandName,
  getBlockedTools,
  getWhitelist,
} from "../config";
import type { WorkflowDefinition, PhaseDefinition, SubworkflowReference } from "../types";


// ── Helpers ──

/** Build a minimal valid user-visible workflow definition. */
function makeUserDef(
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
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
  };
}

/** Build a minimal valid internal (show: "workflows") workflow definition. */
function makeInternalDef(
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
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
  };
}

// ── resolveTemplate ──

describe("resolveTemplate", () => {
  it("replaces {varName} placeholders", () => {
    expect(resolveTemplate("Hello {name}!", { name: "World" })).toBe(
      "Hello World!",
    );
  });

  it("leaves unknown vars as-is", () => {
    expect(resolveTemplate("Hello {unknown}!", { name: "World" })).toBe(
      "Hello {unknown}!",
    );
  });

  it("handles multiple vars", () => {
    expect(
      resolveTemplate("{a} and {b} and {c}", { a: "1", b: "2", c: "3" }),
    ).toBe("1 and 2 and 3");
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
      phases: [
        { subworkflow: true, workflowKey: "sub", resolved: null } as SubworkflowReference,
      ],
    });
    expect(validateWorkflowDefinition("test", def)).toBeNull();
  });

  it("SubworkflowRef entry with empty workflowKey → error", () => {
    const def = makeUserDef({
      phases: [
        { subworkflow: true, workflowKey: "", resolved: null } as SubworkflowReference,
      ],
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
        phases: [
          { subworkflow: true, workflowKey: "b", resolved: null } as SubworkflowReference,
        ],
      }),
      b: makeUserDef(),
    };
    expect(detectCycles(defs)).toEqual([]);
  });

  it("A → A (self-ref) → cycle found", () => {
    const defs: Record<string, WorkflowDefinition> = {
      a: makeUserDef({
        phases: [
          { subworkflow: true, workflowKey: "a", resolved: null } as SubworkflowReference,
        ],
      }),
    };
    const errors = detectCycles(defs);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("Cycle detected");
  });

  it("A → B → A → cycle found", () => {
    const defs: Record<string, WorkflowDefinition> = {
      a: makeUserDef({
        phases: [
          { subworkflow: true, workflowKey: "b", resolved: null } as SubworkflowReference,
        ],
      }),
      b: makeUserDef({
        phases: [
          { subworkflow: true, workflowKey: "a", resolved: null } as SubworkflowReference,
        ],
      }),
    };
    const errors = detectCycles(defs);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("Cycle detected");
  });

  it("A → B → C → A → cycle found", () => {
    const defs: Record<string, WorkflowDefinition> = {
      a: makeUserDef({
        phases: [
          { subworkflow: true, workflowKey: "b", resolved: null } as SubworkflowReference,
        ],
      }),
      b: makeUserDef({
        phases: [
          { subworkflow: true, workflowKey: "c", resolved: null } as SubworkflowReference,
        ],
      }),
      c: makeUserDef({
        phases: [
          { subworkflow: true, workflowKey: "a", resolved: null } as SubworkflowReference,
        ],
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
          { subworkflow: true, workflowKey: "b", resolved: null } as SubworkflowReference,
          { subworkflow: true, workflowKey: "c", resolved: null } as SubworkflowReference,
        ],
      }),
      b: makeUserDef({
        phases: [
          { subworkflow: true, workflowKey: "d", resolved: null } as SubworkflowReference,
        ],
      }),
      c: makeUserDef({
        phases: [
          { subworkflow: true, workflowKey: "d", resolved: null } as SubworkflowReference,
        ],
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
