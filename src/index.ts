import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowState, WorkflowDefinition } from "./types";
import { loadWorkflows } from "./config";
import { persistState, reconstructState } from "./state";
import {
  updateStatus,
  handleToolCall,
  handleBeforeAgentStart,
  handleAgentEnd,
} from "./hooks";
import { timerManager } from "./TimerManager";
import { registerWorkflowTool } from "./tool";
import { registerWorkflowCommand, registerCancelWorkflowCommand } from "./command";
import { registerRenderers } from "./renderers";

/** Check if an error is a stale-context error (session was replaced/reloaded mid-handler). */
function isStaleError(e: unknown): boolean {
  return e instanceof Error && e.message.includes("stale");
}

/** Wrap a synchronous handler so stale-context errors are silently swallowed. */
function withStaleGuard(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    if (isStaleError(e)) return;
    throw e;
  }
}

export default function (pi: ExtensionAPI): void {
  let state: WorkflowState | null = null;
  let definitions: Record<string, WorkflowDefinition> = {};

  const getState = () => state;
  const setState = (s: WorkflowState | null) => {
    state = s;
  };
  const getDefinitions = () => definitions;
  const reloadDefinitions = (cwd?: string) => {
    definitions = loadWorkflows(cwd);
    return Promise.resolve(definitions);
  };

  /** Shared session initialisation used by session_start and session_tree. */
  function initSession(
    ctx: Parameters<typeof reconstructState>[0] & Parameters<typeof updateStatus>[0] & { cwd: string },
  ) {
    timerManager.clearAll();
    definitions = loadWorkflows(ctx.cwd);
    state = reconstructState(ctx);
    updateStatus(ctx, state, definitions);
  }

  pi.on("session_start", (_event, ctx) => {
    withStaleGuard(() => { initSession(ctx); });
  });

  pi.on("session_tree", (_event, ctx) => {
    withStaleGuard(() => { initSession(ctx); });
  });

  pi.on("tool_call", (event, _ctx) => {
    return handleToolCall(event, state, definitions);
  });

  pi.on("before_agent_start", (_event, _ctx) => {
    return handleBeforeAgentStart(state, definitions);
  });

  pi.on("agent_end", (event, ctx) => {
    withStaleGuard(() => {
      const mutation = handleAgentEnd(pi, state, definitions, ctx, event);
      if (mutation.unload) {
        if (mutation.persist && state) {
          persistState(pi, state);
        }
        state = null;
      } else if (mutation.state) {
        state = mutation.state;
        if (mutation.persist) {
          persistState(pi, state);
        }
      }
    });
  });

  pi.on("turn_end", (_event, ctx) => {
    withStaleGuard(() => { updateStatus(ctx, state, definitions); });
  });

  registerWorkflowTool(pi, getState, getDefinitions, setState);
  registerWorkflowCommand(pi, getState, reloadDefinitions, setState);
  registerCancelWorkflowCommand(pi, getState, setState);
  registerRenderers(pi);
}
