import type { PlatformPath } from "node:path";
import type * as PathModule from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { realpathSync } from "node:fs";

// ── Holder for real win32 path utilities, accessible inside hoisted vi.mock ──
const pathRef = vi.hoisted(() => ({
  win32: null as PlatformPath | null,
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  realpathSync: vi.fn(),
}));

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof PathModule>();
  pathRef.win32 = actual.win32;
  return {
    resolve: actual.win32.resolve,
    relative: actual.win32.relative,
    isAbsolute: actual.win32.isAbsolute,
    join: actual.win32.join,
    sep: actual.win32.sep,
    dirname: actual.win32.dirname,
    basename: actual.win32.basename,
    extname: actual.win32.extname,
    normalize: actual.win32.normalize,
  };
});

// Import SUT — will use mocked node:path (win32) and node:fs
import { checkPathSafety } from "../config/loading-phases";

/** Shorthand for the captured win32 path object */
function wp() {
  return pathRef.win32!;
}

describe("checkPathSafety — Windows paths", () => {
  beforeEach(() => {
    vi.mocked(realpathSync).mockReset();
  });

  it("accepts phase file within workflows root", () => {
    const workflowsRoot = wp().resolve("C:\\workflows");
    const dirPath = wp().resolve("C:\\workflows\\my-wf");
    const phaseEntry = "phase.md";
    const resolvedRoot = wp().resolve(workflowsRoot);
    const resolvedPhase = wp().resolve(dirPath, phaseEntry);

    vi.mocked(realpathSync).mockImplementation((p: any) => {
      if (p === resolvedRoot) return resolvedRoot;
      if (p === resolvedPhase) return resolvedPhase;
      throw new Error(`Unexpected realpathSync: ${p}`);
    });

    expect(checkPathSafety(phaseEntry, dirPath, workflowsRoot, "test.yaml")).toBe(true);
  });

  it("rejects traversal with .. segments", () => {
    const workflowsRoot = wp().resolve("C:\\workflows");
    const dirPath = wp().resolve("C:\\workflows\\my-wf");
    const phaseEntry = "..\\..\\etc\\evil.md";
    const resolvedRoot = wp().resolve(workflowsRoot);
    const resolvedPhase = wp().resolve(dirPath, phaseEntry);
    // resolvedPhase = C:\etc\evil.md (outside root)

    vi.mocked(realpathSync).mockImplementation((p: any) => {
      if (p === resolvedRoot) return resolvedRoot;
      if (p === resolvedPhase) return resolvedPhase;
      throw new Error(`Unexpected realpathSync: ${p}`);
    });

    expect(checkPathSafety(phaseEntry, dirPath, workflowsRoot, "test.yaml")).toBe(false);
  });

  it("rejects path at root level (no subdirectory)", () => {
    const workflowsRoot = wp().resolve("C:\\workflows");
    const dirPath = wp().resolve("C:\\workflows");
    const phaseEntry = ".";
    const resolvedRoot = wp().resolve(workflowsRoot);
    const resolvedPhase = wp().resolve(dirPath, phaseEntry);
    // resolvedPhase = C:\workflows (same as root)

    vi.mocked(realpathSync).mockImplementation((p: any) => {
      if (p === resolvedRoot) return resolvedRoot;
      if (p === resolvedPhase) return resolvedPhase;
      throw new Error(`Unexpected realpathSync: ${p}`);
    });

    expect(checkPathSafety(phaseEntry, dirPath, workflowsRoot, "test.yaml")).toBe(false);
  });

  it("handles realpathSync failure (file doesn't exist yet) — safe path", () => {
    const workflowsRoot = wp().resolve("C:\\workflows");
    const dirPath = wp().resolve("C:\\workflows\\my-wf");
    const phaseEntry = "new-phase.md";
    const resolvedRoot = wp().resolve(workflowsRoot);
    const resolvedPhase = wp().resolve(dirPath, phaseEntry);
    // resolvedPhase = C:\workflows\my-wf\new-phase.md (within root)

    vi.mocked(realpathSync).mockImplementation((p: any) => {
      if (p === resolvedRoot) return resolvedRoot;
      if (p === resolvedPhase) throw new Error("ENOENT");
      throw new Error(`Unexpected realpathSync: ${p}`);
    });

    // Falls back to resolved (non-canonical) path, which is within root
    expect(checkPathSafety(phaseEntry, dirPath, workflowsRoot, "test.yaml")).toBe(true);
  });

  it("handles realpathSync failure — unsafe path", () => {
    const workflowsRoot = wp().resolve("C:\\workflows");
    const dirPath = wp().resolve("C:\\workflows\\my-wf");
    const phaseEntry = "..\\..\\etc\\evil.md";
    const resolvedRoot = wp().resolve(workflowsRoot);
    const resolvedPhase = wp().resolve(dirPath, phaseEntry);
    // resolvedPhase = C:\etc\evil.md (outside root)

    vi.mocked(realpathSync).mockImplementation((p: any) => {
      if (p === resolvedRoot) return resolvedRoot;
      if (p === resolvedPhase) throw new Error("ENOENT");
      throw new Error(`Unexpected realpathSync: ${p}`);
    });

    // Falls back to resolved path, which escapes root
    expect(checkPathSafety(phaseEntry, dirPath, workflowsRoot, "test.yaml")).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("case-insensitive match on Windows", () => {
    const workflowsRoot = wp().resolve("C:\\Workflows");
    const dirPath = wp().resolve("C:\\Workflows\\my-wf");
    const phaseEntry = "phase.md";
    // Canonical root has mixed case, canonical phase has different case
    const canonicalRoot = "C:\\Workflows";
    const canonicalPhase = "c:\\WORKFLOWS\\my-wf\\phase.md";

    vi.mocked(realpathSync).mockImplementation((p: any) => {
      const resolvedRoot = wp().resolve(workflowsRoot);
      if (p === resolvedRoot) return canonicalRoot;
      if (p === wp().resolve(dirPath, phaseEntry)) return canonicalPhase;
      throw new Error(`Unexpected realpathSync: ${p}`);
    });

    expect(checkPathSafety(phaseEntry, dirPath, workflowsRoot, "test.yaml")).toBe(true);
  });

  it("UNC path within root", () => {
    const workflowsRoot = wp().resolve("\\\\server\\share\\workflows");
    const dirPath = wp().resolve("\\\\server\\share\\workflows\\sub");
    const phaseEntry = "phase.md";
    const resolvedRoot = wp().resolve(workflowsRoot);
    const resolvedPhase = wp().resolve(dirPath, phaseEntry);

    vi.mocked(realpathSync).mockImplementation((p: any) => {
      if (p === resolvedRoot) return resolvedRoot;
      if (p === resolvedPhase) return resolvedPhase;
      throw new Error(`Unexpected realpathSync: ${p}`);
    });

    expect(checkPathSafety(phaseEntry, dirPath, workflowsRoot, "test.yaml")).toBe(true);
  });

  it("UNC path escaping root", () => {
    const workflowsRoot = wp().resolve("\\\\server\\share\\workflows");
    const dirPath = wp().resolve("\\\\server\\share\\workflows");
    const phaseEntry = "..\\..\\..\\other\\share\\evil.md";
    const resolvedRoot = wp().resolve(workflowsRoot);
    const resolvedPhase = wp().resolve(dirPath, phaseEntry);
    // resolvedPhase = \\other\share\evil.md (different UNC server)

    vi.mocked(realpathSync).mockImplementation((p: any) => {
      if (p === resolvedRoot) return resolvedRoot;
      if (p === resolvedPhase) return resolvedPhase;
      throw new Error(`Unexpected realpathSync: ${p}`);
    });

    expect(checkPathSafety(phaseEntry, dirPath, workflowsRoot, "test.yaml")).toBe(false);
  });
});
