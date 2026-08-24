import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultConfiguration } from "../../src/config";

/**
 * Contract snapshot for the configuration defaults (CFG-020): the committed golden
 * file pins exactly what a fresh installation declares, which is what
 * `sorage config show --json` returns on a fresh installation, and an unreviewed
 * change to any default fails this suite.
 */
const goldenDir = fileURLToPath(new URL("./golden/", import.meta.url));

describe("configuration defaults contract snapshot", () => {
  it("pins the complete fresh-configuration value", () => {
    const config = defaultConfiguration("2f0ac9a0-0000-4000-8000-000000000003");
    const golden = readFileSync(`${goldenDir}config-defaults.json`, "utf8");
    expect(JSON.stringify(config, null, 2)).toBe(golden.trimEnd());
  });
});
