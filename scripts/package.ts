/**
 * The release-candidate packaging pipeline (GEN-002, CLI-015, NFR-012,
 * NFR-013, NFR-017): compile twice, reject irreproducible unsigned output,
 * ad-hoc sign the source-install binary, and emit a versioned GitHub Release
 * candidate with checksum and manifest for darwin-arm64.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SORAGE_VERSION } from "../packages/core/src/version";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const target = "darwin-arm64";
const releaseBase = `sorage-v${SORAGE_VERSION}-${target}`;
const sourceBinary = join(dist, "sorage");
const releaseBinary = join(dist, releaseBase);
const checksumPath = `${releaseBinary}.sha256`;
const manifestPath = `${releaseBinary}.manifest.json`;
const stagedBinary = join(dist, ".sorage.staged");
const stagedReleaseBinary = join(dist, `.${releaseBase}.staged`);
const stagedChecksum = join(dist, `.${releaseBase}.sha256.staged`);
const stagedManifest = join(dist, `.${releaseBase}.manifest.json.staged`);

function sh(command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`${command} ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
    process.exit(1);
  }
  return (result.stdout ?? "").trim();
}

function compile(outfile: string): void {
  rmSync(outfile, { force: true });
  try {
    execFileSync("bun", ["build", "--compile", "apps/cli/src/main.ts", "--outfile", outfile], {
      cwd: root,
      stdio: "inherit",
    });
  } catch (error) {
    console.error(`the compile into ${outfile} failed: ${String(error)}`);
    process.exit(1);
  }
  if (!existsSync(outfile)) {
    console.error(`the compiled binary is missing at ${outfile}`);
    process.exit(1);
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function withdraw(): void {
  for (const file of [
    sourceBinary,
    releaseBinary,
    checksumPath,
    manifestPath,
    stagedBinary,
    stagedReleaseBinary,
    stagedChecksum,
    stagedManifest,
  ]) {
    rmSync(file, { force: true });
  }
}

mkdirSync(dist, { recursive: true });
withdraw();
rmSync(join(dist, "package.json"), { force: true });

// Compile into paths with the same basename so Bun's embedded virtual path
// cannot create a false reproducibility mismatch.
const scratch = join(dist, ".repro");
mkdirSync(scratch, { recursive: true });
const second = join(scratch, "sorage");
compile(sourceBinary);
compile(second);
const firstDigest = sha256(sourceBinary);
const secondDigest = sha256(second);
rmSync(scratch, { recursive: true, force: true });
if (firstDigest !== secondDigest) {
  withdraw();
  console.error(`two builds of the same commit differ: ${firstDigest} vs ${secondDigest}`);
  process.exit(1);
}

// Sign a staged copy, validate that exact copy, and only then publish it under
// both the source-install and release-candidate names.
copyFileSync(sourceBinary, stagedBinary);
sh("codesign", ["--force", "--sign", "-", stagedBinary]);
const receipt = spawnSync("codesign", ["--verify", "--strict", stagedBinary], { encoding: "utf8" });
if (receipt.status !== 0) {
  withdraw();
  console.error(`the ad-hoc signature could not be verified: ${(receipt.stderr ?? "").trim()}`);
  process.exit(1);
}

const signedDigest = sha256(stagedBinary);
if (signedDigest === firstDigest) {
  withdraw();
  console.error("signing did not change the binary; the recorded digest would be ambiguous");
  process.exit(1);
}

const revision = sh("git", ["rev-parse", "HEAD"]);
copyFileSync(stagedBinary, stagedReleaseBinary);
writeFileSync(stagedChecksum, `${signedDigest}  ${releaseBase}\n`);
writeFileSync(
  stagedManifest,
  `${JSON.stringify(
    {
      version: SORAGE_VERSION,
      revision,
      target,
      binary: releaseBase,
      sha256: signedDigest,
      reproducibleUnsignedDigest: firstDigest,
      signature: "ad-hoc",
    },
    null,
    2,
  )}\n`,
);

if (sha256(stagedBinary) !== signedDigest || sha256(stagedReleaseBinary) !== signedDigest) {
  withdraw();
  console.error("release bytes changed while metadata was assembled");
  process.exit(1);
}

renameSync(stagedBinary, sourceBinary);
renameSync(stagedReleaseBinary, releaseBinary);
renameSync(stagedChecksum, checksumPath);
renameSync(stagedManifest, manifestPath);
if (sha256(sourceBinary) !== signedDigest || sha256(releaseBinary) !== signedDigest) {
  withdraw();
  console.error("published release bytes do not match the manifest; all candidate files were withdrawn");
  process.exit(1);
}

console.log(`packaged ${releaseBase} ${SORAGE_VERSION} at ${revision}`);
console.log(`sha256 ${signedDigest} (signed binary)`);
console.log(`reproducible unsigned digest ${firstDigest}`);
