import { parse as yamlParse } from "yaml";
import type { PhaseToolConfig } from "../types";

// ── Types ──

/** Shape of the raw YAML workflow data before validation. */
export interface RawWorkflowYaml {
  name?: unknown;
  commandName?: unknown;
  initialMessage?: unknown;
  show?: unknown;
  phases?: unknown;
  loopable?: unknown;
  sessionNamePrefix?: unknown;
  sessionNameMaxLength?: unknown;
  roleInstruction?: unknown;
  advanceReminder?: unknown;
  blockReasonTemplate?: unknown;
  completionMessage?: unknown;
  notDoneReminder?: unknown;
}

/** Parsed workflow data extracted from a workflow.yaml file. */
export interface ParsedWorkflow {
  name: string;
  commandName: string;
  initialMessage: string;
  show?: "workflows";
  loopable?: boolean;
  sessionNamePrefix?: string;
  sessionNameMaxLength?: number;
  roleInstruction?: string;
  advanceReminder?: string;
  blockReasonTemplate?: string;
  completionMessage?: string;
  notDoneReminder?: string;
  /** Raw phase entries from the YAML (string filenames or subworkflow ref objects). */
  rawPhases: unknown[];
}

/** Parsed phase metadata extracted from a phase .md file's frontmatter. */
export interface PhaseMetadata {
  id: string;
  name: string;
  emoji: string;
  instructions: string;
  tools?: PhaseToolConfig;
  availableProfiles?: string[];
}

// ── Workflow YAML Parsing ──

/** Parse the YAML string and return it typed, or null if not a valid object. */
function validateYamlObject(yamlContent: string, sourcePath: string): RawWorkflowYaml | null {
  const parsed: unknown = yamlParse(yamlContent);
  if (!parsed || typeof parsed !== "object") {
    console.warn(
      `[pi-workflows] Invalid workflow.yaml in ${sourcePath}: not a valid YAML object`,
    );
    return null;
  }
  return parsed;
}

/** Extract the show field from parsed YAML. */
function parseShowField(raw: RawWorkflowYaml): "workflows" | undefined {
  return raw.show === "workflows" ? "workflows" : undefined;
}

/** Validate and extract required fields (name, commandName, initialMessage). */
function extractRequiredFields(
  raw: RawWorkflowYaml,
  sourcePath: string,
  show: "workflows" | undefined,
): { name: string; commandName: string; initialMessage: string } | null {
  if (typeof raw.name !== "string" || !raw.name) {
    console.warn(`[pi-workflows] Missing or invalid "name" in ${sourcePath}`);
    return null;
  }

  let commandName: string;
  let initialMessage: string;

  if (show === "workflows") {
    commandName = typeof raw.commandName === "string" ? raw.commandName : "";
    initialMessage = typeof raw.initialMessage === "string" ? raw.initialMessage : "";
  } else {
    if (typeof raw.commandName !== "string" || !raw.commandName) {
      console.warn(`[pi-workflows] Missing or invalid "commandName" in ${sourcePath}`);
      return null;
    }
    if (typeof raw.initialMessage !== "string" || !raw.initialMessage) {
      console.warn(`[pi-workflows] Missing or invalid "initialMessage" in ${sourcePath}`);
      return null;
    }
    commandName = raw.commandName;
    initialMessage = raw.initialMessage;
  }

  return { name: raw.name, commandName, initialMessage };
}

/** Set optional string/number/boolean fields on the parsed workflow. */
function setOptionalFields(raw: RawWorkflowYaml, target: ParsedWorkflow): void {
  if (typeof raw.loopable === "boolean") target.loopable = raw.loopable;
  if (typeof raw.sessionNamePrefix === "string") target.sessionNamePrefix = raw.sessionNamePrefix;
  if (typeof raw.sessionNameMaxLength === "number")
    target.sessionNameMaxLength = raw.sessionNameMaxLength;
  if (typeof raw.roleInstruction === "string") target.roleInstruction = raw.roleInstruction;
  if (typeof raw.advanceReminder === "string") target.advanceReminder = raw.advanceReminder;
  if (typeof raw.blockReasonTemplate === "string")
    target.blockReasonTemplate = raw.blockReasonTemplate;
  if (typeof raw.completionMessage === "string") target.completionMessage = raw.completionMessage;
  if (typeof raw.notDoneReminder === "string") target.notDoneReminder = raw.notDoneReminder;
}

/**
 * Parse a workflow.yaml content string and extract all fields.
 * Returns a ParsedWorkflow object with extracted fields, or null if invalid.
 */
export function parseWorkflowYaml(
  yamlContent: string,
  sourcePath: string,
): ParsedWorkflow | null {
  const raw = validateYamlObject(yamlContent, sourcePath);
  if (!raw) return null;

  const show = parseShowField(raw);
  const required = extractRequiredFields(raw, sourcePath, show);
  if (!required) return null;

  if (!Array.isArray(raw.phases) || raw.phases.length < 1) {
    console.warn(`[pi-workflows] Missing or invalid "phases" array in ${sourcePath}`);
    return null;
  }

  const result: ParsedWorkflow = {
    ...required,
    rawPhases: raw.phases,
  };

  if (show !== undefined) result.show = show;
  setOptionalFields(raw, result);

  return result;
}

// ── Phase Metadata Extraction ──

/** Extract optional tools config from frontmatter.tools */
function extractToolsConfig(toolsRaw: unknown): PhaseToolConfig | undefined {
  if (!toolsRaw || typeof toolsRaw !== "object" || Array.isArray(toolsRaw)) {
    return undefined;
  }
  const toolsConfig = toolsRaw as Record<string, unknown>;
  const tools: PhaseToolConfig = {};

  if (Array.isArray(toolsConfig.blacklist)) {
    tools.blacklist = toolsConfig.blacklist.map(String);
  }
  if (Array.isArray(toolsConfig.whitelist)) {
    tools.whitelist = toolsConfig.whitelist.map(String);
  }

  return tools.blacklist || tools.whitelist ? tools : undefined;
}

/** Extract optional available profiles from frontmatter.availableProfiles */
function extractAvailableProfiles(profilesRaw: unknown): string[] | undefined {
  if (!Array.isArray(profilesRaw)) return undefined;
  return profilesRaw.map(String);
}

/**
 * Extract phase metadata from a parsed frontmatter/YAML object.
 * Returns a PhaseMetadata object, or null if required fields are missing.
 */
export function extractPhaseMetadata(
  phaseYaml: unknown,
  phaseId: string,
): PhaseMetadata | null {
  if (!phaseYaml || typeof phaseYaml !== "object") {
    console.warn(`[pi-workflows] Invalid frontmatter in phase ${phaseId}`);
    return null;
  }

  const frontmatter = phaseYaml as Record<string, unknown>;

  if (typeof frontmatter.id !== "string" || !frontmatter.id) {
    console.warn(`[pi-workflows] Missing or invalid "id" in ${phaseId}`);
    return null;
  }
  if (typeof frontmatter.name !== "string" || !frontmatter.name) {
    console.warn(`[pi-workflows] Missing or invalid "name" in ${phaseId}`);
    return null;
  }
  if (typeof frontmatter.emoji !== "string" || !frontmatter.emoji) {
    console.warn(`[pi-workflows] Missing or invalid "emoji" in ${phaseId}`);
    return null;
  }

  const metadata: PhaseMetadata = {
    id: frontmatter.id,
    name: frontmatter.name,
    emoji: frontmatter.emoji,
    instructions: "",
  };

  metadata.tools = extractToolsConfig(frontmatter.tools);
  metadata.availableProfiles = extractAvailableProfiles(frontmatter.availableProfiles);

  return metadata;
}


