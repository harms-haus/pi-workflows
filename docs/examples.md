# Workflow Examples

Complete, runnable workflow definitions demonstrating every major feature of pi-workflows. Each example includes the full directory structure, `workflow.yaml`, and all phase `.md` files.

---

## Table of Contents

- [1. Minimal Linear Workflow](#1-minimal-linear-workflow)
- [2. RPIR Development Workflow](#2-rpir-development-workflow)
- [3. Subworkflow Reuse Example](#3-subworkflow-reuse-example)
- [4. Looping Pattern](#4-looping-pattern)
- [5. Whitelist Pattern](#5-whitelist-pattern)
- [6. Custom Templates Example](#6-custom-templates-example)
- [7. Multi-Project Setup](#7-multi-project-setup)

---

## 1. Minimal Linear Workflow

The simplest possible workflow: two phases, no tool restrictions, no subworkflows. The orchestrator handles everything directly.

### Directory Structure

```
~/.pi/agent/workflows/
└── hello-task/
    ├── workflow.yaml
    ├── analyze.md
    └── execute.md
```

### `hello-task/workflow.yaml`

```yaml
name: "Hello Task"
commandName: "hello"
initialMessage: |
  Starting {workflowName} for: "{description}"
  Begin with {firstPhaseEmoji} {firstPhaseName}.
phases:
  - analyze.md
  - execute.md
```

### `hello-task/analyze.md`

```markdown
---
id: analyze
name: Analyze
emoji: "🔍"
---

Analyze the user's request: {description}

1. Read the relevant files in the codebase
2. Identify what needs to change
3. Summarize your findings

When finished, call workflow_step with action='next' to advance to {nextPhaseName}.
```

### `hello-task/execute.md`

```markdown
---
id: execute
name: Execute
emoji: "⚙️"
---

Implement the changes identified during analysis for: {description}

Apply the edits directly. No tool restrictions — you have full access.

When finished, call workflow_step with action='next' to complete the workflow.
```

### How to Run

```
/workflow hello Add a hello world endpoint to the API
```

The workflow advances linearly: Analyze → Execute → DONE.

---

## 2. RPIR Development Workflow

A realistic 4-phase workflow following the **R**esearch, **P**lan, **I**mplement, **R**eview pattern. Each phase restricts tools and specifies which subagent profiles the orchestrator may delegate to.

### Directory Structure

```
~/.pi/agent/workflows/
└── rpir/
    ├── workflow.yaml
    ├── research.md
    ├── planning.md
    ├── implementing.md
    └── reviewing.md
```

### `rpir/workflow.yaml`

```yaml
name: "RPIR Development"
commandName: "rpir"
sessionNamePrefix: "RPIR: "
sessionNameMaxLength: 60
initialMessage: |
  Starting {workflowName} for: "{description}"

  Phase 1: {firstPhaseEmoji} {firstPhaseName}
  Available profiles: {firstPhaseProfiles}
phases:
  - research.md
  - planning.md
  - implementing.md
  - reviewing.md
```

### `rpir/research.md`

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
  - vertical-scout
  - horizontal-scout
---

## Research Phase

You are in **{phaseName}** of **{workflowName}** (step {globalStepCount}).

Task: {description} (ID: {taskId})

You must NOT edit or write files directly. Your job is to gather information.

### Instructions

1. Spawn 1-4 parallel scout subagents to investigate the codebase:

   delegate_to_subagents: [
     { name: "scout-vertical", prompt: "Trace the vertical slice for: {description}. Find all files, functions, and types involved.", profile: "vertical-scout" },
     { name: "scout-horizontal", prompt: "Search for patterns, utilities, and conventions related to: {description}", profile: "horizontal-scout" }
   ]

2. Collect results using get_subagent_output for each sessionId.

3. Synthesize findings into a concise research summary:
   - Relevant files and their roles
   - Existing patterns to follow
   - Potential risks or edge cases

Blocked tools: {blockedToolsList}

When your research is complete, call workflow_step with action='next' to advance to {nextPhaseName}.
```

### `rpir/planning.md`

```markdown
---
id: planning
name: Planning
emoji: "📋"
tools:
  blacklist:
    - edit
    - write
availableProfiles:
  - planner
---

## Planning Phase

You are in **{phaseName}** of **{workflowName}** (step {globalStepCount}).

Task: {description}

The previous phase (**{previousPhaseName}**) produced research findings. Now create an implementation plan.

### Instructions

1. Based on the research, delegate plan creation to the planner profile:

   delegate_to_subagents: [
     { name: "planner", prompt: "Create a step-by-step implementation plan for: {description}\n\nResearch context: [insert research summary here]\n\nProduce a numbered list of specific, atomic changes.", profile: "planner" }
   ]

2. Collect and review the plan.

3. Ensure the plan covers:
   - Files to create or modify
   - Specific functions/types to add or change
   - Test coverage requirements
   - Migration or deployment steps (if any)

Blocked tools: {blockedToolsList}

When the plan is finalized, call workflow_step with action='next' to advance to {nextPhaseName}.
```

### `rpir/implementing.md`

```markdown
---
id: implementing
name: Implementation
emoji: "⚙️"
tools:
  blacklist:
    - edit
    - write
availableProfiles:
  - task-worker
---

## Implementation Phase

You are in **{phaseName}** of **{workflowName}** (step {globalStepCount}).

Task: {description}

The plan from **{previousPhaseName}** is ready. Execute it by delegating to task workers.

### Instructions

1. Break the plan into discrete, parallelizable tasks.

2. Spawn 1-4 task-worker subagents:

   delegate_to_subagents: [
     { name: "worker-1", prompt: "Implement step X of the plan for: {description}\n\nSpecific changes: [describe]", profile: "task-worker" },
     { name: "worker-2", prompt: "Implement step Y of the plan for: {description}\n\nSpecific changes: [describe]", profile: "task-worker" }
   ]

3. Collect results and verify each worker completed its task.

4. If any task failed or is incomplete, spawn additional workers to address the gaps.

Blocked tools: {blockedToolsList}

When all implementation tasks are complete, call workflow_step with action='next' to advance to {nextPhaseName}.
```

### `rpir/reviewing.md`

```markdown
---
id: reviewing
name: Review
emoji: "🔎"
tools:
  blacklist:
    - edit
    - write
availableProfiles:
  - reviewer
---

## Review Phase

You are in **{phaseName}** of **{workflowName}** (step {globalStepCount}).

Task: {description}

The implementation is complete. Perform a final quality review.

### Instructions

1. Delegate a review to the reviewer profile:

   delegate_to_subagents: [
     { name: "reviewer", prompt: "Review the implementation for: {description}\n\nCheck for:\n- Correctness and edge cases\n- Code style and conventions\n- Missing tests\n- Potential regressions\n- Performance concerns", profile: "reviewer" }
   ]

2. Collect the review output.

3. If issues are found:
   - Delegate fixes to additional task-worker subagents
   - Re-review after fixes

4. If the review passes cleanly, finalize.

Blocked tools: {blockedToolsList}

When the review is complete and all issues are resolved, call workflow_step with action='next' to complete the workflow.
```

### How to Run

```
/workflow rpir Add user authentication with JWT tokens
```

The orchestrator delegates all implementation work to subagent profiles. It never edits files directly — the `blacklist` on every phase enforces this.

---

## 3. Subworkflow Reuse Example

Two top-level workflows (`rpir-dev` and `rpir-improve`) share a common `rpir-implement` subworkflow containing the implementation and review loop. This avoids duplicating those phase definitions.

### Directory Structure

```
~/.pi/agent/workflows/
├── rpir-dev/
│   ├── workflow.yaml
│   ├── research.md
│   └── planning.md
├── rpir-improve/
│   ├── workflow.yaml
│   ├── assess.md
│   └── scope.md
└── rpir-implement/
    ├── workflow.yaml
    ├── implementing.md
    └── reviewing.md
```

### `rpir-dev/workflow.yaml`

A development workflow: research, plan, then hand off to the shared implement+review subworkflow.

```yaml
name: "RPIR Development"
commandName: "rpir-dev"
sessionNamePrefix: "RPIR-Dev: "
initialMessage: |
  Starting {workflowName} for: "{description}"
  Phase 1: {firstPhaseEmoji} {firstPhaseName}
phases:
  - research.md
  - planning.md
  - { subworkflow: rpir-implement }
```

### `rpir-dev/research.md`

```markdown
---
id: rpir-dev-research
name: Research
emoji: "🔍"
tools:
  blacklist:
    - edit
    - write
availableProfiles:
  - vertical-scout
  - horizontal-scout
---

## Research Phase

Task: {description}

Investigate the codebase using scout subagents. Identify all relevant files, patterns, and conventions.

Summarize findings. When done, call workflow_step with action='next' to advance to {nextPhaseName}.
```

### `rpir-dev/planning.md`

```markdown
---
id: rpir-dev-planning
name: Planning
emoji: "📋"
tools:
  blacklist:
    - edit
    - write
availableProfiles:
  - planner
---

## Planning Phase

Task: {description}

Create an implementation plan based on research findings. Delegate to the planner profile.

When the plan is finalized, call workflow_step with action='next' to advance to {nextPhaseName} (the implementation subworkflow).
```

### `rpir-improve/workflow.yaml`

An improvement workflow: assess existing code, scope changes, then reuse the same implement+review subworkflow.

```yaml
name: "RPIR Improvement"
commandName: "rpir-improve"
sessionNamePrefix: "RPIR-Improve: "
initialMessage: |
  Starting {workflowName} for: "{description}"
  Phase 1: {firstPhaseEmoji} {firstPhaseName}
phases:
  - assess.md
  - scope.md
  - { subworkflow: rpir-implement }
```

### `rpir-improve/assess.md`

```markdown
---
id: rpir-improve-assess
name: Assess
emoji: "📊"
tools:
  blacklist:
    - edit
    - write
availableProfiles:
  - vertical-scout
---

## Assessment Phase

Task: {description}

Examine the existing code that needs improvement. Identify current behavior, pain points, and technical debt.

When done, call workflow_step with action='next' to advance to {nextPhaseName}.
```

### `rpir-improve/scope.md`

```markdown
---
id: rpir-improve-scope
name: Scope Changes
emoji: "📐"
tools:
  blacklist:
    - edit
    - write
availableProfiles:
  - planner
---

## Scoping Phase

Task: {description}

Based on the assessment, create a scoped improvement plan. Define exactly what will change and what will stay the same.

When done, call workflow_step with action='next' to enter the implementation subworkflow.
```

### `rpir-implement/workflow.yaml`

The shared subworkflow — hidden from `/workflow` via `show: "workflows"`, and loopable so the implement-review cycle can repeat.

```yaml
name: "Implement & Review"
show: "workflows"
loopable: true
phases:
  - implementing.md
  - reviewing.md
```

### `rpir-implement/implementing.md`

```markdown
---
id: shared-implement
name: Implementation
emoji: "⚙️"
tools:
  blacklist:
    - edit
    - write
availableProfiles:
  - task-worker
---

## Implementation Phase

Task: {description}

Execute the plan by delegating implementation tasks to task-worker subagents. Break work into parallel units where possible.

Blocked tools: {blockedToolsList}

When all implementation tasks are complete, call workflow_step with action='next' to advance to {nextPhaseName}.
```

### `rpir-implement/reviewing.md`

```markdown
---
id: shared-review
name: Review
emoji: "🔎"
tools:
  blacklist:
    - edit
    - write
availableProfiles:
  - reviewer
  - task-worker
---

## Review Phase

Task: {description}

Delegate a quality review to the reviewer profile. Check for correctness, style, test coverage, and regressions.

### Outcomes

- **Issues found:** Delegate fixes to task-worker subagents, then call workflow_step with action='loop' to restart the implement-review cycle.
- **Clean review:** Call workflow_step with action='next' to exit the subworkflow and return to the parent.
```

### Key Points

- `rpir-implement` has `show: "workflows"` — it never appears in `/workflow` listings and cannot be started directly.
- Both `rpir-dev` and `rpir-improve` reference `{ subworkflow: rpir-implement }` by directory name.
- The `loopable: true` on `rpir-implement` allows the review phase to restart from implementation if issues are found. See [Looping Pattern](#4-looping-pattern) for details.
- Phase `id` values are unique within their own workflow — `shared-implement` and `shared-review` exist in `rpir-implement`'s scope, while `rpir-dev-research` and `rpir-dev-planning` exist in `rpir-dev`'s scope. Cross-workflow ID collisions are allowed.

---

## 4. Looping Pattern

The implement-review loop is the most common looping pattern. When review finds issues, the agent calls `workflow_step loop` to restart the current scope from phase 0. When clean, it calls `workflow_step next` to advance.

This example shows two variations: a loop within a subworkflow scope, and a loop in a flat workflow.

### Variation A: Subworkflow Loop (Recommended)

Using the `rpir-implement` subworkflow from [Example 3](#3-subworkflow-reuse-example), the loop scope is limited to the subworkflow's phases only:

```
rpir-dev phases: [research, planning, {subworkflow: rpir-implement}]
                                                          │
rpir-implement phases: [implementing, reviewing]  ◄──────┘
                          ↑               │
                          └── loop ───────┘  (only this scope restarts)
```

The `reviewing.md` phase instructions control the loop:

```markdown
---
id: shared-review
name: Review
emoji: "🔎"
tools:
  blacklist:
    - edit
    - write
availableProfiles:
  - reviewer
  - task-worker
---

## Review Phase

Task: {description}

### Instructions

1. Delegate a review to the reviewer profile:

   delegate_to_subagents: [
     { name: "reviewer", prompt: "Review the implementation for: {description}. Check correctness, style, tests, regressions.", profile: "reviewer" }
   ]

2. Collect the review output.

### Decision

- **If issues were found:**
  1. Delegate fixes to task-worker subagents
  2. After fixes are applied, call workflow_step with action='loop'
  3. This restarts the implement-review subworkflow from implementing.md

- **If the review passes:**
  1. Call workflow_step with action='next'
  2. The subworkflow completes and control returns to the parent workflow
```

**What happens on `loop`:**

```
currentPath = [{ rpir-dev, 2 }, { rpir-implement, 1 }]
                                                ^^^^^ reviewing (last phase in subworkflow)

→ workflow_step loop

currentPath = [{ rpir-dev, 2 }, { rpir-implement, 0 }]
                                                ^^^^^^^ implementing (restarted)
```

The parent scope (`rpir-dev` at phaseIndex 2) is unaffected. Only the innermost scope loops.

### Variation B: Flat Workflow Loop

A single workflow where `loop` restarts the entire workflow:

```
flat-iterate phases: [implementing, reviewing]
                       ↑               │
                       └── loop ───────┘  (entire workflow restarts)
```

### `flat-iterate/workflow.yaml`

```yaml
name: "Iterate Until Clean"
commandName: "iterate"
loopable: true
initialMessage: |
  Starting {workflowName} for: "{description}"
  Phase 1: {firstPhaseEmoji} {firstPhaseName}
phases:
  - implementing.md
  - reviewing.md
```

### `flat-iterate/implementing.md`

```markdown
---
id: flat-implement
name: Implement
emoji: "⚙️"
availableProfiles:
  - task-worker
---

## Implement Phase

Task: {description}

Implement the required changes by delegating to task-worker subagents.

When done, call workflow_step with action='next' to advance to {nextPhaseName}.
```

### `flat-iterate/reviewing.md`

```markdown
---
id: flat-review
name: Review
emoji: "🔎"
availableProfiles:
  - reviewer
  - task-worker
---

## Review Phase

Task: {description}

Delegate a review to the reviewer profile.

### Decision

- **Issues found:** Delegate fixes, then call workflow_step with action='loop' to restart from the workflow's first phase (Implement).
- **Clean:** Call workflow_step with action='next' to complete the workflow.
```

### Preventing Loops

Set `loopable: false` to prevent the agent from looping back. This is useful for planning or research phases that should run exactly once:

```yaml
name: "One-Shot Plan"
commandName: "plan-once"
loopable: false        # ← agent cannot call workflow_step loop
initialMessage: "Starting {workflowName} for: {description}"
phases:
  - gather.md
  - plan.md
```

If the agent calls `workflow_step loop` on a non-loopable workflow, it receives:

```
⚠️ Looping is disabled for this workflow.
```

---

## 5. Whitelist Pattern

While `blacklist` blocks specific tools and allows everything else, `whitelist` takes the opposite approach: **only** the listed tools are allowed. This is useful for phases that need tightly scoped, minimal tool access.

> **Remember:** `workflow_step` is always allowed regardless of whitelist or blacklist configuration. You cannot block it.

### Directory Structure

```
~/.pi/agent/workflows/
└── audit/
    ├── workflow.yaml
    ├── scan.md
    └── report.md
```

### `audit/workflow.yaml`

```yaml
name: "Security Audit"
commandName: "audit"
sessionNamePrefix: "Audit: "
initialMessage: |
  Starting {workflowName} for: "{description}"
  Phase 1: {firstPhaseEmoji} {firstPhaseName}
phases:
  - scan.md
  - report.md
```

### `audit/scan.md`

```markdown
---
id: scan
name: Scan
emoji: "🛡️"
tools:
  whitelist:
    - read
    - search
    - delegate_to_subagents
availableProfiles:
  - vertical-scout
---

## Security Scan Phase

Task: {description}

### Allowed Tools

You may ONLY use: read, search, delegate_to_subagents, and workflow_step.
All other tools are blocked.

### Instructions

1. Scan the codebase for security concerns using read and search tools.

2. For broader coverage, spawn scout subagents:

   delegate_to_subagents: [
     { name: "sec-scout", prompt: "Scan for security vulnerabilities in: {description}. Check input validation, auth patterns, injection risks.", profile: "vertical-scout" }
   ]

3. Compile a list of findings with severity ratings (Critical / High / Medium / Low).

When the scan is complete, call workflow_step with action='next' to advance to {nextPhaseName}.
```

### `audit/report.md`

```markdown
---
id: report
name: Report
emoji: "📄"
tools:
  whitelist:
    - read
    - delegate_to_subagents
availableProfiles:
  - planner
---

## Report Phase

Task: {description}

### Allowed Tools

You may ONLY use: read, delegate_to_subagents, and workflow_step.

### Instructions

1. Using the scan findings from the previous phase, compile a security report.

2. Delegate report writing to the planner profile:

   delegate_to_subagents: [
     { name: "reporter", prompt: "Create a structured security audit report for: {description}\n\nFindings: [insert findings]\n\nInclude: executive summary, detailed findings with severity, remediation steps.", profile: "planner" }
   ]

3. Present the final report.

When done, call workflow_step with action='next' to complete the workflow.
```

### Blacklist vs Whitelist Decision Guide

| Scenario | Use | Why |
|----------|-----|-----|
| Phase should be read-only | `blacklist: [edit, write]` | Broad access minus the dangerous tools |
| Phase needs minimal, specific tools | `whitelist: [read, search]` | Maximum restriction — nothing unexpected |
| Phase has full access | Omit `tools` entirely | No restrictions applied |
| Both `blacklist` and `whitelist` set | **Invalid** — validation error | Mutually exclusive |

See [Configuration Reference → Tool Configuration](configuration-reference.md#tool-configuration-details) for full details.

---

## 6. Custom Templates Example

Override the default `roleInstruction`, `advanceReminder`, `blockReasonTemplate`, `completionMessage`, and `notDoneReminder` to customize the orchestrator's behavior and messaging for a specific workflow.

> All template variables documented in [Template Variables Reference](template-variables.md) are available.

### Directory Structure

```
~/.pi/agent/workflows/
└── guided-fix/
    ├── workflow.yaml
    ├── diagnose.md
    └── repair.md
```

### `guided-fix/workflow.yaml`

```yaml
name: "Guided Fix"
commandName: "fix"
sessionNamePrefix: "Fix: "
sessionNameMaxLength: 40
loopable: false

roleInstruction: |
  You are a senior debug assistant running {workflowName}.
  Blocked tools: {blockedToolsList}.
  Approach every problem methodically: observe, hypothesize, test, fix.
  Delegate implementation to subagents when edits are needed.

advanceReminder: |
  👉 Phase "{phaseName}" is done. Use {toolName} with action='next' to move to {nextPhaseName}.

blockReasonTemplate: |
  🚫 Tool "{toolName}" is not available during {phaseName}.
  Allowed tools: {allowedTools}.
  Follow the phase instructions or delegate to a subagent profile.

completionMessage: |
  🎉 {workflowName} complete!

  **What was fixed:** {taskDescription}
  **Task ID:** {taskId}
  **Total phases:** {phaseCount}

notDoneReminder: |
  ⚡ Hold on — {workflowName} is still in progress.
  Current phase: {phaseEmoji} {phaseName}

  You cannot stop here. Complete the phase instructions:
  {phaseInstructions}

  Then call workflow_step to advance.

initialMessage: |
  🔧 Starting {workflowName}

  **Problem:** {description}
  **Phase 1:** {firstPhaseEmoji} {firstPhaseName}

phases:
  - diagnose.md
  - repair.md
```

### `guided-fix/diagnose.md`

```markdown
---
id: diagnose
name: Diagnose
emoji: "🔬"
tools:
  blacklist:
    - edit
    - write
availableProfiles:
  - vertical-scout
---

## Diagnose Phase

**Problem:** {description}

### Instructions

1. Reproduce the issue. Use read and search to trace the code path.

2. Identify the root cause. Document:
   - Which file(s) and function(s) are involved
   - What the expected behavior should be
   - What's going wrong and why

3. If the codebase is large, delegate targeted investigation:

   delegate_to_subagents: [
     { name: "investigator", prompt: "Trace the bug: {description}. Find the exact line where the behavior diverges from expected.", profile: "vertical-scout" }
   ]

Blocked tools: {blockedToolsList}

When the root cause is identified, call workflow_step with action='next' to advance to {nextPhaseName}.
```

### `guided-fix/repair.md`

```markdown
---
id: repair
name: Repair
emoji: "🔧"
availableProfiles:
  - task-worker
  - reviewer
---

## Repair Phase

**Problem:** {description}

The diagnosis from **{previousPhaseName}** identified the root cause. Now fix it.

### Instructions

1. Delegate the fix to a task-worker:

   delegate_to_subagents: [
     { name: "fixer", prompt: "Apply the fix for: {description}\n\nRoot cause: [insert diagnosis]\n\nFix approach: [describe the change]", profile: "task-worker" }
   ]

2. After the fix is applied, delegate a quick review:

   delegate_to_subagents: [
     { name: "verifier", prompt: "Verify the fix for: {description}. Check that the original issue is resolved and no regressions introduced.", profile: "reviewer" }
   ]

When the fix is verified, call workflow_step with action='next' to complete the workflow.
```

### Template Variable Resolution Example

When the agent is in the **Diagnose** phase and tries to call a blocked tool:

`blockReasonTemplate` resolves to:

```
🚫 Tool "edit" is not available during Diagnose.
Allowed tools: all tools except edit, write.
Follow the phase instructions or delegate to a subagent profile.
```

When the workflow completes:

`completionMessage` resolves to:

```
🎉 Guided Fix complete!

**What was fixed:** Fix null pointer exception in user service
**Task ID:** wf-1747234567890-a3f2k1
**Total phases:** 2
```

---

## 7. Multi-Project Setup

pi-workflows loads definitions from two tiers: **global** (shared across all projects) and **project-local** (specific to one project). Project definitions override global definitions with the same key.

### Loading Order

| Priority | Location | Loaded From |
|----------|----------|-------------|
| 1 (highest) | `.pi/workflows/` | Relative to the project root (`cwd`) |
| 2 | `~/.pi/agent/workflows/` | Global home directory, or `$PI_CODING_AGENT_DIR/workflows/` |

When both tiers define a workflow with the same directory name, the **project** version wins. The merge uses a simple object spread: `{ ...globalDefs, ...projectDefs }`.

### Example Layout

```
~/.pi/agent/workflows/                         # GLOBAL — available to every project
├── rpir/
│   ├── workflow.yaml                          # Standard RPIR workflow
│   ├── research.md
│   ├── planning.md
│   ├── implementing.md
│   └── reviewing.md
├── code-review/
│   ├── workflow.yaml
│   ├── gather-context.md
│   └── report-findings.md
└── _shared/
    ├── implement-review/
    │   ├── workflow.yaml                      # show: "workflows" — shared subworkflow
    │   ├── implementing.md
    │   └── reviewing.md
    └── scouting.md                            # Shared phase file (not a workflow)

~/projects/webapp/.pi/workflows/               # PROJECT — specific to webapp
├── rpir/
│   ├── workflow.yaml                          # OVERRIDES global rpir/
│   ├── research.md                            # Custom research phase for this project
│   ├── planning.md                            # Custom planning phase
│   ├── implementing.md                        # References project-specific profiles
│   ├── reviewing.md
│   └── deploy.md                              # Extra phase — 5 phases instead of 4
└── hotfix/
    ├── workflow.yaml                          # PROJECT-ONLY workflow
    ├── reproduce.md
    ├── patch.md
    └── verify.md

~/projects/api/.pi/workflows/                  # PROJECT — specific to api
└── hotfix/
    ├── workflow.yaml                          # Different hotfix workflow for API project
    ├── assess.md
    ├── fix.md
    └── test.md
```

### Scenario: Override Global Workflow

The global `rpir` workflow has 4 phases. The `webapp` project needs a 5th deployment phase.

**Global `~/.pi/agent/workflows/rpir/workflow.yaml`:**

```yaml
name: "RPIR Development"
commandName: "rpir"
initialMessage: |
  Starting {workflowName} for: "{description}"
phases:
  - research.md
  - planning.md
  - implementing.md
  - reviewing.md
```

**Project `webapp/.pi/workflows/rpir/workflow.yaml`** (overrides global):

```yaml
name: "RPIR Development (Webapp)"
commandName: "rpir"
sessionNamePrefix: "Webapp-RPIR: "
initialMessage: |
  Starting {workflowName} for: "{description}"
  Phase 1: {firstPhaseEmoji} {firstPhaseName}
phases:
  - research.md
  - planning.md
  - implementing.md
  - reviewing.md
  - deploy.md
```

**Project `webapp/.pi/workflows/rpir/deploy.md`** (project-only phase):

```markdown
---
id: deploy
name: Deploy
emoji: "🚀"
availableProfiles:
  - task-worker
---

## Deploy Phase

Task: {description}

The review from **{previousPhaseName}** passed. Deploy the changes.

### Instructions

1. Run the deployment commands via task-worker subagents.
2. Verify the deployment succeeded.
3. Check health endpoints.

When deployment is verified, call workflow_step with action='next' to complete the workflow.
```

### Scenario: Project-Only Workflow

The `webapp` project defines a `hotfix` workflow that doesn't exist globally:

**Project `webapp/.pi/workflows/hotfix/workflow.yaml`:**

```yaml
name: "Hotfix Pipeline"
commandName: "hotfix"
sessionNamePrefix: "Hotfix: "
loopable: false
initialMessage: |
  🚨 Starting {workflowName} for: "{description}"
  Phase 1: {firstPhaseEmoji} {firstPhaseName}
phases:
  - reproduce.md
  - patch.md
  - verify.md
```

**Project `webapp/.pi/workflows/hotfix/reproduce.md`:**

```markdown
---
id: hotfix-reproduce
name: Reproduce
emoji: "🐛"
tools:
  blacklist:
    - edit
    - write
---

## Reproduce the Bug

Bug report: {description}

1. Search for the relevant code paths
2. Identify and confirm the reproduction steps
3. Document the root cause

Call workflow_step with action='next' to advance to {nextPhaseName}.
```

**Project `webapp/.pi/workflows/hotfix/patch.md`:**

```markdown
---
id: hotfix-patch
name: Patch
emoji: "🩹"
availableProfiles:
  - task-worker
---

## Apply the Patch

Bug: {description}

Based on the reproduction from **{previousPhaseName}**, delegate the fix to a task-worker subagent.

Call workflow_step with action='next' when the patch is applied.
```

**Project `webapp/.pi/workflows/hotfix/verify.md`:**

```markdown
---
id: hotfix-verify
name: Verify
emoji: "✅"
---

## Verify the Fix

Bug: {description}

Confirm the patch resolves the bug. Run tests and check for regressions.

Call workflow_step with action='next' to complete the hotfix.
```

### Result: What Each Project Sees

| Workflow | `~/projects/webapp` | `~/projects/api` | Any other project |
|----------|:---:|:---:|:---:|
| `rpir` | Webapp-RPIR (5 phases) | Global RPIR (4 phases) | Global RPIR (4 phases) |
| `code-review` | Global code-review | Global code-review | Global code-review |
| `hotfix` | Webapp Hotfix Pipeline | API Hotfix Pipeline | *(not available)* |

### Environment Variable Override

The global workflows root defaults to `~/.pi/agent/workflows/`. Set the `PI_CODING_AGENT_DIR` environment variable to change the base directory:

```bash
export PI_CODING_AGENT_DIR="/opt/pi-agent"
# Global workflows loaded from: /opt/pi-agent/workflows/
```

---

## Quick Reference

### `workflow_step` Actions

| Action | Description | When to Use |
|--------|-------------|-------------|
| `next` | Advance to the next phase (or DONE if last) | Phase work is complete |
| `loop` | Restart the current scope from phase 0 | Review found issues; retry the cycle |
| `status` | Show current workflow state, phase instructions, profiles | Need to check where you are |
| `cancel` | Cancel the workflow (requires confirmation) | Workflow is wrong; abort it |

### Phase Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | **Yes** | Unique identifier within the workflow |
| `name` | **Yes** | Display name |
| `emoji` | **Yes** | Single emoji for UI |
| `tools.blacklist` | No | Tools to block |
| `tools.whitelist` | No | Only these tools allowed |
| `availableProfiles` | No | Subagent profiles for this phase |

### workflow.yaml Key Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | **Yes** | Display name |
| `commandName` | Yes (if `show: "user"`) | Slash command name |
| `initialMessage` | Yes (if `show: "user"`) | Message sent on start |
| `phases` | **Yes** | Array of `.md` filenames or `{ subworkflow: key }` |
| `show` | No | `"user"` (default) or `"workflows"` (subworkflow-only) |
| `loopable` | No | `true` (default) or `false` |

For complete field documentation, see [Configuration Reference](configuration-reference.md). For all available template variables, see [Template Variables](template-variables.md).
