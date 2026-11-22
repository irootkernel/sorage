import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeInstallation } from "@sorage/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configStore from "../../src/config-store";
import { createNodeConfigCommandPorts } from "../../src/config-command-ports";
import {
  createNodeHandoffReadPorts,
  createNodeRetentionPorts,
  createNodeReviewPorts,
  createNodeRevisionPorts,
  createNodeSendPorts,
  createNodeTerminalPorts,
  openNodeHandoffDatabase,
} from "../../src/handoff-command-ports";
import { createNodeInboxMarkerPorts } from "../../src/inbox-marker-ports";
import { createNodeInitPorts } from "../../src/init-ports";
import { createNodeProjectPorts } from "../../src/project-command-ports";
import * as sqliteConnections from "../../src/sqlite/connection";
import { createNodeVaultCommandPorts } from "../../src/vault-command-ports";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sorage-port-lifecycle-"));
  process.env.SORAGE_HOME = home;
  const init = initializeInstallation(createNodeInitPorts(), { vaultPath: join(home, "vault") });
  expect(init.ok).toBe(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SORAGE_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("command-scoped port lifecycle and single config-read reuse (TASK-151, ADR-0036)", () => {
  it("closes owned SQLite handles idempotently and never closes a borrowed handle", () => {
    const factories = [
      ["project", (db?: sqliteConnections.SorageSqlite) => createNodeProjectPorts({ database: db })],
      ["send", (db?: sqliteConnections.SorageSqlite) => createNodeSendPorts({ database: db })],
      ["read", (db?: sqliteConnections.SorageSqlite) => createNodeHandoffReadPorts({ database: db })],
      ["review", (db?: sqliteConnections.SorageSqlite) => createNodeReviewPorts({ database: db })],
      ["terminal", (db?: sqliteConnections.SorageSqlite) => createNodeTerminalPorts({ database: db })],
      ["revision", (db?: sqliteConnections.SorageSqlite) => createNodeRevisionPorts({ database: db })],
      ["retention", (db?: sqliteConnections.SorageSqlite) => createNodeRetentionPorts({ database: db })],
      ["marker", (db?: sqliteConnections.SorageSqlite) => createNodeInboxMarkerPorts({ database: db })],
    ] as const;

    const realOpen = sqliteConnections.openSorageDatabase;
    for (const [name, build] of factories) {
      let ownedCloses = 0;
      const openSpy = vi.spyOn(sqliteConnections, "openSorageDatabase").mockImplementation((path: string) => {
        const db = realOpen(path);
        return {
          exec: (sql: string) => db.exec(sql),
          prepare: <Row = Record<string, unknown>>(sql: string) => db.prepare<Row>(sql),
          close: () => {
            ownedCloses += 1;
            db.close();
          },
        };
      });
      try {
        const owned = build();
        owned.close();
        owned.close();
        expect(ownedCloses, `${name} owned close count`).toBe(1);
      } finally {
        openSpy.mockRestore();
      }

      const borrowedReal = realOpen(join(home, "state", "sorage.sqlite3"));
      let borrowedCloses = 0;
      const borrowed: sqliteConnections.SorageSqlite = {
        exec: (sql: string) => borrowedReal.exec(sql),
        prepare: <Row = Record<string, unknown>>(sql: string) => borrowedReal.prepare<Row>(sql),
        close: () => {
          borrowedCloses += 1;
          borrowedReal.close();
        },
      };
      try {
        const bundle = build(borrowed);
        bundle.close();
        expect(borrowedCloses, `${name} borrowed close count`).toBe(0);
        // Borrowed handle remains usable after bundle.close().
        expect(borrowed.prepare("SELECT 1 AS ok").get()).toMatchObject({ ok: 1 });
      } finally {
        borrowedReal.close();
      }
    }
  });

  it("reads operational configuration once per composed Handoff port bundle", () => {
    const realCreateConfigStore = configStore.createConfigStore;
    const factories = [
      ["send", () => createNodeSendPorts()],
      ["read", () => createNodeHandoffReadPorts()],
      ["review", () => createNodeReviewPorts()],
      ["terminal", () => createNodeTerminalPorts()],
      ["revision", () => createNodeRevisionPorts()],
      ["retention", () => createNodeRetentionPorts()],
    ] as const;

    for (const [name, build] of factories) {
      let configReads = 0;
      const storeSpy = vi.spyOn(configStore, "createConfigStore").mockImplementation((options) => {
        const real = realCreateConfigStore(options);
        return {
          ...real,
          readForOperation: () => {
            configReads += 1;
            return real.readForOperation();
          },
        };
      });
      try {
        const ports = build();
        try {
          expect(configReads, `${name} config.readForOperation count`).toBe(1);
        } finally {
          ports.close();
        }
      } finally {
        storeSpy.mockRestore();
      }
    }
  });

  it("classifies database-open contention cleanly through openNodeHandoffDatabase", () => {
    const openSpy = vi.spyOn(sqliteConnections, "openSorageDatabase").mockImplementation(() => {
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    });
    try {
      const opened = openNodeHandoffDatabase();
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
        expect(opened.error.message).toContain("Handoff storage is contended");
      }
    } finally {
      openSpy.mockRestore();
    }
  });

  it("closes an owned handle and preserves a borrowed handle when post-open construction throws", () => {
    const configPath = join(home, "config.yaml");
    const realOpen = sqliteConnections.openSorageDatabase;
    const factories = [
      ["project", (db?: sqliteConnections.SorageSqlite) => createNodeProjectPorts({ database: db })],
      ["send", (db?: sqliteConnections.SorageSqlite) => createNodeSendPorts({ database: db })],
      ["read", (db?: sqliteConnections.SorageSqlite) => createNodeHandoffReadPorts({ database: db })],
      ["review", (db?: sqliteConnections.SorageSqlite) => createNodeReviewPorts({ database: db })],
      ["terminal", (db?: sqliteConnections.SorageSqlite) => createNodeTerminalPorts({ database: db })],
      ["revision", (db?: sqliteConnections.SorageSqlite) => createNodeRevisionPorts({ database: db })],
      ["retention", (db?: sqliteConnections.SorageSqlite) => createNodeRetentionPorts({ database: db })],
    ] as const;

    chmodSync(configPath, 0o000);
    try {
      for (const [name, build] of factories) {
        let ownedCloses = 0;
        const openSpy = vi.spyOn(sqliteConnections, "openSorageDatabase").mockImplementation((path: string) => {
          const db = realOpen(path);
          return {
            exec: (sql: string) => db.exec(sql),
            prepare: <Row = Record<string, unknown>>(sql: string) => db.prepare<Row>(sql),
            close: () => {
              ownedCloses += 1;
              db.close();
            },
          };
        });
        try {
          expect(() => build(), `${name} owned throw`).toThrow();
          expect(ownedCloses, `${name} owned close on construction throw`).toBe(1);
        } finally {
          openSpy.mockRestore();
        }

        const borrowedReal = realOpen(join(home, "state", "sorage.sqlite3"));
        let borrowedCloses = 0;
        const borrowed: sqliteConnections.SorageSqlite = {
          exec: (sql: string) => borrowedReal.exec(sql),
          prepare: <Row = Record<string, unknown>>(sql: string) => borrowedReal.prepare<Row>(sql),
          close: () => {
            borrowedCloses += 1;
            borrowedReal.close();
          },
        };
        try {
          expect(() => build(borrowed), `${name} borrowed throw`).toThrow();
          expect(borrowedCloses, `${name} borrowed close on construction throw`).toBe(0);
          expect(borrowed.prepare("SELECT 1 AS ok").get()).toMatchObject({ ok: 1 });
        } finally {
          borrowedReal.close();
        }
      }
    } finally {
      chmodSync(configPath, 0o600);
    }
  });

  it("preserves borrowed DB lifetime, handles post-drain artifact query errors, and reads fresh movePorts etag in vault-command-ports", () => {
    const configPorts = createNodeConfigCommandPorts();
    const initialRead = configPorts.store.readForOperation();
    expect(initialRead.ok && initialRead.value !== null).toBe(true);
    if (!initialRead.ok || initialRead.value === null) return;
    const staleConfiguration = initialRead.value;

    const realDb = sqliteConnections.openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    let borrowedCloses = 0;
    let failArtifactsQuery = false;
    const borrowed: sqliteConnections.SorageSqlite = {
      exec: (sql: string) => realDb.exec(sql),
      prepare: <Row = Record<string, unknown>>(sql: string) => {
        if (failArtifactsQuery && sql.includes("FROM artifacts a JOIN content_records c")) {
          throw new Error("simulated post-drain artifact query error");
        }
        return realDb.prepare<Row>(sql);
      },
      close: () => {
        borrowedCloses += 1;
        realDb.close();
      },
    };
    try {
      const vaultPorts = createNodeVaultCommandPorts({
        contentionSurface: "handoff",
        database: borrowed,
        configuration: staleConfiguration,
      });
      // Normal drainAtStart keeps borrowed DB open.
      expect(vaultPorts.drainAtStart().ok).toBe(true);
      expect(borrowedCloses).toBe(0);
      expect(borrowed.prepare("SELECT 1 AS ok").get()).toMatchObject({ ok: 1 });

      // Transient post-drain SQLite read error inside recordedArtifactsOn skips GC
      // rather than escaping and failing drainAtStart().
      failArtifactsQuery = true;
      expect(vaultPorts.drainAtStart().ok).toBe(true);
      failArtifactsQuery = false;
      expect(borrowedCloses).toBe(0);

      // Mutate config on disk so disk etag diverges from staleConfiguration.etag;
      // movePorts().config.current() MUST read the fresh etag from disk.
      const updatedConfig = {
        ...staleConfiguration.config,
        handoff: { ...staleConfiguration.config.handoff, inboxMarker: !staleConfiguration.config.handoff.inboxMarker },
      };
      const written = configPorts.store.write(updatedConfig, { etag: staleConfiguration.etag });
      expect(written.ok).toBe(true);
      const freshRead = configPorts.store.readForOperation();
      expect(freshRead.ok && freshRead.value !== null).toBe(true);
      if (!freshRead.ok || freshRead.value === null) return;
      expect(freshRead.value.etag).not.toBe(staleConfiguration.etag);

      const moveVaultPorts = createNodeVaultCommandPorts({
        targetPath: join(home, "vault-moved"),
        database: borrowed,
        configuration: staleConfiguration,
      });
      const movePorts = moveVaultPorts.movePorts();
      expect(movePorts.ok).toBe(true);
      if (!movePorts.ok) return;
      const current = movePorts.value.config.current();
      expect(current.ok).toBe(true);
      if (current.ok) {
        expect(current.value.etag).toBe(freshRead.value.etag);
      }
      expect(borrowedCloses).toBe(0);
    } finally {
      realDb.close();
    }
  });
});
