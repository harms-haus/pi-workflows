# Hook Lifecycle

The pi-workflows extension registers **4 hook functions** on pi framework lifecycle events. Each hook receives the current [`WorkflowState`](#hookstatemutation-and-workflowstate) and the loaded [`WorkflowDefinition`](configuration-reference.md) map, then either mutates state, injects messages, or returns control signals back to the framework.

For the overall extension architecture, see [architecture.md](architecture.md). For state semantics and the `resolveActive` / `isActive` helpers, see [state-management.md](state-management.md).

---

## Registration

All four hooks are wired in [`src/index.ts`](../src/index.ts) via `pi.on()`:

| Framework Event | Hook Function | Called When |
|---|---|---|
| `session_start` | `updateStatus` | Session loaded or created |
| `session_tree` | `updateStatus` | Session branch changed |
| `turn_end` | `updateStatus` | Agent turn completed |
| `tool_call` | `handleToolCall` | Agent requests a tool invocation |
| `before_agent_start` | `handleBeforeAgentStart` | Before the agent begins a new turn |
| `agent_end` | `handleAgentEnd` | Agent stops (completion, error, or interruption) |

`session_start` and `session_tree` also handle definition loading and state reconstruction before calling `updateStatus`.

---

## updateStatus

```ts
function updateStatus(
  ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } },
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
): void
```

**Called on:** `session_start`, `session_tree`, `turn_end`

### Logic

1. **Early-return conditions** → calls `ctx.ui.setStatus("workflow", undefined)` to clear the status bar and returns immediately if any of these conditions are met:
   - `!state` (null state)
   - `!state.active` (inactive state)
   - `state.currentPath.length === 0` (empty path)
   - `!(state.currentPath[0].workflowKey in definitions)` (missing root definition)

2. **Build status parts array** → starts with the top-level workflow name.

3. **Loop through `currentPath` segments** → for each segment, looks up its definition and phase entry:
   - For `SubworkflowReference` entries: adds `{name} [current/total]` (no emoji)
   - For `PhaseDefinition` entries: adds `{emoji} {name} [current/total]`

4. **Bounds check** → if any segment's `phaseIndex` is out of bounds (>= phases.length), clears status bar and returns.

5. **Format and set** → joins all parts with ` > ` and calls `ctx.ui.setStatus("workflow", statusString)`.

### Status Format

All status strings use ` > ` as the segment separator. Every level in the path — including subworkflow containers — shows its own `[N/M]` progress counter. Emojis appear only on concrete `PhaseDefinition` entries; subworkflow levels (`SubworkflowReference`) show name + progress without an emoji.

**Linear workflow** (`currentPath.length === 1`):

```
{workflowName} > {phaseEmoji} {phaseName} [{current}/{total}]
```

Example: `CI/CD Pipeline > 📋 Planning [1/3]`

**Nested workflow** (`currentPath.length === 2`) — shows the subworkflow container with its own progress, then the inner phase:

```
{workflowName} > {subworkflowName} [{subCurrent}/{subTotal}] > {phaseEmoji} {phaseName} [{current}/{total}]
```

Example: `Release Pipeline > Code Review [2/3] > 🔍 Static Analysis [1/2]`

**Deep nesting** (`currentPath.length > 2`) — each subworkflow level repeats the `{name} [N/M]` pattern, terminated by the leaf phase with its emoji:

```
{workflowName} > {sub1} [N/M] > {sub2} [N/M] > {phaseEmoji} {phaseName} [N/M]
```

Example: `RPIR Development > Implementation [3/5] > Testing [2/2] > 🧪 Unit Tests [1/4]`

Progress numbers are 1-indexed (`phaseIndex + 1`). Each level's total comes from the corresponding workflow definition's `phases.length`.

---

## handleToolCall

```ts
function handleToolCall(
  event: ToolCallEvent,
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
): { block: true; reason: string } | void
```

**Called on:** `tool_call`

Returns `{ block: true; reason: string }` to block the tool call, or `void` (undefined) to allow it.

### Decision Flow

```
state is null or inactive → allow (return void)
  │
  ▼
resolveActive fails → allow
  │
  ▼
toolName === "workflow_step" → always allow
  │
  ▼
phase.tools is undefined → allow (no restrictions for this phase)
  │
  ▼
phase.tools.blacklist is set AND toolName is in blockedTools → BLOCK
  │
  ▼
phase.tools.whitelist is set AND toolName is NOT in whitelist → BLOCK
  │
  ▼
otherwise → allow
```

Key behaviors:
- **`workflow_step` is always allowed** regardless of blacklist/whitelist. This ensures the agent can always advance phases.
- If a phase has no `tools` property, all tools are permitted.
- Exactly one of `blacklist` or `whitelist` may be set per phase (mutually exclusive).

### Block Reason Template

When a tool is blocked, the reason string is generated from the definition's `blockReasonTemplate` (or the built-in default). Available template variables:

| Variable | Description |
|---|---|
| `{workflowName}` | Human-readable workflow name |
| `{phaseName}` | Current phase name |
| `{toolName}` | The tool that was blocked |
| `{allowedTools}` | Human-readable list of permitted tools |

**Default template:**

```
[workflow] The tool "{toolName}" is blocked during the {phaseName} phase.
Refer to the current phase instructions for allowed tools and approaches.
When finished, call workflow_step to advance to the next phase.
```

When the block comes from a blacklist, `{allowedTools}` resolves to `"all except: "` + the joined blacklist. When from a whitelist, it resolves to the joined whitelist.

---

## handleBeforeAgentStart

```ts
function handleBeforeAgentStart(
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
): { message: { customType: string; content: string; display: boolean } } | void
```

**Called on:** `before_agent_start`

### Logic

1. If state is inactive or null, or `resolveActive` fails → return `void` (no injection).
2. Otherwise, calls [`buildContextPrompt(active)`](#buildcontextprompt-details) to generate the full context string.
3. Returns a hidden message with `customType: "workflow:context"` and `display: false`.

The returned message is injected into the conversation before the agent begins its turn. Because `display: false`, the user does not see it, but the agent reads it as context.

### buildContextPrompt Details

The prompt is assembled from these sections in order:

| Section | Source | Notes |
|---|---|---|
| **Header line** | `[Workflow path: {breadcrumb} ▸ {emoji} {name}]` | Breadcrumb from `active.breadcrumb` |
| **Role instruction** | `definition.roleInstruction` or default | Template-resolved with workflow/phase variables |
| **Task details** | `taskDescription`, `taskId` | From `state` |
| **Current phase** | Emoji + name | From `active.currentPhase` |
| **Progress** | `globalStepCount` and `phaseIndex`/total | Format varies for linear vs nested |
| **Phase instructions** | `currentPhase.instructions` | Template-resolved |
| **Profiles** | `availableProfiles` + all workflow profiles | Lists per-phase and global profiles |
| **Advance reminder** | `definition.advanceReminder` or default | Reminds agent to call `workflow_step` |

**Default role instruction:**

> You are the ORCHESTRATOR for this workflow. You must NOT use the edit or write tools directly. All implementation work must be delegated to subagents via the delegate_to_subagents tool. Follow the phase instructions precisely.

**Default advance reminder:**

> When you finish this phase, call the workflow_step tool with action='next' to advance to the next phase. If you need to restart the current scope from the beginning, use action='loop'.

Template variables available to `roleInstruction`, `instructions`, and `advanceReminder`:

`{workflowName}`, `{workflowKey}`, `{description}`, `{taskId}`, `{phaseId}`, `{phaseName}`, `{previousPhaseName}`, `{nextPhaseName}`, `{blockedToolsList}`, `{toolName}`, `{breadcrumbPath}`, `{globalStepCount}`

---

## handleAgentEnd

```ts
function handleAgentEnd(
  pi: ExtensionAPI,
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
  ctx: ExtensionContext,
  event: AgentEndEvent,
): HookStateMutation
```

**Called on:** `agent_end`

This hook has three distinct code paths. It returns a [`HookStateMutation`](#hookstatemutation-interface) to tell `index.ts` how to update module state.

### Case A — Workflow just completed (DONE)

**Condition:** `state` exists, `state.active === false`, `state.completionNotified === false`.

There are two sub-cases:

#### Normal completion (`state.cancelled === false`)

1. Looks up the definition via `state.workflowKey`.
2. Resolves the `completionMessage` template (or default) with variables: `{workflowName}`, `{taskDescription}`, `{taskId}`, `{phaseCount}`.
3. Sends a visible message via `pi.sendMessage` with `customType: "workflow:complete"`, `display: true`, `triggerTurn: false`.
4. Sets `state.completionNotified = true`.
5. Clears the status bar.
6. Returns `{ unload: true, persist: true }`.

**Default completion message:**

```
✅ **{workflowName} Complete**

**Task:** {taskDescription}
**Task ID:** {taskId}
**Phases completed:** {phaseCount}
```

#### Cancellation (`state.cancelled === true`)

Same flow as normal completion, but resolves `completionMessage` if set, otherwise falls back to `DEFAULT_CANCELLED_MESSAGE` (not `DEFAULT_COMPLETION_MESSAGE`). Returns `{ unload: true, persist: false }` (no persistence of cancelled state).

> **Note:** There is no separate `cancelledMessage` field on `WorkflowDefinition`. The cancellation path reuses `completionMessage` with `DEFAULT_CANCELLED_MESSAGE` as fallback. Additionally, the `/cancel-workflow` command (`src/command.ts`) sends a hardcoded message with no template resolution and unloads state immediately, so this hook branch only fires when cancelled state is reached through other paths (e.g., session resume).

**Default cancelled message:**

```
❌ **{workflowName} Cancelled**

**Task:** {taskDescription}
**Task ID:** {taskId}
```

### Case B — Workflow still active (agent stopped mid-workflow)

**Condition:** `state.active === true`.

1. Checks [`wasAborted(event.messages)`](#wasaborted-check) — if the user interrupted the agent, returns `{ unload: false, persist: false }` (no enforcement).
2. Resolves the active workflow. If resolution fails, returns no-op.
3. Resolves the `notDoneReminder` template (or default) with variables: `{workflowName}`, `{phaseName}`, `{phaseEmoji}`, `{phaseInstructions}`, `{taskDescription}`, `{taskId}`, `{workflowKey}`.
4. Sends an immediate countdown message via `pi.sendMessage` with `customType: "workflow:countdown"`, `display: true`, `triggerTurn: false`:
   ```
   Auto-continuing workflow in 3s... (type anything to interrupt)
   ```
5. After a **3-second `setTimeout`**, calls `pi.sendUserMessage(reminder)` to inject the full reminder as a user message. If the user started typing during the grace period, the call is caught and silently ignored.
6. Returns `{ unload: false, persist: false }`.

**Default not-done reminder:**

```
⚠️ The {workflowName} is still active. Current phase: {phaseEmoji} {phaseName}.

You must NOT stop yet. The workflow requires you to complete the current phase
and call workflow_step to advance.

Current phase instructions:
{phaseInstructions}

Continue working on the current phase and call workflow_step when done.
```

### Case C — Already notified or no state

**Condition:** State is null, or `completionNotified === true`, or any other unhandled case.

Returns `{ unload: false, persist: false }` — a no-op.

### wasAborted Check

The `wasAborted` helper walks `event.messages` in reverse to find the last assistant message. If that message has `stopReason === "aborted"`, the agent was interrupted by the user. This prevents the auto-continue countdown from firing when the user deliberately stopped the agent.

---

## HookStateMutation Interface

```ts
interface HookStateMutation {
  /** If true, set module state to null (unload workflow). */
  unload: boolean;
  /** If set, replace module state with this value (mutated copy). */
  state?: WorkflowState;
  /** If true, persist the current state via pi.appendEntry. */
  persist: boolean;
}
```

Returned by `handleAgentEnd` and consumed by `index.ts` in the `agent_end` handler:

```ts
const mutation = handleAgentEnd(pi, state, definitions, ctx, event);
if (mutation.unload) {
  state = null;                    // Unload: clear module state
} else if (mutation.state) {
  state = mutation.state;          // Replace: use the returned state
}
if (mutation.persist && state) {
  persistState(pi, state);         // Persist: write to session entry log
}
```

### Mutation Semantics by Case

| Case | `unload` | `state` | `persist` | Effect |
|---|---|---|---|---|
| No-op | `false` | — | `false` | No changes |
| Normal completion | `true` | — | `true` | State persisted, then unloaded |
| Cancellation | `true` | — | `false` | State discarded, unloaded |
| Still active / countdown | `false` | — | `false` | No state change; auto-continue fires |

---

## Message Custom Types

The hooks produce three distinct `customType` values, each with a registered renderer in [`src/renderers.ts`](../src/renderers.ts):

| Custom Type | Produced By | `display` | `triggerTurn` | Rendered Appearance |
|---|---|---|---|---|
| `workflow:context` | `handleBeforeAgentStart` | `false` | — | `🔄 [Workflow Context injected]` (dim) |
| `workflow:complete` | `handleAgentEnd` (Case A) | `true` | `false` | Bold success/completion message in green |
| `workflow:countdown` | `handleAgentEnd` (Case B) | `true` | `false` | `⏳ Auto-continuing workflow in 3s...` (dim) |

### Renderer Details

Each custom type has a dedicated renderer registered via `pi.registerMessageRenderer`:

- **`workflow:context`** — Renders a minimal dim accent line. Because `display: false`, this message is hidden from the user's main conversation view; the renderer produces a subtle indicator only.
- **`workflow:complete`** — Renders the full completion or cancellation message in bold green (`theme.fg("success", ...)`).
- **`workflow:countdown`** — Renders the countdown timer text in accent color with dim styling, showing the user they have a grace period to interrupt.

---

## Hook Interaction Flow

The following timeline shows how the hooks interact during a typical workflow run:

```
1. session_start / session_tree
   └─ loadWorkflows() → reconstructState() → updateStatus()

2. [Each agent turn]
   ├─ before_agent_start
   │  └─ handleBeforeAgentStart() → injects workflow:context message
   ├─ [agent runs, may call tools]
   │  └─ tool_call (per tool)
   │     └─ handleToolCall() → may block with reason
   └─ agent_end
      └─ handleAgentEnd() → HookStateMutation
         ├─ Case A: DONE → workflow:complete message, unload
         ├─ Case B: still active → workflow:countdown, 3s auto-continue
         └─ Case C: no-op

3. turn_end
   └─ updateStatus() → refreshes status bar with current phase
```

Each hook reads state immutably (except `handleAgentEnd`, which may set `completionNotified`). All state mutations flow back through `index.ts` via the `HookStateMutation` return value — hooks never call `setState` directly.
