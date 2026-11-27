import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSqliteEventLedger } from "../../src/events";
import { createSqliteProjectHandoffStats } from "../../src/handoff-stats";
import { createNodeProjectPorts } from "../../src/project-command-ports";
import { createSqliteProjectReader, createSqliteProjectRepository } from "../../src/projects";
import type { SorageSqlite } from "../../src/sqlite/connection";

const TEST_ACTOR = { kind: "user", id: null } as const;
const NOOP_WITHDRAWN = () => {};

import { MIGRATIONS, PROJECT_REGISTRY_MIGRATION, productionMigrationPlan } from "../../src/sqlite/migrations";
import { MigrationFailedError, migrate, openAndMigrate } from "../../src/sqlite/migrator";
import { makeTempDatabase } from "../../src/testkit/temp-database";

const tempCleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of tempCleanups) cleanup();
});

function migratedDb() {
  const temp = makeTempDatabase();
  tempCleanups.push(temp.cleanup);
  migrate(temp.db, MIGRATIONS);
  temp.db
    .prepare("INSERT INTO installation (id, installation_id, schema_version, created_at) VALUES (1, ?, 2, ?)")
    .run("00000000-0000-4000-8000-000000000001", "2026-01-01T00:00:00.000Z");
  const row = temp.db.prepare("SELECT installation_id FROM installation WHERE id = 1").get() as {
    installation_id: string;
  };
  if (row === undefined) {
    throw new Error("the migrated database has no installation row");
  }
  return temp;
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "sorage-projects-"));
  tempCleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedProject(temp: ReturnType<typeof migratedDb>, slug: string, id = "11111111-1111-4111-8111-111111111111") {
  const repository = createSqliteProjectRepository(temp.db, {
    installationId: "00000000-0000-4000-8000-000000000001",
    events: createSqliteEventLedger(temp.db),
    onLocalProjectWithdrawn: NOOP_WITHDRAWN,
  });
  const result = repository.createProject(
    {
      id,
      slug,
      displayName: slug,
      description: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    TEST_ACTOR,
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("project registry migration", () => {
  it("creates the projects and project_bindings tables with their indexes", () => {
    const temp = migratedDb();
    const names = (
      temp.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(names).toContain("projects");
    expect(names).toContain("project_bindings");
    expect(names).toContain("idx_project_bindings_project_id");
  });

  it("rolls a failed later migration back and leaves no orphan index", () => {
    const temp = migratedDb();
    const projectSql = PROJECT_REGISTRY_MIGRATION.sql;
    if (projectSql === undefined) throw new Error("The Project registry fixture requires its original SQL migration");
    const failing = [
      ...MIGRATIONS,
      {
        version: 9,
        name: "broken-after-projects",
        sql: `${projectSql.replace(/projects/g, "orphan_projects")}; CREATE TABLE deliberately_broken (id INTEGER PRIMARY KEY);`,
      },
    ];
    expect(() => migrate(temp.db, failing)).toThrowError(MigrationFailedError);
    const leftovers = (
      temp.db
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'orphan_%' OR name = 'deliberately_broken'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(leftovers).toEqual([]);
    const versions = temp.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
    }>;
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("project repository", () => {
  it("resolves replacement paths before opening the SQLite write transaction", () => {
    const temp = migratedDb();
    const project = seedProject(temp, "web-app");
    const oldDir = tempDir();
    const newDir = tempDir();
    const vault = tempDir();
    const base = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
      events: createSqliteEventLedger(temp.db),
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const added = base.addBinding(
      {
        id: "21111111-1111-4111-8111-211111111111",
        projectId: project.id,
        directory: oldDir,
        bindingKind: "directory",
        createdAt: "t1",
      },
      TEST_ACTOR,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    let inWriteTransaction = false;
    const tracked: SorageSqlite = {
      exec(sql) {
        temp.db.exec(sql);
        if (sql === "BEGIN IMMEDIATE") inWriteTransaction = true;
        if (sql === "COMMIT" || sql === "ROLLBACK") inWriteTransaction = false;
      },
      prepare<Row = Record<string, unknown>>(sql: string) {
        return temp.db.prepare<Row>(sql);
      },
      close: () => temp.db.close(),
    };
    const repository = createSqliteProjectRepository(tracked, {
      installationId: "00000000-0000-4000-8000-000000000001",
      events: createSqliteEventLedger(tracked),
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
      vaultPath: vault,
      fs: {
        realpath(path) {
          if (inWriteTransaction) throw new Error("filesystem resolution occurred inside the write transaction");
          return realpathSync(path);
        },
      },
    });
    const result = repository.replaceBinding(
      added.value.id,
      added.value.directory,
      { directory: newDir, bindingKind: "directory", physicalPath: newDir, updatedAt: "t2" },
      TEST_ACTOR,
    );
    expect(result.ok).toBe(true);
    expect(inWriteTransaction).toBe(false);
  });
  it("rejects a replacement that resolves into the Vault after command validation", () => {
    const temp = migratedDb();
    const project = seedProject(temp, "web-app");
    const oldDir = tempDir();
    const target = tempDir();
    const vault = tempDir();
    const original = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
      events: createSqliteEventLedger(temp.db),
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const added = original.addBinding(
      {
        id: "21111111-1111-4111-8111-211111111111",
        projectId: project.id,
        directory: oldDir,
        bindingKind: "directory",
        createdAt: "t1",
      },
      TEST_ACTOR,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const replacement = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
      events: createSqliteEventLedger(temp.db),
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
      vaultPath: vault,
      fs: { realpath: (path) => (path === target ? realpathSync(vault) : realpathSync(path)) },
    });
    const changed = replacement.replaceBinding(
      added.value.id,
      added.value.directory,
      { directory: target, bindingKind: "directory", physicalPath: target, updatedAt: "t2" },
      TEST_ACTOR,
    );
    expect(changed.ok).toBe(false);
    expect(!changed.ok && changed.error.code).toBe("VAULT_CONTAINMENT");
    const stored = original.listBindingsForProject(project.id);
    expect(stored.ok && stored.value[0]?.directory).toBe(realpathSync(oldDir));
    const events = temp.db.prepare("SELECT event_type FROM events WHERE event_type = 'PROJECT_BINDING_REBOUND'").all();
    expect(events).toHaveLength(0);
  });
  it("returns its committed binding even when another writer rebinds before the response", () => {
    const temp = migratedDb();
    const project = seedProject(temp, "web-app");
    const oldDir = tempDir();
    const firstDir = tempDir();
    const laterDir = tempDir();
    const other = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
      events: createSqliteEventLedger(temp.db),
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const added = other.addBinding(
      {
        id: "21111111-1111-4111-8111-211111111111",
        projectId: project.id,
        directory: oldDir,
        bindingKind: "directory",
        createdAt: "t",
      },
      TEST_ACTOR,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    let arm = true;
    const base = temp.db as unknown as SorageSqlite;
    const intercepted: SorageSqlite = {
      exec(sql) {
        temp.db.exec(sql);
        if (sql === "COMMIT" && arm) {
          arm = false;
          const later = other.replaceBinding(
            added.value.id,
            realpathSync(firstDir),
            { directory: laterDir, bindingKind: "directory", physicalPath: laterDir, updatedAt: "t3" },
            TEST_ACTOR,
          );
          expect(later.ok).toBe(true);
        }
      },
      prepare<Row = Record<string, unknown>>(sql: string) {
        return base.prepare<Row>(sql);
      },
      close: () => temp.db.close(),
    };
    const first = createSqliteProjectRepository(intercepted, {
      installationId: "00000000-0000-4000-8000-000000000001",
      events: createSqliteEventLedger(intercepted),
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    }).replaceBinding(
      added.value.id,
      added.value.directory,
      { directory: firstDir, bindingKind: "directory", physicalPath: firstDir, updatedAt: "t2" },
      TEST_ACTOR,
    );
    expect(first.ok && first.value.directory).toBe(realpathSync(firstDir));
    const current = other.listBindingsForProject(project.id);
    expect(current.ok && current.value[0]?.directory).toBe(realpathSync(laterDir));
  });

  it("rolls a binding replacement back when its event cannot be appended", () => {
    const temp = migratedDb();
    const project = seedProject(temp, "web-app");
    const oldDir = tempDir();
    const newDir = tempDir();
    const ledger = createSqliteEventLedger(temp.db);
    const repository = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
      events: {
        ...ledger,
        appendNow(input) {
          if (input.eventType === "PROJECT_BINDING_REBOUND") throw new Error("injected event failure");
          ledger.appendNow(input);
        },
      },
    });
    const added = repository.addBinding(
      {
        id: "21111111-1111-4111-8111-211111111111",
        projectId: project.id,
        directory: oldDir,
        bindingKind: "directory",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      TEST_ACTOR,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const changed = repository.replaceBinding(
      added.value.id,
      added.value.directory,
      { directory: newDir, bindingKind: "directory", physicalPath: newDir, updatedAt: "2026-01-02T00:00:00.000Z" },
      TEST_ACTOR,
    );
    expect(changed.ok).toBe(false);
    const stored = repository.listBindingsForProject(project.id);
    expect(stored.ok && stored.value[0]?.directory).toBe(realpathSync(oldDir));
  });

  it("rechecks a newly bound outer Git repository inside the replacement transaction", () => {
    const temp = migratedDb();
    const project = seedProject(temp, "web-app");
    const repository = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
      events: createSqliteEventLedger(temp.db),
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const oldDir = tempDir();
    const outer = tempDir();
    const common = join(outer, ".git");
    const nested = join(outer, "nested");
    mkdirSync(common);
    mkdirSync(nested);
    const old = repository.addBinding(
      {
        id: "21111111-1111-4111-8111-211111111111",
        projectId: project.id,
        directory: oldDir,
        bindingKind: "directory",
        createdAt: "t",
      },
      TEST_ACTOR,
    );
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    // This registration occurs after an application preflight but before replacement.
    expect(
      repository.addBinding(
        {
          id: "31111111-1111-4111-8111-311111111111",
          projectId: project.id,
          directory: common,
          bindingKind: "git_repository",
          createdAt: "t",
        },
        TEST_ACTOR,
      ).ok,
    ).toBe(true);
    const changed = repository.replaceBinding(
      old.value.id,
      old.value.directory,
      { directory: nested, bindingKind: "directory", physicalPath: nested, updatedAt: "t2" },
      TEST_ACTOR,
    );
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.code).toBe("BINDING_DUPLICATE");
    const stored = repository.listBindingsForProject(project.id);
    expect(
      stored.ok &&
        stored.value.some((binding) => binding.id === old.value.id && binding.directory === realpathSync(oldDir)),
    ).toBe(true);
  });

  it("inserts two bindings of one Project on two directories", () => {
    const temp = migratedDb();
    const project = seedProject(temp, "web-app");
    const repository = createSqliteProjectRepository(temp.db, {
      events: createSqliteEventLedger(temp.db),
      installationId: "00000000-0000-4000-8000-000000000001",
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const firstDir = tempDir();
    const secondDir = tempDir();
    const first = repository.addBinding(
      {
        id: "21111111-1111-4111-8111-211111111111",
        projectId: project.id,
        directory: firstDir,
        bindingKind: "directory",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      TEST_ACTOR,
    );
    const second = repository.addBinding(
      {
        id: "31111111-1111-4111-8111-311111111111",
        projectId: project.id,
        directory: secondDir,
        bindingKind: "directory",
        createdAt: "2026-01-01T00:00:02.000Z",
      },
      TEST_ACTOR,
    );
    expect(first.ok && second.ok).toBe(true);
    const bindings = repository.listBindingsForProject(project.id);
    expect(bindings.ok && bindings.value).toHaveLength(2);
    expect(bindings.ok && bindings.value.map((binding) => binding.directory).sort()).toEqual(
      [realpathSync(firstDir), realpathSync(secondDir)].sort(),
    );
  });

  it("rejects a duplicate installation and directory pair in the database and surfaces BINDING_DUPLICATE", () => {
    const temp = migratedDb();
    const project = seedProject(temp, "web-app");
    const directory = tempDir();
    const repository = createSqliteProjectRepository(temp.db, {
      events: createSqliteEventLedger(temp.db),
      installationId: "00000000-0000-4000-8000-000000000001",
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const input = {
      projectId: project.id,
      directory,
      bindingKind: "directory" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(repository.addBinding({ ...input, id: "41111111-1111-4111-8111-411111111111" }, TEST_ACTOR).ok).toBe(true);
    const duplicate = repository.addBinding({ ...input, id: "51111111-1111-4111-8111-511111111111" }, TEST_ACTOR);
    expect(duplicate.ok).toBe(false);
    expect(!duplicate.ok && duplicate.error.code).toBe("BINDING_DUPLICATE");
    // The database constraint itself is the authority; the port only maps it.
    const rows = temp.db.prepare("SELECT directory FROM project_bindings").all() as Array<{ directory: string }>;
    expect(rows).toHaveLength(1);
  });

  it("collides two slugs that differ only in case with PROJECT_SLUG_CONFLICT", () => {
    const temp = migratedDb();
    seedProject(temp, "web-app");
    const repository = createSqliteProjectRepository(temp.db, {
      events: createSqliteEventLedger(temp.db),
      installationId: "00000000-0000-4000-8000-000000000001",
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const collision = repository.createProject(
      {
        id: "61111111-1111-4111-8111-611111111111",
        slug: "Web-App",
        displayName: "Web App",
        description: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      TEST_ACTOR,
    );
    expect(collision.ok).toBe(false);
    expect(!collision.ok && collision.error.code).toBe("PROJECT_SLUG_CONFLICT");
  });

  it("stores every directory as a normalized real path", () => {
    const temp = migratedDb();
    const project = seedProject(temp, "web-app");
    const real = tempDir();
    mkdirSync(join(real, "nested"));
    const alias = join(tempDir(), "alias");
    symlinkSync(real, alias);
    const repository = createSqliteProjectRepository(temp.db, {
      events: createSqliteEventLedger(temp.db),
      installationId: "00000000-0000-4000-8000-000000000001",
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const viaSymlink = repository.addBinding(
      {
        id: "71111111-1111-4111-8111-711111111111",
        projectId: project.id,
        directory: join(alias, "nested"),
        bindingKind: "directory",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      TEST_ACTOR,
    );
    expect(viaSymlink.ok).toBe(true);
    expect(viaSymlink.ok && viaSymlink.value.directory).toBe(join(realpathSync(real), "nested"));
    const stored = temp.db.prepare("SELECT directory FROM project_bindings").get() as { directory: string };
    expect(stored.directory).toBe(join(realpathSync(real), "nested"));
  });

  it("finds a project by slug case-insensitively and lists projects ordered by slug", () => {
    const temp = migratedDb();
    seedProject(temp, "alpha", "81111111-1111-4111-8111-811111111111");
    seedProject(temp, "Beta", "91111111-1111-4111-8111-911111111111");
    const repository = createSqliteProjectRepository(temp.db, {
      events: createSqliteEventLedger(temp.db),
      installationId: "00000000-0000-4000-8000-000000000001",
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const found = repository.findProjectBySlug("ALPHA");
    expect(found.ok && found.value?.slug).toBe("alpha");
    const missing = repository.findProjectBySlug("missing");
    expect(missing.ok ? missing.value : undefined).toBeNull();
    const listed = repository.listProjects();
    expect(listed.ok && listed.value.map((project) => project.slug)).toEqual(["alpha", "Beta"]);
  });

  it("folds a non-Latin lookup the way stored slugs are folded, because NOCASE folds only ASCII", () => {
    const temp = migratedDb();
    seedProject(temp, "проект", "71111111-1111-4111-8111-711111111111");
    const repository = createSqliteProjectRepository(temp.db, {
      events: createSqliteEventLedger(temp.db),
      installationId: "00000000-0000-4000-8000-000000000001",
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const found = repository.findProjectBySlug("ПРОЕКТ");
    expect(found.ok && found.value?.slug).toBe("проект");
  });

  it("folds a lookup through the locale-independent mapping, so a Turkic-locale host finds the same slug", () => {
    const temp = migratedDb();
    seedProject(temp, "wizard", "71111111-1111-4111-8111-711111111112");
    const repository = createSqliteProjectRepository(temp.db, {
      events: createSqliteEventLedger(temp.db),
      installationId: "00000000-0000-4000-8000-000000000001",
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const found = repository.findProjectBySlug("WIZARD");
    expect(found.ok && found.value?.slug).toBe("wizard");
  });

  it("maps a binding directory that vanishes before the insert to INTERNAL_ERROR instead of throwing", () => {
    const temp = migratedDb();
    const repository = createSqliteProjectRepository(temp.db, {
      events: createSqliteEventLedger(temp.db),
      installationId: "00000000-0000-4000-8000-000000000001",
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
      fs: {
        realpath: () => {
          throw new Error("ENOENT: the directory vanished between the check and the insert");
        },
      },
    });
    const result = repository.addBinding(
      {
        id: "71111111-1111-4111-8111-711111111113",
        projectId: "81111111-1111-4111-8111-811111111111",
        directory: "/tmp/vanished",
        bindingKind: "directory",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      TEST_ACTOR,
    ) as { ok: boolean; error?: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INTERNAL_ERROR");
    expect(result.error?.message).toContain("vanished");
  });

  it("invokes onLocalProjectWithdrawn synchronously before event emit on archive and on last local binding removal", () => {
    const temp = migratedDb();
    const project = seedProject(temp, "withdrawn-hook");
    const firstDir = tempDir();
    const secondDir = tempDir();
    const calls: Array<{ projectId: string; eventsAtHookTime: number }> = [];
    const repository = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
      events: createSqliteEventLedger(temp.db),
      onLocalProjectWithdrawn(projectId) {
        const count = (
          temp.db
            .prepare(
              "SELECT COUNT(*) AS count FROM events WHERE event_type IN ('PROJECT_STATUS_ARCHIVED', 'PROJECT_BINDING_REMOVED')",
            )
            .get() as { count: number }
        ).count;
        calls.push({ projectId, eventsAtHookTime: count });
      },
    });
    const b1 = repository.addBinding(
      {
        id: "a1111111-1111-4111-8111-111111111111",
        projectId: project.id,
        directory: firstDir,
        bindingKind: "directory",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      TEST_ACTOR,
    );
    const b2 = repository.addBinding(
      {
        id: "a2222222-2222-4222-8222-222222222222",
        projectId: project.id,
        directory: secondDir,
        bindingKind: "directory",
        createdAt: "2026-01-01T00:00:02.000Z",
      },
      TEST_ACTOR,
    );
    expect(b1.ok && b2.ok).toBe(true);

    // Non-last local binding removal must NOT invoke the withdrawal hook.
    expect(repository.removeBinding("a1111111-1111-4111-8111-111111111111", TEST_ACTOR).ok).toBe(true);
    expect(calls).toEqual([]);

    // Foreign-installation binding removal must NOT invoke the withdrawal hook.
    temp.db
      .prepare(
        "INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at) VALUES (?, ?, ?, ?, 'directory', 't', 't')",
      )
      .run("a3333333-3333-4333-8333-333333333333", project.id, "00000000-0000-4000-8000-999999999999", "/foreign");
    expect(repository.removeBinding("a3333333-3333-4333-8333-333333333333", TEST_ACTOR).ok).toBe(true);
    expect(calls).toEqual([]);

    // Removing the last local binding invokes the hook BEFORE emitting PROJECT_BINDING_REMOVED.
    expect(repository.removeBinding("a2222222-2222-4222-8222-222222222222", TEST_ACTOR).ok).toBe(true);
    expect(calls).toEqual([{ projectId: project.id, eventsAtHookTime: 2 }]);

    // Archiving invokes the hook BEFORE emitting PROJECT_STATUS_ARCHIVED; unarchiving does not.
    expect(repository.updateProjectStatus(project.id, "archived", "2026-01-02T00:00:00.000Z", TEST_ACTOR).ok).toBe(
      true,
    );
    expect(calls).toEqual([
      { projectId: project.id, eventsAtHookTime: 2 },
      { projectId: project.id, eventsAtHookTime: 3 },
    ]);
    expect(repository.updateProjectStatus(project.id, "active", "2026-01-03T00:00:00.000Z", TEST_ACTOR).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("atomically rolls back Project state, hook SQL, and event ledger when onLocalProjectWithdrawn throws on archive or last-binding unbind", () => {
    const temp = migratedDb();
    const project = seedProject(temp, "atomic-rollback");
    const dir = tempDir();
    temp.db.exec("CREATE TABLE hook_probe (project_id TEXT NOT NULL)");

    let shouldThrow = false;
    const repository = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
      events: createSqliteEventLedger(temp.db),
      onLocalProjectWithdrawn(projectId) {
        temp.db.prepare("INSERT INTO hook_probe (project_id) VALUES (?)").run(projectId);
        if (shouldThrow) throw new Error("injected withdrawal hook failure");
      },
    });
    const added = repository.addBinding(
      {
        id: "b1111111-1111-4111-8111-111111111111",
        projectId: project.id,
        directory: dir,
        bindingKind: "directory",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      TEST_ACTOR,
    );
    expect(added.ok).toBe(true);

    // 1. Trigger point: archive
    shouldThrow = true;
    const archived = repository.updateProjectStatus(project.id, "archived", "2026-01-02T00:00:00.000Z", TEST_ACTOR);
    expect(archived.ok).toBe(false);
    const afterArchiveStatus = temp.db.prepare("SELECT status FROM projects WHERE id = ?").get(project.id) as {
      status: string;
    };
    expect(afterArchiveStatus.status).toBe("active");
    expect(temp.db.prepare("SELECT * FROM hook_probe").all()).toHaveLength(0);
    expect(temp.db.prepare("SELECT * FROM events WHERE event_type = 'PROJECT_STATUS_ARCHIVED'").all()).toHaveLength(0);

    // 2. Trigger point: removal of last local binding
    const removed = repository.removeBinding("b1111111-1111-4111-8111-111111111111", TEST_ACTOR);
    expect(removed.ok).toBe(false);
    const bindings = repository.listBindingsForProject(project.id);
    expect(bindings.ok && bindings.value).toHaveLength(1);
    expect(temp.db.prepare("SELECT * FROM hook_probe").all()).toHaveLength(0);
    expect(temp.db.prepare("SELECT * FROM events WHERE event_type = 'PROJECT_BINDING_REMOVED'").all()).toHaveLength(0);
  });

  it("exposes a dedicated read-only createSqliteProjectReader without write methods", () => {
    const temp = migratedDb();
    const project = seedProject(temp, "reader-only");
    const reader = createSqliteProjectReader(temp.db);
    expect(Object.keys(reader).sort()).toEqual([
      "findProjectBySlug",
      "listBindings",
      "listBindingsForProject",
      "listProjects",
    ]);
    const found = reader.findProjectBySlug("READER-ONLY");
    expect(found.ok && found.value?.id).toBe(project.id);
    const listed = reader.listProjects();
    expect(listed.ok && listed.value.map((p) => p.slug)).toEqual(["reader-only"]);
  });

  it("counts recipient-scoped open and recorded unfinished accepted Handoffs via createSqliteProjectHandoffStats (PRJ-022, HPR-011)", () => {
    const dir = tempDir();
    const plan = productionMigrationPlan();
    const { db } = openAndMigrate(join(dir, "stats.sqlite3"), plan.migrations, { rebuilds: plan.rebuilds });
    tempCleanups.push(() => db.close());
    db.prepare(
      "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, ?, ?, NULL, 'active', 't', 't')",
    ).run("p-rec", "rec", "Rec");
    db.prepare(
      "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, ?, ?, NULL, 'active', 't', 't')",
    ).run("p-other", "other", "Other");
    const inlineBody = "x";
    const inlineSha256 = createHash("sha256").update(inlineBody).digest("hex");
    const insertContent = db.prepare(
      "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, ?, NULL, ?, ?, 1, 't')",
    );
    const insertArtifact = db.prepare(
      "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, 'body.md', 'body.md', 'text/markdown', NULL, 't', ?)",
    );
    const insertHandoff = db.prepare(
      `INSERT INTO handoffs (id, title, sender_kind, sender_project_id, recipient_project_id, current_artifact_id, revision, row_version, review_state, consecutive_no_change_resolutions, pinned, read_status, processing_status, processing_started_at, processing_completed_at, archived_at, deleted_at, created_at, updated_at)
       VALUES (?, 't', 'registered_project', ?, ?, ?, 1, 1, ?, 0, 0, 'unconfirmed', ?, ?, ?, ?, ?, 't', 't')`,
    );
    const seedRow = (
      id: string,
      senderId: string,
      recipientId: string,
      reviewState: string,
      processingStatus: string,
      archivedAt: string | null,
      deletedAt: string | null,
    ) => {
      const startedAt =
        processingStatus === "in_progress" || processingStatus === "completed" ? "2026-01-01T00:00:00.000Z" : null;
      const completedAt = processingStatus === "completed" ? "2026-01-01T00:01:00.000Z" : null;
      db.exec("BEGIN IMMEDIATE");
      const artifactId = deletedAt === null ? `a-${id}` : null;
      if (artifactId !== null) {
        insertContent.run(`c-${id}`, inlineBody, Buffer.byteLength(inlineBody, "utf8"), inlineSha256);
        insertArtifact.run(artifactId, id, `c-${id}`);
      }
      insertHandoff.run(
        id,
        senderId,
        recipientId,
        artifactId,
        reviewState,
        processingStatus,
        startedAt,
        completedAt,
        archivedAt,
        deletedAt,
      );
      db.exec("COMMIT");
    };
    // Counted (4): awaiting_recipient, changes_requested, accepted+not_started, accepted+in_progress (archived)
    seedRow("h1", "p-other", "p-rec", "awaiting_recipient", "not_started", null, null);
    seedRow("h2", "p-other", "p-rec", "changes_requested", "not_started", null, null);
    seedRow("h3", "p-other", "p-rec", "accepted", "not_started", null, null);
    seedRow("h4", "p-other", "p-rec", "accepted", "in_progress", "2026-01-01T00:00:00.000Z", null);
    // Not counted: accepted+completed, accepted+unrecorded (legacy), deleted, declined, withdrawn, sender-only
    seedRow("h5", "p-other", "p-rec", "accepted", "completed", null, null);
    seedRow("h6", "p-other", "p-rec", "accepted", "unrecorded", null, null);
    seedRow("h7", "p-other", "p-rec", "awaiting_recipient", "not_started", null, "2026-01-02T00:00:00.000Z");
    seedRow("h8", "p-other", "p-rec", "declined", "not_started", null, null);
    seedRow("h9", "p-other", "p-rec", "withdrawn", "not_started", null, null);
    seedRow("h10", "p-rec", "p-other", "awaiting_recipient", "not_started", null, null);

    const stats = createSqliteProjectHandoffStats(db);
    expect(stats.openHandoffCount("p-rec")).toEqual({ ok: true, value: 4 });
    expect(stats.openHandoffCount("p-other")).toEqual({ ok: true, value: 1 });
  });
});

describe("commit-time containment, conflict revalidation, and absentRealPath root joins (ADR-0041)", () => {
  it("resolves realpath before BEGIN IMMEDIATE and rejects VAULT_CONTAINMENT or conflict with zero partial rows", () => {
    const temp = migratedDb();
    const vault = tempDir();
    const repoDir = tempDir();
    const repoGit = join(repoDir, ".git");
    mkdirSync(repoGit);
    const insideRepo = join(repoDir, "nested");
    mkdirSync(insideRepo);

    let inWriteTransaction = false;
    const tracked: SorageSqlite = {
      exec(sql) {
        temp.db.exec(sql);
        if (sql === "BEGIN IMMEDIATE") inWriteTransaction = true;
        if (sql === "COMMIT" || sql === "ROLLBACK") inWriteTransaction = false;
      },
      prepare<Row = Record<string, unknown>>(sql: string) {
        return temp.db.prepare<Row>(sql);
      },
      close: () => temp.db.close(),
    };

    const repo = createSqliteProjectRepository(tracked, {
      installationId: "00000000-0000-4000-8000-000000000001",
      events: createSqliteEventLedger(tracked),
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
      vaultPath: vault,
      fs: {
        realpath(path) {
          if (inWriteTransaction) throw new Error("filesystem resolution occurred inside the write transaction");
          return realpathSync(path);
        },
      },
    });

    // Reject "/" in createProjectWithBinding with zero partial Project or binding rows.
    const rootCreate = repo.createProjectWithBinding(
      { id: "p-root", slug: "root", displayName: "Root", description: null, createdAt: "t1" },
      {
        id: "b-root",
        projectId: "p-root",
        directory: "/",
        bindingKind: "directory",
        physicalPath: "/",
        createdAt: "t1",
      },
      TEST_ACTOR,
    );
    expect(rootCreate.ok).toBe(false);
    expect(!rootCreate.ok && rootCreate.error.code).toBe("VAULT_CONTAINMENT");
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 0 });
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM project_bindings").get()).toEqual({ n: 0 });
    expect(inWriteTransaction).toBe(false);

    // Valid git_repository registration succeeds, resolving realpath outside BEGIN IMMEDIATE.
    const validCreate = repo.createProjectWithBinding(
      { id: "p-repo", slug: "repo", displayName: "Repo", description: null, createdAt: "t2" },
      {
        id: "b-repo",
        projectId: "p-repo",
        directory: repoGit,
        bindingKind: "git_repository",
        physicalPath: repoDir,
        createdAt: "t2",
      },
      TEST_ACTOR,
    );
    expect(validCreate.ok).toBe(true);
    expect(inWriteTransaction).toBe(false);

    // Commit-time findBindingConflict rejects adding a nested directory inside the bound git repo,
    // both via createProjectWithBinding (leaving zero partial Project rows) and via addBinding.
    const nestedCreate = repo.createProjectWithBinding(
      { id: "p-sub", slug: "sub", displayName: "Sub", description: null, createdAt: "t3" },
      {
        id: "b-sub",
        projectId: "p-sub",
        directory: insideRepo,
        bindingKind: "directory",
        physicalPath: insideRepo,
        createdAt: "t3",
      },
      TEST_ACTOR,
    );
    expect(nestedCreate.ok).toBe(false);
    expect(!nestedCreate.ok && nestedCreate.error.code).toBe("BINDING_DUPLICATE");
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 1 });

    const rootAdd = repo.addBinding(
      {
        id: "b-add-root",
        projectId: "p-repo",
        directory: "/",
        bindingKind: "directory",
        physicalPath: "/",
        createdAt: "t4",
      },
      TEST_ACTOR,
    );
    expect(rootAdd.ok).toBe(false);
    expect(!rootAdd.ok && rootAdd.error.code).toBe("VAULT_CONTAINMENT");

    const nestedAdd = repo.addBinding(
      {
        id: "b-add-sub",
        projectId: "p-repo",
        directory: insideRepo,
        bindingKind: "directory",
        physicalPath: insideRepo,
        createdAt: "t5",
      },
      TEST_ACTOR,
    );
    expect(nestedAdd.ok).toBe(false);
    expect(!nestedAdd.ok && nestedAdd.error.code).toBe("BINDING_DUPLICATE");
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM project_bindings").get()).toEqual({ n: 1 });

    // Commit-time replaceBinding also rejects "/" with VAULT_CONTAINMENT outside BEGIN IMMEDIATE,
    // leaving the binding unchanged and emitting zero PROJECT_BINDING_REBOUND events.
    const rootReplace = repo.replaceBinding(
      "b-repo",
      realpathSync(repoGit),
      { directory: "/", bindingKind: "directory", physicalPath: "/", updatedAt: "t6" },
      TEST_ACTOR,
    );
    expect(rootReplace.ok).toBe(false);
    expect(!rootReplace.ok && rootReplace.error.code).toBe("VAULT_CONTAINMENT");
    expect(inWriteTransaction).toBe(false);
    expect(temp.db.prepare("SELECT directory FROM project_bindings WHERE id = 'b-repo'").get()).toEqual({
      directory: realpathSync(repoGit),
    });
    expect(
      temp.db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'PROJECT_BINDING_REBOUND'").get(),
    ).toEqual({ n: 0 });
  });

  it("emits '/<rest>' rather than '//<rest>' in absentRealPath when '/' is the longest existing ancestor", () => {
    const temp = migratedDb();
    const home = tempDir();
    const vault = join(home, "vault");
    mkdirSync(vault);
    const ports = createNodeProjectPorts({
      database: temp.db,
      configuration: {
        config: {
          installationId: "00000000-0000-4000-8000-000000000001",
          vault: { path: vault },
        } as never,
        etag: "test",
        source: "file",
      } as never,
      userHome: home,
    });
    try {
      const missing = "/sorage-definitely-missing-top-level-dir-169/sub/leaf";
      const resolved = ports.bindings.absentRealPath(missing, home);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.value).toBe(missing);
        expect(resolved.value.startsWith("//")).toBe(false);
      }
      const rootOnly = ports.bindings.absentRealPath("/", home);
      expect(rootOnly).toEqual({ ok: true, value: "/" });
    } finally {
      ports.close();
    }
  });

  it("resolves an absent vaultPath via its longest existing ancestor during commit-time containment checks", () => {
    const temp = migratedDb();
    const root = tempDir();
    const projectDir = join(root, "proj");
    mkdirSync(projectDir);
    const absentOutsideVault = join(root, "not-yet-created-vault");
    const repoOutside = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
      vaultPath: absentOutsideVault,
      events: createSqliteEventLedger(temp.db),
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const accepted = repoOutside.createProjectWithBinding(
      { id: "p-absent-ok", slug: "absent-ok", displayName: "Absent OK", description: null, createdAt: "t1" },
      { id: "b-absent-ok", projectId: "", directory: projectDir, bindingKind: "directory", createdAt: "t1" },
      TEST_ACTOR,
    );
    expect(accepted.ok).toBe(true);

    const absentInsideVault = join(projectDir, "future-vault");
    const repoInside = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
      vaultPath: absentInsideVault,
      events: createSqliteEventLedger(temp.db),
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const refused = repoInside.createProjectWithBinding(
      { id: "p-absent-bad", slug: "absent-bad", displayName: "Absent Bad", description: null, createdAt: "t2" },
      { id: "b-absent-bad", projectId: "", directory: projectDir, bindingKind: "directory", createdAt: "t2" },
      TEST_ACTOR,
    );
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.code).toBe("VAULT_CONTAINMENT");
    // Rejected commit-time containment checks must leave zero partial rows.
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 1 });
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM project_bindings").get()).toEqual({ n: 1 });

    // Unnormalized '..' and '//' in an absent absolute vaultPath normalize before containment checks.
    const traversalInsideVault = `${root}//outside/../proj/nested/../future-vault/`;
    const repoTraversal = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
      vaultPath: traversalInsideVault,
      events: createSqliteEventLedger(temp.db),
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const traversalRefused = repoTraversal.createProjectWithBinding(
      { id: "p-absent-trav", slug: "absent-trav", displayName: "Absent Trav", description: null, createdAt: "t3" },
      { id: "b-absent-trav", projectId: "", directory: projectDir, bindingKind: "directory", createdAt: "t3" },
      TEST_ACTOR,
    );
    expect(traversalRefused.ok).toBe(false);
    expect(!traversalRefused.ok && traversalRefused.error.code).toBe("VAULT_CONTAINMENT");
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 1 });
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM project_bindings").get()).toEqual({ n: 1 });

    // Symlinked ancestor pointing to the Project directory still triggers VAULT_CONTAINMENT.
    const symlinkToProject = join(root, "link-to-proj");
    symlinkSync(projectDir, symlinkToProject);
    const repoSymlinkAncestor = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
      vaultPath: join(symlinkToProject, "future-vault"),
      events: createSqliteEventLedger(temp.db),
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const symlinkRefused = repoSymlinkAncestor.createProjectWithBinding(
      { id: "p-absent-sym", slug: "absent-sym", displayName: "Absent Sym", description: null, createdAt: "t4" },
      { id: "b-absent-sym", projectId: "", directory: projectDir, bindingKind: "directory", createdAt: "t4" },
      TEST_ACTOR,
    );
    expect(symlinkRefused.ok).toBe(false);
    expect(!symlinkRefused.ok && symlinkRefused.error.code).toBe("VAULT_CONTAINMENT");
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 1 });
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM project_bindings").get()).toEqual({ n: 1 });

    // Absent top-level vaultPath whose longest existing ancestor is '/' resolves to '/<rest>'
    // (not '//<rest>') and respects injected ProjectRepositoryFs.lstat: a Project rooted at the
    // missing prefix is rejected with VAULT_CONTAINMENT (which would pass wrongly if '//' were emitted),
    // while an unrelated Project is accepted.
    const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const lstatCalls: string[] = [];
    const missingTopRoot = "/sorage-definitely-missing-top-level-vault-175";
    const missingTopVault = `${missingTopRoot}/sub`;
    const virtualRootFs = {
      realpath: (p: string) => {
        if (p === "/" || p === missingTopRoot) return p;
        if (p === missingTopVault) throw enoent();
        return realpathSync(p);
      },
      lstat: (p: string) => {
        lstatCalls.push(p);
        if (p === missingTopVault || p === missingTopRoot) throw enoent();
      },
    };
    const repoRootOverlap = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
      vaultPath: missingTopVault,
      fs: virtualRootFs,
      events: createSqliteEventLedger(temp.db),
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const rootOverlapRefused = repoRootOverlap.createProjectWithBinding(
      {
        id: "p-root-overlap",
        slug: "absent-root-overlap",
        displayName: "Root Overlap",
        description: null,
        createdAt: "t5a",
      },
      { id: "b-root-overlap", projectId: "", directory: missingTopRoot, bindingKind: "directory", createdAt: "t5a" },
      TEST_ACTOR,
    );
    expect(rootOverlapRefused.ok).toBe(false);
    expect(!rootOverlapRefused.ok && rootOverlapRefused.error.code).toBe("VAULT_CONTAINMENT");
    expect(lstatCalls).toEqual([missingTopVault, missingTopRoot]);
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 1 });
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM project_bindings").get()).toEqual({ n: 1 });

    const rootProjectDir = join(root, "proj-root-ok");
    mkdirSync(rootProjectDir);
    const repoRootAncestor = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
      vaultPath: missingTopVault,
      events: createSqliteEventLedger(temp.db),
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const rootAncestorAccepted = repoRootAncestor.createProjectWithBinding(
      { id: "p-absent-root", slug: "absent-root", displayName: "Absent Root", description: null, createdAt: "t5" },
      {
        id: "b-absent-root",
        projectId: "",
        directory: rootProjectDir,
        bindingKind: "directory",
        createdAt: "t5",
      },
      TEST_ACTOR,
    );
    expect(rootAncestorAccepted.ok).toBe(true);
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 2 });
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM project_bindings").get()).toEqual({ n: 2 });

    // Dangling symlink at vaultPath or an ancestor fails closed (mapped to INTERNAL_ERROR) instead of climbing past the link.
    const danglingVault = join(root, "dangling-vault");
    symlinkSync(join(projectDir, "not-yet-created-target"), danglingVault);
    const repoDangling = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
      vaultPath: danglingVault,
      events: createSqliteEventLedger(temp.db),
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const danglingRefused = repoDangling.createProjectWithBinding(
      { id: "p-dangling", slug: "absent-dangling", displayName: "Dangling", description: null, createdAt: "t6" },
      { id: "b-dangling", projectId: "", directory: projectDir, bindingKind: "directory", createdAt: "t6" },
      TEST_ACTOR,
    );
    expect(danglingRefused.ok).toBe(false);
    expect(!danglingRefused.ok && danglingRefused.error.code).toBe("INTERNAL_ERROR");
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 2 });
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM project_bindings").get()).toEqual({ n: 2 });

    const repoDanglingAncestor = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
      vaultPath: join(danglingVault, "nested-vault"),
      events: createSqliteEventLedger(temp.db),
      onLocalProjectWithdrawn: NOOP_WITHDRAWN,
    });
    const danglingAncestorRefused = repoDanglingAncestor.createProjectWithBinding(
      {
        id: "p-dangling-anc",
        slug: "absent-dangling-anc",
        displayName: "Dangling Anc",
        description: null,
        createdAt: "t7",
      },
      { id: "b-dangling-anc", projectId: "", directory: projectDir, bindingKind: "directory", createdAt: "t7" },
      TEST_ACTOR,
    );
    expect(danglingAncestorRefused.ok).toBe(false);
    expect(!danglingAncestorRefused.ok && danglingAncestorRefused.error.code).toBe("INTERNAL_ERROR");
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 2 });
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM project_bindings").get()).toEqual({ n: 2 });
  });
});
