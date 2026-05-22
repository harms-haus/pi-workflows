import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { PhaseDefinition } from "../types";
import { extractPhaseMetadata } from "./loading-parse";

// ── Path Safety ──

/**
 * Check that a phase file path does not escape the workflows root directory.
 * Validates by resolving both the canonical root and the phase file path,
 * then ensuring the phase path is a subpath of the root.
 *
 * @param phaseEntry - Relative phase filename from the YAML
 * @param dirPath - Directory containing the workflow.yaml
 * @param workflowsRoot - Parent directory containing all workflows
 * @param yamlPath - Path to workflow.yaml (used in warning messages)
 * @returns true if the path is safe, false otherwise
 */
export function checkPathSafety(
  phaseEntry: string,
  dirPath: string,
  workflowsRoot: string,
  yamlPath: string,
): boolean {
  const canonicalRoot = realpathSync(resolve(workflowsRoot));
  const phaseFilePath = resolve(dirPath, phaseEntry);
  try {
    const canonicalPhase = realpathSync(phaseFilePath);
    if (!canonicalPhase.startsWith(canonicalRoot + sep)) {
      console.warn(
        `[pi-workflows] Phase file path escapes workflows root: ${phaseEntry} in ${yamlPath}`,
      );
      return false;
    }
  } catch {
    const resolvedPath = resolve(dirPath, phaseEntry);
    if (!resolvedPath.startsWith(canonicalRoot + sep)) {
      console.warn(
        `[pi-workflows] Phase file path escapes workflows root: ${phaseEntry} in ${yamlPath}`,
      );
      return false;
    }
  }
  return true;
}

// ── Phase Loading ──

/**
 * Load a phase definition from a markdown file with frontmatter.
 *
 * Expects the file to contain YAML frontmatter with required fields:
 * `id`, `name`, `emoji`, and optional `tools` and `availableProfiles`.
 * The body (after frontmatter) becomes the phase instructions.
 *
 * @param phasePath - Absolute path to the .md phase file
 * @returns Parsed PhaseDefinition, or null if the file is invalid
 */
export function loadPhaseFromMarkdown(phasePath: string): PhaseDefinition | null {
  const phaseContent = readFileSync(phasePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(phaseContent);

  const metadata = extractPhaseMetadata(frontmatter, phasePath);
  if (!metadata) return null;

  const phase: PhaseDefinition = {
    id: metadata.id,
    name: metadata.name,
    emoji: metadata.emoji,
    instructions: body.trim(),
  };

  if (metadata.tools) phase.tools = metadata.tools;
  if (metadata.availableProfiles) phase.availableProfiles = metadata.availableProfiles;

  return phase;
}
