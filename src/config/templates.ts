import type { PhaseDefinition } from "../types";

// ── Template Resolution ──

/**
 * Replaces {varName} occurrences in template with values from vars.
 * Unknown variables are left as-is.
 */
export function resolveTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    return key in vars ? vars[key] : `{${key}}`;
  });
}

// ── Utility: get blocked/allowed tools for a phase ──

export function getBlockedTools(phase: PhaseDefinition): string[] {
  if (phase.tools?.blacklist) return [...phase.tools.blacklist];
  return [];
}

export function getWhitelist(phase: PhaseDefinition): string[] | null {
  if (phase.tools?.whitelist) return [...phase.tools.whitelist];
  return null;
}
