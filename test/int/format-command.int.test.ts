import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("checks without writing and explicitly formats through the managed runner", () => {
  const root = mkdtempSync("/tmp/sorage-format-command-");
  try {
    mkdirSync(join(root, "scripts"));
    for (const file of [
      "package.json",
      "biome.json",
      ".bun-version",
      ".node-version",
      "scripts/toolchain.sh",
      "scripts/toolchain.ts",
      "scripts/toolchain-runtime.ts",
    ]) {
      copyFileSync(file, join(root, file));
    }
    for (const directory of [".toolchains", "node_modules"]) symlinkSync(resolve(directory), join(root, directory));
    const file = join(root, "example.ts");
    const unformatted = "export const value={answer:42}\n";
    writeFileSync(file, unformatted);
    const run = (name: string) =>
      spawnSync("/bin/sh", [join(root, "scripts/toolchain.sh"), "script", name], {
        encoding: "utf8",
        env: { ...process.env, SORAGE_HOME: join(root, "home") },
      });
    expect(run("check:format").status).not.toBe(0);
    expect(readFileSync(file, "utf8")).toBe(unformatted);
    const formatted = run("format");
    expect(formatted.status, formatted.stderr).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("export const value = { answer: 42 };\n");
    expect(run("check:format").status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
