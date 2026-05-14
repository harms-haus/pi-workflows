import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

/** Creates a mock ExtensionContext with sensible defaults. */
export function createMockContext(
  overrides: Partial<ExtensionContext> = {},
): ExtensionContext {
  return {
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    sessionManager: {
      getBranch: vi.fn(() => []),
    },
    cwd: process.cwd(),
    ...overrides,
  } as unknown as ExtensionContext;
}

/** Creates a mock ExtensionAPI with a dual-handle pattern. */
export function createMockAPI(): {
  api: ExtensionAPI;
  sendMessage: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  registerMessageRenderer: ReturnType<typeof vi.fn>;
  setWidget: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn();
  const sendUserMessage = vi.fn();
  const registerTool = vi.fn();
  const on = vi.fn();
  const registerMessageRenderer = vi.fn();
  const setWidget = vi.fn();

  return {
    api: {
      sendMessage,
      sendUserMessage,
      registerTool,
      on,
      registerMessageRenderer,
      ui: { setWidget },
    } as unknown as ExtensionAPI,
    sendMessage,
    sendUserMessage,
    registerTool,
    on,
    registerMessageRenderer,
    setWidget,
  };
}
