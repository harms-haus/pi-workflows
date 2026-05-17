import { getBlockedTools, resolveTemplate } from "./config";
import type { ActiveWorkflow, PhaseEntry } from "./types";
import { isSubworkflowRef } from "./types";

// ── Defaults ──
const DEFAULT_ROLE_INSTRUCTION =
  "You are the ORCHESTRATOR for this workflow. You must NOT use the edit or write tools directly. " +
  "All implementation work must be delegated to subagents via the delegate_to_subagents tool. " +
  "Follow the phase instructions precisely.";

const DEFAULT_ADVANCE_REMINDER =
  "When you finish this phase, call the workflow_step tool with action='next' to advance to the next phase. If you need to restart the current scope from the beginning, use action='loop'.";

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

  // Breadcrumb
  const breadcrumbNames = active.breadcrumb.map((b) => b.name).join(" > ");

  // Progress
  const innerSegment = state.currentPath[state.currentPath.length - 1];
  // Determine inner phase count for the innermost scope
  const innerTotal =
    state.currentPath.length > 1
      ? isSubworkflowRef(active.currentPhaseEntry) && active.currentPhaseEntry.resolved
        ? active.currentPhaseEntry.resolved.phases.length
        : definition.phases.length
      : definition.phases.length;
  const progress =
    state.currentPath.length === 1
      ? `**Progress:** Step ${state.globalStepCount} (${innerSegment.phaseIndex + 1}/${innerTotal} phases)`
      : `**Progress:** Step ${state.globalStepCount} (${innerSegment.phaseIndex + 1}/${innerTotal} in current scope)`;

  // Next phase name
  let nextPhaseName: string;
  if (nextPhase) {
    nextPhaseName =
      isSubworkflowRef(nextPhase) && nextPhase.resolved
        ? (nextPhase.resolved.name)
        : isSubworkflowRef(nextPhase)
          ? nextPhase.workflowKey
          : nextPhase.name;
  } else {
    nextPhaseName = "DONE";
  }

  const vars: Record<string, string> = {
    workflowName: definition.name,
    workflowKey: state.workflowKey,
    description: state.taskDescription,
    taskId: state.taskId,
    phaseId: currentPhase.id,
    phaseName: currentPhase.name,
    previousPhaseName: getPreviousPhaseName(definition, innerSegment.phaseIndex),
    nextPhaseName,
    blockedToolsList: blockedTools.length > 0 ? blockedTools.join(", ") : "(none)",
    toolName: "workflow_step",
    breadcrumbPath: breadcrumbNames,
    globalStepCount: String(state.globalStepCount),
  };

  const roleInstruction = resolveTemplate(
    definition.roleInstruction ?? DEFAULT_ROLE_INSTRUCTION,
    vars,
  );

  const phaseInstructions = resolveTemplate(currentPhase.instructions, vars);

  const advanceReminder = resolveTemplate(definition.advanceReminder ?? DEFAULT_ADVANCE_REMINDER, {
    ...vars,
    nextPhaseName,
  });

  const lines: string[] = [];
  lines.push(`[Workflow path: ${breadcrumbNames} ▸ ${currentPhase.emoji} ${currentPhase.name}]`);
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
 * Collect all unique profile names across all phases in a workflow,
 * recursively descending into subworkflow references.
 */
function collectAllProfiles(definition: { phases: PhaseEntry[] }): string[] {
  const seen = new Set<string>();
  function visit(phases: PhaseEntry[]) {
    for (const phase of phases) {
      if (isSubworkflowRef(phase) && phase.resolved) {
        visit(phase.resolved.phases);
      } else if (!isSubworkflowRef(phase)) {
        if (phase.availableProfiles) {
          for (const p of phase.availableProfiles) seen.add(p);
        }
      }
    }
  }
  visit(definition.phases);
  return Array.from(seen);
}

/**
 * Get the name of the previous phase, or "(start)" if this is the first phase.
 */
function getPreviousPhaseName(definition: { phases: PhaseEntry[] }, currentIndex: number): string {
  if (currentIndex <= 0) return "(start)";
  const prev = definition.phases[currentIndex - 1];
  if (isSubworkflowRef(prev) && prev.resolved) return prev.resolved.name;
  if (isSubworkflowRef(prev)) return prev.workflowKey;
  return prev.name;
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
  "❌ **{workflowName} Cancelled**\n\n" + "**Task:** {taskDescription}\n" + "**Task ID:** {taskId}";
