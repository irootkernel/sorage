import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfiguration, errorSpec, type Configuration } from "@sorage/core";
import { createConfigStore, type ConfigStoreFs } from "../../src/config-store";
import { createHomePaths, createNodeHomePaths } from "../../src/home";
import { createNodeLockProbePorts } from "../../src/lockfile";
import {
  CrashPointRegistry,
  FakeClock,
  faultInjectingFs,
  makeTempHome,
  withTempHome,
  type CrashPointRegistry as Registry,
} from "../../src/testkit";

const UUID = "1f0ac9a0-0000-4000-8000-00000000000a";

/** An annotated, fully populated configuration used as the on-disk starting point. */
const ANNOTATED = `# installation configuration
schemaVersion: 1
configRevision: 1
installationId: "${UUID}"

# the Vault; comments must survive a mediated write
vault:
  path: "~/.sorage/vault"
  importMode: "copy"

server:
  host: "127.0.0.1"
  port: 46321
  autoStart: false
  openBrowserOnStart: false

handoff:
  allowUnregisteredSenders: true
  requireRegisteredRecipient: true
  inboxMarker: false

artifact:
  maxBytes: 104857600
  externalSourcePolicy: "workspace_or_explicit"
  verifyChecksumOnFetch: false

gitBackup:
  enabled: false
  schedule:
    type: "daily"
    at: "03:00"
    timezone: "UTC"
    catchUpAfterMissedRun: true
  commit:
    messageTemplate: "sorage backup: {timestamp}"
  push:
    enabled: false
    remote: "origin"
    branch: "main"
  largeArtifactWarningBytes: 26214400
  snapshot:
    redactWorkspacePaths: true

ui:
  defaultPageSize: 50
  showArchivedByDefault: false
  timezone: null

logging:
  level: "warn"
  includeFullPaths: false
  rotation:
    maxBytes: 104857600
    maxFiles: 5

gc:
  graceHours: 24
`;

function storeFixture(registry?: Registry) {
  const home = makeTempHome("sorage-test-config-store-");
  const paths = createHomePaths({ SORAGE_HOME: home.home }, "/Users/tester");
  let fs: ConfigStoreFs | undefined;
  if (registry !== undefined) {
    const injected = faultInjectingFs(registry);
    fs = {
      writeFile: (path, data) => injected.writeFile(path, data),
      readFile: (path) => Buffer.from(injected.readFile(path)).toString("utf8"),
      rename: injected.rename,
      unlink: injected.unlink,
      mkdir: injected.mkdir,
      // The testkit fsync opens "r+", which a directory rejects; this variant keeps
      // the crash-point surface while serving both files and parent directories.
      fsync: (path) => {
        registry.fire("fs", "fsync", "before");
        const handle = openSync(path, "r");
        try {
          fsyncSync(handle);
        } finally {
          closeSync(handle);
        }
        registry.fire("fs", "fsync", "after");
      },
      copyFile: injected.copyFile,
      chmod: (path, mode) => chmodSync(path, mode),
    };
  }
  const store = createConfigStore({
    home: paths,
    lockPorts: createNodeLockProbePorts(new FakeClock()),
    userHome: "/Users/tester",
    fs,
  });
  return { home, paths, store, cleanup: home.cleanup };
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("the atomic configuration store", () => {
  it("reads null before any file exists and validates a written file", async () => {
    await withTempHome(async (home) => {
      const store = createConfigStore({
        home: createNodeHomePaths(),
        lockPorts: createNodeLockProbePorts(),
        userHome: "/Users/tester",
      });
      const missing = store.read();
      expect(missing.ok).toBe(true);
      if (missing.ok) expect(missing.value).toBeNull();
      expect(store.etag()).toBeNull();
      writeFileSync(createNodeHomePaths().configFile, ANNOTATED);
      const read = store.read();
      expect(read.ok).toBe(true);
      if (read.ok && read.value !== null) {
        expect(read.value.revision).toBe(1);
        expect(read.value.config.installationId).toBe(UUID);
        // The canonical ~/.sorage prefix resolves under the overridden Sorage home.
        expect(read.value.config.vault.path).toBe(join(home, "vault"));
        expect(read.value.etag).toBe(store.etag());
      }
    }, "sorage-test-store-read-");
  });

  it("writes with owner-only permissions and a monotonic configRevision", () => {
    const { store, paths, cleanup } = storeFixture();
    try {
      const first = store.write(defaultConfiguration(UUID));
      expect(first.ok).toBe(true);
      expect(mode(paths.configFile)).toBe(0o600);
      const second = store.write(defaultConfiguration(UUID));
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.value.config.configRevision).toBe(2);
        expect(readFileSync(paths.configFile, "utf8")).toContain("configRevision: 2");
        expect(mode(paths.configFile)).toBe(0o600);
        expect(mode(`${paths.configFile}.bak`)).toBe(0o600);
      }
    } finally {
      cleanup();
    }
  });

  it("preserves comments and key order through a mediated write", () => {
    const { store, paths, cleanup } = storeFixture();
    try {
      writeFileSync(paths.configFile, ANNOTATED);
      const changed: Configuration = {
        ...defaultConfiguration(UUID),
        server: { ...defaultConfiguration(UUID).server, port: 46322 },
      };
      const result = store.write(changed, { revision: 1 });
      expect(result.ok).toBe(true);
      const text = readFileSync(paths.configFile, "utf8");
      expect(text).toContain("# installation configuration");
      expect(text).toContain("# the Vault; comments must survive a mediated write");
      expect(text).toContain("port: 46322");
    } finally {
      cleanup();
    }
  });

  it("rejects a stale expected revision with CONFIG_CONFLICT, whose exit code is 75", () => {
    const { store, paths, cleanup } = storeFixture();
    try {
      writeFileSync(paths.configFile, ANNOTATED);
      const before = readFileSync(paths.configFile, "utf8");
      const result = store.write(defaultConfiguration(UUID), { revision: 0 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CONFIG_CONFLICT");
        expect(errorSpec(result.error.code).exitCode).toBe(75);
      }
      expect(readFileSync(paths.configFile, "utf8")).toBe(before);
    } finally {
      cleanup();
    }
  });

  it("rejects a stale ETag after a manual edit, which itself changes the ETag", () => {
    const { store, paths, cleanup } = storeFixture();
    try {
      writeFileSync(paths.configFile, ANNOTATED);
      const etagBefore = store.etag();
      expect(etagBefore).not.toBeNull();
      const edited = ANNOTATED.replace("port: 46321", "port: 46400");
      writeFileSync(paths.configFile, edited);
      expect(store.etag()).not.toBe(etagBefore);
      const result = store.write(defaultConfiguration(UUID), { etag: etagBefore ?? "" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CONFIG_CONFLICT");
        expect(errorSpec(result.error.code).exitCode).toBe(75);
      }
      expect(readFileSync(paths.configFile, "utf8")).toBe(edited);
    } finally {
      cleanup();
    }
  });

  it("keeps the previous valid configuration active and the .bak intact through an injected crash between write and rename", () => {
    const registry = new CrashPointRegistry();
    const { store, paths, cleanup } = storeFixture(registry);
    try {
      writeFileSync(paths.configFile, ANNOTATED);
      const firstWrite = store.write(
        { ...defaultConfiguration(UUID), server: { ...defaultConfiguration(UUID).server, port: 46331 } },
        { revision: 1 },
      );
      expect(firstWrite.ok).toBe(true);
      const activeAfterFirst = readFileSync(paths.configFile, "utf8");
      const bakAfterFirst = readFileSync(`${paths.configFile}.bak`, "utf8");

      registry.arm("CP-write-rename", "fs", "rename", "before");
      expect(() =>
        store.write(
          { ...defaultConfiguration(UUID), server: { ...defaultConfiguration(UUID).server, port: 46332 } },
          { revision: 2 },
        ),
      ).toThrow();
      registry.disarm("CP-write-rename");

      // The ten-step order replaces .bak (step 7) before the rename (step 8), so the
      // crash leaves the previous valid configuration active with the backup holding
      // exactly that same content: nothing is lost and the last known good survives.
      expect(readFileSync(paths.configFile, "utf8")).toBe(activeAfterFirst);
      expect(readFileSync(`${paths.configFile}.bak`, "utf8")).toBe(activeAfterFirst);
      expect(activeAfterFirst).toContain("port: 46331");
      expect(bakAfterFirst).toContain("port: 46321");
      const residue = `${paths.configFile}.tmp-${process.pid}`;
      expect(existsSync(residue)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("leaves the previous valid configuration active when the proposal is invalid", () => {
    const { store, paths, cleanup } = storeFixture();
    try {
      writeFileSync(paths.configFile, ANNOTATED);
      const before = readFileSync(paths.configFile, "utf8");
      const invalid = { ...defaultConfiguration(UUID), server: { ...defaultConfiguration(UUID).server, port: 80 } };
      const result = store.write(invalid, { revision: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("CONFIG_INVALID");
      expect(readFileSync(paths.configFile, "utf8")).toBe(before);
      expect(existsSync(`${paths.configFile}.bak`)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("reports a malformed current file as CONFIG_INVALID without rewriting anything", () => {
    const { store, paths, cleanup } = storeFixture();
    try {
      writeFileSync(paths.configFile, "vault: [unclosed");
      const read = store.read();
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.error.code).toBe("CONFIG_INVALID");
      const result = store.write(defaultConfiguration(UUID));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("CONFIG_INVALID");
      expect(readFileSync(paths.configFile, "utf8")).toBe("vault: [unclosed");
    } finally {
      cleanup();
    }
  });
});
