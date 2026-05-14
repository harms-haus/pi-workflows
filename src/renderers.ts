import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * Register message renderers for the workflow extension.
 */
export function registerRenderers(pi: ExtensionAPI): void {
  // Context injection renderer — shows a minimal dim line for hidden context injections
  pi.registerMessageRenderer("workflow:context", (_message, _opts, theme) => {
    return new Text(
      theme.fg("accent", "🔄 ") + theme.fg("dim", "[Workflow Context injected]"),
      0,
      0,
    );
  });

  // Completion message renderer — shows the completion/cancellation message in bold
  pi.registerMessageRenderer("workflow:complete", (message, _opts, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    return new Text(
      theme.fg("success", theme.bold(content)),
      0,
      0,
    );
  });

  // Countdown shown during the grace period before auto-continue
  pi.registerMessageRenderer("workflow:countdown", (message, _opts, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    return new Text(
      theme.fg("accent", "⏳ ") + theme.fg("dim", content),
      0,
      0,
    );
  });
}
