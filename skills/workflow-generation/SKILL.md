---
name: workflow-generation
description: Build pi-workflow definitions (workflows, phases, subworkflows, agent-profiles). Use when asked to create or modify a workflow for the pi-workflows extension. Covers the full file-based schema, directory layout, phase frontmatter, subworkflow references, looping, tool blacklists/whitelists, and agent-profile authoring.
---

# Workflow Generation

This skill teaches how to build **pi-workflows** — file-based workflow definitions loaded from `~/.pi/agent/workflows/` (global) or `.pi/workflows/` (project-local) by the `pi-workflows` extension.

Read this entire file before building any workflow.

## Directory Layout

```
~/.pi/agent/workflows/
├── my-workflow/              # One directory per user-facing workflow
│   └── workflow.yaml         # Entry point: name, commandName, phases list
├── _shared/                  # Convention: underscore-prefixed dirs hold reusable phases
│   ├── scouting.md
│   └── planning.md
└── my-other-workflow/
    └── workflow.yaml         # Can reference ../_shared/*.md phases
```

- Each workflow is a **directory** containing a `workflow.yaml`.
- Phase instructions live in **`.md` files** with YAML frontmatter.
- Directories starting with `_` are convention for shared phase libraries (not loaded as standalone workflows since they lack `workflow.yaml`).
- Phase `.md` files are referenced by **relative path** from the workflow directory.

## Agent Profiles

Agent profiles live in `~/.pi/agent/agent-profiles/` as `.md` files with YAML frontmatter:

```markdown
---
name: my-profile
provider: openai          # Provider ID
model: gpt-4o             # Model ID
thinkingLevel: medium     # low | medium | high
tools: read,bash,edit,write,lsp-diagnostics,lsp-find-references,lsp-goto-definition
---

System prompt for the agent goes here as free-form markdown.
```

**Key fields:**
- `name` — must match the filename (without `.md`)
- `tools` — comma-separated list of tools the subagent can use. Omitting a tool prevents the subagent from using it.
- `thinkingLevel` — controls reasoning effort

### Designing Profiles

1. **One responsibility per profile.** A scout scouts. A writer writes. A reviewer reviews. Never combine.
2. **Restrict tools to the minimum needed.** Scouts don't need `edit`/`write`. Writers do. Reviewers only need `read`-family tools.
3. **Set thinking level appropriately.** Low for fast scouting. Medium for implementation/writing. High for reviewing and planning.
4. **Reuse before creating.** Check `~/.pi/agent/agent-profiles/` for existing profiles before creating new ones.

## workflow.yaml Schema

```yaml
name: Human-Readable Workflow Name    # Required
commandName: my-command               # Required for user-facing workflows. Used as: /workflow my-command <desc>
sessionNamePrefix: 'Prefix: '         # Optional. Shown in TUI session name
sessionNameMaxLength: 50              # Optional. Default 50
initialMessage: |                     # Required for user-facing workflows
  Start the {workflowName} for: "{description}"
  Begin with Phase 1 ({firstPhaseName}).
show: user                            # Optional. "user" (default) or "workflows" (subworkflow-only)
phases:                               # Required. Array of phase file paths or subworkflow references
  - ../_shared/scouting.md
  - ../_shared/planning.md
  - ./implementing.md
  - { subworkflow: my-sub-workflow }  # Delegates to another workflow
```

**Template variables** available in `initialMessage`:
- `{workflowName}`, `{description}`, `{firstPhaseId}`, `{firstPhaseName}`, `{firstPhaseEmoji}`, `{firstPhaseProfiles}`

**Optional workflow-level fields:**
- `show: "workflows"` — makes the workflow invisible to `/workflow` command; only usable as a subworkflow
- `loopable: false` — prevents looping (restarting from phase 0). Default is `true`.

## Phase .md File Schema

```markdown
---
id: my-phase-id          # Required. Unique within the workflow.
name: My Phase           # Required. Display name.
emoji: "🔍"              # Required. Single emoji.
tools:                   # Optional. Exactly one of blacklist or whitelist.
  blacklist:
    - edit
    - write
availableProfiles:       # Optional. Profiles the agent may delegate to.
  - vertical-scout
  - horizontal-scout
---

Phase instructions go here as free-form markdown.

These instructions are injected into the agent's context during this phase.
They tell the agent WHAT to do and HOW to use subagents.
```

### Tool Configuration

Each phase can restrict tools via `tools`:
- **`blacklist`**: Block these specific tools. Everything else is allowed.
- **`whitelist`**: Allow ONLY these tools. Everything else is blocked.
- Cannot use both simultaneously.
- `workflow_step` is always allowed regardless of configuration.

Common pattern: read-only phases use `blacklist: [edit, write]` so the agent can scout/plan/review but not modify files directly — it must delegate to subagent profiles that have those tools.

### Phase Instructions Best Practices

Phase instructions are the core of your workflow. They must be:

1. **Self-contained** — The agent only sees the current phase's instructions. Include all context the agent needs.
2. **Actionable** — Tell the agent exactly what to do. Specify when to use `delegate_to_subagents`, `workflow_step next`, `workflow_step loop`.
3. **Profile-aware** — List which profiles to use and what prompts to send them.
4. **Terminal** — Every phase MUST end with either `workflow_step next` (advance) or `workflow_step loop` (restart the current workflow scope from phase 0).

Example instruction patterns:

```
Spawn 1-4 parallel subagents:
  delegate_to_subagents: [{ name: "scout-N", prompt: "Investigate: [topic]", profile: "vertical-scout" }]

Collect results:
  get_subagent_output for each sessionId

Advance:
  workflow_step next
```

## Subworkflows

A subworkflow delegates a phase to an entire other workflow. In `workflow.yaml`:

```yaml
phases:
  - { subworkflow: my-sub-workflow }
```

This resolves `my-sub-workflow` by its **directory name** in the workflows root. The parent workflow's phase becomes the entire subworkflow's phase sequence.

### Subworkflow Rules

1. The referenced key is the **directory name**, not the workflow's `name` field.
2. Subworkflows can be marked `show: "workflows"` to hide them from `/workflow`.
3. Subworkflow nesting is supported (a subworkflow can reference another subworkflow).
4. **Cycles are detected and rejected** — the reference graph must be a DAG.
5. If a referenced subworkflow doesn't exist, the parent workflow is skipped with a warning.

### When to Use Subworkflows

Use subworkflows when:
- Multiple top-level workflows share the same phase sequence (e.g., research → plan → implement → review)
- You want to reuse a "loop" boundary (looping restarts the current scope)

Example — a shared implementation+review loop used by two workflows:

```
workflows/
├── rpir-dev/
│   └── workflow.yaml          # phases: [research, plan, {subworkflow: rpir-implement}]
├── rpir-improve/
│   └── workflow.yaml          # phases: [research, plan, {subworkflow: rpir-implement}]
└── rpir-implement/
    └── workflow.yaml          # show: workflows
                                # phases: [implement.md, review.md]  ← loopable unit
```

## Looping

When a phase calls `workflow_step loop`, the **current workflow scope** restarts from its **phase 0**. This is how iterative refinement works:

1. An "implement" phase writes code
2. A "review" phase checks it
3. If review finds issues → `workflow_step loop` → back to implement
4. If review is clean → `workflow_step next` → advance past the loop

**Loop scope** is determined by the workflow boundary:
- In a flat workflow, `loop` restarts the entire workflow
- In a subworkflow reference, `loop` restarts only the subworkflow's phases

Set `loopable: false` to prevent looping (useful for planning phases that should run once).

## Phase Reuse Pattern

Avoid copy-pasting phase `.md` files across workflows. Instead:

1. Create a shared directory (convention: `_myshared/` with leading underscore)
2. Put reusable phases there
3. Reference them with relative paths: `../_myshared/scouting.md`

```
workflows/
├── workflow-a/
│   └── workflow.yaml       # phases: [../_shared/scouting.md, ./a-specific.md]
├── workflow-b/
│   └── workflow.yaml       # phases: [../_shared/scouting.md, ./b-specific.md]
└── _shared/
    ├── scouting.md          # Shared phase
    └── planning.md          # Shared phase
```

## Building a New Workflow — Checklist

1. **Define the workflow** — What is the goal? What phases does it need?
2. **Check for reusable phases** — Look in `~/.pi/agent/workflows/` for `_`-prefixed shared directories with phases you can reference.
3. **Check for reusable profiles** — Look in `~/.pi/agent/agent-profiles/` before creating new ones.
4. **Create the directory** — `~/.pi/agent/workflows/my-workflow/`
5. **Write `workflow.yaml`** — name, commandName, initialMessage, phases list
6. **Write phase `.md` files** — Each with frontmatter (id, name, emoji) and instructions. Place shared phases in a `_shared/` directory and reference with `../_shared/...` paths.
7. **Create agent profiles** — Only if no existing profile fits. Place in `~/.pi/agent/agent-profiles/`.
8. **Validate** — Ensure every phase `.md` has `id`, `name`, `emoji`. Ensure all referenced profiles exist. Ensure YAML is valid.

## Common Patterns

### Read-Only Phase (Scouting/Planning/Reviewing)
```yaml
# frontmatter
tools:
  blacklist:
    - edit
    - write
```
The agent delegates to subagent profiles that have write tools. The orchestrator itself cannot modify files.

### Implementation Phase
```yaml
# frontmatter
tools:
  blacklist:
    - edit
    - write
availableProfiles:
  - task-worker
```
Same pattern — the orchestrator delegates to `task-worker` which has edit/write tools.

### Skip-if-Clean Phase
In the phase instructions, include:
```
If there are no issues, immediately perform `workflow_step next` to skip.
Otherwise, fix issues and use `workflow_step loop` to re-review.
```

### Parallel Subagent Delegation
```
Spawn 1-4 parallel subagents:
  delegate_to_subagents: [
    { name: "task-1", prompt: "...", profile: "my-profile" },
    { name: "task-2", prompt: "...", profile: "my-profile" }
  ]
Collect results with get_subagent_output for each sessionId.
```
