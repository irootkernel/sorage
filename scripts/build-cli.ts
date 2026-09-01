/**
 * The `make build` entry (NFR-013): compiles dist/sorage and removes any
 * release-candidate files left by an earlier `make package`, because an
 * unsigned build must never sit beside metadata describing signed bytes.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SORAGE_VERSION } from "../packages/core/src/version";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseBase = `sorage-v${SORAGE_VERSION}-darwin-arm64`;
for (const file of [releaseBase, `${releaseBase}.sha256`, `${releaseBase}.manifest.json`, "package.json"]) {
  rmSync(join(root, "dist", file), { force: true });
}
execFileSync("bun", ["build", "--compile", "apps/cli/src/main.ts", "--outfile", "dist/sorage"], {
  cwd: root,
  stdio: "inherit",
});
