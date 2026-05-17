import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type {
  WorkflowState,
  GetState,
  SetState,
  GetDefinitions,
  WorkflowDefinition,
} from "./types";
import { advancePhase, persistState, resolveActive, isActive, loopPhase } from "./state";

// ── Shared Utility Functions ──

/** Create a typed text content object (ensures `type` is narrowed to "text" literal). */
function textPart(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

/** Standard "no active workflow" response, with an optional description message. */
function noActiveWorkflowResponse(description?: string) {
  const text =
    description ?? "No active workflow. Use /workflow {name} {description} to start one.";
  return {
    content: [textPart(text)],
    details: { active: false },
  };
}

/** Deep-clone a WorkflowState (copies the mutable currentPath array). */
function cloneState(state: WorkflowState): WorkflowState {
  return {
    ...state,
    currentPath: state.currentPath.map((s) => ({ ...s })),
  };
}

// ── Action Handlers ──

/** Handle the "status" action: return current workflow status. */
function handleStatus(
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
) {
  if (!state || !state.active) {
    return noActiveWorkflowResponse();
  }
  const active = resolveActive(state, definitions);
  if (!active) {
    return {
      content: [
        textPart(
          "The workflow configuration for this session is no longer available. Use workflow_step with action='cancel' to clear it, or reload the workflow definitions.",
        ),
      ],
      details: { active: false, stale: true },
    };
  }
  const { definition, currentPhase, breadcrumb } = active;
  const top = state.currentPath[state.currentPath.length - 1];
  const topDef = definitions[top.workflowKey];
  const total = topDef.phases.length;
  const current = top.phaseIndex + 1;
  const lines: string[] = [];
  lines.push(`**Workflow:** ${definition.name} (${state.workflowKey})`);
  lines.push(`**Task ID:** ${state.taskId}`);
  lines.push(`**Description:** ${state.taskDescription}`);
  if (state.currentPath.length > 1) {
    // Nested: show breadcrumb path with inner scope progress
    const breadcrumbStr = breadcrumb.map((b) => b.name).join(" > ");
    lines.push(`**Path:** ${breadcrumbStr}`);
    lines.push(
      `**Phase:** ${currentPhase.emoji} ${currentPhase.name} [${current}/${total}] (step ${state.globalStepCount})`,
    );
  } else {
    // Linear: keep existing format
    lines.push(`**Phase:** ${currentPhase.emoji} ${currentPhase.name} [${current}/${total}]`);
  }
  lines.push(`**Started:** ${new Date(state.startedAt).toISOString()}`);
  lines.push("");
  lines.push("**What to do:**");
  lines.push(currentPhase.instructions);
  const profiles = currentPhase.availableProfiles;
  lines.push("");
  lines.push(`**Available profiles:** ${profiles?.join(", ") ?? "(none)"}`);
  return {
    content: [textPart(lines.join("\n"))],
    details: { active: true, workflowKey: state.workflowKey, currentPath: state.currentPath },
  };
}

/** Handle the "cancel" action: two-step confirmation then cancel. */
function handleCancel(
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
  getState: GetState,
  setState: SetState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
) {
  if (!isActive(state)) {
    return noActiveWorkflowResponse("No active workflow to cancel.");
  }
  // Two-step cancellation: first call requests confirmation, second call within the same turn confirms
  if (!state._cancelPending) {
    // Intentionally mutate shared state without persisting — the _cancelPending flag
    // acts as a volatile confirmation marker for the two-step cancel flow.
    // It will be persisted only if the user confirms cancellation on the next call.
    state._cancelPending = true;
    return {
      content: [
        textPart(
          `⚠️ **Confirm cancellation** of workflow "${state.taskDescription}"?\nCall workflow_step with action='cancel' again to confirm. This cannot be undone.`,
        ),
      ],
      details: { active: true, cancelPending: true },
    };
  }
  const newState: WorkflowState = {
    ...cloneState(state),
    active: false,
    cancelled: true,
    completionNotified: false,
  };
  setState(newState);
  persistState(pi, newState);
  ctx.ui.setStatus("workflow", undefined);
  return {
    content: [textPart(`Workflow cancelled: "${state.taskDescription}"`)],
    details: { active: false, cancelled: true },
  };
}

/** Handle the "next" action: advance phase, with subworkflow enter/done detection. */
function handleNext(
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
  summary: string,
  getState: GetState,
  setState: SetState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
) {
  if (!isActive(state)) {
    return noActiveWorkflowResponse();
  }
  const active = resolveActive(state, definitions);
  if (!active) {
    return {
      content: [textPart(`Workflow definition '${state.workflowKey}' not found.`)],
      details: { active: false },
    };
  }
  const { currentPhase } = active;
  const pathLenBefore = state.currentPath.length;
  const result = advancePhase(state, definitions);
  if (!result.advanced) {
    return {
      content: [textPart(`Could not advance: ${currentPhase.name}`)],
      details: { active: true },
    };
  }
  // Workflow completed (top-level done)
  if (result.to === null) {
    const newState: WorkflowState = {
      ...cloneState(state),
      active: false,
      completionNotified: false,
    };
    setState(newState);
    persistState(pi, newState);
    ctx.ui.setStatus("workflow", undefined);
    return {
      content: [textPart(`✓ Advanced: ${currentPhase.name} → DONE\n\n🎉 **All phases complete!**`)],
      details: { advanced: true, from: currentPhase.name, to: "DONE" },
    };
  }

  // Re-resolve to get the new current phase
  const newActive = resolveActive(state, definitions);
  if (!newActive) {
    return {
      content: [textPart("Error: could not resolve active workflow after advance.")],
      details: {},
    };
  }
  persistState(pi, state);
  ctx.ui.setStatus("workflow", undefined); // Will be re-set by turn_end hook

  const pathLenAfter = state.currentPath.length;
  let advanceVerb = "Advanced";
  if (pathLenAfter > pathLenBefore) {
    // Entered a subworkflow — name it
    const subName =
      newActive.breadcrumb.length > 0
        ? newActive.breadcrumb[newActive.breadcrumb.length - 1].name
        : "subworkflow";
    advanceVerb = `Entered subworkflow '${subName}'`;
  } else if (pathLenAfter < pathLenBefore) {
    // Exited a subworkflow — show where we returned to
    const parentBreadcrumb = newActive.breadcrumb.map((b) => b.name).join(" > ");
    advanceVerb = `Exited subworkflow, returning to ${parentBreadcrumb}`;
  }

  return {
    content: [
      textPart(
        `✓ ${advanceVerb}: ${currentPhase.name} → ${newActive.currentPhase.emoji} ${newActive.currentPhase.name}\n\n` +
          `**What to do in ${newActive.currentPhase.name}:**\n` +
          newActive.currentPhase.instructions,
      ),
    ],
    details: { advanced: true, from: currentPhase.name, to: newActive.currentPhase.name },
  };
}

/** Handle the "loop" action: restart the current scope from phase 0. */
function handleLoop(
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
  getState: GetState,
  setState: SetState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
) {
  if (!isActive(state)) {
    return {
      content: [textPart("No active workflow to loop.")],
      details: { active: false },
    };
  }
  const result = loopPhase(state, definitions);
  if ("error" in result) {
    return {
      content: [textPart(`⚠️ ${result.error}`)],
      details: { active: true, error: result.error },
    };
  }
  persistState(pi, state);
  const newActive = resolveActive(state, definitions);
  if (!newActive) {
    return {
      content: [textPart("Error: could not resolve active workflow after loop.")],
      details: {},
    };
  }
  ctx.ui.setStatus("workflow", undefined); // will be re-set by turn_end
  // Identify which scope was looped
  const loopedScopeName =
    newActive.breadcrumb.length > 0
      ? newActive.breadcrumb[newActive.breadcrumb.length - 1].name
      : "workflow";
  return {
    content: [
      textPart(
        `🔄 Looped '${loopedScopeName}' back to: ${newActive.currentPhase.emoji} ${newActive.currentPhase.name}\n\n` +
          `**What to do in ${newActive.currentPhase.name}:**\n` +
          newActive.currentPhase.instructions,
      ),
    ],
    details: { looped: true, to: result.to },
  };
}

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
      "Show current workflow status, advance to the next phase, loop back to the start of the current scope, or cancel the active workflow. " +
      "Use this to coordinate any configured workflow.",
    parameters: Type.Object({
      action: StringEnum(["next", "status", "cancel", "loop"] as const, {
        description:
          '"next" to advance to the next phase, "status" to check current state, "cancel" to abort the workflow, "loop" to restart the current scope from phase 0',
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
      "Use workflow_step with action='loop' to restart the current scope from the beginning.",
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await Promise.resolve();
      const state = getState();
      const definitions = getDefinitions();

      switch (params.action) {
        case "status":
          return handleStatus(state, definitions);
        case "cancel":
          return handleCancel(state, definitions, getState, setState, pi, ctx);
        case "next":
          return handleNext(state, definitions, params.summary ?? "", getState, setState, pi, ctx);
        case "loop":
          return handleLoop(state, definitions, getState, setState, pi, ctx);
        default:
          return {
            content: [textPart(`Unknown action: ${params.action as string}`)],
            details: {},
          };
      }
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("workflow_step ")) + theme.fg("accent", args.action),
        0,
        0,
      );
    },
    renderResult(result, _opts, theme) {
      const text = result.content[0];
      if (text.type === "text") {
        const t = text.text;
        const isError =
          t.startsWith("⚠️") ||
          t.startsWith("Error:") ||
          t.startsWith("Could not") ||
          t.startsWith("Unknown action") ||
          t.includes("not found");
        const isCancel = t.includes("Confirm cancellation") || t.includes("cancelled");
        const isComplete = t.includes("All phases complete");
        if (isError || isCancel || isComplete) {
          return new Text(theme.fg("toolOutput", t), 0, 0);
        }
        // For next/loop/status, show just the first line (transition summary)
        // and hide the verbose phase instructions below
        const firstLine = t.split("\n")[0];
        if (firstLine) {
          return new Text(theme.fg("toolOutput", firstLine), 0, 0);
        }
      }
      return new Container();
    },
  });
}
