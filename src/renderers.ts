import type { ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * Factory that creates a message renderer callback.
 *
 * @param prefix    Optional prefix string (e.g. an emoji) rendered in the accent color.
 * @param colorKey  Theme color key used for the main content.
 * @param opts.bold          Whether to wrap content in `theme.bold()`.
 * @param opts.staticContent If set, use this fixed string instead of `message.content`.
 */
function createTextRenderer(
  prefix: string,
  colorKey: ThemeColor,
  opts: { bold?: boolean; staticContent?: string } = {},
) {
  return (
    message: { content: unknown },
    _options: unknown,
    theme: Theme,
  ) => {
    const raw = typeof message.content === "string" ? message.content : "";
    const content = opts.staticContent ?? raw;
    const styledContent = opts.bold ? theme.bold(content) : content;
    const parts: string[] = [];
    if (prefix) parts.push(theme.fg("accent", prefix));
    parts.push(theme.fg(colorKey, styledContent));
    return new Text(parts.join(""), 0, 0);
  };
}

/**
 * Register message renderers for the workflow extension.
 */
export function registerRenderers(pi: ExtensionAPI): void {
  // Context injection renderer — shows a minimal dim line for hidden context injections
  pi.registerMessageRenderer(
    "workflow:context",
    createTextRenderer("🔄 ", "dim", { staticContent: "[Workflow Context injected]" }),
  );

  // Completion message renderer — shows the completion/cancellation message in bold
  pi.registerMessageRenderer(
    "workflow:complete",
    createTextRenderer("", "success", { bold: true }),
  );

  // Countdown shown during the grace period before auto-continue
  pi.registerMessageRenderer(
    "workflow:countdown",
    createTextRenderer("⏳ ", "dim"),
  );
}
