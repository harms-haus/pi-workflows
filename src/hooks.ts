import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  AgentEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { WorkflowState, WorkflowDefinition, HookStateMutation } from "./types";
import { isSubworkflowRef } from "./types";
import { resolveActive, isActive, phaseEntryName } from "./state";
import { buildContextPrompt, DEFAULT_NOT_DONE_REMINDER } from "./prompts";
import { resolveTemplate, getBlockedTools, getWhitelist } from "./config";
import { timerManager } from "./TimerManager";

// ── Status Bar ──
export function updateStatus(
  ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } },
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
): void {
  if (
    !state ||
    !state.active ||
    state.currentPath.length === 0 ||
    !state.currentPath[0] ||
    !(state.currentPath[0].workflowKey in definitions)
  ) {
    ctx.ui.setStatus("workflow", undefined);
    return;
  }
  const parts: string[] = [];

  // First part: top-level workflow name only (no progress)
  const topDef = definitions[state.currentPath[0].workflowKey];
  if (!topDef) return;
  parts.push(topDef.name);

  // For each path segment, show progress at that level
  for (let i = 0; i < state.currentPath.length; i++) {
    const seg = state.currentPath[i];
    const segDef = seg ? definitions[seg.workflowKey] : undefined;
    if (!seg || !segDef) {
      ctx.ui.setStatus("workflow", undefined);
      return;
    }
    const entry = seg.phaseIndex < segDef.phases.length ? segDef.phases[seg.phaseIndex] : null;
    if (!entry) {
      ctx.ui.setStatus("workflow", undefined);
      return;
    }
    const current = seg.phaseIndex + 1;
    const total = segDef.phases.length;

    if (isSubworkflowRef(entry)) {
      parts.push(`${phaseEntryName(entry)} [${current}/${total}]`);
    } else {
      parts.push(`${entry.emoji} ${entry.name} [${current}/${total}]`);
    }
  }

  const statusText = parts.join(" > ");
  ctx.ui.setStatus("workflow", statusText);
}

// ── tool_call Hook ──
export function handleToolCall(
  event: ToolCallEvent,
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
): { block: true; reason: string } | undefined {
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
    return {
      block: true,
      reason: resolveTemplate(definition.blockReasonTemplate ?? DEFAULT_BLOCK_REASON, {
        workflowName: definition.name,
        phaseName: phase.name,
        toolName,
        allowedTools: "all except: " + blockedTools.join(", "),
      }),
    };
  }
  if (toolConfig.whitelist && whitelist && !whitelist.includes(toolName)) {
    return {
      block: true,
      reason: resolveTemplate(definition.blockReasonTemplate ?? DEFAULT_BLOCK_REASON, {
        workflowName: definition.name,
        phaseName: phase.name,
        toolName,
        allowedTools: whitelist.join(", "),
      }),
    };
  }
  return undefined;
}

const DEFAULT_BLOCK_REASON =
  `[workflow] The tool "{toolName}" is blocked during the {phaseName} phase.\n` +
  `Refer to the current phase instructions for allowed tools and approaches.\n` +
  `When finished, call workflow_step to advance to the next phase.`;

// ── before_agent_start Hook ──
export function handleBeforeAgentStart(
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
): { message: { customType: string; content: string; display: boolean } } | undefined {
  if (!isActive(state)) return;
  const active = resolveActive(state, definitions);
  if (!active) return;
  const prompt = buildContextPrompt(active);
  return { message: { customType: "workflow:context", content: prompt, display: false } };
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
    if (!msg) continue;
    if (msg.role === "assistant") {
      return (msg as { stopReason?: string }).stopReason === "aborted";
    }
  }
  // No assistant message found — shouldn't happen, but treat as not aborted
  return false;
}

/** Start a countdown widget that auto-continues after a delay. */
function startCountdown(pi: ExtensionAPI, ctx: ExtensionContext, reminder: string): void {
  if (ctx.hasUI) {
    // Capture ui reference to guard against stale ctx in callbacks
    const ui = ctx.ui;

    let remaining = 3;
    timerManager.startInterval(1000, () => {
      try {
        remaining--;
        if (remaining > 0) {
          ui.setWidget(
            "workflow-countdown",
            [`⏳ Auto-continuing in ${remaining}s... (type anything to interrupt)`],
            { placement: "aboveEditor" },
          );
        } else {
          timerManager.clearAll();
          ui.setWidget("workflow-countdown", undefined);
          try {
            pi.sendUserMessage(reminder);
          } catch {
            // User already started typing — skip auto-continue
          }
        }
      } catch {
        timerManager.clearAll();
        ui.setWidget("workflow-countdown", undefined);
      }
    });

    ui.setWidget(
      "workflow-countdown",
      ["⏳ Auto-continuing in 3s... (type anything to interrupt)"],
      { placement: "aboveEditor" },
    );
  } else {
    pi.sendMessage(
      {
        customType: "workflow:countdown",
        content: "Auto-continuing workflow in 3s... (type anything to interrupt)",
        display: true,
      },
      { triggerTurn: false },
    );
    timerManager.startTimeout(3000, () => {
      try {
        pi.sendUserMessage(reminder);
      } catch {
        // User already started typing — skip auto-continue
      }
    });
  }
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
    const definition = definitions[state.workflowKey];
    if (!definition) return noOp;
    const mutatedState = { ...state, completionNotified: true };
    ctx.ui.setStatus("workflow", undefined);
    return { unload: true, persist: true, state: mutatedState };
  }
  // Case B: Workflow is still active (agent tried to stop mid-workflow)
  if (state.active) {
    if (wasAborted(event.messages)) {
      return noOp;
    }
    const active = resolveActive(state, definitions);
    if (!active) return noOp;
    const { definition, currentPhase } = active;
    const reminder = resolveTemplate(definition.notDoneReminder ?? DEFAULT_NOT_DONE_REMINDER, {
      workflowName: definition.name,
      phaseName: currentPhase.name,
      phaseEmoji: currentPhase.emoji,
      phaseInstructions: currentPhase.instructions,
      taskDescription: state.taskDescription,
      taskId: state.taskId,
      workflowKey: state.workflowKey,
    });
    startCountdown(pi, ctx, reminder);
    return noOp;
  }
  return noOp;
}
