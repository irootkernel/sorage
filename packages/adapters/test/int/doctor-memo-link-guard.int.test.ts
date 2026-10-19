import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeInstallation } from "@sorage/core";
import { createNodeDoctorPorts } from "../../src/doctor";
import { createHomePaths } from "../../src/home";
import { createNodeInitPorts } from "../../src/init-ports";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { FakeClock } from "../../src/testkit/fakes";

/**
 * The `content.checksums` Memo-link guard owns its connection's close on every
 * exit (SHR-004, SHR-014, the C1 correction): a dangling Memo reference is a
 * blocking refusal and a thrown guard surfaces as the check's blocking
 * diagnostic, and both paths release the check's own database connection. The
 * close is observed directly through the connection module seam — a wrapped
 * `openSorageDatabase` whose `close` counts — so the test fails on the exact
 * leaked-refusal regression rather than on an indirect POSIX artifact.
 */

const closeState = vi.hoisted(() => ({ closes: 0 }));
const guardControl = vi.hoisted(() => ({ throwOnGuard: false }));

vi.mock("../../src/sqlite/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sqlite/connection")>();
  return {
    ...actual,
    openSorageDatabase: (path: string, options?: Parameters<typeof actual.openSorageDatabase>[1]) => {
      const db = actual.openSorageDatabase(path, options);
      return {
        exec: (sql: string) => db.exec(sql),
        prepare: (sql: string) => db.prepare(sql),
        close: () => {
          closeState.closes++;
          db.close();
        },
      };
    },
  };
});

vi.mock("../../src/content-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/content-store")>();
  return {
    ...actual,
    validateMemoContentLinks: (db: Parameters<typeof actual.validateMemoContentLinks>[0]) => {
      if (guardControl.throwOnGuard) throw new Error("injected guard failure");
      return actual.validateMemoContentLinks(db);
    },
  };
});

const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  guardControl.throwOnGuard = false;
  closeState.closes = 0;
});

const PROJECT = "cd000000-0000-4000-8000-000000000001";
const MEMO = "ab000000-0000-4000-8000-000000000001";
const RECORD = "ab000000-0000-4000-8000-000000000002";
const TIME = "2026-10-19T00:00:00.000Z";
const ACTOR = JSON.stringify({ kind: "user", id: null });

/** A schema-10 home whose only Memo references a deleted content record. */
function danglingLinkHome(): { home: string } {
  const home = mkdtempSync(join(tmpdir(), "sorage-doctor-memo-guard-"));
  homes.push(home);
  const initialized = initializeInstallation(
    createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() }),
    { vaultPath: join(home, "vault") },
  );
  if (initialized.ok !== true) throw new Error("fixture initialization failed");
  const paths = createHomePaths({ SORAGE_HOME: home }, home);
  const db = openSorageDatabase(join(paths.stateDir, "sorage.sqlite3"));
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare(
    "INSERT INTO projects (id, slug, display_name, status, created_at, updated_at) VALUES (?, 'p', 'P', 'active', ?, ?)",
  ).run(PROJECT, TIME, TIME);
  db.prepare(
    `INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at)
     VALUES (?, CAST(? AS TEXT), NULL, ?, ?, 1, ?)`,
  ).run(RECORD, Buffer.from("body", "utf8"), 3, "a".repeat(64), TIME);
  db.prepare(
    `INSERT INTO project_memos (id, project_id, title, content_record_id, state, row_version, created_at, updated_at, created_by, updated_by, closed_at, closed_by)
     VALUES (?, ?, 'dangling', ?, 'open', 1, ?, ?, ?, ?, NULL, NULL)`,
  ).run(MEMO, PROJECT, RECORD, TIME, TIME, ACTOR, ACTOR);
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare("DELETE FROM content_records WHERE id = ?").run(RECORD);
  db.exec("PRAGMA foreign_keys=ON");
  db.close();
  return { home };
}

describe("content.checksums Memo-link guard connection ownership", () => {
  it("returns the blocking dangling-link refusal and closes its own connection", () => {
    const { home } = danglingLinkHome();
    // The fixture's own connection cycles through the same wrapper; zero the
    // counter so it observes only the doctor check's owned connection.
    closeState.closes = 0;
    const doctor = createNodeDoctorPorts({ env: { SORAGE_HOME: home }, userHome: home, portProbe: () => false });
    const outcome = doctor.probe("content.checksums");
    expect(outcome.severity).toBe("blocking");
    expect(outcome.message).toContain("references content record");
    expect(outcome.message).not.toContain("SENTINEL");
    // The refusal path released the check's own connection; the old code
    // returned before the close ownership and this count stayed at zero.
    expect(closeState.closes).toBe(1);
  });

  it("closes the connection when the guard itself throws", () => {
    const { home } = danglingLinkHome();
    guardControl.throwOnGuard = true;
    try {
      closeState.closes = 0;
      const doctor = createNodeDoctorPorts({ env: { SORAGE_HOME: home }, userHome: home, portProbe: () => false });
      const outcome = doctor.probe("content.checksums");
      expect(outcome.severity).toBe("blocking");
      expect(outcome.message).toContain("could not be verified");
      expect(closeState.closes).toBe(1);
    } finally {
      guardControl.throwOnGuard = false;
    }
  });
});
