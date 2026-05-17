# Testing

Test suite for pi-workflows, covering workflow configuration loading and validation, state machine transitions, prompt generation, event hooks, tool registration, command handling, TUI renderers, and the extension entry point.

---

## Test Framework

|                 |                                                            |
| --------------- | ---------------------------------------------------------- |
| **Runner**      | [Vitest](https://vitest.dev/) v4.1.6                       |
| **Config**      | `vitest.config.ts` — includes `src/__tests__/**/*.test.ts` |
| **Test script** | `"test": "vitest run"` in `package.json`                   |

Tests use Vitest's built-in `describe`/`it`/`expect` API. No additional assertion libraries are required.

---

## Test Files

All tests live under `src/__tests__/`. There are 8 test files with **268 total test cases**.

| File                | Tests | What's Covered                                                                                                                                                                                                              |
| ------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.test.ts`    | 84    | `resolveTemplate`, `validateWorkflowDefinition`, `detectCycles`, `findWorkflowByCommandName`, `getBlockedTools`, `getWhitelist`, `loadWorkflowFromDir`, `loadWorkflowsFromDir`, `loadWorkflows`                             |
| `state.test.ts`     | 36    | `createInitialState`, `advancePhase` (linear, enter-subworkflow, breakout, multi-level, auto-enter, two-subworkflows), `loopPhase` (scope isolation, loopable inheritance), `resolveActive`, `reconstructState`, `isActive` |
| `prompts.test.ts`   | 10    | `buildContextPrompt` (linear, nested, template resolution, profiles), `collectAllProfiles`, `getPreviousPhaseName`, default message constants                                                                               |
| `hooks.test.ts`     | 43    | `updateStatus`, `handleToolCall`, `handleBeforeAgentStart`, `handleAgentEnd` (completion, cancellation, countdown widget, abort detection, no-UI fallback, edge cases), `clearActiveCountdown`                              |
| `tool.test.ts`      | 34    | `registerWorkflowTool` — `status`, `next`, `cancel`, `loop` actions; `renderCall`, `renderResult`; edge cases (stale definition, nested path, unknown action)                                                               |
| `command.test.ts`   | 28    | `registerWorkflowCommand` (start, validation, conflicts, tab completion, subworkflow rejection), `registerCancelWorkflowCommand` (cancel, persist, message)                                                                 |
| `renderers.test.ts` | 10    | `registerRenderers` — `workflow:context`, `workflow:complete`, `workflow:countdown` renderers                                                                                                                               |
| `index.test.ts`     | 23    | Extension entry point — event handler registration, `session_start`, `session_tree`, `tool_call`, `before_agent_start`, `agent_end`, `turn_end` handlers                                                                    |

### config.test.ts (84 tests)

**`resolveTemplate`** — 4 tests covering placeholder replacement, unknown variables left as-is, multiple variables, and empty template.

**`validateWorkflowDefinition`** — 24 tests covering:

- Valid `show: "user"` workflow passes
- Missing `commandName` / `initialMessage` on user-visible workflows → error
- `show: "workflows"` (internal) workflows skip those required-field checks
- `loopable` type validation (string vs boolean)
- `SubworkflowReference` entries: valid and empty `workflowKey`
- Duplicate phase IDs → error
- Empty or missing `phases` array → error
- Invalid `show` value → error
- Missing/empty `name` → error
- Invalid `commandName` format → error
- Non-array `blacklist` / `whitelist` → error
- Both blacklist and whitelist set → error
- Valid tools config with blacklist
- Missing `id`, `name`, `emoji`, or `instructions` on concrete phases → error

**`detectCycles`** — 9 tests covering:

- No subworkflow references → no cycles
- A → B (no cycle), A → A (self-reference), A → B → A, A → B → C → A
- DAG with multiple paths (A→B, A→C, B→D, C→D) → no cycles
- Empty definitions
- Disconnected components with one cyclic pair
- Subworkflow refs to non-existent workflows → no cycle

**`findWorkflowByCommandName`** — 2 tests: finds matching workflow, returns `null` for unknown name.

**`getBlockedTools` / `getWhitelist`** — 6 tests covering blacklist extraction, whitelist extraction, no-tools fallback, and cross-exclusivity.

**`loadWorkflowFromDir`** — 18 tests covering:

- Missing `workflow.yaml` → null
- Valid workflow with phases loaded from `.md` files
- Tool config (blacklist/whitelist) parsing from frontmatter
- Subworkflow reference entries
- Invalid phase entry types
- Missing `name` / `commandName` / `initialMessage` → null
- Path traversal outside workflows root → null
- Internal (`show: "workflows"`) workflows without `commandName`
- Optional fields (`loopable`, `roleInstruction`, `advanceReminder`, etc.)
- Missing phase frontmatter fields (`id`, `name`, `emoji`)
- Invalid YAML (not an object)
- Phase file read errors
- `realpathSync` edge cases

**`loadWorkflowsFromDir`** — 4 tests covering non-existent directory, loading from subdirectories, individual workflow errors, `readdirSync` errors, non-directory entries.

**`loadWorkflows`** — 8 tests covering loading from global pi dir, merging project-local over global, deduplication by `commandName`, subworkflow reference resolution, cycle removal, missing subworkflow reference removal, invalid workflow skipping, `PI_CODING_AGENT_DIR` env variable.

### state.test.ts (36 tests)

Uses shared fixture definitions imported from `helpers/fixtures.ts` (see [Test Helpers](#test-helpers)), exercising a 3-phase linear workflow and a parent workflow containing a nested subworkflow.

**`createInitialState`** — 2 tests: correct field initialization (`currentPath`, `active`, `taskId` prefix) and absence of legacy `currentPhaseIndex` field.

**`advancePhase` — linear** — 3 tests: advance through phases 0→1→2, final advance sets `active=false`.

**`advancePhase` — enter subworkflow** — 2 tests: path length increases from 1 to 2, new segment pushed with correct `workflowKey`.

**`advancePhase` — breakout** — 2 tests: last phase of subworkflow pops segment, path length decreases.

**`advancePhase` — multi-level** — 1 test: full journey — enter sub → advance within → breakout → advance parent to DONE.

**`advancePhase` — auto-enter concrete phase name** — 2 tests: advancing to subworkflow ref returns concrete first phase name.

**`advancePhase` — breakout + auto-enter (two subworkflows)** — 2 tests: advance through parent → sub → sub2 → phase3, verifying auto-enter at each transition.

**`loopPhase`** — 3 tests: resets `phaseIndex` to 0 and increments `globalStepCount`, rejects non-loopable workflows, resets only innermost scope in nested workflows.

**`loopPhase` — subworkflow scope** — 1 test: after auto-enter, loop resets subworkflow scope.

**`loopPhase` — loopable isolation** — 2 tests: parent `loopable=false` does not block subworkflow looping; subworkflow `loopable=false` blocks looping even if parent allows it.

**`resolveActive` — linear** — 2 tests: single-element path resolves correctly, returns correct `currentPhase` and `nextPhase`.

**`resolveActive` — nested** — 2 tests: multi-element path resolves to innermost phase, breadcrumb array has correct entries.

**`resolveActive` — edge cases** — 4 tests: missing definition, out-of-bounds index, null state, inactive state.

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

### hooks.test.ts (43 tests)

**`clearActiveCountdown`** — 3 tests: clears widget when interval is active, safe to call with no active countdown, safe when `ctx.hasUI` is false.

**`handleAgentEnd` — countdown widget** — 4 tests: skips auto-continue on abort, shows countdown widget before auto-continue (3s→2s→1s→send), handles `sendUserMessage` throwing during countdown, prevents stacked intervals.

**`handleAgentEnd` — null state** — 2 tests: no widget when state is null, returns noOp for active state.

**`handleAgentEnd` — no-UI fallback** — 1 test: uses `sendMessage` + `setTimeout` when `hasUI` is false.

**`updateStatus`** — 7 tests: clears when state is null, clears when inactive, shows phase name for linear workflow, shows breadcrumb format for nested subworkflow, clears when `resolveActive` returns null, shows progress at every level for deeply nested workflow, clears status when intermediate segment has out-of-bounds phaseIndex.

**`handleToolCall`** — 9 tests: allows all tools when null/inactive state, blocks blacklisted tools, blocks non-whitelisted tools, allows whitelisted tools, allows all when no tool config, always allows `workflow_step`, allows non-blacklisted tools.

**`handleBeforeAgentStart`** — 4 tests: returns undefined when null/inactive, returns context prompt when active, returns undefined when `resolveActive` returns null.

**`handleAgentEnd` — completion path** — 3 tests: sends default completion message, uses custom `completionMessage` template, uses `DEFAULT_COMPLETION_MESSAGE` when no custom template.

**`handleAgentEnd` — cancellation path** — 4 tests: sends cancelled message with details, uses custom template for cancelled workflow, uses `DEFAULT_CANCELLED_MESSAGE`, does not set `completionNotified` when cancelled.

**`handleAgentEnd` — edge cases** — 3 tests: returns noOp when already `completionNotified`, returns noOp when `resolveActive` returns null, detects abort from message history.

**`handleToolCall` — edge cases** — 2 tests: returns undefined when `resolveActive` returns null, uses custom `blockReasonTemplate`.

**`handleAgentEnd` — additional edge cases** — 3 tests: no-UI fallback `setTimeout` throwing, `setWidget` throwing inside interval gracefully, countdown outer catch.

### tool.test.ts (34 tests)

**Status action** — 3 tests: no active workflow, current phase info when active, stale definition.

**Next action** — 5 tests: advances phase and updates status, marks complete on last phase, entering subworkflow pushes new scope, exiting subworkflow pops scope, stale definition.

**Cancel action** — 3 tests: first call sets `_cancelPending`, second call marks cancelled, no active workflow.

**Loop action** — 3 tests: resets phase index, non-loopable returns error, no active workflow.

**Summary parameter** — 1 test: stored in state when provided with next action.

**`renderCall`** — 2 tests: returns Text component with tool name and action, renders different actions correctly.

**`renderResult`** — 10 tests: error results, `Error:` prefix, `Could not` prefix, `Unknown action` prefix, `not found` content, cancel confirmation, cancelled result, completion result, normal results (first line only), Container for non-text/empty content.

**Unknown action** — 1 test: returns unknown action message for invalid action.

**Loop stale definition** — 1 test: resolves correctly after loop.

### command.test.ts (28 tests)

**`registerWorkflowCommand`** — registers `/workflow` command.

- **No arguments** (2): shows usage info with available workflow names, handles `undefined` args.
- **Valid invocation** (5): creates state and sends initial message, sets session name, respects `sessionNamePrefix`, truncates long description, calls `persistState`.
- **Unknown commandName** (2): shows error notification, lists available workflows in error message.
- **Already active** (2): shows confirm dialog, starts new workflow when confirmed.
- **Subworkflow rejection** (1): rejects subworkflow-only workflows started directly.
- **Missing description** (2): shows usage warning for empty/whitespace-only description.
- **Tab completion** (4): returns matching names, excludes subworkflow-only workflows, returns null for no match, returns all user-visible when prefix is empty.

**`registerCancelWorkflowCommand`** — registers `/cancel-workflow` command.

- **When not active** (2): info notification for null state, info notification for inactive state.
- **When active** (5): persists cancelled state, clears status bar, sends cancellation message, includes task description/ID, sets state to null, shows cancellation notification.

### renderers.test.ts (10 tests)

**Registration** — 1 test: calls `registerMessageRenderer` 3 times with correct message types.

**`workflow:context` renderer** — 3 tests: returns Text instance, ignores message content (fixed context text), produces same output regardless of content.

**`workflow:complete` renderer** — 3 tests: returns Text instance, extracts string content with bold+success styling, handles non-string content gracefully.

**`workflow:countdown` renderer** — 3 tests: returns Text instance, extracts string content with dim styling, handles non-string content gracefully.

### index.test.ts (23 tests)

Tests the extension entry point by mocking all sub-modules (`config`, `state`, `hooks`, `tool`, `command`, `renderers`) and verifying the wiring.

**Module registration** — 4 tests: exports a default function, registers 6 event handlers, registers the workflow tool, registers commands and renderers.

**`session_start` handler** — 3 tests: loads workflows and updates status, catches stale errors, re-throws non-stale errors.

**`session_tree` handler** — 3 tests: loads workflows and updates status, catches stale errors, re-throws non-stale errors.

**`tool_call` handler** — 2 tests: delegates to `handleToolCall`, returns block result when blocking.

**`before_agent_start` handler** — 2 tests: delegates to `handleBeforeAgentStart`, returns undefined when void.

**`agent_end` handler** — 5 tests: persists when mutation says persist, unloads state when `unload=true`, updates state when `mutation.state` provided, catches stale errors, re-throws non-stale errors.

**`turn_end` handler** — 3 tests: delegates to `updateStatus`, catches stale errors, re-throws non-stale errors.

---

## Test Helpers

Test helpers are split between **local helpers** defined in individual test files and **shared helpers** in `src/__tests__/helpers/`.

### Shared Helpers (`helpers/mocks.ts`)

Provides mock implementations of the pi agent runtime interfaces:

**`createMockContext`** — creates a mock `ExtensionContext` with sensible defaults:

```typescript
import { createMockContext } from "./helpers/mocks";

// Default mock with hasUI: true
const ctx = createMockContext();

// Override specific fields
const ctx = createMockContext({ hasUI: false });
```

**`createMockAPI`** — creates a mock `ExtensionAPI` using a dual-handle pattern that returns both the `api` object and individual mock functions:

```typescript
import { createMockAPI } from "./helpers/mocks";

const { api, sendMessage, registerTool, registerCommand, on } = createMockAPI();

// Use api for registration
registerWorkflowTool(api, getState, getDefinitions, setState);

// Assert on captured calls
expect(registerTool).toHaveBeenCalledTimes(1);
```

Used by `hooks.test.ts`, `tool.test.ts`, `renderers.test.ts`, and `index.test.ts`.

### Shared Fixtures (`helpers/fixtures.ts`)

Provides factory functions and fixture data for constructing test `WorkflowDefinition`, `WorkflowState`, and `PhaseDefinition` objects. Exports are namespaced per test file to avoid collisions:

| Export                                                                                                                                    | Used By                          | Description                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| `STATE_PHASE_*`, `makeStateLinearDef`, `makeStateParentDef`, `makeStateSubDef`, `makeStateAllDefs`                                        | `state.test.ts`                  | 3-phase linear, 2-phase sub, parent with sub ref                    |
| `TOOL_PHASE_*`, `makeToolLinearDef`, `makeToolParentDef`, `makeToolSubDef`, `makeToolNoLoopDef`, `makeToolAllDefs`, `makeToolActiveState` | `tool.test.ts`                   | Linear, parent, sub, and no-loop definitions + active state builder |
| `PROMPTS_PHASE_*`, `makePromptsLinearDef`                                                                                                 | `prompts.test.ts`                | 2-phase linear workflow for prompt tests                            |
| `CMD_*`, `makeCommandDefs`                                                                                                                | `command.test.ts`                | User-visible and subworkflow-only command definitions               |
| `makeDefinition`, `makeActiveState`                                                                                                       | `hooks.test.ts`, `index.test.ts` | Minimal single-workflow definition and state                        |

### Local Helpers

Some test files define additional helpers locally:

**`makeUserDef` / `makeInternalDef`** (config.test.ts) — build minimal `show: "user"` or `show: "workflows"` workflow definitions with optional overrides. Used for `validateWorkflowDefinition` and `detectCycles` tests.

**`makeCtx`** (state.test.ts) — creates a mock extension context for `reconstructState` tests, simulating session branch entries.

**`makeActive`** (prompts.test.ts) — builds a complete `ActiveWorkflow` object from a workflow definition and optional state/path overrides.

**`setupTool`** (tool.test.ts) — registers the workflow tool with mock API and returns `{ execute, renderCall, renderResult, ctx, getState, setState }` for testing.

**`createMockPI`** (command.test.ts) — creates a mock API that captures registered command handlers in a `Map`.

---

## Test Setup

A global setup file (`src/__tests__/setup.ts`) mocks the TUI rendering library so tests run without the full TUI dependency:

```typescript
import { vi } from "vitest";

vi.mock("@earendil-works/pi-tui", () => ({
  Text: class Text {
    constructor(public content: string) {}
    render = vi.fn(() => this.content);
  },
  Container: class Container {
    render = vi.fn(() => "");
  },
}));
```

This is referenced via `setupFiles` in `vitest.config.ts`.

---

## Running Tests

```bash
# Run all tests once (CI mode)
npm test

# Run in watch mode (development)
npx vitest

# Run with coverage report
npx vitest run --coverage
```

Vitest discovers tests via the `include` pattern in `vitest.config.ts` and enforces **90% coverage thresholds** across all metrics:

```typescript
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/**/*.test.ts", "src/**/setup.ts", "src/**/helpers/**"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
```

### Current Coverage

| File                   | Statements | Branches | Functions | Lines  |
| ---------------------- | ---------- | -------- | --------- | ------ |
| **Overall**            | 96.03%     | 90.6%    | 96.26%    | 97.09% |
| `command.ts`           | 97.18%     | 85.71%   | 100%      | 98.5%  |
| `hooks.ts`             | 100%       | 98.5%    | 100%      | 100%   |
| `index.ts`             | 91.22%     | 100%     | 66.66%    | 94.11% |
| `prompts.ts`           | 96.49%     | 80.95%   | 100%      | 100%   |
| `state.ts`             | 88.13%     | 78.04%   | 100%      | 90.82% |
| `tool.ts`              | 97.24%     | 92.06%   | 100%      | 97.19% |
| `config/loading.ts`    | 96.42%     | 91.17%   | 100%      | 96.64% |
| `config/validation.ts` | 99.17%     | 97.11%   | 100%      | 100%   |

---

## Remaining Coverage Gaps

All major modules now have dedicated test coverage. The remaining uncovered lines are primarily defensive branches and edge cases:

- **`state.ts`** (88.13% statements) — uncovered branches include multi-level breakout with more than two nesting levels and some `advancePhase` internal paths.
- **`prompts.ts`** (80.95% branches) — uncovered branches include some template variable resolution paths and conditional prompt sections.
- **`command.ts`** (85.71% branches) — one uncovered line in the session name handling.
- **`index.ts`** (91.22% statements, 66.66% functions) — some event handler wrapper functions are only exercised through specific mock paths.

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

When testing modules that consume `WorkflowDefinition`, `WorkflowState`, or `ActiveWorkflow`, import from the shared helpers:

```typescript
import { makeDefinition, makeActiveState } from "./helpers/fixtures";
import { createMockAPI, createMockContext } from "./helpers/mocks";
```

See [Test Helpers](#test-helpers) for the full list of available factories.

### Test edge cases

Following the existing patterns, each function's test suite covers:

1. **Happy path** — correct inputs produce expected outputs
2. **Invalid inputs** — missing fields, empty arrays, wrong types
3. **Boundary conditions** — first phase, last phase, null state, out-of-bounds index
4. **State mutations** — verify the object is mutated correctly (tests assert on the same `state` reference after calling `advancePhase`, `loopPhase`, etc.)

### Mocking ExtensionAPI

Use `createMockAPI` and `createMockContext` from `helpers/mocks.ts` rather than building mocks by hand:

```typescript
import { createMockAPI, createMockContext } from "./helpers/mocks";

const { api, sendMessage, registerTool } = createMockAPI();
const ctx = createMockContext();
```

For testing tools, capture the registered tool definition and test the `execute` callback directly:

```typescript
registerWorkflowTool(api, getState, getDefinitions, setState);
const toolConfig = registerTool.mock.calls[0][0];
const execute = toolConfig.execute as ToolExecuteFn;

const result = await execute("call-1", { action: "status" }, undefined, undefined, ctx);
```

### Enable coverage

Coverage is already configured in `vitest.config.ts` with v8 provider, lcov and text reporters, and 90% thresholds on all metrics. Run:

```bash
npx vitest run --coverage
```

CI builds will fail if any metric drops below the threshold.

---

## Related Documentation

- [Architecture](architecture.md) — module map, dependency graph, and data flows
- [State Management](state-management.md) — detailed state machine design and transitions
- [Subworkflows](subworkflows.md) — nested workflow entry/exit mechanics
