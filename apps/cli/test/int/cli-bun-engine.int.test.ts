import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The suite runs through the vitest alias that maps `bun:sqlite` onto `node:sqlite`,
 * whose no-row `get()` returns `undefined` while the shipping Bun engine returns
 * `null`. This file spawns the real Bun runtime with no alias so the engine seam
 * stays covered: an unknown slug must exit 66 with `PROJECT_NOT_FOUND`, and unbind
 * must remove a binding whose directory has vanished, on the engine that ships.
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop() as string, { recursive: true, force: true });
});

describe("the real bun engine", () => {
  it("keeps PROJECT_NOT_FOUND and vanished-directory unbind working without the node:sqlite alias", () => {
    const home = mkdtempSync(join(tmpdir(), "sorage-bun-engine-"));
    homes.push(home);
    const dir = join(home, "proj");
    const cliMain = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
    const script = `
      process.env.SORAGE_HOME = ${JSON.stringify(home)};
      const { mkdirSync, rmSync } = await import("node:fs");
      const { runCli } = await import(${JSON.stringify(cliMain)});
      const sinks = { out: () => {}, err: () => {} };
      const codes = [];
      mkdirSync(${JSON.stringify(dir)});
      codes.push(runCli(["init", "--vault", ${JSON.stringify(join(home, "vault"))}, "--non-interactive"], sinks));
      codes.push(runCli(["project", "add", "--name", "Demo", "--dir", ${JSON.stringify(dir)}], sinks));
      codes.push(runCli(["project", "show", "missing"], sinks));
      rmSync(${JSON.stringify(dir)}, { recursive: true, force: true });
      codes.push(runCli(["project", "unbind", "demo", "--dir", ${JSON.stringify(dir)}], sinks));
      codes.push(runCli(["project", "list", "--json"], sinks));
      console.log(JSON.stringify({ codes }));
    `;
    const result = spawnSync("bun", ["-e", script], { encoding: "utf8", timeout: 60_000 });
    expect(result.status).toBe(0);
    const lastLine = (result.stdout ?? "").trim().split("\n").pop() ?? "{}";
    const payload = JSON.parse(lastLine) as { codes: number[] };
    expect(payload.codes).toEqual([0, 0, 66, 0, 0]);
  });
});
