import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConfigurationFile } from "../../src/config";
import { setConfigurationValue, type ConfigCommandPorts, type ConfigCommandStore } from "../../src/config-commands";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const exampleText = readFileSync(`${repoRoot}docs/examples/config.example.yaml`, "utf8");

function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A store double that records the write expectation and otherwise serves the example file. */
function recordingStore(): {
  ports: ConfigCommandPorts;
  writeExpectation: () => { revision?: number; etag?: string } | undefined;
} {
  const parsed = parseConfigurationFile(exampleText);
  if (!parsed.ok) throw new Error("the example configuration must parse for the double");
  let expectation: { revision?: number; etag?: string } | undefined;
  const store: ConfigCommandStore = {
    read: () => ({ ok: true, value: { config: parsed.value.config, etag: sha256Of(exampleText), revision: 1 } }),
    readText: () => exampleText,
    write: (_config, expect) => {
      expectation = expect;
      return { ok: true, value: { config: parsed.value.config, etag: sha256Of(exampleText) } };
    },
    writeRaw: (_text, _expect) => ({ ok: true, value: { etag: sha256Of(exampleText) } }),
  };
  return {
    ports: {
      store,
      configFile: "/tmp/sorage-test/config.yaml",
      userHome: "/tmp/sorage-test-user",
      sorageHome: "/tmp/sorage-test",
      openEditor: () => ({ ok: true, value: undefined }),
    },
    writeExpectation: () => expectation,
  };
}

describe("setConfigurationValue", () => {
  it("fences every write on the ETag of the file view it read", () => {
    const { ports, writeExpectation } = recordingStore();
    const result = setConfigurationValue(ports, { key: "server.port", rawValue: "46322", asUser: true });
    expect(result.ok).toBe(true);
    expect(writeExpectation()).toEqual({ etag: sha256Of(exampleText) });
  });

  it("carries the expected revision alongside the ETag fence", () => {
    const { ports, writeExpectation } = recordingStore();
    const result = setConfigurationValue(ports, {
      key: "server.port",
      rawValue: "46322",
      asUser: true,
      expectedRevision: 7,
    });
    expect(result.ok).toBe(true);
    expect(writeExpectation()).toEqual({ revision: 7, etag: sha256Of(exampleText) });
  });
});
