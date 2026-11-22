import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() =>
  vi.fn<(cmd: string, args: string[], opts: Record<string, unknown>) => { status: number | null; error?: Error }>(),
);

vi.mock("node:child_process", async (original) => {
  const cp = await original<typeof import("node:child_process")>();
  return {
    ...cp,
    spawnSync: (...args: unknown[]) =>
      spawnMock(args[0] as string, args[1] as string[], args[2] as Record<string, unknown>),
  };
});

import { createNodeConfigCommandPorts } from "../../src/config-command-ports";

const homes: string[] = [];
beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockReturnValue({ status: 0 });
});
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sorage-config-editor-"));
  homes.push(home);
  return home;
}

describe("createNodeConfigCommandPorts openEditor EDITOR fallback (TASK-149 #7)", () => {
  it.each([undefined, "", "   "])("falls back to vi when EDITOR is %j", (editorValue) => {
    const home = tempHome();
    const ports = createNodeConfigCommandPorts({
      env: { SORAGE_HOME: home, EDITOR: editorValue },
      userHome: home,
    });
    const opened = ports.openEditor(ports.configFile);
    expect(opened.ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("vi", [ports.configFile], { stdio: "inherit" });
  });

  it("uses the trimmed EDITOR command when set", () => {
    const home = tempHome();
    const ports = createNodeConfigCommandPorts({
      env: { SORAGE_HOME: home, EDITOR: "  nano  " },
      userHome: home,
    });
    const opened = ports.openEditor(ports.configFile);
    expect(opened.ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith("nano", [ports.configFile], { stdio: "inherit" });
  });

  it("returns INTERNAL_ERROR on spawn error or non-zero exit status", () => {
    const home = tempHome();
    const ports = createNodeConfigCommandPorts({
      env: { SORAGE_HOME: home, EDITOR: undefined },
      userHome: home,
    });

    spawnMock.mockReturnValueOnce({ status: null, error: new Error("ENOENT") });
    const spawnFailed = ports.openEditor(ports.configFile);
    expect(spawnFailed.ok).toBe(false);
    if (!spawnFailed.ok) {
      expect(spawnFailed.error.code).toBe("INTERNAL_ERROR");
      expect(spawnFailed.error.message).toContain("'vi'");
    }

    spawnMock.mockReturnValueOnce({ status: 2 });
    const exitFailed = ports.openEditor(ports.configFile);
    expect(exitFailed.ok).toBe(false);
    if (!exitFailed.ok) {
      expect(exitFailed.error.code).toBe("INTERNAL_ERROR");
      expect(exitFailed.error.message).toContain("status 2");
    }
  });
});
