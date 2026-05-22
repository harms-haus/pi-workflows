# State Management

The pi-workflows runtime tracks the lifecycle of a single workflow execution through a module-level closure variable, persisted to the session branch for crash recovery.

---

## State Architecture

State lives as a single closure-scoped variable in [`src/index.ts`](../src/index.ts):

```
let state: WorkflowState | null = null;
```

| Value                                | Meaning                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `null`                               | No workflow has been started, or the previous workflow completed/was cancelled and unloaded.                                                                       |
| `WorkflowState` with `active: true`  | A workflow is currently executing. The agent is expected to be working through phases.                                                                             |
| `WorkflowState` with `active: false` | The workflow has finished all phases (or was cancelled) but the completion notification has not yet been sent. A transient state consumed by the `agent_end` hook. |

There is **never more than one** active workflow per session. Starting a new workflow while one is active prompts the user for confirmation.

### Lifecycle overview

```
                    ┌──────────────────┐
  /workflow cmd ──► │ createInitialState│──► persist
                    └────────┬─────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │  active: true       │◄─── loopPhase() resets
                  │  agent executes     │     innermost scope
                  │  current phase      │
                  └──────┬──────────────┘
                         │
            workflow_step │ action='next'
                         │
                         ▼
               ┌─── advancePhase() ───┐
               │                       │
        ┌──────┴──────┐         ┌──────┴──────┐
        │ more phases │         │ all done    │
        │ stay active │         │ active:false│
        └──────┬──────┘         └──────┬──────┘
               │                       │
               ▼                       ▼
          persist,            agent_end hook sends
          next turn            completion notification
                                    │
                                    ▼
                              state = null (unload)
```

---

## WorkflowState Fields

Defined in [`src/types.ts`](../src/types.ts):

| Field                | Type                 | Description                                                                                                              |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `active`             | `boolean`            | `true` when the agent should be working on phases. Set to `false` when the top-level workflow completes or is cancelled. |
| `workflowKey`        | `string`             | The top-level workflow definition key from settings (e.g. `"rpir"`, `"code-review"`).                                    |
| `currentPath`        | `PathSegment[]`      | Navigation stack. Index 0 = root workflow, last index = innermost scope.                                                 |
| `globalStepCount`    | `number`             | Monotonically increasing counter. Incremented on every `advancePhase()`, `loopPhase()`, and subworkflow entry.           |
| `taskId`             | `string`             | Unique identifier for this workflow run. Format: `wf-{timestamp}-{random6}`.                                             |
| `taskDescription`    | `string`             | The user's original task description from the `/workflow` command.                                                       |
| `startedAt`          | `number`             | Unix timestamp (ms) when the workflow was created via `Date.now()`.                                                      |
| `completionNotified` | `boolean`            | Whether the DONE notification has already been sent. Prevents duplicate messages on repeated `agent_end` events.         |
| `cancelled`          | `boolean`            | `true` if the workflow was cancelled (not completed normally). Controls which completion message template is used.       |
| `_cancelPending`     | `boolean` (optional) | Internal flag set after the first cancel request, requiring a second call to confirm cancellation within the same turn.  |

### Task ID format

```
wf-1747234567890-a3f9k2
│   │            │
│   │            └── 6 random base-36 chars (Math.random().toString(36).slice(2, 8))
│   └─────────────── Date.now() timestamp
└─────────────────── literal prefix
```

Example: `wf-1747234567890-a3f9k2`

---

## PathSegment

Each element in the `currentPath` stack represents one scope level:

```typescript
interface PathSegment {
  workflowKey: string; // which workflow definition this scope refers to
  phaseIndex: number; // current position in that workflow's phases array
}
```

**Stack semantics:**

```
currentPath[0]            = root (top-level) workflow
currentPath[length - 1]   = innermost (currently executing) scope
currentPath.length === 1  → flat, non-nested workflow
currentPath.length > 1    → inside one or more subworkflows
```

For details on how subworkflows create nested scopes, see [docs/subworkflows.md](subworkflows.md).

---

## Copy-on-Write Pattern

All state-transition functions in [`src/state.ts`](../src/state.ts) follow a **copy-on-write** pattern: they receive the current `WorkflowState`, produce a **new** cloned state object, mutate the clone, and return it alongside metadata. The original input is never modified.

The canonical clone helper is `cloneState()`, exported from `state.ts`:

```typescript
export function cloneState(state: WorkflowState): WorkflowState {
  return {
    ...state,
    currentPath: state.currentPath.map((s) => ({ ...s })),
  };
}
```

This shallow-copies the top-level object and deep-copies the `currentPath` array (with new segment objects), ensuring each transition produces an independent state snapshot.

### Return types

| Function                      | Return type                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `advancePhase(state, defs)`   | `{ advanced: true; from: string; to: string \| null; newState: WorkflowState }`                     |
| `loopPhase(state, defs)`      | `{ looped: true; to: string; newState: WorkflowState } \| { looped: false; error: string }`         |
| `autoEnterSubworkflowRefs(state, entry)` | `{ phaseName: string \| null; newState: WorkflowState }`                                     |

Callers (e.g. `tool.ts`, `command.ts`) receive `newState` and pass it to `setState()` to update the closure.

---

## Phase Transitions

`advancePhase()` in [`src/state.ts`](../src/state.ts) handles all forward navigation. It clones the input state, examines the **top of the stack** (innermost scope) and the **current phase entry** at that position, then applies one of four cases:

### Case 1: Entering a subworkflow (push)

When the current entry at the top of the stack is a `SubworkflowReference`:

```
BEFORE (input state):
  currentPath = [{ release, phaseIndex: 1 }]
                                       ↑ points to { subworkflow: "review" }

ACTION:  clone state (via cloneState()), push { review, phaseIndex: 0 } onto clone

AFTER (newState — input is untouched):
  currentPath = [{ release, 1 }, { review, 0 }]
                                  ↑ now executing review's first phase

  newState.globalStepCount++
```

### Case 2: Normal advance (increment)

When the current entry is a concrete `PhaseDefinition` and is **not** the last in scope:

```
BEFORE (input state):
  currentPath = [{ release, phaseIndex: 0 }]
                                       ↑ "build" phase, not the last

ACTION:  clone state (via cloneState()), increment clone's top.phaseIndex

AFTER (newState — input is untouched):
  currentPath = [{ release, 1 }]
                            ↑ now at next phase

  newState.globalStepCount++
```

### Case 3: Top-level completion (set inactive)

When the current entry is the **last** phase in scope and the stack has only **one** segment (root workflow):

```
BEFORE (input state):
  currentPath = [{ release, phaseIndex: 3 }]
                                       ↑ last phase "verify"

ACTION:  clone state (via cloneState()), set clone.active = false, clone.completionNotified = false

AFTER (newState):
  currentPath = [{ release, 3 }]   (unchanged)
  active: false   → workflow is DONE

  newState.globalStepCount++
```

The `agent_end` hook detects `active: false` + `completionNotified: false`, sends the completion message, then unloads state.

### Case 4: Subworkflow breakout (pop + advance parent)

When the current entry is the **last** phase in scope and the stack has **more than one** segment (inside a subworkflow):

```
BEFORE (input state):
  currentPath = [{ release, 1 }, { review, 2 }]
                                               ↑ last phase in "review"

ACTION:  clone state (via cloneState()), pop clone's stack, increment clone's parent.phaseIndex

AFTER (newState — input is untouched):
  currentPath = [{ release, 2 }]
                            ↑ parent advances past the subworkflow reference

  newState.globalStepCount++
```

### ASCII summary of the four cases

```
                    ┌─────────────────────────────┐
                    │ Read top of currentPath      │
                    │ Read phaseEntry at top index │
                    └──────────┬──────────────────┘
                               │
                 ┌─────────────┴─────────────┐
                 │ Is entry a SubworkflowRef? │
                 └──┬──────────────────┬─────┘
              YES   │                  │  NO
                    ▼                  │
            ┌──────────────┐           │
            │ CASE 1: PUSH │           │
            │ clone, push  │           │
            │ new segment  │           │
            └──────────────┘           │
                                       ▼
                         ┌───────────────────────┐
                         │ Is this the last phase│
                         │ in the current scope? │
                         └──┬──────────────┬────┘
                         NO │              │ YES
                            ▼              ▼
                   ┌──────────────┐  ┌─────────────────┐
                   │ CASE 2:      │  │ Stack length?   │
                   │ INCREMENT    │  └──┬──────────┬───┘
                   │ clone, idx++ │   1 │          │ >1
                   └──────────────┘     ▼          ▼
                                   ┌────────┐  ┌──────────────┐
                                   │ CASE 3 │  │ CASE 4:      │
                                   │ DONE   │  │ POP + ADVANCE│
                                   │ clone, │  │ clone, pop,  │
                                   │active- │  │ parent idx++ │
                                   │ =false │  │              │
                                   └────────┘  └──────────────┘
```

---

## Loop Phase

`loopPhase()` restarts the **innermost scope** from phase 0. It clones the input state, resets the top segment's `phaseIndex`, increments `globalStepCount`, and returns `{ looped: true, to, newState }`. If the workflow has `loopable: false`, it returns `{ looped: false, error }` instead — without cloning.

```typescript
const s = cloneState(state);
const top = s.currentPath[s.currentPath.length - 1];
top.phaseIndex = 0;
s.globalStepCount++;
return { looped: true, to: phaseName, newState: s };
```

**Guards:**

- If the innermost workflow definition has `loopable: false`, the operation is rejected:

  ```
  { error: "Looping is disabled for this workflow." }
  ```

- `loopable` defaults to `true` when omitted from the workflow definition.

**Example — looping inside a nested subworkflow:**

```
BEFORE (input state):
  currentPath = [{ release, 2 }, { review, 1 }]
                                 ↑ innermost at phase 1

ACTION:  loopPhase() → clone, set clone's top.phaseIndex = 0

AFTER (newState):
  currentPath = [{ release, 2 }, { review, 0 }]
                                           ↑ restarted

  Input state is untouched.
```

---

## Persistence

State is persisted after every state transition (each of which returns a new state object) so the session can recover after a crash or reload.

### Storage mechanism

```typescript
pi.appendEntry("workflow:state", { ...state });
```

Each call appends a **new** entry to the session branch (no in-place updates). The latest entry is found by scanning in reverse during reconstruction.

### When persistence occurs

| Trigger                 | Location                              | Condition                                                         |
| ----------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| Workflow creation       | `registerWorkflowCommand` handler     | Immediately after `createInitialState()`                          |
| Phase advance           | `workflow_step` tool, action `next`   | After `advancePhase()` returns new state                           |
| Phase loop              | `workflow_step` tool, action `loop`   | After `loopPhase()` returns new state                              |
| Cancellation (tool)     | `workflow_step` tool, action `cancel` | After setting `cancelled: true`, `active: false`                  |
| Cancellation (command)  | `/cancel-workflow` command            | After setting `cancelled: true`, `active: false`                  |
| Completion notification | `agent_end` hook                      | After sending the DONE message (marks `completionNotified: true`) |

### Entry structure in the session branch

```json
{
  "type": "custom",
  "customType": "workflow:state",
  "data": {
    "active": true,
    "workflowKey": "rpir",
    "currentPath": [{ "workflowKey": "rpir", "phaseIndex": 2 }],
    "globalStepCount": 2,
    "taskId": "wf-1747234567890-a3f9k2",
    "taskDescription": "Refactor authentication module",
    "startedAt": 1747234567890,
    "completionNotified": false,
    "cancelled": false
  }
}
```

---

## Reconstruction (Crash Recovery)

When a session starts or the session tree changes, `reconstructState()` scans the session branch entries in **reverse chronological order** to find the most recent workflow state.

### Algorithm

```
1. Get the full session branch (array of entries)
2. Iterate from the last entry backwards
3. Match entries where:
     type === "custom"
     customType === "workflow:state"
     data.workflowKey exists
4. Apply migrations (see below)
5. Validate structure
6. Return the reconstructed state (or null if none found)
```

### Migration: `currentPhaseIndex` → `currentPath`

Old versions of pi-workflows used a single `currentPhaseIndex` field (no subworkflow support). The reconstruction migrates this on-the-fly:

```typescript
if (data.currentPhaseIndex !== undefined && !data.currentPath) {
  data.currentPath = [
    {
      workflowKey: data.workflowKey,
      phaseIndex: data.currentPhaseIndex,
    },
  ];
  delete data.currentPhaseIndex;
}
```

### Migration: missing `globalStepCount`

Early persisted states may lack `globalStepCount`:

```typescript
if (data.currentPath && data.globalStepCount === undefined) {
  data.globalStepCount = data.currentPath[0]?.phaseIndex ?? 0;
}
```

This is a best-effort approximation using the root phase index as the step count.

### Validation

After migration, the path structure is validated to prevent crashes from corrupted or tampered data:

```typescript
// Reject empty paths
if (!Array.isArray(data.currentPath) || data.currentPath.length === 0) {
  return null;
}

// Reject malformed segments
for (const seg of data.currentPath) {
  if (typeof seg.workflowKey !== "string" || typeof seg.phaseIndex !== "number") {
    return null;
  }
}
```

Invalid states are silently discarded — the session starts with `state = null` (no active workflow).

### When reconstruction runs

| Event           | Handler in `index.ts`                                          |
| --------------- | -------------------------------------------------------------- |
| `session_start` | Definitions are loaded, then `reconstructState(ctx)` is called |
| `session_tree`  | Same flow — reload definitions and reconstruct state           |

---

## ActiveWorkflow Resolution

`resolveActive()` converts the raw `WorkflowState` + definitions into a fully resolved `ActiveWorkflow` object with a breadcrumb trail. This is the primary interface used by hooks and the tool handler.

### Resolution steps

```
1. Return null if state is null or inactive
2. Walk currentPath — validate every segment's workflowKey exists in definitions
3. Read innermost (top) segment
4. Get the current PhaseEntry at that position
5. If the entry is a SubworkflowReference, drill into its first concrete PhaseDefinition
6. Build breadcrumb from all path segments
7. Return ActiveWorkflow
```

### Return value

```typescript
interface ActiveWorkflow {
  definition: WorkflowDefinition; // top-level workflow definition
  state: WorkflowState; // current state
  currentPhase: PhaseDefinition; // innermost concrete phase (never a SubworkflowRef)
  currentPhaseEntry: PhaseEntry; // raw entry at top of stack (may be SubworkflowRef)
  nextPhase: PhaseEntry | null; // next entry in innermost scope, or null
  breadcrumb: Array<{
    workflowKey: string;
    name: string;
    phaseName: string;
    emoji: string;
  }>;
}
```

### Subworkflow drilling

When the innermost scope's current entry is a `SubworkflowReference`, `resolveActive()` drills into the subworkflow's first phase to find a concrete `PhaseDefinition`:

```
currentPath = [{ release, 1 }]
                          ↑ points to { subworkflow: "review" }

resolveActive drills:
  review.phases[0] → concrete PhaseDefinition (e.g. "Static Analysis")

→ currentPhase = "Static Analysis" (not the SubworkflowReference)
```

### Breadcrumb construction

The breadcrumb array has one entry per path segment. The innermost entry gets the current phase's emoji; ancestor entries get an empty emoji:

```
Path:  [{ release, 1 }, { review, 0 }]

Breadcrumb:
  [
    { workflowKey: "release", name: "Release Pipeline", phaseName: "Release Pipeline", emoji: "" },
    { workflowKey: "review",  name: "Code Review",      phaseName: "Static Analysis", emoji: "🔍" }
  ]
```

This drives the status bar display:

```
Release Pipeline > Code Review [2/3] > 🔍 Static Analysis [1/2]
```

---

## State Mutation Pattern

Hooks don't modify the closure variable directly. Instead, they return a `HookStateMutation`:

```typescript
interface HookStateMutation {
  unload: boolean; // if true, set state = null
  state?: WorkflowState; // if set, replace state with this value
  persist: boolean; // if true, persist via pi.appendEntry
}
```

The `index.ts` event handler applies the mutation:

```typescript
const mutation = handleAgentEnd(pi, state, definitions, ctx, event);
if (mutation.unload) {
  state = null;
} else if (mutation.state) {
  state = mutation.state;
}
if (mutation.persist && state) {
  persistState(pi, state);
}
```

The `workflow_step` tool and `/workflow` command use accessor callbacks (`getState`, `setState`) instead, since they are registered with references to the same closure.

---

## Two-Step Cancellation

Cancelling a workflow via the tool requires two consecutive `workflow_step` calls with `action: "cancel"`:

1. **First call** — sets `_cancelPending = true`, returns a confirmation prompt.
2. **Second call** (same turn) — creates a new state object with `active: false`, `cancelled: true`, persists it, and updates the closure.

The `/cancel-workflow` command bypasses this two-step flow and immediately cancels.

---

## Related Documentation

- [Subworkflows](subworkflows.md) — How subworkflow references create nested path stacks and the full loading/resolution process
- [Configuration Reference](configuration-reference.md) — Workflow definition schema including `loopable`, `show`, phase definitions, and template variables
