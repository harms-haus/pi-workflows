# Template Variables Reference

## Overview

Pi-workflows uses a `{varName}` template syntax throughout its configurable strings — phase instructions, role instructions, block reasons, completion messages, and more. Templates are resolved by `resolveTemplate()` in `src/config/templates.ts`.

**Resolution rules:**

| Rule                 | Behavior                                                            |
| -------------------- | ------------------------------------------------------------------- |
| Matching `{varName}` | Replaced with the corresponding value from the variables map        |
| Unknown `{varName}`  | **Left as-is** — the literal text `{varName}` remains in the output |
| No curly braces      | Plain text passes through unchanged                                 |

```typescript
// Simplified from src/config/templates.ts
function resolveTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    return vars[key] !== undefined ? vars[key] : `{${key}}`;
  });
}
```

> **Where to use templates:** Any configurable string in a workflow definition can contain template variables — `initialMessage`, `roleInstruction`, `advanceReminder`, `blockReasonTemplate`, `completionMessage`, `notDoneReminder`, and each phase's `instructions` frontmatter body. See [Configuration Reference](configuration-reference.md) for where each field lives.

---

## Variable Availability by Context

Variables are resolved in different contexts with different sets available. The table below summarizes which variables exist in each context; detailed tables follow.

| Variable               | `initialMessage` | Phase Instructions / Context Prompt | `blockReasonTemplate` | `completionMessage` | Cancel case | `notDoneReminder` |
| ---------------------- | :--------------: | :---------------------------------: | :-------------------: | :-----------------: | :---------: | :---------------: |
| `{workflowName}`       |        ✅        |                 ✅                  |          ✅           |         ✅          |     ✅      |        ✅         |
| `{workflowKey}`        |        ✅        |                 ✅                  |           —           |          —          |      —      |        ✅         |
| `{description}`        |        ✅        |                 ✅                  |           —           |          —          |      —      |         —         |
| `{taskDescription}`    |        —         |                  —                  |           —           |         ✅          |     ✅      |        ✅         |
| `{taskId}`             |        —         |                 ✅                  |           —           |         ✅          |     ✅      |        ✅         |
| `{phaseId}`            |        —         |                 ✅                  |           —           |          —          |      —      |         —         |
| `{phaseName}`          |        —         |                 ✅                  |          ✅           |          —          |      —      |        ✅         |
| `{previousPhaseName}`  |        —         |                 ✅                  |           —           |          —          |      —      |         —         |
| `{nextPhaseName}`      |        —         |                 ✅                  |           —           |          —          |      —      |         —         |
| `{blockedToolsList}`   |        —         |                 ✅                  |           —           |          —          |      —      |         —         |
| `{toolName}`           |        —         |                 ✅                  |          ✅           |          —          |      —      |         —         |
| `{breadcrumbPath}`     |        —         |                 ✅                  |           —           |          —          |      —      |         —         |
| `{globalStepCount}`    |        —         |                 ✅                  |           —           |          —          |      —      |         —         |
| `{phaseEmoji}`         |        —         |                  —                  |           —           |          —          |      —      |        ✅         |
| `{phaseInstructions}`  |        —         |                  —                  |           —           |          —          |      —      |        ✅         |
| `{phaseCount}`         |        —         |                  —                  |           —           |         ✅          |     ✅      |         —         |
| `{allowedTools}`       |        —         |                  —                  |          ✅           |          —          |      —      |         —         |
| `{firstPhaseId}`       |        ✅        |                  —                  |           —           |          —          |      —      |         —         |
| `{firstPhaseName}`     |        ✅        |                  —                  |           —           |          —          |      —      |         —         |
| `{firstPhaseEmoji}`    |        ✅        |                  —                  |           —           |          —          |      —      |         —         |
| `{firstPhaseProfiles}` |        ✅        |                  —                  |           —           |          —          |      —      |         —         |

> **Note:** There is no separate `cancelledMessage` field on `WorkflowDefinition`. The cancellation path reuses `completionMessage` with `DEFAULT_CANCELLED_MESSAGE` as fallback. See [Cancelled Message](#cancelled-message) below.

---

## `initialMessage` Variables

Resolved once when the workflow starts (in `src/command.ts`). The `initialMessage` field is defined in `workflow.yaml`.

| Variable               | Source                                                        | Example Value                     |
| ---------------------- | ------------------------------------------------------------- | --------------------------------- |
| `{workflowName}`       | `definition.name`                                             | `Refine, Plan, Implement, Review` |
| `{workflowKey}`        | Definition map key                                            | `rpir`                            |
| `{description}`        | User's description argument (trimmed)                         | `Add login page`                  |
| `{firstPhaseId}`       | First concrete phase's `id`                                   | `refine`                          |
| `{firstPhaseName}`     | First concrete phase's `name`                                 | `Refine Requirements`             |
| `{firstPhaseEmoji}`    | First concrete phase's `emoji`                                | `🔍`                              |
| `{firstPhaseProfiles}` | First phase's `availableProfiles` joined by `, `, or `(none)` | `planner, researcher`             |

**Example template:**

```yaml
# workflow.yaml
initialMessage: |
  Starting {workflowName} ({workflowKey}).
  Task: {description}
  First phase: {firstPhaseEmoji} {firstPhaseName} ({firstPhaseId})
  Available profiles: {firstPhaseProfiles}
```

**Resolved output:**

```
Starting Refine, Plan, Implement, Review (rpir).
Task: Add login page
First phase: 🔍 Refine Requirements (refine)
Available profiles: planner, researcher
```

> **Note:** If the first phase entry is a subworkflow reference, resolution drills into it to find the first concrete phase.

---

## Phase Instructions Variables

Available inside every phase's `instructions` body (the markdown content in each `.md` phase file). Also available in `roleInstruction` and `advanceReminder` — see [Context Prompt Variables](#context-prompt-variables) below.

Resolved per-turn in `buildContextPrompt()` (`src/prompts.ts`).

| Variable              | Source                                         | Example Value                     |
| --------------------- | ---------------------------------------------- | --------------------------------- |
| `{workflowName}`      | Top-level workflow `name`                      | `Refine, Plan, Implement, Review` |
| `{workflowKey}`       | `state.workflowKey`                            | `rpir`                            |
| `{description}`       | User's original description                    | `Add login page`                  |
| `{taskId}`            | Generated task ID                              | `wf-1747234567890-a3f2k1`         |
| `{phaseId}`           | Current phase `id`                             | `implement`                       |
| `{phaseName}`         | Current phase `name`                           | `Implementation`                  |
| `{previousPhaseName}` | Previous phase's `name`, or `(start)` if first | `Planning`                        |
| `{nextPhaseName}`     | Next phase's `name`, or `DONE` if last         | `Review`                          |
| `{blockedToolsList}`  | Blocked tools joined by `, `, or `(none)`      | `edit, write`                     |
| `{toolName}`          | Always `"workflow_step"`                       | `workflow_step`                   |
| `{breadcrumbPath}`    | Breadcrumb trail joined by `>`                 | `RPIR > Implementation`           |
| `{globalStepCount}`   | Monotonically increasing step counter          | `3`                               |

**Example phase instructions:**

```markdown
---
id: implement
name: Implementation
emoji: ⚙️
---

You are in phase **{phaseName}** of **{workflowName}** (step {globalStepCount}).

Task: {description} (ID: {taskId})

The previous phase ({previousPhaseName}) produced a plan. Now implement it.
When done, use `{toolName}` to advance to {nextPhaseName}.

Blocked tools: {blockedToolsList}
```

**Resolved output (inside context prompt):**

```
You are in phase **Implementation** of **Refine, Plan, Implement, Review** (step 3).

Task: Add login page (ID: wf-1747234567890-a3f2k1)

The previous phase (Planning) produced a plan. Now implement it.
When done, use `workflow_step` to advance to Review.

Blocked tools: edit, write
```

---

## Context Prompt Variables

The **context prompt** is injected as a hidden message before every agent turn via `buildContextPrompt()` in `src/prompts.ts`. It composes several template strings together using the **same variable map** as phase instructions.

The following configurable templates all receive the full phase instructions variable set:

| Template Field       | Purpose                                                         |
| -------------------- | --------------------------------------------------------------- |
| `roleInstruction`    | Prepended to every context injection — defines the agent's role |
| `advanceReminder`    | Appended to every context injection — reminds agent to advance  |
| Phase `instructions` | The main body of what the agent should do this phase            |

All three are resolved with the identical variable map documented in [Phase Instructions Variables](#phase-instructions-variables) above.

---

## Block Reason Variables

Resolved when a tool call is blocked during a phase (in `src/hooks.ts`, `handleToolCall()`). Used by the `blockReasonTemplate` field.

| Variable         | Source                           | Example Value                               |
| ---------------- | -------------------------------- | ------------------------------------------- |
| `{workflowName}` | `definition.name`                | `Refine, Plan, Implement, Review`           |
| `{phaseName}`    | Current phase `name`             | `Refine Requirements`                       |
| `{toolName}`     | The tool name that was blocked   | `edit`                                      |
| `{allowedTools}` | Description of what _is_ allowed | `all except: edit, write` or `read, search` |

The `{allowedTools}` value depends on the tool restriction mode:

- **Blacklist mode:** `"all except: " + blockedTools.join(", ")` → e.g. `all except: edit, write`
- **Whitelist mode:** `whitelist.join(", ")` → e.g. `read, search`

> **Note:** `workflow_step` is always allowed regardless of blacklist or whitelist configuration, but it is **not** included in the `{allowedTools}` value for whitelist mode. It will never appear in the resolved template.

**Example:**

Template:

```
[workflow] "{toolName}" is blocked during {phaseName}.
Allowed: {allowedTools}. Use workflow_step when done.
```

Resolved (blacklist):

```
[workflow] "edit" is blocked during Refine Requirements.
Allowed: all except: edit, write. Use workflow_step when done.
```

---

## Completion & Reminder Variables

### Completion Message (`completionMessage`)

Resolved when the workflow reaches the DONE state.

| Variable            | Source                                 | Example Value                     |
| ------------------- | -------------------------------------- | --------------------------------- |
| `{workflowName}`    | `definition.name`                      | `Refine, Plan, Implement, Review` |
| `{taskDescription}` | User's original description            | `Add login page`                  |
| `{taskId}`          | Generated task ID                      | `wf-1747234567890-a3f2k1`         |
| `{phaseCount}`      | Total phases in the top-level workflow | `4`                               |

### Cancelled Message

There is **no separate** `cancelledMessage` field on `WorkflowDefinition`. The cancellation path reuses the same `completionMessage` field, but with a different fallback.

**Two cancellation paths exist:**

1. **`/cancel-workflow` command** (`src/command.ts`) — Sends a **hardcoded message** with no template resolution at all:

   ```
   ❌ **Workflow Cancelled**

   **Task:** {taskDescription}
   **Task ID:** {taskId}
   ```

   This command also unloads the workflow state immediately, so the `agent_end` hook sees null state and does nothing further.

2. **`agent_end` hook** (`src/hooks.ts`) — When `state.cancelled === true` and `state.completionNotified === false`, resolves `definition.completionMessage` if set, otherwise falls back to `DEFAULT_CANCELLED_MESSAGE` (not `DEFAULT_COMPLETION_MESSAGE`). Uses the same variable set as the completion message: `{workflowName}`, `{taskDescription}`, `{taskId}`, `{phaseCount}`.

**Default cancelled message** (`DEFAULT_CANCELLED_MESSAGE` from `src/prompts.ts`):

```
❌ **{workflowName} Cancelled**

**Task:** {taskDescription}
**Task ID:** {taskId}
```

### Not-Done Reminder (`notDoneReminder`)

Resolved when the agent tries to stop while the workflow is still active. Forces the agent to continue.

| Variable              | Source                                 | Example Value                     |
| --------------------- | -------------------------------------- | --------------------------------- |
| `{workflowName}`      | `definition.name`                      | `Refine, Plan, Implement, Review` |
| `{taskDescription}`   | User's original description            | `Add login page`                  |
| `{taskId}`            | Generated task ID                      | `wf-1747234567890-a3f2k1`         |
| `{workflowKey}`       | `state.workflowKey`                    | `rpir`                            |
| `{phaseName}`         | Current phase `name`                   | `Implementation`                  |
| `{phaseEmoji}`        | Current phase `emoji`                  | `⚙️`                              |
| `{phaseInstructions}` | Current phase's full instructions text | _(the raw instructions string)_   |

---

## Default Templates

All configurable template fields have sensible defaults defined in `src/prompts.ts` and `src/hooks.ts`. If a field is omitted from the workflow definition, the corresponding default is used.

### `DEFAULT_ROLE_INSTRUCTION`

Used when `roleInstruction` is not set in the workflow definition.

```
You are the ORCHESTRATOR for this workflow. You must NOT use the edit or write tools directly.
All implementation work must be delegated to subagents via the delegate_to_subagents tool.
Follow the phase instructions precisely.
```

### `DEFAULT_ADVANCE_REMINDER`

Used when `advanceReminder` is not set.

```
When you finish this phase, call the workflow_step tool with action='next' to advance to the next phase. If you need to restart the current scope from the beginning, use action='loop'.
```

### `DEFAULT_BLOCK_REASON`

Used when `blockReasonTemplate` is not set. Defined in `src/hooks.ts`.

```
[workflow] The tool "{toolName}" is blocked during the {phaseName} phase.
Refer to the current phase instructions for allowed tools and approaches.
When finished, call workflow_step to advance to the next phase.
```

### `DEFAULT_COMPLETION_MESSAGE`

Used when `completionMessage` is not set.

```
✅ **{workflowName} Complete**

**Task:** {taskDescription}
**Task ID:** {taskId}
**Phases completed:** {phaseCount}
```

### `DEFAULT_NOT_DONE_REMINDER`

Used when `notDoneReminder` is not set.

```
⚠️ The {workflowName} is still active. Current phase: {phaseEmoji} {phaseName}.

You must NOT stop yet. The workflow requires you to complete the current phase
and call workflow_step to advance.

Current phase instructions:
{phaseInstructions}

Continue working on the current phase and call workflow_step when done.
```

### `DEFAULT_CANCELLED_MESSAGE`

Fallback for the cancellation path in `handleAgentEnd` when `completionMessage` is not set on the workflow definition. Note: the `/cancel-workflow` command sends its own hardcoded message and does not use this constant.

```
❌ **{workflowName} Cancelled**

**Task:** {taskDescription}
**Task ID:** {taskId}
```

---

## Resolution Examples

### Full lifecycle trace

Given a workflow with `name: "Code Review"`, `commandName: "review"`, and two phases (`gather` → `report`):

**1. `/workflow review Check auth module`** — `initialMessage` resolved:

```
{workflowName}        → Code Review
{workflowKey}         → code-review
{description}         → Check auth module
{firstPhaseId}        → gather
{firstPhaseName}      → Gather Context
{firstPhaseEmoji}     → 📋
{firstPhaseProfiles}  → (none)
```

**2. Agent turn during `gather` phase** — phase `instructions` resolved:

```
{workflowName}        → Code Review
{description}        → Check auth module
{taskId}              → wf-1747234567890-b2c4d6
{phaseId}             → gather
{phaseName}           → Gather Context
{previousPhaseName}   → (start)
{nextPhaseName}       → Report Findings
{blockedToolsList}    → (none)
{globalStepCount}     → 0
```

**3. Agent calls `edit` during a phase with `blacklist: [edit]`** — `blockReasonTemplate` resolved:

```
{workflowName}  → Code Review
{phaseName}     → Gather Context
{toolName}      → edit
{allowedTools}  → all except: edit
```

**4. Workflow completes** — `completionMessage` resolved:

```
{workflowName}      → Code Review
{taskDescription}   → Check auth module
{taskId}            → wf-1747234567890-b2c4d6
{phaseCount}        → 2
```
