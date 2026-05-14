import type { ExtensionAPI, ExtensionContext, ToolCallEvent, AgentEndEvent, } from "@earendil-works/pi-coding-agent";
import type { WorkflowState, WorkflowDefinition, HookStateMutation, } from "./types";
import { resolveActive, isActive } from "./state";
import { buildContextPrompt, DEFAULT_NOT_DONE_REMINDER, DEFAULT_COMPLETION_MESSAGE, DEFAULT_CANCELLED_MESSAGE } from "./prompts";
import { resolveTemplate, getBlockedTools, getWhitelist } from "./config";

// Module-level countdown handle — prevents stacked intervals when agent_end
// fires while a previous countdown is still active (race condition guard).
let activeCountdown: ReturnType<typeof setInterval> | null = null;

/** Clear any active countdown interval and widget. Called from session_start/session_tree handlers. */
export function clearActiveCountdown(ctx: ExtensionContext): void {
  if (activeCountdown !== null) {
    clearInterval(activeCountdown);
    activeCountdown = null;
  }
  if (ctx.hasUI) {
    ctx.ui.setWidget("workflow-countdown", undefined);
  }
}

// ── Status Bar ──
export function updateStatus(
  ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } },
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
): void {
  if (!state || !state.active) {
    ctx.ui.setStatus("workflow", undefined);
    return;
  }
  const active = resolveActive(state, definitions);
  if (!active) {
    ctx.ui.setStatus("workflow", undefined);
    return;
  }
  const phase = active.currentPhase;
  let statusText: string;
  if (state.currentPath.length === 1) {
    // Linear workflow — keep existing format
    const total = active.definition.phases.length;
    const current = state.currentPath[0].phaseIndex + 1;
    const name = active.definition.name;
    statusText = `${name} — ${phase.emoji} ${phase.name} [${current}/${total}]`;
  } else {
    // Nested workflow — breadcrumb format with inner scope progress
    const top = state.currentPath[state.currentPath.length - 1];
    const innerDef = definitions[top.workflowKey];
    const innerTotal = innerDef?.phases.length ?? 0;
    const innerCurrent = top.phaseIndex + 1;
    const breadcrumbNames = active.breadcrumb.slice(0, -1).map((b) => b.name).join(" > ");
    const innerName = active.breadcrumb[active.breadcrumb.length - 1]?.name ?? "";
    statusText = `${breadcrumbNames} > ${innerName} — ${phase.emoji} ${phase.name} [${innerCurrent}/${innerTotal}]`;
  }
  ctx.ui.setStatus("workflow", statusText);
}

// ── tool_call Hook ──
export function handleToolCall(
  event: ToolCallEvent,
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
): { block: true; reason: string } | void {
  if (!isActive(state)) return;
  const active = resolveActive(state, definitions);
  if (!active) return;
  const toolName = event.toolName;
  // Always allow workflow_step
  if (toolName === "workflow_step") return;
  const phase = active.currentPhase;
  const toolConfig = phase.tools;
  if (!toolConfig) return; // No tool restrictions for this phase
  const definition = active.definition;
  const blockedTools = getBlockedTools(phase);
  const whitelist = getWhitelist(phase);
  if (toolConfig.blacklist && blockedTools.includes(toolName)) {
    return { block: true, reason: resolveTemplate(
      definition.blockReasonTemplate ?? DEFAULT_BLOCK_REASON,
      { workflowName: definition.name, phaseName: phase.name, toolName, allowedTools: "all except: " + blockedTools.join(", "), },
    ), };
  }
  if (toolConfig.whitelist && whitelist && !whitelist.includes(toolName)) {
    return { block: true, reason: resolveTemplate(
      definition.blockReasonTemplate ?? DEFAULT_BLOCK_REASON,
      { workflowName: definition.name, phaseName: phase.name, toolName, allowedTools: whitelist.join(", "), },
    ), };
  }
}

const DEFAULT_BLOCK_REASON = `[workflow] The tool "{toolName}" is blocked during the {phaseName} phase.\n` +
  `Refer to the current phase instructions for allowed tools and approaches.\n` +
  `When finished, call workflow_step to advance to the next phase.`;

// ── before_agent_start Hook ──
export function handleBeforeAgentStart(
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
): { message: { customType: string; content: string; display: boolean } } | void {
  if (!isActive(state)) return;
  const active = resolveActive(state, definitions);
  if (!active) return;
  const prompt = buildContextPrompt(active);
  return { message: { customType: "workflow:context", content: prompt, display: false, }, };
}

// ── agent_end Hook ──

/**
 * Check if the last assistant message in the agent_end event was aborted
 * (i.e., the user interrupted the agent). Returns true if the agent was
 * interrupted, false if it stopped naturally.
 */
function wasAborted(messages: AgentEndEvent["messages"]): boolean {
  // Walk messages in reverse to find the last assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      return msg.stopReason === "aborted";
    }
  }
  // No assistant message found — shouldn't happen, but treat as not aborted
  return false;
}

export function handleAgentEnd(
  pi: ExtensionAPI,
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
  ctx: ExtensionContext,
  event: AgentEndEvent,
): HookStateMutation {
  const noOp: HookStateMutation = { unload: false, persist: false };
  if (!state) return noOp;
  // Case A: Workflow just reached DONE (not yet notified)
  if (!state.active && !state.completionNotified) {
    if (state.cancelled) {
      // Cancellation — send cancelled message and unload
      const definition = definitions[state.workflowKey];
      if (definition) {
        const msg = resolveTemplate(
          definition.completionMessage ?? DEFAULT_CANCELLED_MESSAGE,
          { workflowName: definition.name, taskDescription: state.taskDescription, taskId: state.taskId, phaseCount: String(definition.phases.length), },
        );
        pi.sendMessage(
          { customType: "workflow:complete", content: msg, display: true },
          { triggerTurn: false },
        );
      }
      ctx.ui.setStatus("workflow", undefined);
      return { unload: true, persist: false };
    }
    // Normal completion
    const definition = definitions[state.workflowKey];
    if (definition) {
      const msg = resolveTemplate(
        definition.completionMessage ?? DEFAULT_COMPLETION_MESSAGE,
        { workflowName: definition.name, taskDescription: state.taskDescription, taskId: state.taskId, phaseCount: String(definition.phases.length), },
      );
      pi.sendMessage(
        { customType: "workflow:complete", content: msg, display: true },
        { triggerTurn: false },
      );
    }
    state.completionNotified = true;
    ctx.ui.setStatus("workflow", undefined);
    return { unload: true, persist: true };
  }
  // Case B: Workflow is still active (agent tried to stop mid-workflow)
  if (state.active) {
    // If the user interrupted the agent, don't enforce continuation
    if (wasAborted(event.messages)) {
      return noOp;
    }
    const active = resolveActive(state, definitions);
    if (!active) return noOp;
    const { definition, currentPhase } = active;
    const reminder = resolveTemplate(
      definition.notDoneReminder ?? DEFAULT_NOT_DONE_REMINDER,
      { workflowName: definition.name, phaseName: currentPhase.name, phaseEmoji: currentPhase.emoji, phaseInstructions: currentPhase.instructions, taskDescription: state.taskDescription, taskId: state.taskId, workflowKey: state.workflowKey, },
    );
    // Show live countdown widget and auto-continue after 3 seconds
    if (ctx.hasUI) {
      // Clear any existing countdown to prevent stacked intervals
      if (activeCountdown !== null) { clearInterval(activeCountdown); }

      let remaining = 3;
      const interval = setInterval(() => {
        try {
          remaining--;
          if (remaining > 0) {
            ctx.ui.setWidget("workflow-countdown", [
              `⏳ Auto-continuing in ${remaining}s... (type anything to interrupt)`,
            ], { placement: "aboveEditor" });
          } else {
            clearInterval(interval);
            activeCountdown = null;
            ctx.ui.setWidget("workflow-countdown", undefined);
            try {
              pi.sendUserMessage(reminder);
            } catch {
              // User already started typing — skip auto-continue
            }
          }
        } catch {
          clearInterval(interval);
          activeCountdown = null;
          ctx.ui.setWidget("workflow-countdown", undefined);
        }
      }, 1000);
      activeCountdown = interval;

      // Show initial widget immediately (3s)
      ctx.ui.setWidget("workflow-countdown", [
        "⏳ Auto-continuing in 3s... (type anything to interrupt)",
      ], { placement: "aboveEditor" });
    } else {
      // Fallback for RPC/print mode — no UI available
      pi.sendMessage(
        { customType: "workflow:countdown", content: "Auto-continuing workflow in 3s... (type anything to interrupt)", display: true },
        { triggerTurn: false },
      );
      setTimeout(() => {
        try {
          pi.sendUserMessage(reminder);
        } catch {
          // User already started typing — skip auto-continue
        }
      }, 3000);
    }
    return noOp;
  }
  return noOp;
}
