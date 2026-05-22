# Contributing to pi-workflows

Thank you for your interest in contributing. This guide covers everything you need to set up a development environment, understand the codebase, and submit changes.

## Development Setup

**Prerequisites:** [Node.js](https://nodejs.org/) (v20+ recommended) and npm.

```bash
git clone <repo-url>
cd pi-workflows
npm install
```

There is **no build step**. The pi framework loads TypeScript source files directly via `src/index.ts` (declared as `"main"` in `package.json`). TypeScript is used for type-checking only (`noEmit: true` in `tsconfig.json`).

**Run tests:**

```bash
npm test
```

This runs `vitest run` — tests live in `src/__tests__/` and are matched by the pattern `src/__tests__/**/*.test.ts`.

## Project Structure

```
pi-workflows/
├── src/
│   ├── index.ts              # Extension entry point & event wiring
│   ├── types.ts              # Type definitions, interfaces, type guards
│   ├── config/               # Workflow loading, validation, template resolution
│   │   ├── index.ts          #   Re-exports from sub-modules
│   │   ├── loading.ts        #   Workflow directory scanning & two-pass loading
│   │   ├── loading-parse.ts  #   Definition file parsing
│   │   ├── loading-phases.ts #   Phase extraction & ordering
│   │   ├── loading-resolve.ts#   Subworkflow & reference resolution
│   │   ├── validation.ts     #   Definition validation & cycle detection
│   │   └── templates.ts      #   Template variable resolution
│   ├── state.ts              # State creation, advancement, persistence, reconstruction
│   ├── tool.ts               # workflow_step tool registration & execution
│   ├── command.ts            # /workflow and /cancel-workflow slash commands
│   ├── hooks.ts              # Lifecycle hooks (tool_call, before_agent_start, agent_end, turn_end)
│   ├── prompts.ts            # Context injection prompt builder & default templates
│   ├── renderers.ts          # TUI message renderers for workflow events
│   ├── TimerManager.ts       # Timer lifecycle management for workflow timeouts
│   └── __tests__/
│       ├── command.test.ts
│       ├── config.test.ts
│       ├── hooks.test.ts
│       ├── index.test.ts
│       ├── prompts.test.ts
│       ├── renderers.test.ts
│       ├── setup.ts
│       ├── state.test.ts
│       ├── tool.test.ts
│       └── helpers/
│           ├── fixtures.ts
│           └── mocks.ts
├── skills/
│   └── workflow-generation/
│       └── SKILL.md          # Agent skill for generating workflow definitions
├── docs/                     # Documentation
│   ├── architecture.md
│   ├── configuration-reference.md
│   ├── contributing.md
│   ├── examples.md
│   ├── state-management.md
│   ├── subworkflows.md
│   ├── template-variables.md
│   └── testing.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

For a detailed explanation of how these modules interact, see [architecture.md](architecture.md).

## Code Style

- **TypeScript with ESM modules** — `"type": "module"` in `package.json`, `module: "ESNext"` in `tsconfig.json`.
- **Explicit return types** on all exported functions.
- **JSDoc comments** on public/exported functions describing purpose and parameters.
- **`const`** for bindings that are never reassigned; `let` only when reassignment is required.
- **No runtime build** — the project relies on `"noEmit": true` and the host framework's TypeScript loader.

Example of expected style:

```typescript
/**
 * Validate a workflow definition and return an error message if invalid.
 */
export function validateWorkflowDefinition(key: string, def: WorkflowDefinition): string | null {
  // ...
}
```

## Adding a New Feature

Follow these steps in order:

1. **Define types in `types.ts`** — Add interfaces, type aliases, and type guards. All runtime types and Zod/typebox schemas live alongside or reference these definitions.

2. **Implement in the appropriate module** — Place logic in the module that owns that domain:
   - Workflow loading/validation → `config/`
   - State manipulation → `state.ts`
   - Tool behavior → `tool.ts`
   - Slash commands → `command.ts`
   - Hook handlers → `hooks.ts`
   - Prompt text → `prompts.ts`
   - TUI rendering → `renderers.ts`

3. **Wire into `index.ts`** — The default export function receives the `ExtensionAPI` and registers everything. Import your new function and call it from the entry point, or extend an existing registration call.

4. **Add tests in `src/__tests__/`** — Create a `<module>.test.ts` file alongside the existing test files. Use vitest (`describe`, `it`, `expect`).

5. **Update documentation in `docs/`** — Add or update relevant docs to reflect the new behavior.

6. **Update `skills/workflow-generation/SKILL.md`** — If your change affects the workflow definition schema (e.g., new fields in `WorkflowDefinition`, new phase frontmatter keys, or changed directory conventions), update the skill so the agent can generate definitions that use the new features.

## PR Guidelines

- **Focused PRs** — One concern per pull request. Avoid mixing refactors, features, and documentation updates in a single PR unless tightly coupled.
- **All tests pass** — Run `npm test` before pushing. CI will validate this.
- **New features include tests** — Every new exported function or behavior change should have corresponding test coverage.
- **Docs in the same PR** — Documentation updates should accompany the code they describe, not follow in a separate PR.
- **Schema changes update SKILL.md** — If the workflow definition schema changes, the agent skill must be updated in the same PR.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](https://opensource.org/licenses/MIT), consistent with the project's `"license": "MIT"` in `package.json`.
