// ── Phase-level tool control ──

/** Exactly one of blacklist or whitelist may be set (not both simultaneously active). */
export interface PhaseToolConfig {
  /**
   * Tool names to BLOCK during this phase.
   * If set, all tools EXCEPT these are allowed.
   * Mutually exclusive with whitelist.
   */
  blacklist?: string[];
  /**
   * Tool names to ALLOW during this phase.
   * If set, ONLY these tools are allowed (everything else is blocked).
   * Mutually exclusive with blacklist.
   * The workflow_step tool is ALWAYS allowed regardless.
   */
  whitelist?: string[];
}

// ── Phase Definition ──

export interface PhaseDefinition {
  /** Machine-readable phase identifier. Must be unique within a workflow. */
  id: string;
  /** Human-readable phase name for UI display. */
  name: string;
  /** Emoji icon for status bar and messages. */
  emoji: string;
  /**
   * Instructions injected into the agent context during this phase.
   * Supports template variables: {taskDescription}, {taskId}, {workflowName},
   * {workflowKey}, {phaseId}, {phaseName}, {previousPhaseName}, {nextPhaseName}.
   */
  instructions: string;
  /** Tool blocking/allowing configuration for this phase. */
  tools?: PhaseToolConfig;
  /** Subagent profiles available during this phase (listed in context injection). */
  availableProfiles?: string[];
}

// ── Workflow Definition ──

export interface WorkflowDefinition {
  /** Human-readable workflow name for UI display. */
  name: string;
  /**
   * The slash command name. The extension registers ONE /workflow command.
   * This value is used as the first argument: /workflow {commandName} {description}
   * Must be unique across all configured workflows.
   */
  commandName: string;
  /**
   * Initial message sent to the agent when the workflow starts.
   * Template variables: {workflowName}, {description}, {firstPhaseId}, {firstPhaseName},
   * {firstPhaseEmoji}, {firstPhaseProfiles}.
   */
  initialMessage: string;
  /** Prefix for the session name. Defaults to "Workflow: ". */
  sessionNamePrefix?: string;
  /** Max session name length. Defaults to 50. */
  sessionNameMaxLength?: number;
  /**
   * Ordered list of phase definitions.
   * The workflow advances linearly through this list.
   * Must contain at least 1 phase.
   */
  phases: PhaseDefinition[];
  /**
   * Role instruction prepended to every context injection.
   * Template variables: {workflowName}, {blockedToolsList}.
   * If omitted, a sensible default is used.
   */
  roleInstruction?: string;
  /**
   * Message appended at the end of every context injection reminding the agent
   * to advance when done. Template variables: {workflowName}, {toolName}, {nextPhaseName}.
   */
  advanceReminder?: string;
  /**
   * The reason shown to the agent when a tool is blocked.
   * Template variables: {workflowName}, {phaseName}, {toolName}, {allowedTools}.
   */
  blockReasonTemplate?: string;
  /**
   * Message sent when workflow reaches DONE state.
   * Template variables: {workflowName}, {taskDescription}, {taskId}, {phaseCount}.
   */
  completionMessage?: string;
  /**
   * Message shown when the agent tries to finish (agent_end) but the workflow
   * is still active (not DONE).
   * Template variables: {workflowName}, {phaseName}, {phaseEmoji}, {phaseInstructions}.
   */
  notDoneReminder?: string;
}

// ── Settings Shape ──

/**
 * Expected structure under the "workflows" key in settings.json:
 * {
 *   "workflows": {
 *     "definitions": {
 *       "rpir": { ...WorkflowDefinition },
 *       "code-review": { ...WorkflowDefinition }
 *     }
 *   }
 * }
 */
export interface WorkflowSettings {
  definitions: Record<string, WorkflowDefinition>;
}

// ── Runtime State ──

export interface WorkflowState {
  /** Whether the workflow is currently active. */
  active: boolean;
  /** The workflow definition key from settings (e.g., "rpir"). */
  workflowKey: string;
  /** Index into the workflow's phases array. */
  currentPhaseIndex: number;
  /** Unique task ID. */
  taskId: string;
  /** User's original description. */
  taskDescription: string;
  /** Timestamp when workflow started. */
  startedAt: number;
  /**
   * Tracks whether DONE notification has been sent.
   * Prevents duplicate notifications on repeated agent_end events.
   */
  completionNotified: boolean;
  /**
   * True if the workflow was cancelled (not completed).
   */
  cancelled: boolean;
}

// ── Resolved Active Workflow (runtime convenience) ──

export interface ActiveWorkflow {
  definition: WorkflowDefinition;
  state: WorkflowState;
  currentPhase: PhaseDefinition;
  nextPhase: PhaseDefinition | null;
}

// ── Hook state mutation pattern ──

export interface HookStateMutation {
  /** If true, set module state to null (unload workflow). */
  unload: boolean;
  /** If set, replace module state with this value (mutated copy). */
  state?: WorkflowState;
  /** If true, persist the current state via pi.appendEntry. */
  persist: boolean;
}

// ── State accessor callbacks ──

export type GetState = () => WorkflowState | null;
export type SetState = (s: WorkflowState | null) => void;
export type GetDefinitions = () => Record<string, WorkflowDefinition>;
export type ReloadDefinitions = () => Promise<Record<string, WorkflowDefinition>>;
