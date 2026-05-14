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

| File | Responsibility | Key Exports | Internal Dependencies |
|---|---|---|---|
| `index.ts` | Entry point; wires all event subscriptions and registrations | `default` (extension function) | All other modules |
| `types.ts` | Type definitions and discriminated-union guards | `PhaseToolConfig`, `PathSegment`, `PhaseDefinition`, `SubworkflowReference`, `PhaseEntry`, `WorkflowDefinition`, `WorkflowSettings`, `WorkflowState`, `ActiveWorkflow`, `HookStateMutation`, `GetState`, `SetState`, `GetDefinitions`, `ReloadDefinitions`, `isSubworkflowRef()`, `isPhaseDefinition()` | — |
| `config.ts` | Workflow discovery, YAML/Markdown loading, validation, cycle detection, template resolution | `resolveTemplate()`, `validateWorkflowDefinition()`, `detectCycles()`, `findWorkflowByCommandName()`, `loadWorkflows()`, `getBlockedTools()`, `getWhitelist()` | `types.ts` |
| `state.ts` | State creation, phase advancement, subworkflow navigation, persistence, reconstruction | `createInitialState()`, `advancePhase()`, `loopPhase()`, `resolveActive()`, `persistState()`, `reconstructState()`, `isActive()` | `types.ts` |
| `tool.ts` | Registers the `workflow_step` tool (status, next, cancel, loop actions) | `registerWorkflowTool()` | `types.ts`, `state.ts`, `config.ts` |
| `command.ts` | Registers `/workflow` and `/cancel-workflow` slash commands | `registerWorkflowCommand()`, `registerCancelWorkflowCommand()` | `types.ts`, `state.ts`, `config.ts` |
| `hooks.ts` | Lifecycle hook handlers — exports 4 functions used across 6 event registrations (`session_start`/`session_tree` are handled inline in `index.ts`) | `updateStatus()`, `handleToolCall()`, `handleBeforeAgentStart()`, `handleAgentEnd()` | `types.ts`, `state.ts`, `config.ts`, `prompts.ts` |
| `prompts.ts` | Context prompt construction and default message templates | `buildContextPrompt()`, `DEFAULT_NOT_DONE_REMINDER`, `DEFAULT_COMPLETION_MESSAGE`, `DEFAULT_CANCELLED_MESSAGE` | `types.ts`, `config.ts` |
| `renderers.ts` | TUI message renderers for workflow message types | `registerRenderers()` | — |

### Dependency Graph

```
index.ts
├── config.ts ─────── types.ts
├── state.ts ──────── types.ts
├── hooks.ts ──────── types.ts, config.ts, state.ts, prompts.ts
│   └── prompts.ts ── types.ts, config.ts
├── tool.ts ───────── types.ts, config.ts, state.ts
├── command.ts ────── types.ts, config.ts, state.ts
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
  │  const reloadDefinitions = async () => {     │   │  registrations
  │    definitions = await loadWorkflows();       │   │
  │    return definitions;                       │  ─┘
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

| Site | How | Effect |
|---|---|---|
| `session_start` / `session_tree` handlers | Direct assignment to `state` and `definitions` | Loads fresh definitions; reconstructs persisted state |
| `agent_end` handler | Reads `HookStateMutation` result; assigns `state = null` or `state = mutation.state` | Handles completion unload or state update |
| `workflow_step` tool (cancel, next→DONE) | Calls `setState(newState)` | Immediate state swap from within tool execution |
| `/workflow` command | Calls `setState(newState)` | Starts a new workflow, replacing any prior active state |
| `/cancel-workflow` command | Calls `setState(null)` | Unloads workflow immediately |

---

## Event Subscription Map

### Agent Lifecycle Events

| Event | Handler | Purpose | Returns |
|---|---|---|---|
| `session_start` | Inline in `index.ts` | Load definitions from disk; reconstruct state from session branch; update status bar | `void` |
| `session_tree` | Inline in `index.ts` | Same as `session_start` — fires when the user switches session branches. Captures `ctx.cwd` synchronously before any async gap. | `void` |
| `tool_call` | `handleToolCall()` in `hooks.ts` | Block tool calls that violate the active phase's blacklist/whitelist. `workflow_step` is always exempt. | `{ block: true; reason: string }` or `void` |
| `before_agent_start` | `handleBeforeAgentStart()` in `hooks.ts` | Inject a hidden `workflow:context` message containing the full context prompt for the current phase. | `{ message: {...} }` or `void` |
| `agent_end` | `handleAgentEnd()` in `hooks.ts` | Detect completion (send notification, unload state) or mid-workflow stop (send not-done reminder, auto-continue after 3s). Skips auto-continue if the agent was aborted by the user. | `HookStateMutation` (returned inline, not via event return) |
| `turn_end` | `updateStatus()` in `hooks.ts` | Refresh the status bar with the current phase name, emoji, and progress indicator. | `void` |

### Registrations (non-event)

| Registration | Module | Description |
|---|---|---|
| `registerWorkflowTool()` | `tool.ts` | Registers the `workflow_step` tool with actions: `next`, `status`, `cancel`, `loop`. Includes TUI renderers for call/result. |
| `registerWorkflowCommand()` | `command.ts` | Registers the `/workflow` slash command. Supports argument completions for available workflow names. |
| `registerCancelWorkflowCommand()` | `command.ts` | Registers the `/cancel-workflow` slash command for immediate cancellation. |
| `registerRenderers()` | `renderers.ts` | Registers TUI renderers for three custom message types: `workflow:context`, `workflow:complete`, `workflow:countdown`. |

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

### Pattern

Every handler that calls `pi.*` methods or accesses `ctx` after an `await` wraps its body in a try/catch:

```typescript
try {
  // ... handler logic using ctx or pi ...
} catch (e) {
  if (isStaleError(e)) return;   // silently discard
  throw e;                        // re-throw real errors
}
```

The `isStaleError` helper is defined in `index.ts`:

```typescript
function isStaleError(e: unknown): boolean {
  return e instanceof Error && e.message.includes("stale");
}
```

### Handlers with stale guards

| Handler | Why it needs the guard |
|---|---|
| `session_start` | Calls `loadWorkflows(ctx.cwd)` and `updateStatus(ctx, ...)` — the `ctx` is invalid if the session was replaced during the async `loadWorkflows` call. |
| `session_tree` | Same as `session_start`. Additionally captures `ctx.cwd` synchronously before the async gap to prevent accessing a stale context. |
| `agent_end` | Calls `pi.sendMessage()`, `persistState(pi, ...)`, and `ctx.ui.setStatus()` — all of which can throw on a replaced session. |
| `turn_end` | Calls `updateStatus(ctx, ...)` which uses `ctx.ui.setStatus()`. |

Handlers that are **not** guarded (`tool_call`, `before_agent_start`) operate on the closure-captured `state` and `definitions` without calling async `pi.*` or `ctx.*` methods, so they cannot encounter stale-context errors.

---

## Tech Stack

### Runtime Packages

Only `@earendil-works/pi-coding-agent` is a **direct dependency** listed in `package.json`. The remaining packages are **transitive dependencies** — they are imported directly by pi-workflows source code but resolved through the `@earendil-works/pi-coding-agent` dependency chain.

| Package | Type | Purpose | Used In |
|---|---|---|---|
| `@earendil-works/pi-coding-agent` | Direct | Extension API (`ExtensionAPI`, `ExtensionContext`, event types, `parseFrontmatter`), tool registration, command registration, message rendering | All modules except `types.ts` |
| `@earendil-works/pi-tui` | Transitive | Terminal UI rendering — `Text` component for custom tool call/result and message renderers | `tool.ts`, `renderers.ts` |
| `@earendil-works/pi-ai` | Transitive | `StringEnum` for TypeBox schema generation of the `action` parameter in `workflow_step` | `tool.ts` |
| `typebox` | Transitive | Runtime type schema construction (`Type.Object`, `Type.String`, `Type.Optional`) for tool parameter validation | `tool.ts` |
| `yaml` | Transitive | YAML parsing for `workflow.yaml` files during definition loading | `config.ts` |

### Standard Library Usage

| Module | Purpose |
|---|---|
| `node:fs` | `readdirSync`, `readFileSync`, `existsSync`, `realpathSync` — synchronous file I/O for workflow discovery and phase loading |
| `node:path` | `join`, `resolve`, `sep` — path construction and path-safety checks |
| `node:os` | `homedir` — resolving the global `~/.pi/agent/workflows/` directory |

### Key convention: synchronous file I/O

Workflow loading in `config.ts` uses **synchronous** filesystem operations. This is intentional — the `loadWorkflows()` function itself is `async` (for API consistency), but all file reads are synchronous. The agent runtime calls `loadWorkflows` during `session_start` / `session_tree` and awaits the result, so blocking the microtask queue briefly is acceptable and avoids the complexity of managing concurrent reads.

---

## Further Reading

- **[Hook Lifecycle](hook-lifecycle.md)** — Deep-dive into each event hook's execution order, return value semantics, and interaction with the agent loop.
- **[State Management](state-management.md)** — Detailed walkthrough of the state machine, path stack navigation, subworkflow enter/exit, and persistence/reconstruction.
- **[Configuration Reference](configuration-reference.md)** — Complete field-by-field reference for `workflow.yaml` and phase `.md` frontmatter.
- **[Subworkflows](subworkflows.md)** — Guide to nested workflow references, cycle detection, and the two-pass resolution algorithm.
- **[Template Variables](template-variables.md)** — Full catalog of `{variable}` placeholders available in every template field.
