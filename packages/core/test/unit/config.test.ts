import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONFIGURATION_DEFAULTS,
  applyConfigurationToDocument,
  defaultConfiguration,
  expandConfiguration,
  expandConfigurationPath,
  loadConfiguration,
  serializeConfiguration,
  validateConfiguration,
  type Configuration,
} from "../../src/config";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const schemaPath = `${repoRoot}docs/schemas/config.schema.json`;
const examplePath = `${repoRoot}docs/examples/config.example.yaml`;

const UUID = "9d57384c-030e-4ff7-90ca-c615d8043db2";

/** An annotated fixture exercising comments, quoted scalars, null, and key order. */
const ANNOTATED = `# annotated fixture — comments must survive a round trip
schemaVersion: 1
configRevision: 7
installationId: "${UUID}"

# comment above a mapping survives verbatim
vault:
  path: "~/Vault" # expanded against the user home
  importMode: "copy"

server:
  host: "::1"
  port: 46322
  autoStart: true
  openBrowserOnStart: false

handoff:
  allowUnregisteredSenders: false
  requireRegisteredRecipient: true
  inboxMarker: true

artifact:
  maxBytes: 2048
  externalSourcePolicy: "workspace_only"
  verifyChecksumOnFetch: true

gitBackup:
  enabled: true
  schedule:
    type: "daily"
    at: "04:30"
    timezone: "Asia/Seoul"
    catchUpAfterMissedRun: false
  commit:
    messageTemplate: "nightly {timestamp}"
  push:
    enabled: true
    remote: "backup"
    branch: "vault"
  largeArtifactWarningBytes: 1024
  snapshot:
    redactWorkspacePaths: false

ui:
  defaultPageSize: 100
  showArchivedByDefault: true
  timezone: "Asia/Seoul"

logging:
  level: "info"
  includeFullPaths: true
  rotation:
    maxBytes: 4096
    maxFiles: 2

gc:
  graceHours: 48
`;

function validFile(): Record<string, unknown> {
  const loaded = loadConfiguration(ANNOTATED, { userHome: "/Users/tester" });
  if (!loaded.ok) throw new Error(`fixture must load: ${loaded.error.message}`);
  return loaded.value.config as unknown as Record<string, unknown>;
}

describe("default configuration", () => {
  it("returns exactly the declared fixed defaults plus the generated identifier", () => {
    const config = defaultConfiguration(UUID);
    const expected = { ...CONFIGURATION_DEFAULTS, installationId: UUID };
    expect(config).toEqual(expected);
  });

  it("declares the same fixed default as every schema leaf except installationId", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as unknown;
    const leaves: Array<{ path: string[]; schema: Record<string, unknown> }> = [];
    collectLeaves(schema, [], leaves);
    expect(leaves.length).toBeGreaterThan(30);
    let withoutDefault = 0;
    let checked = 0;
    const defaults = defaultConfiguration(UUID) as unknown as Record<string, unknown>;
    for (const leaf of leaves) {
      if (!("default" in leaf.schema)) {
        expect(leaf.path).toEqual(["installationId"]);
        withoutDefault += 1;
        continue;
      }
      expect(readAtPath(defaults, leaf.path)).toEqual(leaf.schema.default);
      checked += 1;
    }
    expect(withoutDefault).toBe(1);
    expect(checked).toBe(leaves.length - 1);
  });

  it("validates examples/config.example.yaml into exactly the declared defaults", () => {
    const text = readFileSync(examplePath, "utf8");
    const loaded = loadConfiguration(text, { userHome: "/Users/tester" });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const expected = expandConfiguration(defaultConfiguration(UUID), "/Users/tester");
      expect(loaded.value.config).toEqual(expected);
    }
  });
});

describe("comment-preserving round trip", () => {
  it("is byte-identical for the annotated fixture, comments and key order included", () => {
    const loaded = loadConfiguration(ANNOTATED, { userHome: "/Users/tester" });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(serializeConfiguration(loaded.value)).toBe(ANNOTATED);
  });

  it("is byte-identical for the tracked example file", () => {
    const text = readFileSync(examplePath, "utf8");
    const loaded = loadConfiguration(text, { userHome: "/Users/tester" });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(serializeConfiguration(loaded.value)).toBe(text);
  });

  it("keeps comments when a changed value is applied to the document", () => {
    const loaded = loadConfiguration(ANNOTATED, { userHome: "/Users/tester" });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const changed = { ...loaded.value.config, configRevision: 8 } as Configuration;
    applyConfigurationToDocument(loaded.value.document, changed);
    const text = serializeConfiguration(loaded.value);
    expect(text).toContain("# annotated fixture — comments must survive a round trip");
    expect(text).toContain("# expanded against the user home");
    expect(text).toContain("configRevision: 8");
    const reloaded = loadConfiguration(text, { userHome: "/Users/tester" });
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value.config.configRevision).toBe(8);
  });
});

describe("tilde expansion and path normalization", () => {
  it("expands ~ and ~/ against the user home", () => {
    expect(expandConfigurationPath("~", "/Users/tester")).toBe("/Users/tester");
    expect(expandConfigurationPath("~/vault", "/Users/tester")).toBe("/Users/tester/vault");
    expect(expandConfigurationPath("~/a/b", "/Users/tester/")).toBe("/Users/tester/a/b");
  });

  it("resolves the canonical ~/.sorage prefix under the effective Sorage home", () => {
    expect(expandConfigurationPath("~/.sorage/vault", "/Users/tester", "/tmp/override")).toBe("/tmp/override/vault");
    expect(expandConfigurationPath("~/.sorage", "/Users/tester", "/tmp/override")).toBe("/tmp/override");
    expect(expandConfigurationPath("~/.sorage/vault", "/Users/tester")).toBe("/Users/tester/.sorage/vault");
    expect(expandConfigurationPath("~/.sorage-backup/vault", "/Users/tester", "/tmp/override")).toBe(
      "/Users/tester/.sorage-backup/vault",
    );
  });

  it("normalizes dots and duplicate separators without resolving against the cwd", () => {
    expect(expandConfigurationPath("/tmp//x/./y", "/Users/tester")).toBe("/tmp/x/y");
    expect(expandConfigurationPath("~/a/../b", "/Users/tester")).toBe("/Users/tester/b");
    expect(expandConfigurationPath("relative/path", "/Users/tester")).toBe("relative/path");
  });

  it("expands vault.path in the loaded runtime view only", () => {
    const loaded = loadConfiguration(ANNOTATED, { userHome: "/Users/tester" });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.config.vault.path).toBe("/Users/tester/Vault");
      // The document keeps the literal tilde so serialization stays byte-stable.
      expect(serializeConfiguration(loaded.value)).toContain('path: "~/Vault"');
    }
    const literal = expandConfiguration({ vault: { path: "kept", importMode: "copy" } } as Configuration, "/h");
    expect(literal.vault.path).toBe("kept");
  });
});

describe("validation failures", () => {
  it("rejects an unknown top-level key with CONFIG_INVALID", () => {
    const file = validFile();
    file.notAKey = true;
    expectFailure(file, "notAKey");
  });

  it("rejects an unknown nested key with CONFIG_INVALID", () => {
    const file = validFile();
    (file.server as Record<string, unknown>).hostname = "localhost";
    expectFailure(file, "server.hostname");
  });

  it("rejects a non-loopback server.host, including the name localhost", () => {
    for (const host of ["localhost", "0.0.0.0", "example.internal"]) {
      const file = validFile();
      (file.server as Record<string, unknown>).host = host;
      expectFailure(file, "server.host");
    }
  });

  it("rejects a malformed schedule time and an unsupported timezone", () => {
    const badTime = validFile();
    deepSet(badTime, ["gitBackup", "schedule", "at"], "25:00");
    expectFailure(badTime, "gitBackup.schedule.at");

    const badZone = validFile();
    deepSet(badZone, ["gitBackup", "schedule", "timezone"], "Not/AZone");
    expectFailure(badZone, "gitBackup.schedule.timezone");

    const badUiZone = validFile();
    deepSet(badUiZone, ["ui", "timezone"], "Mars/Olympus");
    expectFailure(badUiZone, "ui.timezone");
  });

  it("rejects structural violations with CONFIG_INVALID", () => {
    const missingIdentity = validFile();
    delete missingIdentity.installationId;
    expectFailure(missingIdentity, "installationId");

    const badUuid = validFile();
    badUuid.installationId = "not-a-uuid";
    expectFailure(badUuid, "installationId");

    const zeroRevision = validFile();
    zeroRevision.configRevision = 0;
    expectFailure(zeroRevision, "configRevision");

    const badPort = validFile();
    (badPort.server as Record<string, unknown>).port = 80;
    expectFailure(badPort, "server.port");

    const unlockedRecipient = validFile();
    (unlockedRecipient.handoff as Record<string, unknown>).requireRegisteredRecipient = false;
    expectFailure(unlockedRecipient, "handoff.requireRegisteredRecipient");

    const arrayRoot = ["not", "a", "mapping"];
    const result = validateConfiguration(arrayRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFIG_INVALID");
  });

  it("rejects unparseable YAML with CONFIG_INVALID", () => {
    const result = loadConfiguration("vault: [unclosed", { userHome: "/Users/tester" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFIG_INVALID");
  });
});

function expectFailure(file: Record<string, unknown>, path: string): void {
  const result = validateConfiguration(file);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("CONFIG_INVALID");
    expect(JSON.stringify(result.error.details)).toContain(path);
  }
}

function collectLeaves(
  node: unknown,
  path: string[],
  out: Array<{ path: string[]; schema: Record<string, unknown> }>,
): void {
  if (typeof node !== "object" || node === null) return;
  const schema = node as Record<string, unknown>;
  const properties = schema.properties;
  if (typeof properties === "object" && properties !== null) {
    for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
      collectLeaves(child, [...path, key], out);
    }
    return;
  }
  out.push({ path, schema });
}

function readAtPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function deepSet(value: Record<string, unknown>, path: string[], replacement: unknown): void {
  let current: Record<string, unknown> = value;
  for (const key of path.slice(0, -1)) {
    current = current[key] as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (last !== undefined) current[last] = replacement;
}
