# pi-workflows

A configurable pi extension for defining and running named multi-phase workflows with tool control, subworkflow nesting, and state persistence.

## Features

- **Named workflows** — Define any number of workflows as standalone directories with a `workflow.yaml` file, each invoked by a unique slash command.
- **Configurable phases** — Each phase specifies its own instructions, emoji, and available subagent profiles.
- **Per-phase tool control** — Restrict tools per phase using a blacklist (block specific tools) or whitelist (allow only specific tools).
- **Subworkflow nesting** — Compose workflows by referencing other workflows as phases, with cycle detection and breadcrumb navigation.
- **State persistence** — Workflow state survives session restarts via `pi.appendEntry`.
- **Auto-continue enforcement** — The agent cannot finish until the workflow reaches DONE; a configurable reminder is injected on premature `agent_end`.
- **Template variables** — Use `{workflowName}`, `{phaseName}`, `{taskDescription}`, and more in messages and instructions.
- **Slash commands** — Start workflows with `/workflow`, cancel with `/cancel-workflow`, and inspect progress with the `workflow_step` tool.

## Installation

```bash
pi install git:github.com/harms-haus/pi-workflows
```

## Quick Start

**1. Create a workflow directory** under `.pi/workflows/` in your project (or `~/.pi/agent/workflows/` globally):

```bash
mkdir -p .pi/workflows/my-workflow
```

**2. Write `workflow.yaml`** with two phases referencing markdown files:

```yaml
name: My Workflow
commandName: my-workflow
initialMessage: "Starting {workflowName} for: \"{description}\""
phases:
  - gather.md
  - execute.md
```

Create the phase files alongside `workflow.yaml`:

```markdown
<!-- gather.md -->
---
id: gather
name: Gather
emoji: "🔍"
---
Research the task and summarize findings.
```

```markdown
<!-- execute.md -->
---
id: execute
name: Execute
emoji: "🔨"
tools:
  whitelist:
    - edit
    - write
    - workflow_step
---
Implement the solution based on gathered research.
```

See [docs/configuration-reference.md](docs/configuration-reference.md) for the full schema.

**3. Run the workflow** in your pi session:

```
/workflow my-workflow add user authentication
```

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/workflow {commandName} {description}` | Start a workflow |
| `/cancel-workflow` | Cancel the active workflow (bypasses the not-done reminder) |

### `workflow_step` Tool

| Action | Description |
|--------|-------------|
| `status` | Show current workflow state, phase instructions, and available profiles |
| `next` | Advance to the next phase (or DONE if on the last phase) |
| `cancel` | Cancel the active workflow (requires two calls to confirm) |
| `loop` | Restart the current scope from phase 0 (if the workflow is `loopable`) |

For complete examples, see [docs/examples.md](docs/examples.md).

## Documentation

| Document | Description |
|----------|-------------|
| [Configuration Reference](docs/configuration-reference.md) | Full schema for `workflow.yaml` and phase markdown files |
| [Template Variables](docs/template-variables.md) | All available `{variables}` and where they can be used |
| [Subworkflows](docs/subworkflows.md) | Composing workflows from other workflows |
| [Examples](docs/examples.md) | Complete workflow definitions and usage patterns |
| [Architecture](docs/architecture.md) | Extension structure, hooks, and data flow |
| [Hook Lifecycle](docs/hook-lifecycle.md) | How hooks intercept agent turns and tool calls |
| [State Management](docs/state-management.md) | How workflow state is tracked and persisted |
| [Testing](docs/testing.md) | Running and writing tests for the extension |
| [Contributing](docs/contributing.md) | Development setup and contribution guidelines |

## License

MIT
