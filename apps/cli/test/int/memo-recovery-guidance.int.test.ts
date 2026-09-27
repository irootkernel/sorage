import { describe, expect, it, vi } from "vitest";
import * as memoPorts from "@sorage/adapters/src/memo-command-ports";
import { memoCliFixture } from "../fixtures/memo-cli";
import { runCli } from "../../src/main";

describe("Memo recovery guidance through the CLI", () => {
  it("reports ambiguous inference and accepts its explicit Project recovery without changing Handoff guidance", () => {
    const f = memoCliFixture();
    const previous = process.env.SORAGE_HOME;
    process.env.SORAGE_HOME = f.home;
    const create = memoPorts.createNodeMemoPorts;
    // The SQLite unique-directory invariant prevents constructing a natural same-depth
    // duplicate. Inject that repository result, then run the real resolver and CLI.
    const spy = vi.spyOn(memoPorts, "createNodeMemoPorts").mockImplementation(() => {
      const ports = create();
      const bindings = ports.projectPorts.projects.listBindings();
      if (!bindings.ok || bindings.value.length !== 2) throw new Error("Expected two fixture bindings");
      ports.projectPorts.projects.listBindings = () => ({
        ok: true,
        value: bindings.value.map((binding) => ({ ...binding, directory: process.cwd(), bindingKind: "directory" })),
      });
      return ports;
    });
    try {
      let stderr = "";
      let stdout = "";
      const output = {
        out: (text: string) => {
          stdout += text;
        },
        err: (text: string) => {
          stderr += text;
        },
      };
      expect(runCli(["memo", "list", "--json"], output)).toBe(64);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr).error).toMatchObject({
        code: "AMBIGUOUS_PROJECT",
        recovery: { suggestedCommand: "Pass --project <project-slug>, or remove the aliased binding" },
      });
      stderr = "";
      expect(runCli(["memo", "list", "--project", "memo", "--json"], output)).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout).data.items).toEqual([]);
      stderr = "";
      expect(runCli(["memo", "list"], output)).toBe(64);
      expect(stderr).toContain("Recovery: Pass --project <project-slug>");
    } finally {
      spy.mockRestore();
      if (previous === undefined) delete process.env.SORAGE_HOME;
      else process.env.SORAGE_HOME = previous;
      f.cleanup();
    }
  });
});
