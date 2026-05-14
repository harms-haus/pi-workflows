# Subworkflows

## What Are Subworkflows

A **subworkflow** is a workflow definition referenced as a phase entry inside another workflow's `phases` array. The entire subworkflow's phase sequence runs as a single logical "phase" within the parent. When the subworkflow completes (all its phases finish), control returns to the parent's next phase.

Subworkflows enable composition: build small, reusable workflow units and combine them into larger pipelines without duplicating phase definitions.

```
Parent Workflow
├── Phase A: "Gather Requirements"
├── Phase B: "Code Review Cycle"          ← This is actually a subworkflow
│   ├── Phase B1: "Static Analysis"
│   ├── Phase B2: "Peer Review"
│   └── Phase B3: "Approval Gate"
├── Phase C: "Deploy"
└── Phase D: "Verify"
```

---

## Declaring a Subworkflow Reference

In `workflow.yaml`, use an **object syntax** to declare a subworkflow reference within the `phases` array:

```yaml
# my-workflow/workflow.yaml
name: "Release Pipeline"
commandName: "release"
initialMessage: "Starting {workflowName} for: {description}"
phases:
  - build.md                    # concrete phase (string = filename)
  - { subworkflow: code-review } # subworkflow reference
  - deploy.md                   # concrete phase
```

The `subworkflow` value must match the **directory name** of another workflow loaded from the same workflows root. During the two-pass loading process (see [Resolution and Loading](#resolution-and-loading)), the reference is replaced with a resolved link to the target workflow definition.

### In-memory representation

After loading, a subworkflow reference is represented as a [`SubworkflowReference`](../src/types.ts) object:

```typescript
interface SubworkflowReference {
  subworkflow: true;          // discriminator
  workflowKey: string;        // directory name of the target workflow
  resolved: WorkflowDefinition | null; // null after Pass 1, populated during Pass 2 resolution
}
```

The `resolved` field is initialized as `null` during Pass 1 loading and only populated with the target `WorkflowDefinition` during Pass 2 resolution. Code that traverses phase entries should check for `resolved === null` to detect unresolved references.

The type guard `isSubworkflowRef(entry)` distinguishes subworkflow references from plain `PhaseDefinition` objects.

---

## Subworkflow-Only Workflows

Some workflows exist solely to be consumed as subworkflows — they should never appear in the `/workflow` slash command menu. Set `show: "workflows"` in their `workflow.yaml`:

```yaml
# _shared/code-review/workflow.yaml
name: "Code Review Cycle"
show: "workflows"             # hidden from /workflow command
loopable: false
phases:
  - static-analysis.md
  - peer-review.md
  - approval-gate.md
```

When `show` is `"workflows"`:

- The workflow is **excluded** from the `/workflow` command list.
- `commandName` and `initialMessage` are **optional** (defaults to empty string).
- The workflow can still be freely referenced as a subworkflow by other workflows.

When `show` is omitted or `"user"` (the default), the workflow is visible to users and `commandName`/`initialMessage` are required.

---

## Resolution and Loading

Workflows are loaded via a **two-pass** process:

### Pass 1 — Load all directories

1. Scan the global directory (`~/.pi/agent/workflows/`) and project-local directory (`.pi/workflows/`).
2. Each subdirectory containing a `workflow.yaml` is loaded as a `WorkflowDefinition`.
3. Project definitions override global definitions with the same key (directory name).
4. Each definition is validated with `validateWorkflowDefinition()`. Invalid definitions are excluded.
5. Subworkflow references are parsed but **not yet resolved** — the `resolved` field is `null`.

### Pass 2 — Resolve references (with cascading)

After all definitions are loaded, subworkflow references are resolved in a loop that repeats until stable:

1. For each workflow containing an unresolved `SubworkflowReference`, look up `workflowKey` in the loaded definitions map.
2. If the target **does not exist**, the referencing workflow is **excluded** (removed from the valid set) and a warning is logged:
   ```
   [pi-workflows] Workflow "my-pipeline" references non-existent subworkflow "missing-step". Skipping.
   ```
3. If the target **exists**, the `resolved` field is populated with the target `WorkflowDefinition`.
4. Repeat until no more exclusions occur — this handles [cascading exclusion](#cascading-exclusion).

### Load-time ordering summary

```
1. Load all workflow directories          → Record<string, WorkflowDefinition>
2. Validate each definition              → remove invalid
3. Detect cycles (DFS)                   → remove cyclic workflows
4. Resolve subworkflow references         → populate .resolved, remove broken
5. Repeat step 4 until stable             → handle cascading
6. Check for duplicate commandNames       → warn (first wins)
```

---

## Stack-Based Navigation

The runtime uses a **path stack** (`currentPath`) to track position within potentially nested workflows. Each element is a [`PathSegment`](../src/types.ts):

```typescript
interface PathSegment {
  workflowKey: string;  // which workflow
  phaseIndex: number;   // which phase within that workflow
}
```

- **Index 0** = top-level (root) workflow.
- **Last index** = innermost (currently active) scope.
- A single-element stack means a flat, non-nested workflow.

### Visualizing the stack

Consider a parent workflow with a subworkflow that itself contains a nested subworkflow:

```
Parent "release"              phases: [build, {subworkflow: review}, deploy]
  └── review                  phases: [static, {subworkflow: security}, approval]
        └── security          phases: [scan, report]
```

When the agent is executing the "scan" phase of "security":

```
currentPath stack (bottom → top):

  ┌─────────────────────────────────┐
  │ { workflowKey: "release",       │  ← root scope
  │   phaseIndex: 1 }              │     (at the subworkflow entry)
  ├─────────────────────────────────┤
  │ { workflowKey: "review",        │  ← middle scope
  │   phaseIndex: 1 }              │     (at the subworkflow entry)
  ├─────────────────────────────────┤
  │ { workflowKey: "security",      │  ← innermost (active)
  │   phaseIndex: 0 }              │     (at "scan" phase)
  └─────────────────────────────────┘
```

### Advance cases

`advancePhase()` in [`state.ts`](../src/state.ts) handles four cases when the agent calls `workflow_step` with action `next`:

| Case | Condition | Action |
|------|-----------|--------|
| **1 — Enter subworkflow** | Current entry is a `SubworkflowReference` | **Push** new `PathSegment` onto stack with `phaseIndex: 0` |
| **2 — Normal advance** | Current entry is a concrete phase, not the last in scope | Increment `phaseIndex` in the top segment |
| **3 — Top-level done** | Last phase in root scope (`currentPath.length === 1`) | Set `active = false`, workflow is DONE |
| **4 — Subworkflow complete** | Last phase in a subworkflow scope | **Pop** the stack, increment parent's `phaseIndex` |

#### Case 1 diagram — entering a subworkflow

```
BEFORE:  currentPath = [{ release, phaseIndex: 0 }]
         → current entry = "build" (concrete phase)

ADVANCE: current entry at index 0 is concrete, not last
         → phaseIndex++ (Case 2)

BEFORE:  currentPath = [{ release, phaseIndex: 1 }]
         → current entry = { subworkflow: "review" }

ADVANCE: push { review, phaseIndex: 0 }  (Case 1)

AFTER:   currentPath = [{ release, 1 }, { review, 0 }]
         → now executing review's first phase
```

#### Case 4 diagram — completing a subworkflow

```
BEFORE:  currentPath = [{ release, 1 }, { review, 2 }]
         → review phaseIndex 2 = "approval" (last phase in review)

ADVANCE: pop { review, 2 }, increment parent to phaseIndex 2 (Case 4)

AFTER:   currentPath = [{ release, 2 }]
         → now executing release's "deploy" phase
```

---

## Cycle Detection

Cycles in the subworkflow reference graph are detected **at load time** using iterative DFS with 3-color marking. This prevents infinite loops during execution.

### Algorithm

1. Build an adjacency list from all subworkflow references.
2. Mark every node `WHITE` (unvisited).
3. For each `WHITE` node, run iterative DFS:
   - `GRAY` = currently being explored (on the DFS stack).
   - `BLACK` = fully explored, no cycles through this node.
4. If a `GRAY` node is encountered during exploration, a **back edge** (cycle) is found.
5. Reconstruct and report the cycle path.

### Example

Given workflows: `A → B → C → A` (A references B, B references C, C references A):

```
[pi-workflows] Cycle detected: A → B → C → A. Skipping workflow "A".
```

All workflows participating in the cycle are **excluded** from the valid set.

> **Note:** The cycle detection only considers edges where the target workflow actually exists in the definitions. References to missing workflows are handled separately during [resolution](#resolution-and-loading).

---

## Nesting Depth

There is **no explicit depth limit** on subworkflow nesting. The practical constraint is that the reference graph must form a DAG (directed acyclic graph) — enforced by [cycle detection](#cycle-detection). As long as no cycles exist, arbitrarily deep nesting is allowed.

---

## Loop Scope

When the agent calls `workflow_step` with action `loop`, only the **innermost scope** is restarted. The `loopPhase()` function resets the top `PathSegment`'s `phaseIndex` to `0`:

```typescript
// loopPhase resets only the top of the stack
top.phaseIndex = 0;
```

### Example

```
currentPath = [{ release, 2 }, { review, 1 }]
                parent          innermost

→ loop resets { review, 0 }

currentPath = [{ release, 2 }, { review, 0 }]
                               ^^^^^^^^^^^^
                               restarted to first phase
```

The parent scope is unaffected. The workflow's `loopable` setting is checked on the **innermost** workflow — if `loopable: false`, the loop is rejected with an error.

---

## Cascading Exclusion

When a workflow is excluded (due to a broken reference), other workflows that reference it may also become invalid. The loading process handles this with an iterative loop:

```typescript
let changed = true;
while (changed) {
  changed = false;
  // check each workflow's subworkflow references
  // if any reference target is missing → exclude the referencing workflow
  // if any exclusions occurred → set changed = true, loop again
}
```

### Example cascade

```
Workflows loaded: A, B, C, D
  A references B
  B references C
  C references (non-existent) Z

Step 1: C references missing Z → exclude C
Step 2: B references missing C  → exclude B
Step 3: A references missing B  → exclude A
Step 4: No more broken references → stable

Result: Only D remains.
```

Each exclusion logs a warning identifying the broken reference:

```
[pi-workflows] Workflow "C" references non-existent subworkflow "Z". Skipping.
[pi-workflows] Workflow "B" references non-existent subworkflow "C". Skipping.
[pi-workflows] Workflow "A" references non-existent subworkflow "B". Skipping.
```

---

## Shared Phase Pattern

A common convention is to organize reusable subworkflows under a `_shared/` directory:

```
workflows/
├── _shared/
│   ├── code-review/
│   │   ├── workflow.yaml        ← show: "workflows"
│   │   ├── static-analysis.md
│   │   ├── peer-review.md
│   │   └── approval-gate.md
│   └── testing/
│       ├── workflow.yaml        ← show: "workflows"
│       ├── unit-tests.md
│       └── integration-tests.md
├── release-pipeline/
│   ├── workflow.yaml
│   ├── build.md
│   └── deploy.md
└── feature-work/
    ├── workflow.yaml
    ├── design.md
    └── implement.md
```

Key points for `_shared/` workflows:

- Set `show: "workflows"` to hide them from the `/workflow` command.
- `commandName` and `initialMessage` can be omitted or left empty.
- Reference them from any other workflow: `{ subworkflow: code-review }` or `{ subworkflow: testing }`.
- The underscore prefix in `_shared` is a convention only — it has no special meaning to the loader. All subdirectories are scanned regardless of name.

---

## Breadcrumb Display

When a workflow is active with nested subworkflows, the status bar and status output show a **breadcrumb trail** of the full path from root to innermost scope.

### Status bar (nested)

When `currentPath.length > 1`, the status bar shows:

```
Release Pipeline > Code Review Cycle — 🔍 Static Analysis [1/3]
```

Format: `{parent names} > {innermost name} — {emoji} {phase name} [{current}/{total}]`

- `{parent names}` — all ancestor workflow names joined by ` > `.
- `{innermost name}` — the deepest workflow's display name.
- Phase progress `[current/total]` is relative to the **innermost** scope.

### Status bar (non-nested)

When `currentPath.length === 1`, the standard format is used:

```
Release Pipeline — 🚀 Deploy [3/4]
```

### Status command output

The `workflow_step` action `status` also includes a `**Path:**` line when nested:

```
**Workflow:** Release Pipeline (release)
**Path:** Release Pipeline > Code Review Cycle > Security Scan
**Phase:** 🔍 Dependency Audit [1/2] (step 5)
```

### Prompt injection

During context injection, the breadcrumb is embedded in the agent prompt for orientation:

```
[Workflow path: Release Pipeline > Code Review Cycle ▸ 🔍 Static Analysis]
```

---

## Full workflow.yaml Schema

For the complete `workflow.yaml` schema including all fields (role instructions, advance reminders, completion messages, etc.), see [configuration-reference.md](configuration-reference.md).

---

## API Reference

### Types

| Type | Description |
|------|-------------|
| `SubworkflowReference` | A phase entry that delegates to another workflow. Fields: `subworkflow: true`, `workflowKey`, `resolved` |
| `PathSegment` | A navigation stack element. Fields: `workflowKey`, `phaseIndex` |
| `PhaseEntry` | Union type: `PhaseDefinition \| SubworkflowReference` |
| `ActiveWorkflow` | Resolved runtime state. Includes `breadcrumb` array for display |

### Type guards

| Function | Signature | Returns |
|----------|-----------|---------|
| `isSubworkflowRef` | `(entry: PhaseEntry) => boolean` | `true` if entry is a `SubworkflowReference` |
| `isPhaseDefinition` | `(entry: PhaseEntry) => boolean` | `true` if entry is a concrete `PhaseDefinition` |

### Key functions

| Function | Module | Purpose |
|----------|--------|---------|
| `loadWorkflows(cwd?)` | `config.ts` | Two-pass loading: directories → validate → cycle detect → resolve references |
| `detectCycles(definitions)` | `config.ts` | DFS 3-color cycle detection; returns error messages for cycles found |
| `validateWorkflowDefinition(key, def)` | `config.ts` | Validates a single definition; relaxed rules when `show: "workflows"` |
| `advancePhase(state, definitions)` | `state.ts` | Four-case stack navigation (enter/advance/done/breakout) |
| `loopPhase(state, definitions)` | `state.ts` | Restart innermost scope from phase 0 |
| `resolveActive(state, definitions)` | `state.ts` | Resolve state to `ActiveWorkflow` with breadcrumb |
| `createInitialState(key, description)` | `state.ts` | Create fresh state with single-element `currentPath` stack |
