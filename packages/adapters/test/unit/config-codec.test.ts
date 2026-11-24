import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Configuration, defaultConfiguration, expandConfiguration } from "@sorage/core";
import { describe, expect, it } from "vitest";
import {
  applyConfigurationToDocument,
  createYamlConfigTextCodec,
  loadConfiguration,
  parseConfigurationFile,
  probeConfigurationPath,
  serializeConfiguration,
} from "../../src/config-codec";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const examplePath = `${repoRoot}docs/specs/examples/config.example.yaml`;

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

describe("configuration YAML codec (CFG-018)", () => {
  it("validates examples/config.example.yaml into exactly the declared defaults", () => {
    const text = readFileSync(examplePath, "utf8");
    const loaded = loadConfiguration(text, { userHome: "/Users/tester" });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const expected = expandConfiguration(defaultConfiguration(UUID), "/Users/tester");
      expect(loaded.value.config).toEqual(expected);
    }
  });

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

  it("expands vault.path in the loaded runtime view only while preserving literal tilde in serialization", () => {
    const loaded = loadConfiguration(ANNOTATED, { userHome: "/Users/tester" });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.config.vault.path).toBe("/Users/tester/Vault");
      expect(serializeConfiguration(loaded.value)).toContain('path: "~/Vault"');
    }
  });

  it("rejects unparseable YAML with CONFIG_INVALID and the yaml: issue payload", () => {
    const result = parseConfigurationFile("vault: [unclosed");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_INVALID");
      expect(result.error.message).toContain("the configuration is invalid: yaml: ");
      const issues = (result.error.details as { issues?: string[] } | undefined)?.issues;
      expect(Array.isArray(issues)).toBe(true);
      expect(issues?.[0]).toMatch(/^yaml: /);
    }
    const viaCodec = createYamlConfigTextCodec().parse("vault: [unclosed");
    expect(viaCodec.ok).toBe(false);
    if (!viaCodec.ok) {
      expect(viaCodec.error.code).toBe("CONFIG_INVALID");
      expect(viaCodec.error.message).toContain("yaml: ");
    }
  });
});

describe("probeConfigurationPath", () => {
  const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

  it("classifies regular files, non-regular entries, absence, dangling symlinks, loops, and access errors", () => {
    expect(
      probeConfigurationPath(
        () => ({ isFile: () => true }),
        () => ({ isFile: () => true }),
      ),
    ).toEqual({ kind: "regular-file" });
    expect(
      probeConfigurationPath(
        () => ({ isFile: () => false }),
        () => ({ isFile: () => false }),
      ),
    ).toEqual({ kind: "not-regular" });
    expect(
      probeConfigurationPath(
        () => {
          throw errno("ENOENT");
        },
        () => {
          throw errno("ENOENT");
        },
      ),
    ).toEqual({ kind: "missing" });
    expect(
      probeConfigurationPath(
        () => {
          throw errno("ENOENT");
        },
        () => ({ isFile: () => false }),
      ),
    ).toEqual({ kind: "dangling-symlink" });
    expect(
      probeConfigurationPath(
        () => {
          throw errno("ELOOP");
        },
        () => ({ isFile: () => false }),
      ),
    ).toEqual({ kind: "symlink-loop" });
    expect(
      probeConfigurationPath(
        () => {
          throw errno("EACCES");
        },
        () => ({ isFile: () => true }),
      ),
    ).toEqual({ kind: "access-failure" });
    expect(
      probeConfigurationPath(
        () => {
          throw errno("ENOENT");
        },
        () => {
          throw errno("EACCES");
        },
      ),
    ).toEqual({ kind: "access-failure" });
  });
});
