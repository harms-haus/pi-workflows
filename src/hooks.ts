import type { ExtensionAPI, ExtensionContext, ToolCallEvent, BeforeAgentStartEvent, AgentEndEvent, } from "@earendil-works/pi-coding-agent";
import type { WorkflowState, WorkflowDefinition, HookStateMutation, } from "./types";
import { resolveActive, persistState, isActive } from "./state";
import { buildContextPrompt, DEFAULT_NOT_DONE_REMINDER, DEFAULT_COMPLETION_MESSAGE, DEFAULT_CANCELLED_MESSAGE } from "./prompts";
import { resolveTemplate, getBlockedTools, getWhitelist } from "./config";

// ── Status Bar ──
export function updateStatus(
  ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } },
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
): void {
  if (!isActive(state)) {
    ctx.ui.setStatus("workflow", undefined);
    return;
  }
  const active = resolveActive(state, definitions);
  if (!active) {
    ctx.ui.setStatus("workflow", undefined);
    return;
  }
  const phase = active.currentPhase;
  const total = active.definition.phases.length;
  const current = state.currentPhaseIndex + 1;
  ctx.ui.setStatus("workflow", `${phase.emoji} ${phase.name} [${current}/${total}]`);
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
export function handleAgentEnd(
  pi: ExtensionAPI,
  state: WorkflowState | null,
  definitions: Record<string, WorkflowDefinition>,
  ctx: ExtensionContext,
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
    const active = resolveActive(state, definitions);
    if (!active) return noOp;
    const { definition, currentPhase } = active;
    const reminder = resolveTemplate(
      definition.notDoneReminder ?? DEFAULT_NOT_DONE_REMINDER,
      { workflowName: definition.name, phaseName: currentPhase.name, phaseEmoji: currentPhase.emoji, phaseInstructions: currentPhase.instructions, taskDescription: state.taskDescription, taskId: state.taskId, workflowKey: state.workflowKey, },
    );
    pi.sendUserMessage(reminder, { deliverAs: "followUp" });
    return noOp;
  }
  return noOp;
}
