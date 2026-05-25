import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowState, SetState, ReloadDefinitions, WorkflowDefinition } from "./types";
import { isSubworkflowRef } from "./types";
import {
  createInitialState,
  persistState,
  isActive,
  resolveActive,
  autoEnterSubworkflowRefs,
  resolveFirstPhase,
} from "./state";
import { loadWorkflows, findWorkflowByCommandName, resolveTemplate } from "./config";

/** Show available workflows to the user. */
function showAvailableWorkflows(ctx: ExtensionCommandContext): void {
  const workflows = loadWorkflows(ctx.cwd);
  const entries = Object.entries(workflows)
    .filter(([_key, def]) => (def.show ?? "user") === "user")
    .map(([_key, def]) => `  ${def.commandName} — ${def.name}`);
  ctx.ui.notify(
    "Usage: /workflow {name} {description}\n\nAvailable workflows:\n" + entries.join("\n"),
    "info",
  );
}

/** Set the session name and send the initial workflow message. */
function startWorkflowSession(
  pi: ExtensionAPI,
  definition: WorkflowDefinition,
  workflowKey: string,
  description: string,
): void {
  const prefix = definition.sessionNamePrefix ?? "Workflow: ";
  const maxLen = definition.sessionNameMaxLength ?? 50;
  pi.setSessionName(
    `${prefix}${description.slice(0, maxLen)}${description.length > maxLen ? "…" : ""}`,
  );
  const firstPhase = resolveFirstPhase(definition.phases);
  if (!firstPhase) return;
  const initialMessage = resolveTemplate(definition.initialMessage, {
    workflowName: definition.name,
    workflowKey,
    description,
    firstPhaseId: firstPhase.id,
    firstPhaseName: firstPhase.name,
    firstPhaseEmoji: firstPhase.emoji,
    firstPhaseProfiles: firstPhase.availableProfiles?.join(", ") ?? "(none)",
  });
  pi.sendUserMessage(initialMessage);
}

/**
 * Register the /workflow command.
 * Usage: /workflow {commandName} {description}
 */
export function registerWorkflowCommand(
  pi: ExtensionAPI,
  getState: () => WorkflowState | null,
  reloadDefinitions: ReloadDefinitions,
  setState: SetState,
): void {
  pi.registerCommand("workflow", {
    description: "Start a configured workflow. Usage: /workflow {name} {description}",
    getArgumentCompletions(prefix: string) {
      const workflows = loadWorkflows();
      const names = Object.values(workflows)
        .filter((w) => (w.show ?? "user") === "user")
        .map((w) => w.commandName);
      const filtered = names.filter((n) => n.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((n) => ({ value: n, label: n })) : null;
    },
    handler: async (args, ctx) => {
      // Parse: split on first whitespace to get commandName and description
      const input = typeof args === "string" ? args : "";
      const parts = input.trim().match(/^(\S+)\s*(.*)/s);
      if (!parts) {
        showAvailableWorkflows(ctx);
        return;
      }

      const commandName = parts[1];
      const description = parts[2];
      if (commandName === undefined || description === undefined) {
        showAvailableWorkflows(ctx);
        return;
      }
      if (!description || description.trim() === "") {
        ctx.ui.notify(`Usage: /workflow ${commandName} {description}`, "warning");
        return;
      }

      // Reload definitions to get latest
      const definitions = await reloadDefinitions(ctx.cwd);

      // Find the workflow
      const match = findWorkflowByCommandName(definitions, commandName);
      if (!match) {
        const available = Object.values(definitions)
          .map((d) => d.commandName)
          .join(", ");
        ctx.ui.notify(
          `Unknown workflow: "${commandName}". Available: ${available || "(none)"}`,
          "error",
        );
        return;
      }

      const [workflowKey, definition] = match;

      // Safety check: reject workflows not shown to users
      if (definition.show === "workflows") {
        ctx.ui.notify(
          `"${commandName}" is a subworkflow that can only run as part of another workflow. It cannot be started directly.`,
          "error",
        );
        return;
      }
      const state = getState();

      // Check for existing active workflow
      if (isActive(state)) {
        const active = resolveActive(state, definitions);
        const phaseName = active ? active.currentPhase.name : "unknown";
        const existingDesc = state.taskDescription;
        const ok = await ctx.ui.confirm(
          "Workflow already active",
          `Phase: ${phaseName}\nTask: ${existingDesc}\n\nStart a new one?`,
        );
        if (!ok) return;
      }

      // Create new state
      const newState = createInitialState(workflowKey, description.trim());

      // Auto-enter subworkflow if first phase is a SubworkflowRef
      const firstEntry = definition.phases[0];
      let stateToSet = newState;
      if (isSubworkflowRef(firstEntry)) {
        const { newState: enteredState } = autoEnterSubworkflowRefs(newState, firstEntry);
        stateToSet = enteredState;
      }

      setState(stateToSet);
      persistState(pi, stateToSet);
      ctx.ui.setStatus("workflow", undefined);
      startWorkflowSession(pi, definition, workflowKey, description.trim());
    },
  });
}

/**
 * Register the /cancel-workflow command.
 * Immediately jumps the active workflow to DONE, bypassing the not-done reminder loop.
 */
export function registerCancelWorkflowCommand(
  pi: ExtensionAPI,
  getState: () => WorkflowState | null,
  setState: (s: WorkflowState | null) => void,
): void {
  pi.registerCommand("cancel-workflow", {
    description:
      "Cancel the active workflow and jump to DONE. Bypasses the not-done reminder loop.",
    handler: (_args, ctx) => {
      const state = getState();
      if (!state || !state.active) {
        ctx.ui.notify("No active workflow to cancel.", "info");
        return Promise.resolve();
      }

      // Jump straight to DONE state
      const doneState: WorkflowState = {
        ...state,
        currentPath: state.currentPath.map((seg) => ({ ...seg })),
        active: false,
        cancelled: true,
        completionNotified: false,
      };

      // Persist so session resume knows it was cancelled
      persistState(pi, doneState);

      // Clear the status
      ctx.ui.setStatus("workflow", undefined);

      // Send cancellation notification immediately (bypass agent_end hook)
      const msg = `❌ **Workflow Cancelled**\n\n**Task:** ${state.taskDescription}\n**Task ID:** ${state.taskId}`;
      pi.sendMessage(
        { customType: "workflow:complete", content: msg, display: true },
        { triggerTurn: false },
      );

      // Unload immediately so agent_end hook sees null state and does nothing
      setState(null);

      ctx.ui.notify("Workflow cancelled.", "info");
      return Promise.resolve();
    },
  });
}
