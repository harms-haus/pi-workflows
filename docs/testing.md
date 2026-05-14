# Testing

Test suite for pi-workflows, covering workflow configuration validation, state machine transitions, and prompt generation.

---

## Test Framework

| | |
|---|---|
| **Runner** | [Vitest](https://vitest.dev/) v4.1.6 |
| **Config** | `vitest.config.ts` — includes `src/__tests__/**/*.test.ts` |
| **Test script** | `"test": "vitest run"` in `package.json` |

Tests use Vitest's built-in `describe`/`it`/`expect` API. No additional assertion libraries are required.

---

## Test Files

All tests live under `src/__tests__/`. There are 3 test files with **71 total test cases**.

| File | Tests | What's Covered |
|---|---|---|
| `config.test.ts` | 32 | `resolveTemplate`, `validateWorkflowDefinition`, `detectCycles`, `findWorkflowByCommandName`, `getBlockedTools`, `getWhitelist` |
| `state.test.ts` | 29 | `createInitialState`, `advancePhase` (linear, enter-subworkflow, breakout, multi-level), `loopPhase`, `resolveActive` (linear, nested, edge cases), `reconstructState` (migration, tampered state), `isActive` |
| `prompts.test.ts` | 10 | `buildContextPrompt` (linear, nested, template resolution, profiles), `collectAllProfiles` (via prompt output), `getPreviousPhaseName` (via prompt output), `DEFAULT_NOT_DONE_REMINDER`, `DEFAULT_COMPLETION_MESSAGE`, `DEFAULT_CANCELLED_MESSAGE` |

### config.test.ts (32 tests)

**`resolveTemplate`** — 4 tests covering placeholder replacement, unknown variables left as-is, multiple variables, and empty template.

**`validateWorkflowDefinition`** — 14 tests covering:
- Valid `show: "user"` workflow passes
- Missing `commandName` / `initialMessage` on user-visible workflows → error
- `show: "workflows"` (internal) workflows skip those required-field checks
- `loopable` type validation (string vs boolean)
- `SubworkflowReference` entries: valid and empty `workflowKey`
- Duplicate phase IDs → error
- Empty or missing `phases` array → error
- Invalid `show` value → error

**`detectCycles`** — 6 tests covering:
- No subworkflow references → no cycles
- A → B (no cycle), A → A (self-reference), A → B → A, A → B → C → A
- DAG with multiple paths (A→B, A→C, B→D, C→D) → no cycles

**`findWorkflowByCommandName`** — 2 tests: finds matching workflow, returns `null` for unknown name.

**`getBlockedTools` / `getWhitelist`** — 6 tests covering blacklist extraction, whitelist extraction, no-tools fallback, and cross-exclusivity (whitelist present → `getBlockedTools` returns `[]`, blacklist present → `getWhitelist` returns `null`).

### state.test.ts (29 tests)

Uses shared fixture definitions (`linearDef`, `parentDef`, `subDef`) exercising a 3-phase linear workflow and a parent workflow containing a nested subworkflow.

**`createInitialState`** — 2 tests: correct field initialization (`currentPath`, `active`, `taskId` prefix) and absence of legacy `currentPhaseIndex` field.

**`advancePhase`** — 12 tests across four groups:
- **Linear** (3): advance through phases 0→1→2, final advance sets `active=false`
- **Enter subworkflow** (2): path length increases from 1 to 2, new segment pushed with correct `workflowKey`
- **Breakout** (2): last phase of subworkflow pops segment, path length decreases
- **Multi-level** (1): full journey — enter sub → advance within → breakout → advance parent to DONE

**`loopPhase`** — 3 tests: resets `phaseIndex` to 0 and increments `globalStepCount`, rejects non-loopable workflows, resets only innermost scope in nested workflows.

**`resolveActive`** — 6 tests: resolves `currentPhase`/`nextPhase` for linear, resolves innermost phase for nested, breadcrumb construction, and edge cases (missing definition, out-of-bounds index, null state, inactive state).

**`reconstructState`** — 5 tests: migration from legacy `currentPhaseIndex` to `currentPath`, passthrough for new-format states, null for missing entries, null for empty `currentPath` (tampered), null for malformed path segment (tampered).

**`isActive`** — 3 tests: active state, inactive state, null.

### prompts.test.ts (10 tests)

**`buildContextPrompt`** — 4 tests:
- Linear workflow includes phase name, instructions, and progress (e.g. `1/2 phases`)
- Nested workflow includes `[Workflow path:` breadcrumb line
- All template variables resolved (no leftover `{varName}`)
- `availableProfiles` shown in prompt when phase defines them

**`collectAllProfiles`** (tested via prompt output) — 1 test: profiles from subworkflow phases are included in the "All profiles" section when parent is active.

**`getPreviousPhaseName`** (tested via prompt output) — 2 tests: first phase resolves to `(start)`, later phase resolves to the previous phase's name.

**Default message constants** — 3 tests: each constant (`DEFAULT_NOT_DONE_REMINDER`, `DEFAULT_COMPLETION_MESSAGE`, `DEFAULT_CANCELLED_MESSAGE`) contains expected template variables.

---

## Test Helpers

Each test file defines local helper functions to construct minimal valid test data without coupling tests to full production definitions.

### `makeUserDef` (config.test.ts)

Builds a minimal `show: "user"` workflow definition. Used for most `validateWorkflowDefinition` and `findWorkflowByCommandName` tests.

```typescript
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
```

**Usage** — override specific fields while keeping a valid baseline:

```typescript
// Missing required field
const def = makeUserDef({ commandName: "" });

// Multiple phases with duplicate IDs
const phase: PhaseDefinition = { id: "dup", name: "P", emoji: "⚡", instructions: "X" };
const def = makeUserDef({ phases: [phase, { ...phase }] });
```

### `makeInternalDef` (config.test.ts)

Builds a minimal `show: "workflows"` (internal) workflow definition. Omits `commandName` and `initialMessage` by default since those are not required for internal workflows.

```typescript
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
```

### `makeCtx` (state.test.ts)

Creates a mock extension context for `reconstructState` tests, simulating the session branch entries.

```typescript
function makeCtx(entries: Record<string, unknown>[]) {
  return { sessionManager: { getBranch: () => entries } };
}
```

### `makeActive` (prompts.test.ts)

Builds a complete `ActiveWorkflow` object from a workflow definition and optional state/path overrides. Manually resolves `currentPhase`, `nextPhase`, and `breadcrumb` from the given definition and path.

```typescript
function makeActive(
  def: WorkflowDefinition,
  stateOverrides: Partial<WorkflowState> = {},
  pathOverrides?: PathSegment[],
): ActiveWorkflow { /* ... */ }
```

**Usage:**

```typescript
// Default: active at phase index 0
const active = makeActive(linearDef);

// Active at phase index 1
const active = makeActive(defWithPrev, {}, [
  { workflowKey: "test", phaseIndex: 1 },
]);
```

---

## Test Fixtures

`state.test.ts` defines shared phase and workflow definitions used across multiple test groups:

| Fixture | Description |
|---|---|
| `phase1`, `phase2`, `phase3` | Three simple `PhaseDefinition` objects (`p1`–`p3`) |
| `subPhase1`, `subPhase2` | Two phases for the subworkflow (`sp1`, `sp2`) |
| `linearDef` | 3-phase linear workflow (`"Linear"`, command `"lin"`) |
| `subDef` | 2-phase internal subworkflow (`"Sub"`, `show: "workflows"`) |
| `parentDef` | 3-entry parent workflow: `phase1` → subworkflow ref → `phase3` |
| `allDefs` | `Record<string, WorkflowDefinition>` containing `linear`, `parent`, `sub` |

These fixtures exercise the key state machine scenarios:

- **Linear traversal**: `linearDef` — advance through all phases to completion
- **Subworkflow entry**: `parentDef` — advance from parent into `subDef` (path grows)
- **Subworkflow breakout**: advance past the last phase of `subDef` back to parent (path shrinks)
- **Multi-level**: combine entry, traversal, breakout, and final completion in one sequence

---

## Running Tests

```bash
# Run all tests once (CI mode)
npm test

# Run in watch mode (development)
npx vitest
```

Vitest discovers tests via the `include` pattern in `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

There is **no coverage configuration** yet. Adding `--coverage` to the vitest config would enable coverage reporting (see [Adding Tests](#adding-tests)).

---

## Coverage Gaps

The following modules have **no dedicated tests**:

### `hooks.ts`

Contains `updateStatus`, `handleToolCall`, `handleBeforeAgentStart`, and `handleAgentEnd`. These functions depend on `ExtensionAPI` and event objects.

**Suggested tests:**

```typescript
// Mock ExtensionAPI
const mockPi = { sendMessage: vi.fn() };
const mockCtx = { ui: { setStatus: vi.fn() } };

describe("handleToolCall", () => {
  it("blocks blacklisted tool");
  it("blocks non-whitelisted tool when whitelist is set");
  it("allows workflow_step unconditionally");
  it("allows any tool when phase has no tool config");
});

describe("handleBeforeAgentStart", () => {
  it("returns context message when workflow is active");
  it("returns void when no workflow is active");
});

describe("handleAgentEnd", () => {
  it("sends completion message when workflow is done");
  it("sends cancellation message when workflow is cancelled");
  it("auto-continues when workflow is still active");
  it("skips auto-continue when agent was aborted");
});

describe("updateStatus", () => {
  it("sets status bar for linear workflow");
  it("sets status bar for nested workflow with breadcrumb");
  it("clears status when no active workflow");
});
```

### `tool.ts`

Contains `registerWorkflowTool` which registers the `workflow_step` tool with actions: `status`, `next`, `cancel`, `loop`. Requires mocking `ExtensionAPI.registerTool` and capturing the `execute` callback.

**Suggested tests:**

```typescript
describe("workflow_step execute", () => {
  it("status: returns current phase info");
  it("status: reports no active workflow");
  it("next: advances phase and returns new instructions");
  it("next: reports DONE on final phase");
  it("cancel: first call requests confirmation");
  it("cancel: second call confirms cancellation");
  it("loop: resets to phase 0 and returns instructions");
  it("loop: returns error for non-loopable workflow");
});
```

### `command.ts`

Contains `registerWorkflowCommand` and `registerCancelWorkflowCommand`. Requires mocking `ExtensionAPI.registerCommand` and capturing the `handler` callback.

**Suggested tests:**

```typescript
describe("/workflow command", () => {
  it("starts workflow by commandName");
  it("returns error for unknown command name");
  it("returns error when args are missing");
  it("returns error when workflow is already active");
});

describe("/cancel-workflow command", () => {
  it("cancels active workflow");
  it("returns error when no workflow is active");
});
```

### `renderers.ts`

Contains `registerRenderers` which registers three TUI message renderers (`workflow:context`, `workflow:complete`, `workflow:countdown`). Requires mocking `ExtensionAPI.registerMessageRenderer` and `theme` objects.

**Suggested tests:**

```typescript
describe("registerRenderers", () => {
  it("renders workflow:context as dim status line");
  it("renders workflow:complete with bold success styling");
  it("renders workflow:countdown with countdown text");
});
```

### `index.ts`

The entry point wiring all registrations. Typically tested via integration tests rather than unit tests, since it's pure orchestration.

---

## Adding Tests

### File placement

Create new test files in `src/__tests__/` matching the pattern `*.test.ts`. The vitest config (`vitest.config.ts`) only includes files matching `src/__tests__/**/*.test.ts`.

### Structure

Follow the `describe`/`it` pattern consistent with existing tests:

```typescript
import { describe, it, expect } from "vitest";
import { myFunction } from "../myModule";

describe("myFunction", () => {
  it("handles happy path", () => {
    expect(myFunction("input")).toBe("expected");
  });

  it("handles edge case", () => {
    expect(myFunction("")).toBeNull();
  });
});
```

### Use existing helpers and fixtures

When testing modules that consume `WorkflowDefinition`, `WorkflowState`, or `ActiveWorkflow`, copy or import the helper patterns from existing test files:

- **`makeUserDef` / `makeInternalDef`** — for constructing `WorkflowDefinition` objects (see [Test Helpers](#test-helpers))
- **`makeCtx`** — for mocking the extension context needed by `reconstructState`
- **`makeActive`** — for building `ActiveWorkflow` objects in prompt tests

### Test edge cases

Following the existing patterns, each function's test suite covers:

1. **Happy path** — correct inputs produce expected outputs
2. **Invalid inputs** — missing fields, empty arrays, wrong types
3. **Boundary conditions** — first phase, last phase, null state, out-of-bounds index
4. **State mutations** — verify the object is mutated correctly (tests assert on the same `state` reference after calling `advancePhase`, `loopPhase`, etc.)

### Mocking ExtensionAPI

For testing `hooks.ts`, `tool.ts`, `command.ts`, and `renderers.ts`, mock the pi agent runtime:

```typescript
import { vi } from "vitest";

const mockSetStatus = vi.fn();
const mockSendMessage = vi.fn();
const mockRegisterTool = vi.fn();
const mockRegisterCommand = vi.fn();
const mockRegisterMessageRenderer = vi.fn();

const mockPi = {
  sendMessage: mockSendMessage,
  registerTool: mockRegisterTool,
  registerCommand: mockRegisterCommand,
  registerMessageRenderer: mockRegisterMessageRenderer,
} as unknown as ExtensionAPI;

const mockCtx = {
  ui: { setStatus: mockSetStatus },
} as unknown as ExtensionContext;
```

For `registerWorkflowTool`, capture the tool definition and test the `execute` callback directly:

```typescript
registerWorkflowTool(mockPi, getState, getDefinitions, setState);
const toolDef = mockRegisterTool.mock.calls[0][0];

// Now test toolDef.execute with different params
const result = await toolDef.execute("call-1", { action: "status" }, abortSignal, vi.fn(), mockCtx);
```

### Enable coverage (optional)

Add to `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types.ts'],
    },
  },
});
```

Then run `npx vitest run --coverage`.

---

## Related Documentation

- [Architecture](architecture.md) — module map, dependency graph, and data flows
- [State Management](state-management.md) — detailed state machine design and transitions
- [Subworkflows](subworkflows.md) — nested workflow entry/exit mechanics
