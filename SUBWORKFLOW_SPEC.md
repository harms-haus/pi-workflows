# Subworkflows & Stage Loops — Implementation Spec

This document specifies new features for the `pi-workflows` extension. Read ALL source files in `src/` first to understand the current architecture before making any changes.

## Overview

Add support for **subworkflows** (workflows referenced inside other workflows) and **stage loops** (looping back to the beginning of the current workflow/subworkflow scope). The key principle: **a subworkflow IS a workflow** — same directory structure, same config format. Workflows can reference other workflows as phases, creating a tree. The agent navigates this tree using `workflow_step` with `next` (advance/breakout) and `loop` (restart current scope).

---

## 1. External Phase File References

Phase file entries in `workflow.yaml` may reference files outside the workflow directory using relative paths, resolved from the workflow directory:

```yaml
# my-workflow/workflow.yaml
phases:
  - ../_shared/research.md    # resolves to .pi/workflows/_shared/research.md
  - plan.md                   # resolves to .pi/workflows/my-workflow/plan.md
```

**Path safety:** Phase file paths must NOT escape above the `.pi/workflows/` root directory. Reject and warn at validation time if `../` traversal goes above the workflows root.

## 2. `show` Property on Workflows

Every workflow has an optional `show` property in `workflow.yaml`:

- `"user"` (default) — visible to users in `/workflow` completions. Has `commandName` and `initialMessage`.
- `"workflows"` — NOT visible to users. Only usable as a subworkflow referenced by other workflows. Does NOT require `commandName` or `initialMessage` (make validation conditional).

```yaml
# implementation/workflow.yaml
name: Implementation Loop
show: workflows
phases:
  - implement.md
  - review.md
```

```yaml
# rpir/workflow.yaml
name: RPIR Development Workflow
commandName: rpir
show: user
initialMessage: "Start the {workflowName}..."
phases:
  - plan.md
  - feedback.md
  - { subworkflow: implementation }
  - summary.md
```

## 3. Phase List Syntax: Phases AND Subworkflow References

The `phases` array in `workflow.yaml` accepts two types of entries:

- **String** — a phase file path (local or relative). Loaded as before.
- **Object `{ subworkflow: <key> }`** — a reference to another workflow directory by key (directory name). At load time, this is resolved to a `SubworkflowPhaseDefinition`.

The resolved `phases` array in `WorkflowDefinition` becomes a union type:

```ts
type PhaseEntry = PhaseDefinition | SubworkflowReference;

interface SubworkflowReference {
  /** Discriminator to distinguish from PhaseDefinition */
  subworkflow: true;
  /** The workflow key being referenced */
  workflowKey: string;
  /** Resolved workflow definition (populated at load time) */
  resolved: WorkflowDefinition;
}
```

A `PhaseDefinition` has no `subworkflow` field (or it's absent). A `SubworkflowReference` has `subworkflow: true`. Use this to discriminate at runtime.

## 4. Cycle Detection (Load-Time DAG Validation)

When loading workflows and resolving subworkflow references, build the reference graph and detect cycles. If a cycle is found (e.g., A → B → A), reject with a clear warning:

```
[pi-workflows] Cycle detected: rpir → implementation → rpir. Skipping workflow "rpir".
```

Both direct cycles (A → A) and indirect cycles (A → B → C → A) must be caught. This validation happens entirely at load time — cycles never reach the agent.

## 5. State Representation: Path Stack

**Replace** the flat `currentPhaseIndex: number` with a **path stack** and a **global step counter**:

```ts
interface WorkflowState {
  active: boolean;
  workflowKey: string;
  taskDescription: string;
  taskId: string;
  startedAt: number;
  completionNotified: boolean;
  cancelled: boolean;

  /** Replaces currentPhaseIndex. Stack of (workflowKey, phaseIndex) pairs.
   *  Index 0 = top-level workflow. Last element = innermost active scope. */
  currentPath: PathSegment[];

  /** Monotonically increasing counter. Incremented every time the phase changes
   *  (next, loop, entering/exiting subworkflow). Used for status display. */
  globalStepCount: number;
}

interface PathSegment {
  workflowKey: string;
  phaseIndex: number;
}
```

**Backward compatibility:** A linear workflow (no subworkflows) has a single-element `currentPath: [{ workflowKey: "rpir", phaseIndex: 2 }]`. This is functionally equivalent to the old `currentPhaseIndex: 2`.

**Migration:** `reconstructState` must handle both old entries (with `currentPhaseIndex`) and new entries (with `currentPath`). If an old entry is found, convert it: `currentPath = [{ workflowKey, phaseIndex: currentPhaseIndex }]`.

## 6. `workflow_step` Tool — New `loop` Action

The tool keeps its existing `status` and `cancel` actions unchanged. `next` gets new semantics. A new `loop` action is added.

### `next` (advance/breakout)

1. **Top of stack is a normal phase AND it's not the last phase in its workflow:**
   → Increment top segment's `phaseIndex`. Increment `globalStepCount`.

2. **Top of stack is a normal phase AND it IS the last phase:**
   → If the stack has only 1 element (top-level workflow), workflow is DONE (set `active: false`).
   → If the stack has >1 elements, pop the top segment, increment the new top's `phaseIndex`. This is the "breakout" — exiting the subworkflow and advancing the parent to its next phase. Increment `globalStepCount`.

3. **Top of stack's current phase is a SubworkflowReference:**
   → Push a new segment `{ workflowKey: ref.workflowKey, phaseIndex: 0 }` onto the stack. This enters the subworkflow. Increment `globalStepCount`.

### `loop` (restart current scope)

1. **Top of stack is inside a subworkflow:**
   → Reset top segment's `phaseIndex` to 0. Increment `globalStepCount`. This loops back to the first phase of the current (innermost) subworkflow.

2. **Top of stack is the top-level workflow:**
   → Reset top segment's `phaseIndex` to 0. Increment `globalStepCount`. This loops back to the first phase of the entire workflow.

3. **Workflow has `loopable: false`** (new optional field, defaults to `true`):
   → Return an error: "Looping is disabled for this workflow."

The loop always operates on the **innermost scope** (top of stack), never on a parent scope. Example path: `[RPIR > Implementation > review]` → `loop` → `[RPIR > Implementation > implement]`. The Implementation subworkflow loops, not RPIR.

### `status` (unchanged, but enriched)

Show the full breadcrumb path and the global step count. Example output:

```
**Workflow:** RPIR Development Workflow
**Path:** RPIR > Implementation
**Stage:** (6) Review
...
```

## 7. Status Bar (Powerline Widget)

Format: `{breadcrumb path} > ({globalStepCount}) {currentPhase.emoji} {currentPhase.name}`

The breadcrumb is built by joining all stack entries' workflow names (except the leaf, which shows the phase). Examples:

- Linear: `RPIR Development Workflow — 🔍 Research [1/4]` (keep existing format for backward compat, or use new format — implementer's choice, just be consistent)
- Nested: `RPIR > Implementation — (6) 👁️ Review`
- Deeply nested: `Grandparent > Parent > Child — (12) 🔨 Build`

For linear (single-element stack) workflows, the status bar format can remain as-is for backward compatibility if desired.

## 8. Context Injection (before_agent_start)

Inject **only the current innermost scope's phase instructions** as a hidden message. The parent workflow's phase instructions are still in the conversation context from earlier turns (they're not deleted), but the newest injection overrides/conflicts in favor of the innermost scope.

The injected context should include:
- A breadcrumb line: `[Workflow path: RPIR > Implementation > Review]`
- The role instruction (from the innermost workflow's definition)
- The current phase's instructions
- The advance/loop reminder

## 9. Validation Changes

Update `validateWorkflowDefinition`:

- `show` defaults to `"user"` if absent
- When `show === "workflows"`: `commandName` and `initialMessage` are NOT required
- When `show === "user"`: `commandName` and `initialMessage` ARE required (existing behavior)
- Subworkflow references must point to a loaded workflow definition that exists
- Subworkflow references must not point to a workflow that itself references the current workflow (cycle detection, covered in section 4)
- `loopable` is optional, boolean, defaults to `true`

## 10. Backward Compatibility

- All existing workflow configs without subworkflow references work unchanged
- `reconstructState` handles old state entries with `currentPhaseIndex` (migrate to `currentPath`)
- Status bar format for linear workflows remains familiar
- `workflow_step` tool's existing `next`, `status`, `cancel` actions remain backward-compatible
- The `phases` array in `WorkflowDefinition` type changes to a union — update all code that iterates over phases to handle both `PhaseDefinition` and `SubworkflowReference`

## 11. Files to Modify (Guide)

- **`src/types.ts`** — Add `PathSegment`, `SubworkflowReference`, update `WorkflowState`, update `WorkflowDefinition` to include `show`, `loopable`, and make `phases` a union type
- **`src/config.ts`** — Update `loadWorkflowFromDir` to parse `show`, `loopable`, and `{ subworkflow: key }` entries. Add cycle detection. Allow relative paths for phase files with safety checks. Update validation.
- **`src/state.ts`** — Replace `currentPhaseIndex` with `currentPath` + `globalStepCount`. Update `createInitialState`, `advancePhase`, `resolveActive`, `reconstructState` (migration). Add `loopPhase` function.
- **`src/tool.ts`** — Add `loop` action. Update `next` to handle the stack (entering subworkflows, breaking out). Update `status` to show breadcrumb.
- **`src/hooks.ts`** — Update `updateStatus` for new breadcrumb format. Update `handleBeforeAgentStart` context injection. Update `handleAgentEnd` to use new state shape.
- **`src/prompts.ts`** — Update `buildContextPrompt` to use innermost scope. Update default templates.
- **`src/command.ts`** — Update `/workflow` command to filter by `show: "user"` in completions.
- **`src/renderers.ts`** — Likely no changes needed, but review.

## 12. Example Configurations

### RPIR with reusable Implementation subworkflow

```yaml
# .pi/workflows/rpir/workflow.yaml
name: RPIR Development Workflow
commandName: rpir
show: user
initialMessage: "Start the {workflowName} for: \"{description}\"\n\nBegin with Phase 1 ({firstPhaseName})."
phases:
  - research.md
  - plan.md
  - { subworkflow: implementation }
  - summary.md
```

```yaml
# .pi/workflows/implementation/workflow.yaml
name: Implementation
show: workflows
loopable: true
phases:
  - implement.md
  - review.md
```

### Simple linear workflow (unchanged)

```yaml
# .pi/workflows/code-review/workflow.yaml
name: Code Review
commandName: code-review
show: user
initialMessage: "Start code review for: \"{description}\""
phases:
  - examine.md
  - report.md
```

### Nested subworkflows (deep nesting)

```yaml
# .pi/workflows/grandparent/workflow.yaml
name: Grandparent
commandName: gp
show: user
initialMessage: "..."
phases:
  - kickoff.md
  - { subworkflow: parent }
  - wrapup.md
```

```yaml
# .pi/workflows/parent/workflow.yaml
name: Parent
show: workflows
phases:
  - setup.md
  - { subworkflow: child }
  - teardown.md
```

```yaml
# .pi/workflows/child/workflow.yaml
name: Child
show: workflows
phases:
  - build.md
  - test.md
```

Path: `Grandparent > Parent > Child — (7) 🧪 Test`
