# Configuration Reference

Complete reference for every field in `workflow.yaml` and phase `.md` files used by pi-workflows.

---

## Overview

pi-workflows uses a **two-tier file-based discovery model** for loading workflow definitions:

| Tier        | Location                                                        | Notes                                                    |
| ----------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| **Global**  | `~/.pi/agent/workflows/` (or `$PI_CODING_AGENT_DIR/workflows/`) | Shared across all projects.                              |
| **Project** | `.pi/workflows/` (relative to project root / `cwd`)             | Overrides global workflows with the same directory name. |

Each workflow lives in its own **directory**. The directory name becomes the workflow key. A `workflow.yaml` file serves as the entry point, and individual phase `.md` files define each phase's instructions and metadata.

```
workflows/
  ├── my-workflow/              # key = "my-workflow"
  │   ├── workflow.yaml         # entry point
  │   ├── research.md           # phase file
  │   ├── planning.md           # phase file
  │   └── implementing.md       # phase file
  └── code-review/              # key = "code-review"
      ├── workflow.yaml
      └── ...
```

When both tiers define a workflow with the same directory name, the **project** version wins. Project definitions are merged over global ones with a simple object spread.

---

## Directory Structure

A complete example showing both tiers and various configuration options:

```
~/.pi/agent/workflows/              # Global workflows root
├── rpir/
│   ├── workflow.yaml
│   ├── research.md
│   ├── planning.md
│   ├── implementing.md
│   └── reviewing.md
└── shared-utilities/               # Internal workflow (show: workflows)
    ├── workflow.yaml
    └── refactor.md

my-project/.pi/workflows/           # Project workflows root
├── rpir/                           # Overrides global "rpir"
│   ├── workflow.yaml
│   ├── research.md
│   ├── custom-phase.md
│   └── deploy.md
└── bugfix/                         # Project-only workflow
    ├── workflow.yaml
    ├── reproduce.md
    ├── fix.md
    └── verify.md
```

### `workflow.yaml` Entry Point

The YAML file at the root of each workflow directory defines the workflow metadata and lists its phases (as filenames) or subworkflow references.

### Phase `.md` Files

Each phase is a Markdown file with **YAML frontmatter** for metadata and a **Markdown body** for the agent instructions. The filename is referenced from `workflow.yaml`'s `phases` array.

---

## `workflow.yaml` Field Reference

| Field                  | Type                    | Required                | Default              | Description                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------- | ----------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                 | `string`                | **Yes**                 | —                    | Human-readable workflow name displayed in the status bar, messages, and the `/workflow` listing. Must be a non-empty string.                                                                                                                     |
| `commandName`          | `string`                | Yes (if `show: "user"`) | `""`                 | Slash-command identifier used as `/workflow {commandName} {description}`. Must match `^[a-zA-Z0-9_-]+$`. Ignored for internal workflows (`show: "workflows"`).                                                                                   |
| `initialMessage`       | `string`                | Yes (if `show: "user"`) | `""`                 | Template string sent to the agent when the workflow starts. Supports template variables: `{workflowName}`, `{description}`, `{workflowKey}`, `{firstPhaseId}`, `{firstPhaseName}`, `{firstPhaseEmoji}`, `{firstPhaseProfiles}`.                  |
| `phases`               | `array`                 | **Yes**                 | —                    | Ordered list of phase entries. Each entry is either a **string** (filename of a `.md` phase file) or an **object** with `{ subworkflow: "workflow-key" }`. Must contain at least 1 entry.                                                        |
| `show`                 | `"user" \| "workflows"` | No                      | `"user"`             | Controls visibility. `"user"` = listed in `/workflow` command. `"workflows"` = hidden from direct invocation; only usable as a subworkflow phase in another workflow.                                                                            |
| `loopable`             | `boolean`               | No                      | `true`               | Whether the workflow can be restarted from phase 0 via the `loop` action on `workflow_step`. When `false`, the loop action returns an error.                                                                                                     |
| `sessionNamePrefix`    | `string`                | No                      | `"Workflow: "`       | Prefix prepended to the task description when setting the session name.                                                                                                                                                                          |
| `sessionNameMaxLength` | `number`                | No                      | `50`                 | Maximum character count for the session name (after the prefix). The description is truncated to this length with a trailing `…` if it exceeds it.                                                                                               |
| `roleInstruction`      | `string`                | No                      | _(built-in default)_ | Template prepended to every context injection. All [Phase Instructions variables](template-variables.md#phase-instructions) are available. If omitted, a default instructing the agent to act as orchestrator and delegate to subagents is used. |
| `advanceReminder`      | `string`                | No                      | _(built-in default)_ | Template appended at the end of every context injection reminding the agent to advance. All [Phase Instructions variables](template-variables.md#phase-instructions) are available.                                                              |
| `blockReasonTemplate`  | `string`                | No                      | _(built-in default)_ | Template for the reason shown when a tool call is blocked. Variables: `{workflowName}`, `{phaseName}`, `{toolName}`, `{allowedTools}`.                                                                                                           |
| `completionMessage`    | `string`                | No                      | _(built-in default)_ | Template sent when the workflow reaches the DONE state. Variables: `{workflowName}`, `{taskDescription}`, `{taskId}`, `{phaseCount}`.                                                                                                            |
| `notDoneReminder`      | `string`                | No                      | _(built-in default)_ | Template injected when the agent tries to finish but the workflow is still active. Variables: `{workflowName}`, `{phaseName}`, `{phaseEmoji}`, `{phaseInstructions}`, `{taskDescription}`, `{taskId}`, `{workflowKey}`.                          |

### Example `workflow.yaml`

```yaml
name: "RPIR Development Workflow"
commandName: "rpir"
initialMessage: |
  Start the {workflowName} for: "{description}"

  Begin with Phase 1 ({firstPhaseName}).
sessionNamePrefix: "RPIR: "
sessionNameMaxLength: 60
loopable: false
roleInstruction: "You are the orchestrator for {workflowName}. Delegate all work to subagents."
advanceReminder: "When done with {phaseName}, call {toolName} to advance to {nextPhaseName}."
completionMessage: "✅ {workflowName} complete! Task: {taskDescription} (ID: {taskId}, {phaseCount} phases)"
phases:
  - research.md
  - planning.md
  - implementing.md
  - reviewing.md
```

### Subworkflow Reference in `phases`

Instead of a filename string, a phase entry can be an object referencing another workflow:

```yaml
phases:
  - research.md
  - subworkflow: shared-utilities # delegates to the "shared-utilities" workflow
  - final-review.md
```

See [docs/subworkflows.md](subworkflows.md) for full subworkflow mechanics including cycle detection, resolution, and stack-based navigation.

---

## Phase `.md` File Reference

Each phase file is a Markdown document with YAML frontmatter:

```markdown
---
id: research
name: Research
emoji: "🔍"
tools:
  blacklist:
    - edit
    - write
availableProfiles:
  - vertical-researcher
  - horizontal-researcher
---

## Research Phase Instructions

Spawn parallel research subagents using `delegate_to_subagents` with the
vertical-researcher and horizontal-researcher profiles.

Focus on understanding the codebase and gathering all information needed
for the planning phase.
```

### Frontmatter Fields

| Field               | Type       | Required | Default | Description                                                                                                                        |
| ------------------- | ---------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `id`                | `string`   | **Yes**  | —       | Machine-readable phase identifier. Must be **unique within the workflow** (duplicate IDs are a validation error).                  |
| `name`              | `string`   | **Yes**  | —       | Human-readable phase name shown in the status bar and context injection.                                                           |
| `emoji`             | `string`   | **Yes**  | —       | Emoji string displayed in the status bar, messages, and breadcrumb. Must be a non-empty string.                                    |
| `tools`             | `object`   | No       | —       | Tool restriction configuration. See [Tool Configuration Details](#tool-configuration-details).                                     |
| `tools.blacklist`   | `string[]` | No       | —       | List of tool names to **block** during this phase. Mutually exclusive with `whitelist`.                                            |
| `tools.whitelist`   | `string[]` | No       | —       | List of tool names to **allow** during this phase. All other tools are blocked. Mutually exclusive with `blacklist`.               |
| `availableProfiles` | `string[]` | No       | —       | Subagent profiles listed in the context injection as available for this phase. Informational only — not enforced by the extension. |

### Markdown Body

Everything after the YAML frontmatter delimiter (`---`) is treated as the **phase instructions**. This string is injected into the agent's context on every turn and supports the full set of template variables. Leading/trailing whitespace is trimmed.

See [docs/template-variables.md](template-variables.md) for the complete list of template variables available in phase instructions.

---

## Tool Configuration Details

Each phase can optionally restrict which tools the agent may use. Tool control is configured via the `tools` frontmatter field with either a **blacklist** or a **whitelist** — never both.

### Blacklist Mode

```yaml
tools:
  blacklist:
    - edit
    - write
```

**Semantics:** The listed tools are **blocked**. All other tools (including any not explicitly named) are **allowed**.

Use when a phase should have broad tool access except for a few specific dangerous tools.

### Whitelist Mode

```yaml
tools:
  whitelist:
    - read
    - search
    - delegate_to_subagents
```

**Semantics:** **Only** the listed tools are **allowed**. Every other tool is blocked.

Use when a phase should have minimal, tightly scoped tool access.

### Mutual Exclusivity

Setting both `blacklist` and `whitelist` on the same phase is a **validation error**. The workflow will be skipped during loading with a warning:

```
Workflow "my-workflow", phase "planning": cannot set both blacklist and whitelist.
```

### `workflow_step` Is Always Exempt

The `workflow_step` tool (used to advance, check status, loop, or cancel) is **always allowed** regardless of blacklist or whitelist configuration. It cannot be blocked.

### No `tools` Field

If a phase has no `tools` frontmatter field, **all tools are allowed** — no restrictions are applied.

### Block Reason Message

When a tool call is blocked, the agent receives a reason message. The default is:

```
[workflow] The tool "{toolName}" is blocked during the {phaseName} phase.
Refer to the current phase instructions for allowed tools and approaches.
When finished, call workflow_step to advance to the next phase.
```

Override this by setting `blockReasonTemplate` in `workflow.yaml`. Available variables: `{workflowName}`, `{phaseName}`, `{toolName}`, `{allowedTools}`.

---

## Validation Rules

All validation is performed by `validateWorkflowDefinition()`. Workflows that fail validation are **skipped** (not loaded) with a console warning.

### Workflow-Level Validation

| Rule                      | Applies To     | Error Condition                                  |
| ------------------------- | -------------- | ------------------------------------------------ |
| `name` required           | All            | Missing, empty, or not a string                  |
| `commandName` required    | `show: "user"` | Missing, empty, or not a string                  |
| `commandName` format      | `show: "user"` | Does not match `^[a-zA-Z0-9_-]+$`                |
| `initialMessage` required | `show: "user"` | Missing, empty, or not a string                  |
| `phases` required         | All            | Missing, not an array, or has fewer than 1 entry |
| `loopable` type           | All            | Present but not a boolean                        |
| `show` value              | All            | Present but not `"user"` or `"workflows"`        |

For `show: "workflows"` workflows, `commandName` and `initialMessage` are **not required**. They may be omitted or empty.

### Phase-Level Validation (Concrete Phases)

| Rule                                   | Error Condition                                   |
| -------------------------------------- | ------------------------------------------------- |
| `id` required                          | Missing, empty, or not a string                   |
| `id` unique                            | Duplicate `id` within the same workflow           |
| `name` required                        | Missing, empty, or not a string                   |
| `emoji` required                       | Missing, empty, or not a string                   |
| `instructions` required                | Missing, empty, or not a string (from `.md` body) |
| `tools.blacklist` type                 | Present but not an array                          |
| `tools.whitelist` type                 | Present but not an array                          |
| blacklist/whitelist mutual exclusivity | Both set on the same phase                        |

### Subworkflow Reference Validation

| Rule                   | Error Condition                 |
| ---------------------- | ------------------------------- |
| `workflowKey` required | Missing, empty, or not a string |

Subworkflow references skip `id`/`name`/`emoji`/`instructions` validation — those fields live on the resolved target workflow.

### Cycle Detection

After validation, the loaded definitions undergo **cycle detection** using iterative DFS with 3-state coloring (WHITE/GRAY/BLACK). If a cycle is found:

1. A warning is logged: `Cycle detected: A → B → C → A. Skipping workflow "A".`
2. **All workflows involved in the cycle** are removed from the loaded set.

### Broken Subworkflow References

During resolution, if a workflow references a `workflowKey` that doesn't exist in the valid definitions:

1. A warning is logged: `Workflow "X" references non-existent subworkflow "Y". Skipping.`
2. The referencing workflow is removed.
3. This cascades — any other workflows referencing the removed workflow are also removed. The process repeats until no more deletions occur.

---

## Path Safety

Phase file paths listed in `workflow.yaml`'s `phases` array are subject to **path traversal protection**:

1. The **canonical root** is computed via `realpathSync` on the resolved workflows root directory (either global or project).
2. Each phase file path is **canonicalized** via `realpathSync` on the resolved absolute path of `join(dirPath, phaseEntry)`.
3. The canonical phase path must start with `canonicalRoot + sep` (the root path plus the OS path separator).
4. If the file doesn't exist on disk yet, a deterministic prefix check (`resolve` without `realpathSync`) is performed instead.

**Effect:** Symlinks or relative segments like `../../etc/passwd` are resolved to their real path and rejected if they escape the workflows root. The workflow is skipped with a warning:

```
[pi-workflows] Phase file path escapes workflows root: ../../etc/passwd in /path/to/workflow.yaml
```

---

## Duplicate `commandName` Handling

After all validation, cycle removal, and broken-reference cascading, the loader checks for **duplicate `commandName` values** across the surviving workflow definitions:

1. A `Map<string, string>` tracks the first `commandName → workflowKey` mapping.
2. If a second workflow claims the same `commandName`, a warning is logged:

```
[pi-workflows] Duplicate commandName "rpir" in workflows "old-rpir" and "new-rpir". The first one found will be used.
```

3. **The first workflow encountered wins.** Since project definitions are spread over global ones (`{ ...globalDefs, ...projectDefs }`), project definitions are iterated last — the iteration order of `Object.entries` determines which "first" means. In practice, if a global and project workflow share a `commandName`, the project one overrides the global one's _definition_ (due to the spread), but the duplicate detection logs a warning and the first-encountered one wins.

4. Workflows with `show: "workflows"` that have no `commandName` are skipped during this check.

---

## Template Variables

All `workflow.yaml` template fields and phase instruction bodies support `{varName}` placeholder substitution. Unknown variables are left as-is (e.g., `{unknown}` stays `{unknown}`).

See [docs/template-variables.md](template-variables.md) for the complete variable reference organized by context.

---

## Complete Example

### `workflow.yaml`

```yaml
name: "Bug Fix Workflow"
commandName: "bugfix"
initialMessage: |
  Starting {workflowName} for: "{description}"
  Phase 1: {firstPhaseName} {firstPhaseEmoji}
  Available profiles: {firstPhaseProfiles}
sessionNamePrefix: "Bugfix: "
sessionNameMaxLength: 40
loopable: false
show: "user"
roleInstruction: "You are the orchestrator for {workflowName}. Blocked tools: {blockedToolsList}."
advanceReminder: "Phase complete. Use {toolName} to advance to {nextPhaseName}."
blockReasonTemplate: "Tool '{toolName}' is blocked during {phaseName}. Allowed: {allowedTools}."
completionMessage: |
  ✅ {workflowName} complete!
  Task: {taskDescription}
  ID: {taskId}
  Phases: {phaseCount}
notDoneReminder: |
  ⚠️ {workflowName} is still active (phase: {phaseEmoji} {phaseName}).
  Instructions: {phaseInstructions}
phases:
  - reproduce.md
  - fix.md
  - verify.md
```

### `reproduce.md`

```markdown
---
id: reproduce
name: Reproduce
emoji: "🐛"
tools:
  whitelist:
    - read
    - search
    - delegate_to_subagents
availableProfiles:
  - bug-reproducer
---

## Reproduce the Bug

Read the user's description and reproduce the issue in the codebase.

1. Search for relevant code paths
2. Identify the root cause
3. Document findings for the fix phase
```

### `fix.md`

```markdown
---
id: fix
name: Fix
emoji: "🔧"
tools:
  blacklist:
    - bash
availableProfiles:
  - task-coder
  - task-reviewer
---

## Implement the Fix

Based on the reproduction findings, implement the fix.

Delegate implementation to the task-coder profile, then have the
task-reviewer profile verify the changes.
```

### `verify.md`

```markdown
---
id: verify
name: Verify
emoji: "✅"
---

## Verify the Fix

Confirm the fix resolves the original issue. Run tests and check
for regressions. No tool restrictions — full access allowed.
```
