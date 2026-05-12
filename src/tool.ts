import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { WorkflowState, WorkflowDefinition, GetState, SetState, GetDefinitions, } from "./types";
import { advancePhase, persistState, resolveActive, isActive } from "./state";
import { resolveTemplate } from "./config";

/**
 * Register the workflow_step tool.
 */
export function registerWorkflowTool(
  pi: ExtensionAPI,
  getState: GetState,
  getDefinitions: GetDefinitions,
  setState: SetState,
): void {
  pi.registerTool({
    name: "workflow_step",
    label: "Workflow Step",
    description:
      "Show current workflow status, advance to the next phase, or cancel the active workflow. " +
      "Use this to coordinate any configured workflow.",
    parameters: Type.Object({
      action: StringEnum(["next", "status", "cancel"] as const, {
        description:
          '"next" to advance to the next phase, "status" to check current state, "cancel" to abort the workflow',
      }),
      summary: Type.Optional(
        Type.String({
          description: "Optional summary of what was accomplished in the current phase",
        }),
      ),
    }),
    promptSnippet: "Advance the active workflow to the next phase",
    promptGuidelines: [
      "Use workflow_step with action='next' when you finish a phase and want to advance.",
      "Use workflow_step with action='status' to check current workflow state.",
      "Use workflow_step with action='cancel' to abort the current workflow.",
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      const definitions = getDefinitions();

      // ── Status ──
      if (params.action === "status") {
        if (!state || !state.active) {
          return {
            content: [
              {
                type: "text",
                text: "No active workflow. Use /workflow {name} {description} to start one.",
              },
            ],
            details: { active: false },
          };
        }
        const active = resolveActive(state, definitions);
        if (!active) {
          return {
            content: [
              {
                type: "text",
                text: `Workflow definition '${state.workflowKey}' not found in settings. Use workflow_step with action='cancel' to clear the stale state.`,
              },
            ],
            details: { active: false, stale: true },
          };
        }
        const { definition, currentPhase } = active;
        const total = definition.phases.length;
        const current = state.currentPhaseIndex + 1;
        const lines: string[] = [];
        lines.push(`**Workflow:** ${definition.name} (${state.workflowKey})`);
        lines.push(`**Task ID:** ${state.taskId}`);
        lines.push(`**Description:** ${state.taskDescription}`);
        lines.push(`**Phase:** ${currentPhase.emoji} ${currentPhase.name} [${current}/${total}]`);
        lines.push(`**Started:** ${new Date(state.startedAt).toISOString()}`);
        lines.push("");
        lines.push("**What to do:**");
        lines.push(currentPhase.instructions);
        const profiles = currentPhase.availableProfiles;
        lines.push("");
        lines.push(`**Available profiles:** ${profiles?.join(", ") ?? "(none)"}`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { active: true, workflowKey: state.workflowKey, phaseIndex: state.currentPhaseIndex },
        };
      }

      // ── Cancel ──
      if (params.action === "cancel") {
        if (!isActive(state)) {
          return {
            content: [{ type: "text", text: "No active workflow to cancel." }],
            details: { active: false },
          };
        }
        const newState: WorkflowState = {
          ...state,
          active: false,
          cancelled: true,
          completionNotified: false,
        };
        setState(newState);
        persistState(pi, newState);
        ctx.ui.setStatus("workflow", undefined);
        return {
          content: [{ type: "text", text: `Workflow cancelled: "${state.taskDescription}"` }],
          details: { active: false, cancelled: true },
        };
      }

      // ── Next ──
      if (params.action === "next") {
        if (!isActive(state)) {
          return {
            content: [{ type: "text", text: "No active workflow. Use /workflow {name} {description} to start one." }],
            details: { active: false },
          };
        }
        const active = resolveActive(state, definitions);
        if (!active) {
          return {
            content: [{ type: "text", text: `Workflow definition '${state?.workflowKey}' not found.` }],
            details: { active: false },
          };
        }
        const { definition, currentPhase, nextPhase } = active;
        if (!nextPhase) {
          // Advancing from last phase to DONE
          const newState: WorkflowState = {
            ...state,
            active: false,
            completionNotified: false,
          };
          setState(newState);
          persistState(pi, newState);
          ctx.ui.setStatus("workflow", undefined);
          return {
            content: [
              {
                type: "text",
                text:
                  `✓ Advanced: ${currentPhase.name} → DONE\n\n` +
                  `🎉 **All ${definition.phases.length} phases complete!** ` +
                  `Call workflow_step again or wait for the completion notification.`,
              },
            ],
            details: { advanced: true, from: currentPhase.name, to: "DONE" },
          };
        }
        // Normal phase advance
        const prevState = { ...state };
        advancePhase(state, definition);
        persistState(pi, state);
        // Re-resolve to get the new current phase
        const newActive = resolveActive(state, definitions);
        if (!newActive) {
          return {
            content: [{ type: "text", text: "Error: phase index out of bounds after advance." }],
            details: {},
          };
        }
        ctx.ui.setStatus("workflow", undefined); // Will be re-set by turn_end hook
        return {
          content: [
            {
              type: "text",
              text:
                `✓ Advanced: ${currentPhase.name} → ${newActive.currentPhase.emoji} ${newActive.currentPhase.name}\n\n` +
                `**What to do in ${newActive.currentPhase.name}:**\n` +
                `${newActive.currentPhase.instructions}`,
            },
          ],
          details: { advanced: true, from: currentPhase.name, to: newActive.currentPhase.name },
        };
      }

      return {
        content: [{ type: "text", text: `Unknown action: ${params.action}` }],
        details: {},
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("workflow_step ")) + theme.fg("accent", args.action ?? "status"),
        0,
        0,
      );
    },
    renderResult(result, _opts, theme) {
      const text = result.content[0];
      return new Text(theme.fg("toolOutput", text?.type === "text" ? text.text : "(no output)"), 0, 0);
    },
  });
}
