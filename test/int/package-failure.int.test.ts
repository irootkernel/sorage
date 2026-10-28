import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Only negative paths use a fake compiler/signer. Successful reproducibility,
// signing and candidate execution remain the native package/AJ-16 gate.
describe("package failure cleanup", () => {
  it.each(["compile", "mismatch", "sign"])("withdraws only owned outputs after %s failure", (failure) => {
    const root = mkdtempSync(join(tmpdir(), "sorage-package-failure-"));
    try {
      for (const directory of ["scripts", "packages/core/src", "dist", "bin", "scratch"]) {
        mkdirSync(join(root, directory), { recursive: true });
      }
      copyFileSync(new URL("../../scripts/package.ts", import.meta.url), join(root, "scripts/package.ts"));
      writeFileSync(join(root, "packages/core/src/version.ts"), 'export const SORAGE_VERSION = "0.1.2";\n');
      const bun = spawnSync("bun", ["-p", "process.execPath"], { encoding: "utf8" });
      expect(bun.status, bun.stderr).toBe(0);
      const count = join(root, "count");
      const compiler = join(root, "bin/bun");
      writeFileSync(
        compiler,
        `#!/bin/sh
n=0
if [ -f "$PACKAGE_TEST_COUNT" ]; then n=$(cat "$PACKAGE_TEST_COUNT"); fi
n=$((n + 1))
printf '%s' "$n" > "$PACKAGE_TEST_COUNT"
printf 'fixture unsigned bytes' > "$5"
if [ "$n" = 2 ]; then
  if [ "$PACKAGE_TEST_FAILURE" = compile ]; then exit 7; fi
  if [ "$PACKAGE_TEST_FAILURE" = mismatch ]; then printf 'different bytes' > "$5"; fi
fi
`,
      );
      const signer = join(root, "bin/codesign");
      writeFileSync(signer, "#!/bin/sh\necho 'fixture signature refusal' >&2\nexit 7\n");
      chmodSync(compiler, 0o755);
      chmodSync(signer, 0o755);
      const release = "sorage-v0.1.2-darwin-arm64";
      const outputs = [
        "sorage",
        release,
        `${release}.sha256`,
        `${release}.manifest.json`,
        ".sorage.staged",
        `.${release}.staged`,
        `.${release}.sha256.staged`,
        `.${release}.manifest.json.staged`,
      ];
      for (const output of outputs) writeFileSync(join(root, "dist", output), "old candidate");
      writeFileSync(join(root, "dist/unrelated.json"), "preserve me");
      const result = spawnSync(bun.stdout.trim(), [join(root, "scripts/package.ts")], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
          TMPDIR: join(root, "scratch"),
          SORAGE_HOME: join(root, "home"),
          PACKAGE_TEST_COUNT: count,
          PACKAGE_TEST_FAILURE: failure,
        },
      });
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain(
        failure === "compile" ? "compile into" : failure === "mismatch" ? "two builds" : "fixture signature refusal",
      );
      for (const output of outputs) expect(existsSync(join(root, "dist", output)), output).toBe(false);
      expect(readFileSync(join(root, "dist/unrelated.json"), "utf8")).toBe("preserve me");
      expect(readdirSync(join(root, "scratch")).filter((name) => name.startsWith("sorage-package-"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
