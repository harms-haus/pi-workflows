# Subworkflows & Stage Loops — Implementation Plan

## File Inventory

### Files to Modify (7)
1. `src/types.ts` — New types + updated interfaces
2. `src/config.ts` — Loading, parsing, validation, cycle detection, path safety
3. `src/state.ts` — Path stack, advance/loop/resolve/migration
4. `src/tool.ts` — Loop action, next rewrite, status breadcrumb
5. `src/hooks.ts` — Status bar breadcrumb, context injection, leaf counting
6. `src/prompts.ts` — Innermost context, breadcrumb, profile traversal, template vars
7. `src/command.ts` — show:user filtering, subworkflow-ref first-phase template vars

### Files NOT Modified
- `src/renderers.ts` — No changes needed
- `src/index.ts` — No structural changes needed (existing wiring already calls all the right functions)

### Files to Create (2)
- `vitest.config.ts` — Vitest configuration
- `src/__tests__/config.test.ts`, `src/__tests__/state.test.ts`, `src/__tests__/tool.test.ts`, `src/__tests__/prompts.test.ts` — Test files

---

## Phase 1: Foundation (Types + Type Guards)

### Step 1: Add new types and update interfaces in `src/types.ts`

**File:** `src/types.ts`

**What:** Add new types (`PathSegment`, `SubworkflowReference`), update `WorkflowState`, `WorkflowDefinition`, `ActiveWorkflow`. Add type guard functions. Export `PhaseEntry` union type.

**Details:**

1. **Add `PathSegment` interface** (after `PhaseToolConfig`, before `PhaseDefinition`):
```ts
export interface PathSegment {
  workflowKey: string;
  phaseIndex: number;
}
```

2. **Add `SubworkflowReference` interface** (after `PhaseDefinition`):
```ts
export interface SubworkflowReference {
  /** Discriminator: always true for subworkflow references */
  subworkflow: true;
  /** The workflow key being referenced (directory name) */
  workflowKey: string;
  /** Resolved workflow definition (populated at load time) */
  resolved: WorkflowDefinition;
}
```

3. **Add `PhaseEntry` type alias** (after `SubworkflowReference`):
```ts
export type PhaseEntry = PhaseDefinition | SubworkflowReference;
```

4. **Add type guard functions** (after `PhaseEntry`):
```ts
export function isSubworkflowRef(entry: PhaseEntry): entry is SubworkflowReference {
  return 'subworkflow' in entry && entry.subworkflow === true;
}

export function isPhaseDefinition(entry: PhaseEntry): entry is PhaseDefinition {
  return !('subworkflow' in entry);
}
```

5. **Update `WorkflowDefinition`**:
   - Change `phases: PhaseDefinition[]` → `phases: PhaseEntry[]`
   - Add optional field: `show?: "user" | "workflows"` (defaults to `"user"`)
   - Add optional field: `loopable?: boolean` (defaults to `true`)

6. **Update `WorkflowState`**:
   - Remove `currentPhaseIndex: number`
   - Add `currentPath: PathSegment[]` (stack, index 0 = top-level, last = innermost)
   - Add `globalStepCount: number` (monotonically increasing, incremented on every phase change)

7. **Update `ActiveWorkflow`**:
   - `currentPhase: PhaseDefinition` stays (but is always resolved to the innermost leaf)
   - Add `currentPhaseEntry: PhaseEntry` (the raw entry at the top of stack, might be SubworkflowReference)
   - Change `nextPhase: PhaseDefinition | null` → `nextPhase: PhaseEntry | null`
   - Add `breadcrumb: Array<{ name: string; phaseName: string; emoji: string }>` for status/UI

**Dependencies:** None (first step)

**Test coverage:** Unit tests for `isSubworkflowRef` and `isPhaseDefinition` type guards with both PhaseDefinition and SubworkflowReference objects.

---

### Step 2: Create vitest infrastructure

**File:** `vitest.config.ts`, `package.json`

**What:** Add vitest as dev dependency, create config.

**Details:**
1. Run `npm install -D vitest` in the project directory.
2. Create `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```
3. Add `"test": "vitest run"` to `scripts` in `package.json`.

**Dependencies:** None

**Test coverage:** Run `npx vitest run` to confirm 0 tests pass (infrastructure works).

---

## Phase 2: Config Changes

### Step 3: Update `loadWorkflowFromDir` for show, loopable, relative paths, and `{ subworkflow: key }` entries

**File:** `src/config.ts`

**What:** Update the YAML parsing to handle new fields and mixed phase array entries.

**Details:**

1. **Add imports** at top of file:
```ts
import { resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import type { SubworkflowReference } from "./types";
import { isSubworkflowRef } from "./types";
```

2. **In `loadWorkflowFromDir`**, after parsing YAML:
   - Parse `show`: if `parsed.show === "workflows"` set it, otherwise omit (defaults to `"user"`)
   - Parse `loopable`: if `typeof parsed.loopable === "boolean"` set it, otherwise omit (defaults to `true`)
   - Make `commandName` and `initialMessage` parsing conditional: only required when `show !== "workflows"` (i.e., when `show` is `"user"` or absent). If `show === "workflows"` and either is missing, skip the warning and set them to empty strings (they won't be used).
   - Change the workflow object to include the new optional fields

3. **In the phase loading loop**, handle mixed entries:
   - If `typeof phaseFile === "string"`: existing behavior, but add **path safety check**:
     - Compute `canonicalRoot = realpathSync(resolve(workflowRoot))` where `workflowRoot` is the `.pi/workflows/` directory (pass it as a new parameter `workflowsRoot: string` to `loadWorkflowFromDir`)
     - Compute `canonicalPhase = realpathSync(resolve(dirPath, phaseFile))`
     - If `!canonicalPhase.startsWith(canonicalRoot + sep)`, warn and return null
     - Otherwise, load the file as before
   - If `typeof phaseFile === "object" && phaseFile !== null && typeof phaseFile.subworkflow === "string"`: create a placeholder `SubworkflowReference` with `subworkflow: true`, `workflowKey: phaseFile.subworkflow`, `resolved: null as any`. This will be resolved in the two-pass loading (Step 5).
   - If neither: warn about invalid phase entry and return null.

4. **Update `loadWorkflowFromDir` signature** to accept `workflowsRoot: string` as a second parameter.

5. **Update `loadWorkflowsFromDir`** to compute and pass `workflowsRoot`:
   - `workflowsRoot` is the `parentDir` parameter
   - Pass it to each `loadWorkflowFromDir(join(parentDir, entry.name), parentDir)`

6. **Update `loadWorkflows`** — after the merge but before validation:
   - This becomes the two-pass loading entry point (see Step 5)

**Dependencies:** Step 1 (new types)

**Test coverage:** Tests for path safety (valid relative path, path escaping above root), show/loopable parsing, mixed phase array (string vs object), conditional commandName/initialMessage requirements.

---

### Step 4: Implement cycle detection

**File:** `src/config.ts`

**What:** Add a `detectCycles` function that validates the subworkflow reference graph is a DAG.

**Details:**

Add a new exported function:

```ts
export function detectCycles(
  definitions: Record<string, WorkflowDefinition>
): string[] {
```

Returns array of error messages (empty = no cycles).

**Algorithm:** Iterative DFS with three-state coloring (white=0, gray=1, black=2):
1. For each workflow key, if white, start DFS
2. Push `{key, iterator: phaseIndex=0}` to stack
3. While stack not empty:
   - Peek top. If gray, check each phase entry of that key's definition:
     - For each `isSubworkflowRef(phase)`: if the target `phase.workflowKey` is gray → cycle found. Build cycle path string by tracing parent map back. If white → push it. Continue iterating.
   - If all phases iterated → mark black, pop
   - On first entry to a node → mark gray
4. Maintain a `parent` map: `Map<string, string>` mapping each discovered key to the key that discovered it
5. When cycle found: trace parent map from current → ... → back to current, join with " → ", return as error string

Error format: `"Cycle detected: rpir → implementation → rpir. Skipping workflow \"rpir\"."`

Note: Also detect self-references (a workflow that references itself as a subworkflow).

**Dependencies:** Step 1 (types, type guards)

**Test coverage:**
- No cycles (returns empty array)
- Direct self-reference (A → A)
- Two-node cycle (A → B → A)
- Three-node cycle (A → B → C → A)
- DAG with multiple paths to same node (not a cycle)

---

### Step 5: Implement two-pass loading and subworkflow resolution

**File:** `src/config.ts`

**What:** Restructure `loadWorkflows` to: (1) load all workflows, (2) validate, (3) detect cycles, (4) resolve subworkflow references, (5) filter out cycles.

**Details:**

Restructure `loadWorkflows` function:

```
Pass 1: Load all workflow definitions (existing logic)
  - Load global and project dirs → merge into `raw`
  
Pass 2: Validate each definition (update validateWorkflowDefinition for new fields)
  - Skip invalid ones with warnings

Pass 3: Detect cycles (call detectCycles)
  - Remove any workflow involved in a cycle from the definitions map
  - Console.warn each cycle

Pass 4: Resolve subworkflow references
  - For each definition, for each phase entry:
    - If it's a subworkflow placeholder (has workflowKey but resolved is null):
      - Look up `definitions[entry.workflowKey]`
      - If found: set `entry.resolved = definitions[entry.workflowKey]`
      - If not found: warn and mark the parent workflow as invalid (remove it)

Pass 5: Second cycle detection after resolution (safety check)

Return valid definitions
```

Also update `loadWorkflowFromDir` to store unresolved `SubworkflowReference` placeholders (with `resolved` set to `null as any` temporarily — will be typed properly using a separate `UnresolvedSubworkflowReference` intermediate type or by casting in the resolution pass).

**Important:** The resolution step must handle deep nesting — when resolving a subworkflow reference, its `resolved` definition's phases may also contain subworkflow references that need resolution. Since all definitions are loaded in Pass 1, the lookup in Pass 4 handles this naturally.

**Dependencies:** Steps 3, 4

**Test coverage:**
- Full loading pipeline with subworkflow references
- Missing subworkflow target (should warn and skip parent)
- Cycle detection in full pipeline
- Deep nesting (A refs B, B refs C, all resolve correctly)

---

### Step 6: Update `validateWorkflowDefinition` for conditional validation

**File:** `src/config.ts`

**What:** Make `commandName` and `initialMessage` validation conditional based on `show` field.

**Details:**

At the top of `validateWorkflowDefinition`:
1. Extract `show` from `def.show ?? "user"`
2. Extract `loopable` from `def.loopable ?? true` (just validate type if present)
3. If `show === "user"`:
   - Validate `commandName` as before (required, matches regex)
   - Validate `initialMessage` as before (required, non-empty)
4. If `show === "workflows"`:
   - Skip `commandName` and `initialMessage` validation (they can be absent/empty)
5. For the phases loop, update to handle `PhaseEntry` union:
   - If `isSubworkflowRef(phase)`: validate that `phase.workflowKey` is a non-empty string. Skip id/name/emoji/instructions validation (those are on the resolved definition).
   - If `isPhaseDefinition(phase)`: existing validation
6. Validate `loopable` if present: must be boolean

**Dependencies:** Step 1

**Test coverage:**
- `show: "user"` with missing commandName → error
- `show: "workflows"` with missing commandName → no error
- `show: "user"` with missing initialMessage → error
- `show: "workflows"` with missing initialMessage → no error
- SubworkflowRef entry in phases (valid and invalid workflowKey)
- `loopable: false` (valid)
- `loopable: "not-a-bool"` → error

---

## Phase 3: State Changes

### Step 7: Rewrite `createInitialState` for path stack

**File:** `src/state.ts`

**What:** Replace `currentPhaseIndex: 0` with `currentPath` and `globalStepCount`.

**Details:**

Update `createInitialState`:
```ts
return {
  active: true,
  workflowKey,
  currentPath: [{ workflowKey, phaseIndex: 0 }],
  globalStepCount: 0,
  taskId: `${TASK_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  taskDescription: description,
  startedAt: Date.now(),
  completionNotified: false,
  cancelled: false,
};
```

**Dependencies:** Step 1

**Test coverage:** Test that new state has `currentPath` with one element, `globalStepCount` is 0.

---

### Step 8: Rewrite `advancePhase` for stack-based navigation

**File:** `src/state.ts`

**What:** Rewrite `advancePhase` to handle the 3 cases from the spec: advance within scope, breakout, enter subworkflow.

**Details:**

New signature and logic:
```ts
export function advancePhase(
  state: WorkflowState,
  definitions: Record<string, WorkflowDefinition>,
): { advanced: boolean; from: string; to: string | null } {
```

Note: now takes `definitions` parameter (was just `definition`).

Algorithm:
1. Deep-clone `state.currentPath` via spread+map: `[...state.currentPath.map(s => ({ ...s }))]`
2. Get `top = currentPath[currentPath.length - 1]`
3. Get `topDef = definitions[top.workflowKey]`
4. Get `currentEntry = topDef.phases[top.phaseIndex]`
5. **Case A: currentEntry is a SubworkflowReference** (entering subworkflow):
   - Push `{ workflowKey: currentEntry.workflowKey, phaseIndex: 0 }` onto `currentPath`
   - `state.currentPath = currentPath`
   - `state.globalStepCount += 1`
   - Return `{ advanced: true, from: /* current phase name or subworkflow name */, to: /* first phase name of subworkflow */ }`
6. **Case B: currentEntry is a normal PhaseDefinition AND it's NOT the last phase in topDef**:
   - Increment `top.phaseIndex += 1`
   - `state.globalStepCount += 1`
   - Return `{ advanced: true, from: /* current phase name */, to: /* next phase name */ }`
7. **Case C: currentEntry is a normal PhaseDefinition AND it IS the last phase in topDef**:
   - If `currentPath.length === 1` (top-level): set `state.active = false`, `state.completionNotified = false`, `state.globalStepCount += 1`, return `{ advanced: true, from: ..., to: null }`
   - If `currentPath.length > 1` (inside subworkflow, "breakout"): pop top element, increment new top's `phaseIndex += 1`, `state.globalStepCount += 1`, return `{ advanced: true, from: ..., to: ... }`

**Dependencies:** Step 1, Step 7

**Test coverage:**
- Linear workflow: advance through all phases, final advance sets active=false
- Enter subworkflow: push new segment, globalStepCount increments
- Breakout from subworkflow: pop segment, advance parent, globalStepCount increments
- Multi-level nesting: enter sub > enter sub-sub > advance > breakout > breakout
- Edge: advance on last phase of top-level → DONE

---

### Step 9: Add `loopPhase` function

**File:** `src/state.ts`

**What:** New exported function for the loop action.

**Details:**

```ts
export function loopPhase(
  state: WorkflowState,
  definitions: Record<string, WorkflowDefinition>,
): { looped: boolean; to: string } | { error: string } {
```

Algorithm:
1. Get `top = state.currentPath[state.currentPath.length - 1]`
2. Get `topDef = definitions[top.workflowKey]`
3. Check `loopable`: if `topDef.loopable === false`, return `{ error: "Looping is disabled for this workflow." }`
4. Reset `top.phaseIndex = 0`
5. `state.globalStepCount += 1`
6. Get first phase name of `topDef` for the return value
7. Return `{ looped: true, to: firstPhaseName }`

**Dependencies:** Step 1

**Test coverage:**
- Loop resets to phase 0, increments globalStepCount
- Loop on `loopable: false` returns error
- Loop inside subworkflow only affects innermost scope
- Loop at top-level only affects top-level

---

### Step 10: Rewrite `resolveActive` for path stack + breadcrumb

**File:** `src/state.ts`

**What:** Rewrite to resolve the innermost active phase from the path stack and build breadcrumb.

**Details:**

New signature:
```ts
export function resolveActive(
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
): ActiveWorkflow | null {
```

Algorithm:
1. If `!state || !state.active` return null
2. Deep-clone `state.currentPath` for safety
3. Walk the stack from bottom to top. For each segment, look up `definitions[segment.workflowKey]`. If not found, warn and return null.
4. Get the `top = state.currentPath[state.currentPath.length - 1]`
5. Get `topDef = definitions[top.workflowKey]`
6. Get `currentEntry = topDef.phases[top.phaseIndex]`
7. **If currentEntry is SubworkflowReference:** This shouldn't normally happen (entering should push immediately), but handle gracefully: look up the resolved definition and use its first phase.
8. **If currentEntry is PhaseDefinition:** This is the current active phase.
9. Compute `nextPhase`: `topDef.phases[top.phaseIndex + 1] ?? null`
10. Build `breadcrumb`: For each segment in `currentPath` except the last, add `{ name: definitions[seg.workflowKey].name, phaseName: "...", emoji: "..." }`. For the last segment, use the actual current phase name/emoji.
11. Return `{ definition: definitions[state.currentPath[0].workflowKey], state, currentPhase, currentPhaseEntry: currentEntry, nextPhase, breadcrumb }`

Note: `definition` in ActiveWorkflow becomes the **top-level** workflow definition (for backward compat of completion messages etc.), while breadcrumb provides the full path.

**Dependencies:** Step 1, Step 8

**Test coverage:**
- Linear workflow resolves correctly (single-element path)
- Nested workflow resolves to innermost phase
- Missing definition returns null with warning
- Out-of-bounds phase index returns null with warning
- Breadcrumb built correctly for 1, 2, and 3-level nesting

---

### Step 11: Add state migration in `reconstructState`

**File:** `src/state.ts`

**What:** Detect old state entries with `currentPhaseIndex` and migrate to `currentPath`.

**Details:**

In `reconstructState`, after finding the matching entry's data:

```ts
// Migration: old state has currentPhaseIndex, new state has currentPath
if (data.currentPhaseIndex !== undefined && !data.currentPath) {
  data.currentPath = [{ workflowKey: data.workflowKey, phaseIndex: data.currentPhaseIndex }];
  delete data.currentPhaseIndex;
}
if (data.currentPath && data.globalStepCount === undefined) {
  data.globalStepCount = data.currentPath[0]?.phaseIndex ?? 0;
}
```

This must happen before casting `data as WorkflowState`.

**Dependencies:** Step 1

**Test coverage:**
- Old state with `currentPhaseIndex: 2` → migrated to `currentPath: [{ workflowKey: "rpir", phaseIndex: 2 }], globalStepCount: 2`
- New state with `currentPath` → no migration
- Missing both fields → no migration (returns as-is)

---

## Phase 4: Tool Changes

### Step 12: Add `loop` action to `workflow_step` tool and update `next` action

**File:** `src/tool.ts`

**What:** Add `loop` to the action enum, rewrite `next` for stack semantics, update `status` with breadcrumb.

**Details:**

1. **Update parameter schema**: Change `StringEnum(["next", "status", "cancel"] as const, ...)` to `StringEnum(["next", "status", "cancel", "loop"] as const, ...)`. Update description to mention `loop`.

2. **Update `promptGuidelines`**: Add: `"Use workflow_step with action='loop' to restart the current workflow/subworkflow scope from its first phase."`

3. **Rewrite `status` action** (in execute):
   - Use `resolveActive` to get the active workflow
   - Build breadcrumb string from `active.breadcrumb`: join names with " > ", then append current phase name
   - For linear (single-element path): use existing format `"Phase: {emoji} {name} [{current}/{total}]"` for backward compat
   - For nested: use new format `"Path: {breadcrumb}\nStage: ({globalStepCount}) {emoji} {name}"`
   - Update `details` to include `currentPath` instead of `phaseIndex`

4. **Rewrite `next` action** (in execute):
   - Call `advancePhase(state, definitions)` (new signature)
   - If result indicates entering subworkflow, message should say `"Entering subworkflow: {subworkflowName}"`
   - If breakout, message should say `"Completed subworkflow. Advancing parent to: {nextPhaseName}"`
   - If DONE, existing message format
   - Normal advance: existing format
   - After advance, re-resolve with `resolveActive` and use `newActive.currentPhase` for instructions
   - Update all `details` objects: use `currentPath` snapshot instead of `phaseIndex`
   - Fix spread copies: use `{ ...state, currentPath: state.currentPath.map(s => ({ ...s })) }` for deep clone

5. **Add `loop` action handler** (after the cancel handler, before the fallback):
   ```ts
   if (params.action === "loop") {
     if (!isActive(state)) {
       return { content: [{ type: "text", text: "No active workflow..." }], details: { active: false } };
     }
     const result = loopPhase(state, definitions);
     if ("error" in result) {
       return { content: [{ type: "text", text: result.error }], details: { active: true } };
     }
     persistState(pi, state);
     const newActive = resolveActive(state, definitions);
     // Build response with looped-to phase info
     return {
       content: [{ type: "text", text: `🔄 Looped back to: ${newActive.currentPhase.emoji} ${newActive.currentPhase.name}\n\n**What to do:**\n${newActive.currentPhase.instructions}` }],
       details: { looped: true, to: result.to },
     };
   }
   ```

6. **Import `loopPhase`** from `./state`.

**Dependencies:** Steps 8, 9, 10

**Test coverage:** (unit test the tool handler or integration test — see Phase 7)

---

## Phase 5: Hooks + Prompts

### Step 13: Update `updateStatus` in hooks for breadcrumb format

**File:** `src/hooks.ts`

**What:** Update the status bar text for nested workflows.

**Details:**

In `updateStatus`:
1. Get `active.breadcrumb`
2. If `state.currentPath.length === 1` (linear):
   - Keep existing format: `${name} — ${phase.emoji} ${phase.name} [${current}/${total}]`
3. If `state.currentPath.length > 1` (nested):
   - Build breadcrumb: take all segments except last, join their workflow names with " > "
   - Format: `{breadcrumb} — ({state.globalStepCount}) ${phase.emoji} ${phase.name}`
   - Example: `"RPIR > Implementation — (6) 👁️ Review"`

To compute breadcrumb workflow names for path segments, look up `definitions[segment.workflowKey].name` for each non-leaf segment.

**Dependencies:** Step 10

**Test coverage:** Test status bar text for linear (unchanged format) and nested (breadcrumb format).

---

### Step 14: Update `handleBeforeAgentStart` for innermost scope injection

**File:** `src/hooks.ts`

**What:** No structural change needed — `resolveActive` now returns innermost scope, and `buildContextPrompt` handles the rest. Just ensure the call passes correctly.

**Details:** The function already calls `resolveActive` and `buildContextPrompt`. Since `resolveActive` now resolves to the innermost scope, this should work. No code change needed unless `buildContextPrompt` signature changes (it takes `ActiveWorkflow` which is updated). Verify it compiles.

**Dependencies:** Steps 10, 15

---

### Step 15: Update `buildContextPrompt` for breadcrumb and innermost scope

**File:** `src/prompts.ts`

**What:** Update the prompt builder to include breadcrumb path and use innermost scope's phase. Update `collectAllProfiles` to traverse subworkflows. Update `getPreviousPhaseName` for path-based context. Add template variables.

**Details:**

1. **Update `buildContextPrompt`**:
   - Add breadcrumb line at top: `[Workflow path: {breadcrumb names joined by " > "}]`
   - `previousPhaseName` and `nextPhaseName` should reflect the innermost scope (current path segment), not the top-level workflow
   - `progress` line: show the innermost scope's progress, e.g., `"**Progress:** {innerIndex + 1}/{innerTotal} phases in current scope (step {globalStepCount} overall)"`
   - Template variables: add `{globalStepCount}`, `{breadcrumbPath}`

2. **Update `collectAllProfiles`** to traverse into `SubworkflowReference.resolved.phases`:
   ```ts
   function collectAllProfilesRecursive(phases: PhaseEntry[]): string[] {
     const seen = new Set<string>();
     for (const phase of phases) {
       if (isSubworkflowRef(phase)) {
         for (const p of collectAllProfilesRecursive(phase.resolved.phases)) {
           seen.add(p);
         }
       } else {
         if (phase.availableProfiles) {
           for (const p of phase.availableProfiles) seen.add(p);
         }
       }
     }
     return Array.from(seen);
   }
   ```

3. **Update `getPreviousPhaseName`** to accept `definitions` and the full path:
   - Look at the innermost segment's `phaseIndex - 1` in that segment's workflow definition
   - If `phaseIndex === 0` and there's a parent scope, could show parent's current phase name, but simplest is to return `"(start)"` as before

4. **Import `isSubworkflowRef`** from `./types`.

5. **Update signature** of `buildContextPrompt` if needed — `ActiveWorkflow` type is updated, so the function should still work but may need to access new fields.

**Dependencies:** Step 1

**Test coverage:**
- `collectAllProfiles` traverses into subworkflow references
- `getPreviousPhaseName` works for innermost scope at index 0 and > 0
- `buildContextPrompt` includes breadcrumb line
- `buildContextPrompt` uses innermost scope's phase for instructions

---

### Step 16: Update `handleAgentEnd` for new state shape

**File:** `src/hooks.ts`

**What:** Update references to `state.currentPhaseIndex` and `definition.phases.length` to use the new state shape.

**Details:**

In `handleAgentEnd`:
- Case A (DONE): `phaseCount` template var should reflect the top-level workflow's phase count (total phases across all subworkflow expansions or just top-level — use top-level for backward compat)
- Case B (not done): `resolveActive` already returns innermost phase, so `currentPhase` access is correct. Verify `phaseCount` template var uses correct scope.

The function uses `resolveActive` which now handles the new state shape. The main change is ensuring `state.currentPath` is accessed instead of `state.currentPhaseIndex` (if any direct references exist — check for any `state.currentPhaseIndex` in hooks.ts — there is one on line 24 in `updateStatus`, handled in Step 13).

**Dependencies:** Steps 10, 13

---

### Step 17: Update default templates for subworkflow context

**File:** `src/prompts.ts`

**What:** Ensure `DEFAULT_ADVANCE_REMINDER` and `DEFAULT_NOT_DONE_REMINDER` mention the `loop` action when appropriate.

**Details:**

Update `DEFAULT_ADVANCE_REMINDER`:
```ts
const DEFAULT_ADVANCE_REMINDER =
  "When you finish this phase, call the workflow_step tool with action='next' to advance to the next phase. " +
  "If you need to restart the current scope, use action='loop'.";
```

This is a simple string change, no logic.

**Dependencies:** None

---

## Phase 6: Command Changes

### Step 18: Filter by `show: "user"` in command completions and listing

**File:** `src/command.ts`

**What:** Update `getArgumentCompletions` and the no-args listing to only show `show: "user"` workflows.

**Details:**

1. **In `getArgumentCompletions`**: After loading workflows, filter:
   ```ts
   const names = Object.values(workflows)
     .filter(w => (w.show ?? "user") === "user")
     .map(w => w.commandName);
   ```
   Note: `show` might be undefined for backward compat, so use `w.show ?? "user"`.

2. **In the no-args handler** (the `if (!parts)` block): Filter the listing similarly:
   ```ts
   const entries = Object.entries(workflows)
     .filter(([_, def]) => (def.show ?? "user") === "user")
     .map(([key, def]) => ` ${def.commandName} — ${def.name}`);
   ```

3. **Handle subworkflow references in first-phase template vars**: When building the initial message, `definition.phases[0]` might be a `SubworkflowReference`. If it is, resolve to its first phase:
   ```ts
   let firstPhase = definition.phases[0];
   let currentEntry = firstPhase;
   while (isSubworkflowRef(currentEntry)) {
     currentEntry = currentEntry.resolved.phases[0];
   }
   // Use currentEntry (which is PhaseDefinition) for firstPhaseId, firstPhaseName, etc.
   ```
   Import `isSubworkflowRef` from `./types`.

4. **Import**: Add `isSubworkflowRef` and `PhaseDefinition` to imports from `./types`.

**Dependencies:** Step 1, Step 5

**Test coverage:**
- `show: "workflows"` workflows not in completions
- `show: "user"` (or absent) workflows in completions
- First-phase template vars resolve through subworkflow references to leaf phase

---

## Phase 7: Test Infrastructure + Comprehensive Tests

### Step 19: Write tests for `config.ts` functions

**File:** `src/__tests__/config.test.ts`

**What:** Comprehensive tests for all config functions.

**Details:**

Tests to write:

1. **`resolveTemplate`**: Already testable — test variable substitution, unknown vars left as-is.

2. **`validateWorkflowDefinition`**:
   - Valid `show: "user"` workflow with all required fields → null
   - `show: "user"` missing commandName → error string
   - `show: "workflows"` missing commandName → null (no error)
   - `show: "workflows"` missing initialMessage → null
   - `loopable: false` → null (valid)
   - SubworkflowRef entry with valid workflowKey → null
   - SubworkflowRef entry with empty workflowKey → error
   - Duplicate phase IDs → error

3. **`detectCycles`**:
   - No subworkflow refs → empty array
   - A → B (no cycle) → empty array
   - A → A (self-ref) → error array
   - A → B → A → error array
   - A → B → C → A → error array
   - A → B, A → C, B → D (DAG) → empty array

4. **`findWorkflowByCommandName`**: Existing behavior, straightforward.

5. **Path safety**: (unit test a path safety check helper function — extract it if needed)
   - Path within root → allowed
   - Path escaping root via `../` → rejected

**Dependencies:** Steps 3, 4, 5, 6

---

### Step 20: Write tests for `state.ts` functions

**File:** `src/__tests__/state.test.ts`

**What:** Comprehensive tests for state management.

**Details:**

Create test fixture definitions:
```ts
// Simple linear workflow
const linearDef: WorkflowDefinition = { name: "Linear", commandName: "lin", show: "user", initialMessage: "...", phases: [phase1, phase2, phase3] };

// Workflow with subworkflow reference
const subDef: WorkflowDefinition = { name: "Sub", show: "workflows", phases: [subPhase1, subPhase2] };
const parentDef: WorkflowDefinition = { name: "Parent", commandName: "par", show: "user", initialMessage: "...", phases: [parentPhase1, { subworkflow: true, workflowKey: "sub", resolved: subDef }] };
```

Tests:

1. **`createInitialState`**: Has `currentPath` with one element, `globalStepCount` is 0, no `currentPhaseIndex`.

2. **`advancePhase` — linear**: Start at index 0, advance → index 1, advance → index 2, advance → active=false (DONE).

3. **`advancePhase` — enter subworkflow**: At subworkflow ref phase, advance → pushes new segment, path length becomes 2.

4. **`advancePhase` — breakout**: Last phase of subworkflow, advance → pops segment, advances parent.

5. **`advancePhase` — breakout from last phase of top-level → DONE**.

6. **`loopPhase`**: Reset to phase 0, globalStepCount increments.

7. **`loopPhase` — loopable: false**: Returns error.

8. **`loopPhase` — innermost scope only**: In nested workflow, loop only resets inner segment.

9. **`resolveActive`**: Linear, nested, missing definition, out-of-bounds.

10. **`resolveActive` — breadcrumb**: Verify breadcrumb array is correct for 2-level and 3-level nesting.

11. **`reconstructState` — migration**: Old state with `currentPhaseIndex` → migrated to `currentPath`.

**Dependencies:** Steps 7, 8, 9, 10, 11

---

### Step 21: Write tests for `prompts.ts` functions

**File:** `src/__tests__/prompts.test.ts`

**What:** Tests for prompt building and helper functions.

**Details:**

1. **`buildContextPrompt`**:
   - Linear workflow: includes phase name, instructions, progress
   - Nested workflow: includes breadcrumb line `[Workflow path: Parent > Sub]`
   - All template variables resolved

2. **`collectAllProfiles`** (via prompt output or export it for testing):
   - Profiles from subworkflow phases are included
   - Deduplication works

3. **`getPreviousPhaseName`**:
   - Index 0 → "(start)"
   - Index > 0 → previous phase name

**Dependencies:** Step 15

---

### Step 22: Run all tests and verify

**File:** All test files

**What:** Run `npx vitest run` and verify all tests pass. Run `npx tsc --noEmit` (if tsconfig exists) to verify type checking.

**Details:**
- All tests must pass
- No TypeScript compilation errors
- All existing runtime behavior preserved for linear workflows

**Dependencies:** All previous steps

---

## Summary of Changes by File

| File | # of Steps | Nature of Changes |
|------|-----------|-------------------|
| `src/types.ts` | Step 1 | New interfaces, type guard functions, updated existing interfaces |
| `src/config.ts` | Steps 3, 4, 5, 6 | New parsing, cycle detection, two-pass loading, conditional validation |
| `src/state.ts` | Steps 7, 8, 9, 10, 11 | New state shape, stack-based advance/loop/resolve, migration |
| `src/tool.ts` | Step 12 | Loop action, next rewrite, status breadcrumb |
| `src/hooks.ts` | Steps 13, 14, 16 | Status bar breadcrumb, verify context injection |
| `src/prompts.ts` | Steps 15, 17 | Breadcrumb in context, profile traversal, loop in reminder |
| `src/command.ts` | Step 18 | show:user filtering, first-phase resolution through sub refs |
| `src/__tests__/*.test.ts` | Steps 19, 20, 21 | Comprehensive test coverage |
| `vitest.config.ts` | Step 2 | Test infrastructure |

## Dependency Graph

```
Step 1 (types) ─────────────────────────┬────► Steps 3,4,6,7,9,15,18
Step 2 (vitest) ───────────────────────► independent
Step 3 (config parsing) ──────────────► Step 5
Step 4 (cycle detection) ─────────────► Step 5
Step 5 (two-pass loading) ────────────► Step 18
Step 6 (conditional validation) ──────► Step 19
Step 7 (createInitialState) ──────────► Step 8
Step 8 (advancePhase) ────────────────► Step 12
Step 9 (loopPhase) ───────────────────► Step 12
Step 10 (resolveActive) ──────────────► Steps 12, 13, 14, 16
Step 11 (migration) ──────────────────► Step 20
Steps 12-18 (integration) ────────────► Steps 19-21
Steps 19-21 (tests) ──────────────────► Step 22
```
