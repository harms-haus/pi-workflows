import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowState, SetState, ReloadDefinitions, PhaseEntry } from "./types";
import { isSubworkflowRef, isPhaseDefinition } from "./types";
import { createInitialState, persistState, isActive, resolveActive } from "./state";
import { loadWorkflows, findWorkflowByCommandName, resolveTemplate } from "./config";

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
    async getArgumentCompletions(prefix: string) {
      const workflows = await loadWorkflows();
      const names = Object.values(workflows)
        .filter((w) => (w.show ?? "user") === "user")
        .map((w) => w.commandName);
      const filtered = names.filter((n) => n.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((n) => ({ value: n, label: n })) : null;
    },
    handler: async (args, ctx) => {
      // Parse: split on first whitespace to get commandName and description
      const parts = args?.trim().match(/^(\S+)\s*(.*)/s);
      if (!parts) {
        // No args — show available workflows
        const workflows = await loadWorkflows(ctx.cwd);
        const entries = Object.entries(workflows)
          .filter(([_key, def]) => (def.show ?? "user") === "user")
          .map(([_key, def]) => `  ${def.commandName} — ${def.name}`);
        ctx.ui.notify(
          "Usage: /workflow {name} {description}\n\nAvailable workflows:\n" + entries.join("\n"),
          "info",
        );
        return;
      }

      const [, commandName, description] = parts;
      if (!description || description.trim() === "") {
        ctx.ui.notify(`Usage: /workflow ${commandName} {description}`, "warning");
        return;
      }

      // Reload definitions to get latest
      const definitions = await reloadDefinitions();

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
        const existingDesc = state?.taskDescription ?? "unknown";
        const ok = await ctx.ui.confirm(
          "Workflow already active",
          `Phase: ${phaseName}\nTask: ${existingDesc}\n\nStart a new one?`,
        );
        if (!ok) return;
      }

      // Create new state
      const newState = createInitialState(workflowKey, description.trim());
      setState(newState);
      persistState(pi, newState);

      // Update status
      ctx.ui.setStatus("workflow", undefined); // Will be set by turn_end hook after first turn

      // Set session name
      const prefix = definition.sessionNamePrefix ?? "Workflow: ";
      const maxLen = definition.sessionNameMaxLength ?? 50;
      pi.setSessionName(
        `${prefix}${description.trim().slice(0, maxLen)}${description.trim().length > maxLen ? "…" : ""}`,
      );

      // Resolve and send initial message
      let firstPhaseEntry: PhaseEntry = definition.phases[0];
      while (isSubworkflowRef(firstPhaseEntry)) {
        if (!firstPhaseEntry.resolved) break;
        firstPhaseEntry = firstPhaseEntry.resolved.phases[0];
      }
      if (!isPhaseDefinition(firstPhaseEntry)) {
        ctx.ui.notify("Could not resolve first phase of workflow.", "error");
        return;
      }
      const firstPhase = firstPhaseEntry;
      const initialMessage = resolveTemplate(definition.initialMessage, {
        workflowName: definition.name,
        workflowKey,
        description: description.trim(),
        firstPhaseId: firstPhase.id,
        firstPhaseName: firstPhase.name,
        firstPhaseEmoji: firstPhase.emoji,
        firstPhaseProfiles: firstPhase.availableProfiles?.join(", ") ?? "(none)",
      });
      pi.sendUserMessage(initialMessage);
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
    handler: async (_args, ctx) => {
      const state = getState();
      if (!state || !state.active) {
        ctx.ui.notify("No active workflow to cancel.", "info");
        return;
      }

      // Jump straight to DONE state
      const doneState: WorkflowState = {
        ...state,
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
    },
  });
}
