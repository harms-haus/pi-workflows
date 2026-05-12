import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowState, WorkflowDefinition } from "./types";
import { loadWorkflows } from "./config";
import { persistState, reconstructState } from "./state";
import { updateStatus, handleToolCall, handleBeforeAgentStart, handleAgentEnd } from "./hooks";
import { registerWorkflowTool } from "./tool";
import { registerWorkflowCommand, registerCancelWorkflowCommand } from "./command";
import { registerRenderers } from "./renderers";

/** Check if an error is a stale-context error (session was replaced/reloaded mid-handler). */
function isStaleError(e: unknown): boolean {
  return e instanceof Error && e.message.includes("stale");
}

export default function (pi: ExtensionAPI): void {
  let state: WorkflowState | null = null;
  let definitions: Record<string, WorkflowDefinition> = {};

  const getState = () => state;
  const setState = (s: WorkflowState | null) => {
    state = s;
  };
  const getDefinitions = () => definitions;
  const reloadDefinitions = async () => {
    definitions = await loadWorkflows();
    return definitions;
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      definitions = await loadWorkflows(ctx.cwd);
      state = reconstructState(ctx);
      updateStatus(ctx, state, definitions);
    } catch (e) {
      if (isStaleError(e)) return;
      throw e;
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    try {
      // Capture cwd synchronously before any async gap
      const cwd = ctx.cwd;
      definitions = await loadWorkflows(cwd);
      state = reconstructState(ctx);
      updateStatus(ctx, state, definitions);
    } catch (e) {
      if (isStaleError(e)) return;
      throw e;
    }
  });

  pi.on("tool_call", async (event, _ctx) => {
    return handleToolCall(event, state, definitions);
  });

  pi.on("before_agent_start", async (_event, _ctx) => {
    return handleBeforeAgentStart(state, definitions);
  });

  pi.on("agent_end", async (_event, ctx) => {
    try {
      const mutation = handleAgentEnd(pi, state, definitions, ctx);
      if (mutation.unload) {
        state = null;
      } else if (mutation.state) {
        state = mutation.state;
      }
      if (mutation.persist && state) {
        persistState(pi, state);
      }
    } catch (e) {
      if (isStaleError(e)) return;
      throw e;
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    try {
      updateStatus(ctx, state, definitions);
    } catch (e) {
      if (isStaleError(e)) return;
      throw e;
    }
  });

  registerWorkflowTool(pi, getState, getDefinitions, setState);
  registerWorkflowCommand(pi, getState, reloadDefinitions, setState);
  registerCancelWorkflowCommand(pi, getState, setState);
  registerRenderers(pi);
}
