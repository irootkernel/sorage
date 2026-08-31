/**
 * The `make build` entry (NFR-013): compiles dist/sorage and removes any
 * packaging manifest left by an earlier `make package`, because an unsigned
 * build must never sit beside a manifest describing a signed digest.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(join(root, "dist", "package.json"), { force: true });
execFileSync("bun", ["build", "--compile", "apps/cli/src/main.ts", "--outfile", "dist/sorage"], {
  cwd: root,
  stdio: "inherit",
});
