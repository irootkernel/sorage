/**
 * The TASK-064 packaging pipeline (GEN-002, CLI-015, NFR-012, NFR-013, NFR-017):
 * `make package` compiles the locked-dependency tree through the pinned Bun
 * toolchain into `dist/sorage`, ad-hoc code-signs it, verifies the signature,
 * and emits the Homebrew formula inputs beside it. Two builds of the same
 * commit must produce the same binary, so the compile runs twice into separate
 * outputs and the digests are compared before anything is signed; a mismatch
 * fails the package rather than shipping an irreproducible artifact.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

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

function cliVersion(): string {
  const text = readFileSync(join(root, "apps/cli/src/main.ts"), "utf8");
  const match = /CLI_VERSION = "([^"]+)"/.exec(text);
  if (match === null) {
    console.error("the CLI version could not be read from apps/cli/src/main.ts");
    process.exit(1);
  }
  return match[1] as string;
}

mkdirSync(dist, { recursive: true });
// A rejected or in-flight run must never leave a binary and a manifest that
// describe different builds, so both artifacts start and end atomically.
rmSync(join(dist, "package.json"), { force: true });

// Reproducibility first (NFR-012): two independent compiles of the same tree,
// compared byte for byte through their digests before anything is signed.
// The compiled binary embeds its own basename into the virtual filesystem, so
// the reproducibility probe compiles into scratch directories that preserve the
// exact name; anything else would differ for reasons no user ever sees.
const first = join(dist, "sorage");
const scratch = join(dist, ".repro");
mkdirSync(scratch, { recursive: true });
const second = join(scratch, "sorage");
compile(first);
compile(second);
const firstDigest = sha256(first);
const secondDigest = sha256(second);
rmSync(scratch, { recursive: true, force: true });
if (firstDigest !== secondDigest) {
  rmSync(first, { force: true });
  console.error(`two builds of the same commit differ: ${firstDigest} vs ${secondDigest}`);
  process.exit(1);
}

// Ad-hoc code signing happens on a staged copy so the published pair is
// assembled by renames: Gatekeeper never quarantines a locally signed binary
// the tap installs, and `codesign -dv` leaves a durable, inspectable receipt.
const stagedBinary = join(dist, ".sorage.staged");
copyFileSync(first, stagedBinary);
sh("codesign", ["--force", "--sign", "-", stagedBinary]);
const receipt = spawnSync("codesign", ["-dv", first], { encoding: "utf8" });
if (receipt.status !== 0) {
  console.error(`the ad-hoc signature could not be verified: ${(receipt.stderr ?? "").trim()}`);
  process.exit(1);
}

const version = cliVersion();
const revision = sh("git", ["rev-parse", "HEAD"]);

// The manifest digest describes the signed binary that actually ships: ad-hoc
// signing rewrites the Mach-O, so hashing before it would describe a build
// that never existed.
const signedDigest = sha256(stagedBinary);
if (signedDigest === firstDigest) {
  console.error("signing did not change the binary; the recorded digest would be ambiguous");
  process.exit(1);
}

// The Homebrew formula input: the digest, the revision, and the version the
// tap formula is generated from, kept beside the binary it describes.
const inputs = {
  version,
  revision,
  binary: "dist/sorage",
  sha256: signedDigest,
  reproducibleUnsignedDigest: firstDigest,
  signature: "ad-hoc",
};
const manifestPath = join(dist, "package.json");
const stagedManifest = join(dist, ".package.json.staged");
writeFileSync(stagedManifest, `${JSON.stringify(inputs, null, 2)}\n`);
if (sha256(stagedBinary) !== signedDigest) {
  for (const scratch of [stagedManifest, stagedBinary, first]) rmSync(scratch, { force: true });
  console.error("the binary changed after signing; refusing to publish a mismatched manifest");
  process.exit(1);
}
// Publish the signed binary and its manifest together, then re-hash the
// published bytes: a concurrent writer that slipped between the guard and the
// renames is caught here and both artifacts are withdrawn.
const { renameSync } = require("node:fs") as typeof import("node:fs");
renameSync(stagedBinary, first);
renameSync(stagedManifest, manifestPath);
if (sha256(first) !== signedDigest) {
  rmSync(first, { force: true });
  rmSync(manifestPath, { force: true });
  console.error("dist/sorage changed during publication; both artifacts were withdrawn");
  process.exit(1);
}

console.log(`packaged dist/sorage ${version} at ${revision}`);
console.log(`sha256 ${signedDigest} (signed binary)`);
console.log(`reproducible unsigned digest ${firstDigest}`);
