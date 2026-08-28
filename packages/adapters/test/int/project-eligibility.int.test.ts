import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRecipientEligibility, defaultConfiguration } from "@sorage/core";

const TEST_ACTOR = { kind: "user", id: null } as const;

import { afterAll, describe, expect, it } from "vitest";
import { createConfigStore } from "../../src/config-store";
import { createHomePaths } from "../../src/home";
import { createNodeProjectPorts } from "../../src/project-command-ports";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { openAndMigrate } from "../../src/sqlite/migrator";

/**
 * The one shared recipient rule through the real adapters wiring: the same ports the
 * CLI builds, an initialized temporary installation, and the three rejection outcomes
 * of PRJ-012, PRJ-021, and PRJ-022.
 */
const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

function initializedInstallation(): { env: Record<string, string>; dir: string; secondDir: string; thirdDir: string } {
  const home = mkdtempSync(join(tmpdir(), "sorage-eligibility-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const dir = mkdtempSync(join(tmpdir(), "sorage-eligibility-dir-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const secondDir = mkdtempSync(join(tmpdir(), "sorage-eligibility-second-"));
  cleanups.push(() => rmSync(secondDir, { recursive: true, force: true }));
  const thirdDir = mkdtempSync(join(tmpdir(), "sorage-eligibility-third-"));
  cleanups.push(() => rmSync(thirdDir, { recursive: true, force: true }));
  const userHome = mkdtempSync(join(tmpdir(), "sorage-eligibility-user-"));
  cleanups.push(() => rmSync(userHome, { recursive: true, force: true }));
  const paths = createHomePaths({ SORAGE_HOME: home }, userHome);
  const store = createConfigStore({
    home: paths,
    lockPorts: { clock: { now: () => new Date() }, hostname: () => "", isPidAlive: () => false },
    userHome,
  });
  const config = defaultConfiguration("00000000-0000-4000-8000-0000000000aa");
  mkdirSync(join(home, "state"), { recursive: true });
  const written = store.write({ ...config, vault: { ...config.vault, path: join(home, "vault") } });
  if (!written.ok) throw new Error(written.error.message);
  const { db } = openAndMigrate(join(paths.stateDir, "sorage.sqlite3"), MIGRATIONS);
  db.close();
  return { env: { SORAGE_HOME: home }, dir, secondDir, thirdDir };
}

function register(ports: ReturnType<typeof createNodeProjectPorts>, slug: string, directory: string) {
  const result = ports.projects.createProjectWithBinding(
    { id: ports.ids.next(), slug, displayName: slug, description: null, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: ports.ids.next(), projectId: "", directory, bindingKind: "directory", createdAt: "2026-01-01T00:00:00.000Z" },
    TEST_ACTOR,
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("checkRecipientEligibility through the production wiring", () => {
  it("accepts an active bound Project and rejects unknown, archived, and unbound recipients", () => {
    const { env, dir, secondDir, thirdDir } = initializedInstallation();
    const ports = createNodeProjectPorts({ env });
    const unknown = checkRecipientEligibility(ports, "nope");
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.error.code).toBe("UNREGISTERED_RECIPIENT");
    const bound = register(ports, "bound-one", dir);
    const active = checkRecipientEligibility(ports, "bound-one");
    expect(active.ok && active.value.slug).toBe("bound-one");
    const archived = register(ports, "archived-one", secondDir);
    const flipped = ports.projects.updateProjectStatus(
      archived.project.id,
      "archived",
      "2026-01-01T00:00:01.000Z",
      TEST_ACTOR,
    );
    expect(flipped.ok && flipped.value.status).toBe("archived");
    const rejected = checkRecipientEligibility(ports, "archived-one");
    expect(rejected.ok).toBe(false);
    expect(!rejected.ok && rejected.error.code).toBe("PROJECT_ARCHIVED");
    const unboundProject = ports.projects.createProjectWithBinding(
      {
        id: ports.ids.next(),
        slug: "will-unbind",
        displayName: "Will Unbind",
        description: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: ports.ids.next(),
        projectId: "",
        directory: thirdDir,
        bindingKind: "directory",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      TEST_ACTOR,
    );
    expect(unboundProject.ok).toBe(true);
    const removed = ports.projects.removeBinding(unboundProject.ok ? unboundProject.value.binding.id : "", TEST_ACTOR);
    expect(removed.ok).toBe(true);
    const unbound = checkRecipientEligibility(ports, "will-unbind");
    expect(unbound.ok).toBe(false);
    expect(!unbound.ok && unbound.error.code).toBe("PROJECT_UNBOUND");
    expect(bound.binding.bindingKind).toBe("directory");
  });
});
