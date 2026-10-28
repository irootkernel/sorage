import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeInstallation } from "@sorage/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as artifacts from "../../src/artifact-store";
import {
  createNodeHandoffReadPorts,
  createNodeRetentionPorts,
  createNodeReviewPorts,
  createNodeRevisionPorts,
  createNodeSendPorts,
  createNodeTerminalPorts,
  type NodeHandoffCommandPortsOptions,
} from "../../src/handoff-command-ports";
import { createNodeInitPorts } from "../../src/init-ports";
import * as projects from "../../src/project-command-ports";
import { openCoveredReadStorage } from "../../src/read-storage";
import * as connections from "../../src/sqlite/connection";
import type { SorageSqlite } from "../../src/sqlite/connection";
import * as migrator from "../../src/sqlite/migrator";
import { asAppCommandError } from "../../src/storage-contention";

const factories = [
  ["send", createNodeSendPorts],
  ["read", createNodeHandoffReadPorts],
  ["review", createNodeReviewPorts],
  ["terminal", createNodeTerminalPorts],
  ["revision", createNodeRevisionPorts],
  ["retention", createNodeRetentionPorts],
] as const;

let home: string;
let options: NodeHandoffCommandPortsOptions;
const opened: SorageSqlite[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sorage-handoff-composition-"));
  options = { env: { SORAGE_HOME: home }, userHome: home };
  expect(initializeInstallation(createNodeInitPorts(options), { vaultPath: join(home, "vault") }).ok).toBe(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // Construction-failure tests already closed their owned connection.
    }
  }
  rmSync(home, { recursive: true, force: true });
});

function observeOperationalOpen() {
  const realOpen = migrator.openAndMigrate;
  return vi.spyOn(migrator, "openAndMigrate").mockImplementation((...args) => {
    const result = realOpen(...args);
    opened.push(result.db);
    return result;
  });
}

describe("Handoff command-local database composition", () => {
  it.each(factories)("%s acquires one operational connection for its entire composition", (_name, create) => {
    const open = observeOperationalOpen();
    create(options);
    expect(open).toHaveBeenCalledTimes(1);
    expect(opened[0]?.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
  });

  it.each(factories)("%s closes its owned connection on configuration refusal", (_name, create) => {
    const open = observeOperationalOpen();
    rmSync(join(home, "config.yaml"));
    let failure: unknown;
    try {
      create(options);
    } catch (error) {
      failure = error;
    }
    expect(asAppCommandError(failure)?.error.code).toBe("NOT_INITIALIZED");
    expect(open).toHaveBeenCalledTimes(1);
    expect(() => opened[0]?.prepare("SELECT 1").get()).toThrow();
  });

  it.each(factories)("%s preserves a borrowed connection after nested construction fails", (_name, create) => {
    const db = connections.openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    opened.push(db);
    const close = vi.spyOn(db, "close");
    const open = observeOperationalOpen();
    const failure = new Error("project composition refused");
    vi.spyOn(projects, "createNodeProjectPorts").mockImplementation(() => {
      throw failure;
    });
    expect(() => create({ ...options, database: db })).toThrow(failure);
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(db.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
  });

  it("closes an owned outer connection when revision construction fails after its read ports", () => {
    observeOperationalOpen();
    const failure = new Error("artifact composition refused");
    vi.spyOn(artifacts, "createNodeArtifactStore").mockImplementation(() => {
      throw failure;
    });
    expect(() => createNodeRevisionPorts(options)).toThrow(failure);
    expect(opened).toHaveLength(1);
    expect(() => opened[0]?.prepare("SELECT 1").get()).toThrow();
  });

  it("preserves the primary configuration refusal when owned cleanup also throws", () => {
    const realOpen = migrator.openAndMigrate;
    vi.spyOn(migrator, "openAndMigrate").mockImplementation((...args) => {
      const result = realOpen(...args);
      const db = result.db;
      opened.push(db);
      vi.spyOn(db, "close").mockImplementation(() => {
        throw new Error("cleanup failed");
      });
      return result;
    });
    rmSync(join(home, "config.yaml"));
    let failure: unknown;
    try {
      createNodeSendPorts(options);
    } catch (error) {
      failure = error;
    }
    expect(asAppCommandError(failure)?.error.code).toBe("NOT_INITIALIZED");
  });

  it("keeps covered-read admission borrowed and builds no send-only resources", () => {
    const storage = openCoveredReadStorage({ ...options, surface: "handoff" });
    expect(storage.ok).toBe(true);
    if (!storage.ok) return;
    try {
      const close = vi.spyOn(storage.value.db, "close");
      const open = observeOperationalOpen();
      const artifact = vi.spyOn(artifacts, "createNodeArtifactStore");
      const ports = createNodeHandoffReadPorts({ ...options, database: storage.value.db });
      expect(ports.handoffs.findHandoffView("absent")).toEqual({ ok: true, value: null });
      expect(ports.projectPorts.projects.listProjects().ok).toBe(true);
      expect(open).not.toHaveBeenCalled();
      expect(artifact).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(storage.value.db.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
    } finally {
      storage.value.close();
    }
  });
});
