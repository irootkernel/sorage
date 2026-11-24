import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defaultConfiguration } from "../../src/config";
import {
  type ConfigCommandPorts,
  type ConfigCommandStore,
  type ConfigTextCodec,
  setConfigurationValue,
} from "../../src/config-commands";
import { ok } from "../../src/errors";

const UUID = "9d57384c-030e-4ff7-90ca-c615d8043db2";
const sampleConfig = defaultConfiguration(UUID);
const exampleText = JSON.stringify(sampleConfig, null, 2);

function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A store double that records the write expectation and serves the sample file through a fake codec. */
function recordingStore(): {
  ports: ConfigCommandPorts;
  writeExpectation: () => { revision?: number; etag?: string } | undefined;
} {
  let expectation: { revision?: number; etag?: string } | undefined;
  const store: ConfigCommandStore = {
    read: () => ({
      ok: true,
      value: { config: structuredClone(sampleConfig), etag: sha256Of(exampleText), revision: 1 },
    }),
    readForOperation: () => ({
      ok: true,
      value: { config: structuredClone(sampleConfig), etag: sha256Of(exampleText), revision: 1 },
    }),
    readText: () => exampleText,
    write: (_config, expect) => {
      expectation = expect;
      return { ok: true, value: { config: structuredClone(sampleConfig), etag: sha256Of(exampleText) } };
    },
    writeRaw: (_text, _expect) => ({ ok: true, value: { etag: sha256Of(exampleText) } }),
  };
  const codec: ConfigTextCodec = {
    parse: () => ok(structuredClone(sampleConfig)),
  };
  return {
    ports: {
      store,
      codec,
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
