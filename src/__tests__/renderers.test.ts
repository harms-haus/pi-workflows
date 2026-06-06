import { describe, it, expect, beforeEach } from "vitest";
import { registerRenderers } from "../renderers";
import { createMockAPI } from "./helpers/mocks";
import { Text } from "@earendil-works/pi-tui";

const mockTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
};

// Helper to get the renderer callback for a given message type from mock calls
function getRenderer(
  calls: Array<[string, (...args: Array<unknown>) => unknown]>,
  messageType: string,
): (...args: Array<unknown>) => unknown {
  const call = calls.find((c) => c[0] === messageType);
  if (!call) throw new Error(`No renderer found for ${messageType}`);
  return call[1];
}

describe("registerRenderers", () => {
  let registerMessageRenderer: ReturnType<typeof createMockAPI>["registerMessageRenderer"];

  beforeEach(() => {
    const mock = createMockAPI();
    registerMessageRenderer = mock.registerMessageRenderer;
    registerRenderers(mock.api);
  });

  it("calls registerMessageRenderer 2 times with correct message types", () => {
    expect(registerMessageRenderer).toHaveBeenCalledTimes(2);
    expect(registerMessageRenderer).toHaveBeenCalledWith("workflow:context", expect.any(Function));
    expect(registerMessageRenderer).toHaveBeenCalledWith(
      "workflow:countdown",
      expect.any(Function),
    );
  });

  describe("workflow:context renderer", () => {
    it("returns a Text instance", () => {
      const calls = registerMessageRenderer.mock.calls as Array<
        [string, (...args: Array<unknown>) => unknown]
      >;
      const renderer = getRenderer(calls, "workflow:context");

      const result = renderer({ content: "anything" }, {}, mockTheme);
      expect(result).toBeInstanceOf(Text);
    });

    it("ignores message content and returns the fixed context text", () => {
      const calls = registerMessageRenderer.mock.calls as Array<
        [string, (...args: Array<unknown>) => unknown]
      >;
      const renderer = getRenderer(calls, "workflow:context");

      const result = renderer({ content: "should be ignored" }, {}, mockTheme) as Text;
      const rendered = result.render(80);

      expect(rendered).toContain("[Workflow Context injected]");
    });

    it("produces same output regardless of message content", () => {
      const calls = registerMessageRenderer.mock.calls as Array<
        [string, (...args: Array<unknown>) => unknown]
      >;
      const renderer = getRenderer(calls, "workflow:context");

      const resultA = renderer({ content: "AAA" }, {}, mockTheme) as Text;
      const resultB = renderer({ content: "BBB" }, {}, mockTheme) as Text;

      expect(resultA.render(80)).toBe(resultB.render(80));
    });
  });

  describe("workflow:countdown renderer", () => {
    it("returns a Text instance", () => {
      const calls = registerMessageRenderer.mock.calls as Array<
        [string, (...args: Array<unknown>) => unknown]
      >;
      const renderer = getRenderer(calls, "workflow:countdown");

      const result = renderer({ content: "3s" }, {}, mockTheme);
      expect(result).toBeInstanceOf(Text);
    });

    it("extracts string content from the message", () => {
      const calls = registerMessageRenderer.mock.calls as Array<
        [string, (...args: Array<unknown>) => unknown]
      >;
      const renderer = getRenderer(calls, "workflow:countdown");

      const result = renderer({ content: "3s remaining" }, {}, mockTheme) as Text;
      const rendered = result.render(80);

      expect(rendered).toContain("3s remaining");
      expect(rendered).toContain("<dim>3s remaining</dim>");
    });

    it("handles non-string content gracefully", () => {
      const calls = registerMessageRenderer.mock.calls as Array<
        [string, (...args: Array<unknown>) => unknown]
      >;
      const renderer = getRenderer(calls, "workflow:countdown");

      const result = renderer({ content: null }, {}, mockTheme) as Text;
      const rendered = result.render(80);

      expect(rendered).toContain("<dim></dim>");
    });
  });
});
