# pi-workflows

A generic, configurable pi extension for defining and running multiple named workflows.

## Features

- **Multiple Named Workflows** — Define any number of workflows in `settings.json`
- **Configurable Phases** — Each phase has instructions, emoji, tool blacklist/whitelist, and available subagent profiles
- **`/workflow` Command** — Start any workflow with `/workflow {name} {description}`
- **Tool Enforcement** — Per-phase tool blocking via blacklist or whitelist
- **Agent Completion Blocking** — The agent cannot finish until the workflow reaches DONE
- **State Persistence** — Survives session restarts via `pi.appendEntry`
- **Powerline Widget** — Shows "{workflow name} — {emoji} {phase name} [current/total}]" during active workflow

## Installation

```bash
pi install git:github.com/harms-haus/pi-workflows
```

## Configuration

Workflows are defined in `settings.json` under `workflows.definitions`. Both global (`~/.pi/agent/settings.json`) and project-local (`.pi/settings.json`) settings are supported.

### Schema

```json
{
  "workflows": {
    "definitions": {
      "workflow-key": {
        "name": "Human-Readable Name",
        "commandName": "cmd-name",
        "initialMessage": "Template message with {variables}",
        "sessionNamePrefix": "Workflow: ",
        "sessionNameMaxLength": 50,
        "phases": [
          {
            "id": "phase-id",
            "name": "Phase Name",
            "emoji": "🔍",
            "instructions": "Instructions for this phase...",
            "tools": {
              "blacklist": ["edit", "write"]
            },
            "availableProfiles": ["profile-1", "profile-2"]
          }
        ]
      }
    }
  }
}
```

### Phase Tool Configuration

Each phase can restrict tools using either `blacklist` or `whitelist` (not both):
- **blacklist**: Block specific tools. All other tools are allowed.
- **whitelist**: Allow only specific tools. All other tools are blocked.

The `workflow_step` tool is always allowed regardless of configuration.

### Example: RPIR Workflow

```json
{
  "workflows": {
    "definitions": {
      "rpir": {
        "name": "RPIR Development Workflow",
        "commandName": "rpir",
        "initialMessage": "Start the {workflowName} for: \"{description}\"\n\nBegin with Phase 1 ({firstPhaseName}).",
        "sessionNamePrefix": "RPIR: ",
        "phases": [
          {
            "id": "research",
            "name": "Research",
            "emoji": "🔍",
            "instructions": "Spawn parallel research subagents using delegate_to_subagents with vertical-researcher and horizontal-researcher profiles.",
            "tools": { "blacklist": ["edit", "write"] },
            "availableProfiles": ["vertical-researcher", "horizontal-researcher"]
          },
          {
            "id": "planning",
            "name": "Planning",
            "emoji": "📋",
            "instructions": "Delegate to the planner subagent. Parse the plan into todos using write_todos.",
            "tools": { "blacklist": ["edit", "write"] },
            "availableProfiles": ["planner"]
          },
          {
            "id": "implementing",
            "name": "Implementing",
            "emoji": "🔨",
            "instructions": "Loop through todos. For each: start it, delegate to task-coder, review with task-reviewer, fix if needed (max 3 iterations), then complete.",
            "tools": { "blacklist": ["edit", "write"] },
            "availableProfiles": ["task-coder", "task-reviewer"]
          },
          {
            "id": "reviewing",
            "name": "Reviewing",
            "emoji": "👁️",
            "instructions": "Spawn parallel review specialists (efficiency, security, ui-ux). Present a final summary.",
            "tools": { "blacklist": ["edit", "write"] },
            "availableProfiles": ["efficiency-reviewer", "security-reviewer", "ui-ux-reviewer"]
          }
        ]
      }
    }
  }
}
```

## Usage

```
/workflow rpir Add user authentication with JWT tokens
```

Cancel the active workflow (bypasses the not-done reminder loop):
```
/cancel-workflow
```

### Tool: `workflow_step`

| Action | Description |
|--------|-------------|
| `status` | Show current workflow state |
| `next` | Advance to the next phase |
| `cancel` | Cancel the active workflow |

## License

MIT
