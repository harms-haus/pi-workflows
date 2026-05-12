import type { ActiveWorkflow } from "./types";
import { resolveTemplate, getBlockedTools } from "./config";

// ── Defaults ──
const DEFAULT_ROLE_INSTRUCTION =
  "You are the ORCHESTRATOR for this workflow. You must NOT use the edit or write tools directly. " +
  "All implementation work must be delegated to subagents via the delegate_to_subagents tool. " +
  "Follow the phase instructions precisely.";

const DEFAULT_ADVANCE_REMINDER =
  "When you finish this phase, call the workflow_step tool to advance to the next phase.";

// ── Prompt Builder ──

/**
 * Build the context injection prompt for the current phase.
 * This prompt is injected as a hidden message before each agent turn.
 */
export function buildContextPrompt(active: ActiveWorkflow): string {
  const { definition, state, currentPhase, nextPhase } = active;
  const profiles = currentPhase.availableProfiles ?? [];
  const allProfileNames = collectAllProfiles(definition);
  const blockedTools = getBlockedTools(currentPhase);

  const vars: Record<string, string> = {
    workflowName: definition.name,
    workflowKey: state.workflowKey,
    description: state.taskDescription,
    taskId: state.taskId,
    phaseId: currentPhase.id,
    phaseName: currentPhase.name,
    previousPhaseName: getPreviousPhaseName(definition, state.currentPhaseIndex),
    nextPhaseName: nextPhase ? nextPhase.name : "DONE",
    blockedToolsList: blockedTools.length > 0 ? blockedTools.join(", ") : "(none)",
    toolName: "workflow_step",
  };

  const roleInstruction = resolveTemplate(
    definition.roleInstruction ?? DEFAULT_ROLE_INSTRUCTION,
    vars,
  );

  const phaseInstructions = resolveTemplate(currentPhase.instructions, vars);

  const advanceReminder = resolveTemplate(
    definition.advanceReminder ?? DEFAULT_ADVANCE_REMINDER,
    { ...vars, nextPhaseName: nextPhase ? nextPhase.name : "DONE" },
  );

  const progress = `**Progress:** ${state.currentPhaseIndex + 1}/${definition.phases.length} phases`;

  const lines: string[] = [];
  lines.push(`[${definition.name} ACTIVE — Phase: ${currentPhase.emoji} ${currentPhase.name}]`);
  lines.push("");
  lines.push(roleInstruction);
  lines.push("");
  lines.push(`**Task:** ${state.taskDescription}`);
  lines.push(`**Task ID:** ${state.taskId}`);
  lines.push(`**Current Phase:** ${currentPhase.emoji} ${currentPhase.name}`);
  lines.push(progress);
  lines.push("");
  lines.push("**What to do in this phase:**");
  lines.push(phaseInstructions);
  lines.push("");
  lines.push(`**Available subagent profiles for this phase:** ${profiles.join(", ") || "(none)"}`);
  lines.push(`**All profiles:** ${allProfileNames.join(", ")}`);
  lines.push("");
  lines.push(advanceReminder);

  return lines.join("\n");
}

/**
 * Collect all unique profile names across all phases in a workflow.
 */
function collectAllProfiles(definition: { phases: Array<{ availableProfiles?: string[] }> }): string[] {
  const seen = new Set<string>();
  for (const phase of definition.phases) {
    if (phase.availableProfiles) {
      for (const p of phase.availableProfiles) {
        seen.add(p);
      }
    }
  }
  return Array.from(seen);
}

/**
 * Get the name of the previous phase, or "(start)" if this is the first phase.
 */
function getPreviousPhaseName(
  definition: { phases: Array<{ name: string }> },
  currentIndex: number,
): string {
  if (currentIndex <= 0) return "(start)";
  return definition.phases[currentIndex - 1].name;
}

// ── Default messages for agent_end hook ──
export const DEFAULT_NOT_DONE_REMINDER =
  "⚠️ The {workflowName} is still active. Current phase: {phaseEmoji} {phaseName}.\n\n" +
  "You must NOT stop yet. The workflow requires you to complete the current phase " +
  "and call workflow_step to advance.\n\n" +
  "Current phase instructions:\n{phaseInstructions}\n\n" +
  "Continue working on the current phase and call workflow_step when done.";

export const DEFAULT_COMPLETION_MESSAGE =
  "✅ **{workflowName} Complete**\n\n" +
  "**Task:** {taskDescription}\n" +
  "**Task ID:** {taskId}\n" +
  "**Phases completed:** {phaseCount}";

export const DEFAULT_CANCELLED_MESSAGE =
  "❌ **{workflowName} Cancelled**\n\n" +
  "**Task:** {taskDescription}\n" +
  "**Task ID:** {taskId}";
