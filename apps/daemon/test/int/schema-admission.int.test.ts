import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeDaemonPorts, daemonStartAdmissionRefusal } from "@sorage/adapters/src/daemon-command-ports";
import { openSorageDatabase } from "@sorage/adapters/src/sqlite/connection";
import { knownSchemaMaximum } from "@sorage/core";
import { memoInstallation } from "../../../../packages/adapters/test/fixtures/memo-installation";
import { serveDaemon } from "../../src/runtime";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("daemon storage admission before operational startup", () => {
  it.each(["future", "malformed"])(
    "refuses %s history without a server, token, timer or leaked own lock",
    async (kind) => {
      const f = memoInstallation();
      cleanups.push(f.cleanup);
      const saved = process.env.SORAGE_HOME;
      process.env.SORAGE_HOME = f.home;
      cleanups.push(() => {
        if (saved === undefined) delete process.env.SORAGE_HOME;
        else process.env.SORAGE_HOME = saved;
      });
      const db = openSorageDatabase(f.database);
      try {
        if (kind === "future")
          db.prepare("INSERT INTO schema_migrations VALUES (?, 'future', '2026-01-01T00:00:00.000Z')").run(
            knownSchemaMaximum() + 1,
          );
        else db.exec("UPDATE schema_migrations SET name = 'invalid' WHERE version = 1");
      } finally {
        db.close();
      }
      const code = kind === "future" ? "STORAGE_SCHEMA_UNSUPPORTED" : "STORAGE_INTEGRITY_ERROR";
      const token = join(f.home, "state/api-token");
      rmSync(token, { force: true });
      const config = readFileSync(join(f.home, "config.yaml"));
      const marker = readFileSync(join(f.vault, ".sorage-vault.json"));
      const database = readFileSync(f.database);
      expect(daemonStartAdmissionRefusal({ SORAGE_HOME: f.home })?.code).toBe(code);
      expect(readFileSync(f.database)).toEqual(database);
      expect(existsSync(`${f.database}-wal`)).toBe(false);
      expect(existsSync(`${f.database}-shm`)).toBe(false);
      let servers = 0;
      let timers = 0;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          serveDaemon({
            serverFactory: () => {
              servers += 1;
              throw new Error("unexpected listener");
            },
            scheduleSweep: () => {
              timers += 1;
              return () => {};
            },
            scheduleBackup: () => {
              timers += 1;
              return () => {};
            },
          }),
        ).rejects.toMatchObject({ code });
        expect(existsSync(join(f.home, "run/daemon.lock"))).toBe(false);
      }
      expect(servers).toBe(0);
      expect(timers).toBe(0);
      expect(existsSync(join(f.home, "run/daemon.json"))).toBe(false);
      expect(existsSync(token)).toBe(false);
      expect(readFileSync(f.database)).toEqual(database);
      expect(readFileSync(join(f.home, "config.yaml"))).toEqual(config);
      expect(readFileSync(join(f.vault, ".sorage-vault.json"))).toEqual(marker);
      const own = createNodeDaemonPorts({ env: { SORAGE_HOME: f.home } }).acquireDaemonLock();
      expect(own.ok).toBe(true);
      own.release?.();
      const foreignRecord = join(f.home, "run/daemon.json");
      writeFileSync(foreignRecord, "pre-existing record");
      await expect(serveDaemon()).rejects.toMatchObject({ code });
      expect(readFileSync(foreignRecord, "utf8")).toBe("pre-existing record");
    },
  );
});

describe("daemon storage admission on a write-protected installation (TASK-119, V4)", () => {
  it.each(["normal", "newer-schema", "corrupt"])(
    "classifies the installation's real state (%s) from the private copy, with byte-identical originals",
    (kind) => {
      const f = memoInstallation();
      const db = openSorageDatabase(f.database);
      try {
        if (kind === "newer-schema")
          db.prepare("INSERT INTO schema_migrations VALUES (?, 'future', '2026-01-01T00:00:00.000Z')").run(
            knownSchemaMaximum() + 1,
          );
        else if (kind === "corrupt") db.exec("UPDATE schema_migrations SET name = 'invalid' WHERE version = 1");
      } finally {
        db.close();
      }
      const database = readFileSync(f.database);
      const config = readFileSync(join(f.home, "config.yaml"));
      const marker = readFileSync(join(f.vault, ".sorage-vault.json"));
      const wal = `${f.database}-wal`;
      const walBefore = existsSync(wal) ? readFileSync(wal) : undefined;
      const savedMode = statSync(f.database).mode & 0o777;
      const walSavedMode = walBefore !== undefined ? statSync(wal).mode & 0o777 : undefined;
      chmodSync(f.database, 0o444);
      if (walSavedMode !== undefined) chmodSync(wal, 0o444);
      // This file's cleanups run in registration order, so the mode restore
      // is registered before the fixture's tree removal.
      cleanups.push(() => {
        chmodSync(f.database, savedMode);
        if (walSavedMode !== undefined) chmodSync(wal, walSavedMode);
      });
      cleanups.push(f.cleanup);
      // Before TASK-119 the capture itself failed, so every state answered
      // null (unavailable inspection is not evidence of refusal); now the
      // real state is classified. Writable installations answer identically
      // to before.
      const expected =
        kind === "normal" ? null : kind === "newer-schema" ? "STORAGE_SCHEMA_UNSUPPORTED" : "STORAGE_INTEGRITY_ERROR";
      expect(daemonStartAdmissionRefusal({ SORAGE_HOME: f.home })?.code ?? null).toBe(expected);
      expect(readFileSync(f.database)).toEqual(database);
      expect(walBefore !== undefined ? existsSync(wal) : true).toBe(true);
      if (walBefore !== undefined) expect(readFileSync(wal)).toEqual(walBefore);
      expect(readFileSync(join(f.home, "config.yaml"))).toEqual(config);
      expect(readFileSync(join(f.vault, ".sorage-vault.json"))).toEqual(marker);
      expect(existsSync(`${f.database}-shm`)).toBe(false);
    },
  );
});
