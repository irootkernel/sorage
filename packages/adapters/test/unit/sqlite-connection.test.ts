import { describe, expect, it } from "vitest";
import { configureSorageDatabase, type SorageSqlite } from "../../src/sqlite/connection";

/**
 * The writer-connection configuration of RDR-003: every operational open
 * sets the Sorage pragmas and then keeps the WAL sidecars persistent through
 * `SQLITE_FCNTL_PERSIST_WAL` (opcode 10, argument 1). A refused or throwing
 * control call fails the open, and a connection without the control (the
 * node:sqlite bridge) is configured without it; the native-engine effect is
 * pinned by the read-admission integration suite.
 */

interface Recorded {
  statements: string[];
  controls: Array<{ op: number; arg: number | undefined }>;
}

function fake(control?: (op: number, arg?: number) => number): { db: SorageSqlite; recorded: Recorded } {
  const recorded: Recorded = { statements: [], controls: [] };
  const db: SorageSqlite = {
    exec: (sql) => {
      recorded.statements.push(sql);
    },
    prepare: () => {
      throw new Error("not used by configuration");
    },
    close: () => {},
    ...(control === undefined
      ? {}
      : {
          fileControl: (op: number, arg?: number) => {
            recorded.controls.push({ op, arg });
            return control(op, arg);
          },
        }),
  };
  return { db, recorded };
}

describe("writer connection configuration (RDR-003)", () => {
  it("sets the pragmas and then persists the WAL sidecars with opcode 10 and argument 1", () => {
    const { db, recorded } = fake(() => 0);
    configureSorageDatabase(db);
    expect(recorded.statements).toEqual([
      "PRAGMA busy_timeout = 5000",
      "PRAGMA journal_mode = WAL",
      "PRAGMA foreign_keys = ON",
    ]);
    expect(recorded.controls).toEqual([{ op: 10, arg: 1 }]);
  });

  it("fails the open when the persistence control is refused", () => {
    const { db } = fake(() => 1);
    expect(() => configureSorageDatabase(db)).toThrow(/persisting WAL sidecars was refused/);
  });

  it("fails the open when the persistence control throws", () => {
    const { db } = fake(() => {
      throw new Error("control unavailable");
    });
    expect(() => configureSorageDatabase(db)).toThrow(/control unavailable/);
  });

  it("configures a connection without the control, as the node:sqlite bridge is", () => {
    const { db, recorded } = fake();
    configureSorageDatabase(db);
    expect(recorded.statements).toHaveLength(3);
    expect(recorded.controls).toEqual([]);
  });

  it("honors the busy-timeout option before the WAL conversion", () => {
    const { db, recorded } = fake(() => 0);
    configureSorageDatabase(db, { busyTimeoutMs: 250 });
    expect(recorded.statements[0]).toBe("PRAGMA busy_timeout = 250");
  });
});
