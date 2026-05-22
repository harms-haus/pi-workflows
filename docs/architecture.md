# Architecture

Technical reference for extension developers working on or extending pi-workflows internals.

---

## System Overview

pi-workflows is a **pi coding agent extension** that transforms the agent into a phase-driven orchestrator. It hooks into 6 framework events to inject workflow context into the agent's conversation, enforce per-phase tool restrictions, and manage linear phase progression through arbitrarily nested subworkflows.

The extension has no HTTP server, no database, and no background processes. It is entirely event-driven: the pi agent runtime calls into registered callbacks, and the extension responds by mutating closure-captured state, blocking tool calls, injecting hidden messages, and sending user-visible notifications.

**Core responsibilities:**

1. **Context injection** — Before each agent turn, the `before_agent_start` hook inserts a hidden message containing the current phase instructions, tool restrictions, progress, and advance reminders.
2. **Tool gating** — The `tool_call` hook blocks or allows tool usage per the active phase's `blacklist`/`whitelist` configuration. `workflow_step` is always exempt.
3. **Phase advancement** — The `workflow_step` tool and `agent_end` hook drive phase transitions, subworkflow entry/exit, looping, and completion.
4. **State persistence** — Every state mutation is appended to the session branch via `pi.appendEntry`, enabling full reconstruction on session resume or branch switch.

---

## Module Map

| File                   | Responsibility                                                                                                                                    | Key Exports                                                                                                                                                                                                                                                                         | Internal Dependencies                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `index.ts`             | Entry point; wires all event subscriptions and registrations                                                                                      | `default` (extension function)                                                                                                                                                                                                                                                      | All other modules                                                  |
| `types.ts`             | Type definitions and discriminated-union guards                                                                                                   | `PhaseToolConfig`, `PathSegment`, `PhaseDefinition`, `SubworkflowReference`, `PhaseEntry`, `WorkflowDefinition`, `WorkflowState`, `ActiveWorkflow`, `HookStateMutation`, `GetState`, `SetState`, `GetDefinitions`, `ReloadDefinitions`, `isSubworkflowRef()`, `isPhaseDefinition()` | —                                                                  |
| `config/index.ts`      | Barrel module — re-exports the public API from all config submodules                                                                              | (re-exports only)                                                                                                                                                                                                                                                                   | `config/templates.ts`, `config/validation.ts`, `config/loading.ts` |
| `config/templates.ts`  | Template variable resolution and phase tool-accessor helpers                                                                                      | `resolveTemplate()`, `getBlockedTools()`, `getWhitelist()`                                                                                                                                                                                                                          | `types.ts`                                                         |
| `config/validation.ts` | Workflow definition validation and subworkflow cycle detection (iterative DFS)                                                                    | `validateWorkflowDefinition()`, `detectCycles()`, `VALID_COMMAND_NAME_RE`                                                                                                                                                                                                           | `types.ts`                                                         |
| `config/loading.ts`    | Orchestrator: top-level discovery, directory scanning, command-name lookup                                                                        | `findWorkflowByCommandName()`, `loadWorkflowFromDir()`, `loadWorkflowsFromDir()`, `loadWorkflows()`                                                                                                                                                                                 | `types.ts`, `config/validation.ts`, `config/loading-parse.ts`, `config/loading-phases.ts`, `config/loading-resolve.ts` |
| `config/loading-parse.ts` | YAML parsing, field extraction from `workflow.yaml` and phase frontmatter                                                                      | `parseWorkflowYaml()`, `extractPhaseMetadata()`                                                                                                                                                                                                                                     | `types.ts`                                                         |
| `config/loading-phases.ts` | Path safety checks and phase loading from markdown files                                                                                        | `checkPathSafety()`, `loadPhaseFromMarkdown()`                                                                                                                                                                                                                                      | `types.ts`, `config/loading-parse.ts`                              |
| `config/loading-resolve.ts` | Cycle removal, subworkflow reference resolution, duplicate command-name detection                                                               | `removeCycles()`, `resolveSubworkflowRefs()`, `checkDuplicateCommandNames()`                                                                                                                                                                                                        | `types.ts`, `config/validation.ts`                                 |
| `state.ts`             | State creation, copy-on-write phase advancement, subworkflow navigation, persistence, reconstruction                                             | `createInitialState()`, `cloneState()`, `advancePhase()`, `loopPhase()`, `resolveActive()`, `persistState()`, `reconstructState()`, `isActive()`, `autoEnterSubworkflowRefs()`, `resolveFirstPhase()`, `phaseEntryName()`                                                          | `types.ts`                                                         |
| `TimerManager.ts`      | Timer management singleton tracking `setInterval`/`setTimeout` with stale-callback prevention                                                      | `TimerManager` (class), `timerManager` (singleton)                                                                                                                                                                                                                                   | —                                                                  |
| `tool.ts`              | Registers the `workflow_step` tool (status, next, cancel, loop actions)                                                                           | `registerWorkflowTool()`                                                                                                                                                                                                                                                            | `types.ts`, `state.ts`, `config/`                                  |
| `command.ts`           | Registers `/workflow` and `/cancel-workflow` slash commands                                                                                       | `registerWorkflowCommand()`, `registerCancelWorkflowCommand()`                                                                                                                                                                                                                      | `types.ts`, `state.ts`, `config/`                                  |
| `hooks.ts`             | Lifecycle hook handlers — exports 4 functions used across 6 event registrations (`session_start`/`session_tree` are handled inline in `index.ts`) | `updateStatus()`, `handleToolCall()`, `handleBeforeAgentStart()`, `handleAgentEnd()`                                                                                                                                                                                                | `types.ts`, `state.ts`, `config/`, `prompts.ts`, `TimerManager.ts` |
| `prompts.ts`           | Context prompt construction and default message templates                                                                                         | `buildContextPrompt()`, `DEFAULT_NOT_DONE_REMINDER`, `DEFAULT_COMPLETION_MESSAGE`, `DEFAULT_CANCELLED_MESSAGE`                                                                                                                                                                      | `types.ts`, `config/`, `state.ts`                                  |
| `renderers.ts`         | TUI message renderers for workflow message types                                                                                                  | `registerRenderers()`                                                                                                                                                                                                                                                               | —                                                                  |

### Dependency Graph

```
index.ts
├── config/ ────────────── types.ts
│   ├── loading.ts ──────── types.ts, config/validation.ts, config/loading-parse.ts,
│   │                       config/loading-phases.ts, config/loading-resolve.ts
│   ├── loading-parse.ts ── types.ts
│   ├── loading-phases.ts ─ types.ts, config/loading-parse.ts
│   ├── loading-resolve.ts ─ types.ts, config/validation.ts
│   ├── validation.ts ───── types.ts
│   └── templates.ts ────── types.ts
├── state.ts ──────────── types.ts
├── hooks.ts ──────────── types.ts, config/, state.ts, prompts.ts, TimerManager.ts
│   └── prompts.ts ────── types.ts, config/, state.ts
├── tool.ts ───────────── types.ts, config/, state.ts
├── command.ts ────────── types.ts, config/, state.ts
├── TimerManager.ts
└── renderers.ts
```

---

## Data Flow Diagram

The diagram below traces the complete lifecycle from user invocation through each event hook to workflow completion.

```
User
  │
  ▼
┌──────────────────────────────────────────────────────────────┐
│  /workflow {name} {description}                              │
│  (command.ts → createInitialState → persistState →           │
│   setSessionName → sendUserMessage with initialMessage)      │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  session_start / session_tree                                │
│  (index.ts → loadWorkflows + reconstructState → updateStatus)│
│                                                              │
│  Loads definitions from ~/.pi/agent/workflows/ and           │
│  .pi/workflows/. Replays persisted state from session branch.│
└──────────────────────┬───────────────────────────────────────┘
                       │
          ┌────────────▼────────────┐
          │   Agent turn begins     │◄───────────────────────┐
          └────────────┬────────────┘                        │
                       ▼                                     │
┌──────────────────────────────────────┐                     │
│  before_agent_start                  │                     │
│  (hooks.ts → handleBeforeAgentStart) │                     │
│                                      │                     │
│  If workflow active:                 │                     │
│    resolveActive → buildContextPrompt│                     │
│    → inject hidden message           │                     │
│    (customType: "workflow:context")  │                     │
└──────────────┬───────────────────────┘                     │
               ▼                                             │
┌──────────────────────────────────────┐                     │
│  tool_call                           │                     │
│  (hooks.ts → handleToolCall)         │                     │
│                                      │                     │
│  If workflow active:                 │                     │
│    Check blacklist → block if listed │                     │
│    Check whitelist → block if absent │                     │
│    workflow_step always allowed      │                     │
└──────────────┬───────────────────────┘                     │
               ▼                                             │
┌──────────────────────────────────────┐                     │
│  workflow_step tool invocation       │                     │
│  (tool.ts → execute)                 │                     │
│                                      │                     │
│  action=status → report phase info   │                     │
│  action=next   → advancePhase()      │─────┐               │
│  action=loop   → loopPhase()         │     │               │
│  action=cancel → two-step cancel     │     │               │
└──────────────┬───────────────────────┘     │               │
               │                             │               │
               ▼                             │               │
┌──────────────────────────────────────┐     │               │
│  agent_end                           │     │               │
│  (hooks.ts → handleAgentEnd)         │     │               │
│                                      │     │               │
│  If DONE (not notified):             │     │               │
│    Send completion message           │     │               │
│    → unload state                    │     │               │
│                                      │     │               │
│  If still active (not aborted):      │     │               │
│    Send not-done reminder            │     │               │
│    → auto-continue after 3s delay    │─────┘               │
└──────────────┬───────────────────────┘                     │
               ▼                                             │
┌──────────────────────────────────────┐                     │
│  turn_end                            │                     │
│  (hooks.ts → updateStatus)           │                     │
│                                      │                     │
│  Update status bar with current      │                     │
│  phase name, emoji, and progress.    │                     │
└──────────────────────────────────────┘                     │
```

---

## Closure State Model

The extension's runtime state lives as **closure variables** inside the default export function in `index.ts`. Because pi extensions are single-file modules that export one initialization function, all event handlers, tools, and commands share state through these closures — no global variables or singletons are used.

```
export default function (pi: ExtensionAPI): void {
  ┌─────────────────────────────────────────────┐
  │  let state: WorkflowState | null = null;     │  ← mutable closure variable
  │  let definitions: Record<                    │
  │    string, WorkflowDefinition> = {};         │  ← mutable closure variable
  │                                              │
  │  const getState = () => state;               │  ─┐
  │  const setState = (s) => { state = s; };     │   │  accessor callbacks
  │  const getDefinitions = () => definitions;   │   │  passed to tool/command
  │  const reloadDefinitions = () => {            │   │  registrations
  │    definitions = loadWorkflows();              │   │
  │    return Promise.resolve(definitions);       │  ─┘
  │  };                                          │
  └─────────────────────────────────────────────┘
}
```

### Why accessor callbacks?

Tools and commands are registered at initialization time and receive the accessor functions as arguments. They cannot import or directly reference the closure variables. This pattern:

- **Decouples** registration from state ownership — `tool.ts` and `command.ts` never import from `index.ts`.
- **Enables mutation** — `setState` allows tools/commands to replace the state object (e.g., on cancel or completion).
- **Supports hot reload** — `reloadDefinitions` re-reads workflow files from disk and updates the shared `definitions` closure.

### Where state is mutated

| Site                                      | How                                                                                  | Effect                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `session_start` / `session_tree` handlers | Direct assignment to `state` and `definitions`                                       | Loads fresh definitions; reconstructs persisted state   |
| `agent_end` handler                       | Reads `HookStateMutation` result; assigns `state = null` or `state = mutation.state` | Handles completion unload or state update               |
| `workflow_step` tool (cancel, next→DONE)  | Calls `setState(newState)`                                                           | Immediate state swap from within tool execution         |
| `/workflow` command                       | Calls `setState(newState)`                                                           | Starts a new workflow, replacing any prior active state |
| `/cancel-workflow` command                | Calls `setState(null)`                                                               | Unloads workflow immediately                            |

> **Copy-on-write semantics:** `advancePhase()` and `loopPhase()` in `state.ts` are pure functions — they call `cloneState()` to produce a deep copy, mutate the copy, and return it as `newState` in their result object. The caller (typically `tool.ts` or `hooks.ts`) is responsible for passing the new state to `setState()`. The original state object is never mutated in place.

---

## Event Subscription Map

### Agent Lifecycle Events

| Event                | Handler                                  | Purpose                                                                                                                                                                              | Returns                                                     |
| -------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `session_start`      | Inline in `index.ts`                     | Load definitions from disk; reconstruct state from session branch; update status bar                                                                                                 | `void`                                                      |
| `session_tree`       | Inline in `index.ts`                     | Same as `session_start` — fires when the user switches session branches. Captures `ctx.cwd` synchronously before any async gap.                                                      | `void`                                                      |
| `tool_call`          | `handleToolCall()` in `hooks.ts`         | Block tool calls that violate the active phase's blacklist/whitelist. `workflow_step` is always exempt.                                                                              | `{ block: true; reason: string }` or `void`                 |
| `before_agent_start` | `handleBeforeAgentStart()` in `hooks.ts` | Inject a hidden `workflow:context` message containing the full context prompt for the current phase.                                                                                 | `{ message: {...} }` or `void`                              |
| `agent_end`          | `handleAgentEnd()` in `hooks.ts`         | Detect completion (send notification, unload state) or mid-workflow stop (send not-done reminder, auto-continue after 3s). Skips auto-continue if the agent was aborted by the user. | `HookStateMutation` (returned inline, not via event return) |
| `turn_end`           | `updateStatus()` in `hooks.ts`           | Refresh the status bar with the current phase name, emoji, and progress indicator.                                                                                                   | `void`                                                      |

### Registrations (non-event)

| Registration                      | Module         | Description                                                                                                                  |
| --------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `registerWorkflowTool()`          | `tool.ts`      | Registers the `workflow_step` tool with actions: `next`, `status`, `cancel`, `loop`. Includes TUI renderers for call/result. |
| `registerWorkflowCommand()`       | `command.ts`   | Registers the `/workflow` slash command. Supports argument completions for available workflow names.                         |
| `registerCancelWorkflowCommand()` | `command.ts`   | Registers the `/cancel-workflow` slash command for immediate cancellation.                                                   |
| `registerRenderers()`             | `renderers.ts` | Registers TUI renderers for three custom message types: `workflow:context`, `workflow:complete`, `workflow:countdown`.       |

### Event Handler Signatures

Event handlers receive the event object and a context object. Return values depend on the event:

```
session_start(event, ctx)        → void
session_tree(event, ctx)         → void
tool_call(event, ctx)            → { block: true; reason: string } | void
before_agent_start(event, ctx)   → { message: { customType, content, display } } | void
agent_end(event, ctx)            → (mutation applied inline by index.ts)
turn_end(event, ctx)             → void
```

> **Note:** The `agent_end` handler is unique — it returns a `HookStateMutation` that `index.ts` applies to the closure state. This is because the handler runs in `hooks.ts` which has no access to the closure; the mutation pattern bridges that gap.

---

## Stale Error Handling

When the user replaces or reloads a session while an async handler is still executing, the pi runtime marks the context as **stale**. Any subsequent API call on that context throws an error whose message contains the string `"stale"`.

### `withStaleGuard()` and `initSession()`

Event handlers that call `pi.*` methods or access `ctx` are wrapped in `withStaleGuard()`, a higher-order function defined in `index.ts` that catches stale-context errors and silently discards them:

```typescript
function withStaleGuard(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    if (isStaleError(e)) return;
    throw e;
  }
}
```

The `isStaleError` helper checks for the stale marker:

```typescript
function isStaleError(e: unknown): boolean {
  return e instanceof Error && e.message.includes("stale");
}
```

Both `session_start` and `session_tree` share a common `initSession()` function that handles definition loading, timer cleanup, state reconstruction, and status update:

```typescript
function initSession(ctx: { ... }) {
  timerManager.clearAll();
  definitions = loadWorkflows(ctx.cwd);
  state = reconstructState(ctx);
  updateStatus(ctx, state, definitions);
}
```

This ensures timers from a previous session are always cancelled before loading new state.

### Handlers with stale guards

| Handler         | Guard wrapper     | Why it needs the guard                                                                                                     |
| --------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `session_start` | `withStaleGuard`  | Calls `loadWorkflows(ctx.cwd)`, `reconstructState(ctx)`, and `updateStatus(ctx, ...)` — `ctx` may be stale.               |
| `session_tree`  | `withStaleGuard`  | Same as `session_start`. Also clears timers via `timerManager.clearAll()`.                                                |
| `agent_end`     | `withStaleGuard`  | Calls `pi.sendMessage()`, `persistState(pi, ...)`, and `ctx.ui.setStatus()` — all of which can throw on a replaced session. |
| `turn_end`      | `withStaleGuard`  | Calls `updateStatus(ctx, ...)` which uses `ctx.ui.setStatus()`.                                                           |

Handlers that are **not** guarded (`tool_call`, `before_agent_start`) operate on the closure-captured `state` and `definitions` without calling async `pi.*` or `ctx.*` methods, so they cannot encounter stale-context errors.

---

## Tech Stack

### Runtime Packages

Only `@earendil-works/pi-coding-agent` is a **direct dependency** listed in `package.json`. The remaining packages are **transitive dependencies** — they are imported directly by pi-workflows source code but resolved through the `@earendil-works/pi-coding-agent` dependency chain.

| Package                           | Type       | Purpose                                                                                                                                         | Used In                       |
| --------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `@earendil-works/pi-coding-agent` | Direct     | Extension API (`ExtensionAPI`, `ExtensionContext`, event types, `parseFrontmatter`), tool registration, command registration, message rendering | All modules except `types.ts` |
| `@earendil-works/pi-tui`          | Transitive | Terminal UI rendering — `Text` component for custom tool call/result and message renderers                                                      | `tool.ts`, `renderers.ts`     |
| `@earendil-works/pi-ai`           | Transitive | `StringEnum` for TypeBox schema generation of the `action` parameter in `workflow_step`                                                         | `tool.ts`                     |
| `typebox`                         | Transitive | Runtime type schema construction (`Type.Object`, `Type.String`, `Type.Optional`) for tool parameter validation                                  | `tool.ts`                     |
| `yaml`                            | Transitive | YAML parsing for `workflow.yaml` files during definition loading                                                                                | `config/loading.ts`           |

### Standard Library Usage

| Module      | Purpose                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| `node:fs`   | `readdirSync`, `readFileSync`, `existsSync`, `realpathSync` — synchronous file I/O for workflow discovery and phase loading |
| `node:path` | `join`, `resolve`, `sep` — path construction and path-safety checks                                                         |
| `node:os`   | `homedir` — resolving the global `~/.pi/agent/workflows/` directory                                                         |

### Key convention: synchronous file I/O

Workflow loading in `config/loading.ts` uses **synchronous** filesystem operations. This is intentional — the `loadWorkflows()` function itself is synchronous. The `reloadDefinitions` wrapper returns a `Promise` via `Promise.resolve()` for API consistency (the `ReloadDefinitions` type). The agent runtime calls `reloadDefinitions` during `session_start` / `session_tree`, so blocking the microtask queue briefly is acceptable and avoids the complexity of managing concurrent reads.

---

## Further Reading

- **[Hook Lifecycle](hook-lifecycle.md)** — Deep-dive into each event hook's execution order, return value semantics, and interaction with the agent loop.
- **[State Management](state-management.md)** — Detailed walkthrough of the state machine, path stack navigation, subworkflow enter/exit, and persistence/reconstruction.
- **[Configuration Reference](configuration-reference.md)** — Complete field-by-field reference for `workflow.yaml` and phase `.md` frontmatter.
- **[Subworkflows](subworkflows.md)** — Guide to nested workflow references, cycle detection, and the two-pass resolution algorithm.
- **[Template Variables](template-variables.md)** — Full catalog of `{variable}` placeholders available in every template field.
