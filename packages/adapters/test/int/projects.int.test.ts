import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSqliteProjectRepository } from "../../src/projects";
import { MIGRATIONS, PROJECT_REGISTRY_MIGRATION } from "../../src/sqlite/migrations";
import { MigrationFailedError, migrate } from "../../src/sqlite/migrator";
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
  const repository = createSqliteProjectRepository(temp.db, { installationId: "00000000-0000-4000-8000-000000000001" });
  const result = repository.createProject({
    id,
    slug,
    displayName: slug,
    description: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
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
    const failing = [
      ...MIGRATIONS,
      {
        version: 3,
        name: "broken-after-projects",
        sql: `${PROJECT_REGISTRY_MIGRATION.sql.replace(/projects/g, "orphan_projects")}; CREATE TABLE deliberately_broken (id INTEGER PRIMARY KEY);`,
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
    expect(versions.map((row) => row.version)).toEqual([1, 2]);
  });
});

describe("project repository", () => {
  it("inserts two bindings of one Project on two directories", () => {
    const temp = migratedDb();
    const project = seedProject(temp, "web-app");
    const repository = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
    });
    const firstDir = tempDir();
    const secondDir = tempDir();
    const first = repository.addBinding({
      id: "21111111-1111-4111-8111-211111111111",
      projectId: project.id,
      directory: firstDir,
      bindingKind: "directory",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const second = repository.addBinding({
      id: "31111111-1111-4111-8111-311111111111",
      projectId: project.id,
      directory: secondDir,
      bindingKind: "directory",
      createdAt: "2026-01-01T00:00:02.000Z",
    });
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
      installationId: "00000000-0000-4000-8000-000000000001",
    });
    const input = {
      projectId: project.id,
      directory,
      bindingKind: "directory" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(repository.addBinding({ ...input, id: "41111111-1111-4111-8111-411111111111" }).ok).toBe(true);
    const duplicate = repository.addBinding({ ...input, id: "51111111-1111-4111-8111-511111111111" });
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
      installationId: "00000000-0000-4000-8000-000000000001",
    });
    const collision = repository.createProject({
      id: "61111111-1111-4111-8111-611111111111",
      slug: "Web-App",
      displayName: "Web App",
      description: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
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
      installationId: "00000000-0000-4000-8000-000000000001",
    });
    const viaSymlink = repository.addBinding({
      id: "71111111-1111-4111-8111-711111111111",
      projectId: project.id,
      directory: join(alias, "nested"),
      bindingKind: "directory",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
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
      installationId: "00000000-0000-4000-8000-000000000001",
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
      installationId: "00000000-0000-4000-8000-000000000001",
    });
    const found = repository.findProjectBySlug("ПРОЕКТ");
    expect(found.ok && found.value?.slug).toBe("проект");
  });

  it("folds a lookup through the locale-independent mapping, so a Turkic-locale host finds the same slug", () => {
    const temp = migratedDb();
    seedProject(temp, "wizard", "71111111-1111-4111-8111-711111111112");
    const repository = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
    });
    const found = repository.findProjectBySlug("WIZARD");
    expect(found.ok && found.value?.slug).toBe("wizard");
  });

  it("maps a binding directory that vanishes before the insert to INTERNAL_ERROR instead of throwing", () => {
    const temp = migratedDb();
    const repository = createSqliteProjectRepository(temp.db, {
      installationId: "00000000-0000-4000-8000-000000000001",
      fs: {
        realpath: () => {
          throw new Error("ENOENT: the directory vanished between the check and the insert");
        },
      },
    });
    const result = repository.addBinding({
      id: "71111111-1111-4111-8111-711111111113",
      projectId: "81111111-1111-4111-8111-811111111111",
      directory: "/tmp/vanished",
      bindingKind: "directory",
      createdAt: "2026-01-01T00:00:00.000Z",
    }) as { ok: boolean; error?: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INTERNAL_ERROR");
    expect(result.error?.message).toContain("vanished");
  });
});
