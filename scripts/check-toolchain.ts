import { existsSync, readFileSync } from "node:fs";

const PINNED_VERSION = "1.4.0";
const PIN_FILES = [".bun-version", "package.json (engines.bun)"] as const;

function fail(message: string): never {
  console.error(`toolchain check failed: ${message}`);
  console.error(`Sorage pins Bun ${PINNED_VERSION}; the pin is recorded in ${PIN_FILES.join(" and ")}.`);
  process.exit(1);
}

for (const pinFile of [".bun-version", "package.json"]) {
  if (!existsSync(pinFile)) {
    fail(`${pinFile} is missing; it is one of the two files that record the Bun pin.`);
  }
}

let versionFile: string;
try {
  versionFile = readFileSync(".bun-version", "utf8").trim();
} catch {
  fail(".bun-version is not readable as UTF-8 text.");
}
if (versionFile !== PINNED_VERSION) {
  fail(`.bun-version records "${versionFile}" but this check expects "${PINNED_VERSION}".`);
}

let pkg: { engines?: { bun?: string } };
try {
  pkg = JSON.parse(readFileSync("package.json", "utf8")) as { engines?: { bun?: string } };
} catch {
  fail("package.json is not parseable JSON; it is one of the two files that record the Bun pin.");
}
const enginePin = pkg.engines?.bun;
if (enginePin !== PINNED_VERSION) {
  const recorded = enginePin ?? "absent";
  fail(`package.json engines.bun records "${recorded}" instead of "${PINNED_VERSION}".`);
}

if (!existsSync("bun.lock")) {
  fail("bun.lock is missing; run `bun install` on the pinned version and commit the lockfile.");
}

const runningVersion = Bun.version;
if (runningVersion !== PINNED_VERSION) {
  fail(`Bun ${runningVersion} is running but Sorage pins Bun ${PINNED_VERSION}; install the pinned version and retry.`);
}

console.log(`toolchain check passed: Bun ${runningVersion} matches the pin recorded in ${PIN_FILES.join(" and ")}.`);
