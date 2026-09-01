import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type AppError, errorSpec, initializeInstallation, moveVault, vaultStatus, vaultVerify } from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeInitPorts } from "../../src/init-ports";
import { FakeClock } from "../../src/testkit/fakes";
import { createNodeVaultCommandPorts } from "../../src/vault-command-ports";

/**
 * The relocation failure matrix of section 7 and AJ-09: an injected mid-move
 * failure leaves exactly one usable Vault and a configuration pointing at it,
 * and the retried move over the scratch a failed attempt left behind succeeds.
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  return home;
}

function initializedHome(prefix: string): { home: string; vault: string } {
  const home = tempHome(prefix);
  const vault = join(home, "vault");
  const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
  if (!initializeInstallation(ports, { vaultPath: vault }).ok) throw new Error("fixture init must succeed");
  return { home, vault };
}

function seedArtifact(vault: string, relative: string, content: string): void {
  const path = join(vault, "artifacts", relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function exitCodeOf(error: AppError): number {
  return errorSpec(error.code).exitCode;
}

function statusPathOf(home: string): string | null {
  const ports = createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home });
  const statusPorts = ports.statusPorts();
  if (!statusPorts.ok) return null;
  const status = vaultStatus(statusPorts.value);
  return status.ok ? status.value.path : null;
}

describe("moveVault", () => {
  it("fails the injected mid-move copy and leaves the original active, then the retry succeeds (AJ-09)", () => {
    const { home, vault } = initializedHome("sorage-move-fail-");
    const target = join(home, "moved-vault");
    seedArtifact(vault, "h-1/a-1/doc.md", "document one");
    seedArtifact(vault, "h-2/a-1/doc.md", "document two");
    seedArtifact(vault, "h-3/a-1/doc.md", "document three");

    let copies = 0;
    const failing = createNodeVaultCommandPorts({
      env: { SORAGE_HOME: home },
      userHome: home,
      targetPath: target,
      afterStagedCopy: () => {
        copies++;
        if (copies === 2) throw new Error("injected copy failure");
      },
    });
    const movePorts = failing.movePorts();
    if (!movePorts.ok) throw new Error("move ports must build");
    const failed = moveVault(movePorts.value);
    expect(failed.ok).toBe(false);

    // Exactly one usable Vault: the original is intact and still configured.
    expect(statusPathOf(home)).toBe(vault);
    expect(readFileSync(join(vault, "artifacts/h-1/a-1/doc.md"), "utf8")).toBe("document one");
    expect(readFileSync(join(vault, ".sorage-vault.json"), "utf8")).toContain("sorage-vault");

    // The retry clears the scratch the failed attempt left in the target.
    const retrying = createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home, targetPath: target });
    const retryPorts = retrying.movePorts();
    if (!retryPorts.ok) throw new Error("retry ports must build");
    const moved = moveVault(retryPorts.value);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.artifactsMoved).toBe(3);
    expect(statusPathOf(home)).toBe(target);
    expect(readFileSync(join(target, "artifacts/h-3/a-1/doc.md"), "utf8")).toBe("document three");

    // The VAULT_MOVED audit event lands in the append-only ledger (SEC-012).
    const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      const events = database
        .prepare("SELECT event_type, actor_kind, metadata_json FROM events ORDER BY created_at")
        .all() as Array<{ event_type: string; actor_kind: string; metadata_json: string }>;
      expect(events).toHaveLength(1);
      expect(events[0]?.event_type).toBe("VAULT_MOVED");
      expect(events[0]?.actor_kind).toBe("user");
      expect(JSON.parse(events[0]?.metadata_json ?? "{}")).toMatchObject({
        fromPath: vault,
        toPath: target,
        artifactsMoved: 3,
      });
    } finally {
      database.close();
    }
  });

  it("refuses a foreign non-empty target with VAULT_INTEGRITY_ERROR (VLT-003)", () => {
    const { home, vault } = initializedHome("sorage-move-foreign-");
    const target = join(home, "foreign-target");
    mkdirSync(target);
    writeFileSync(join(target, "important.txt"), "not a vault");
    const ports = createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home, targetPath: target });
    const movePorts = ports.movePorts();
    if (!movePorts.ok) throw new Error("move ports must build");
    const moved = moveVault(movePorts.value);
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.error.code).toBe("VAULT_INTEGRITY_ERROR");
    expect(exitCodeOf(moved.error)).toBe(73);
    expect(readFileSync(join(target, "important.txt"), "utf8")).toBe("not a vault");
    expect(statusPathOf(home)).toBe(vault);
  });

  it("preserves pre-existing artifacts and staging trees without an owned scratch marker", () => {
    const { home, vault } = initializedHome("sorage-move-managed-names-");
    const target = join(home, "foreign-target");
    const artifact = join(target, "artifacts", "keep.txt");
    const staged = join(target, "staging", "keep.txt");
    mkdirSync(join(target, "artifacts"), { recursive: true });
    mkdirSync(join(target, "staging"), { recursive: true });
    writeFileSync(artifact, "not sorage scratch");
    writeFileSync(staged, "also not sorage scratch");

    const ports = createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home, targetPath: target });
    const movePorts = ports.movePorts();
    if (!movePorts.ok) throw new Error("move ports must build");
    const moved = moveVault(movePorts.value);

    expect(moved.ok).toBe(false);
    expect(!moved.ok && moved.error.code).toBe("VAULT_INTEGRITY_ERROR");
    expect(readFileSync(artifact, "utf8")).toBe("not sorage scratch");
    expect(readFileSync(staged, "utf8")).toBe("also not sorage scratch");
    expect(statusPathOf(home)).toBe(vault);
  });

  it("refuses a target inside a bound Project directory with VAULT_CONTAINMENT at exit 64 (VLT-017)", () => {
    const { home, vault } = initializedHome("sorage-move-contain-");
    const project = join(home, "project");
    mkdirSync(project);
    // Register one directory binding the target would live inside.
    const addBinding = createNodeVaultCommandPorts({
      env: { SORAGE_HOME: home },
      userHome: home,
      targetPath: join(project, "vault"),
    });
    // Seed the binding directly through the production database the ports read.
    const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      database
        .prepare(
          "INSERT INTO projects (id, slug, display_name, status, created_at, updated_at) VALUES ('p-1', 'web', 'Web', 'active', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')",
        )
        .run();
      database
        .prepare(
          "INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at) VALUES ('b-1', 'p-1', 'i', ?, 'directory', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')",
        )
        .run(project);
    } finally {
      database.close();
    }
    const movePorts = addBinding.movePorts();
    if (!movePorts.ok) throw new Error("move ports must build");
    const moved = moveVault(movePorts.value);
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.error.code).toBe("VAULT_CONTAINMENT");
    expect(exitCodeOf(moved.error)).toBe(64);
  });

  it("refuses a target that overlaps the current Vault itself (epic audit F005)", () => {
    const { home, vault } = initializedHome("sorage-move-self-");
    for (const target of [join(vault, "nested"), home]) {
      const ports = createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home, targetPath: target });
      const movePorts = ports.movePorts();
      if (!movePorts.ok) throw new Error("move ports must build");
      const moved = moveVault(movePorts.value);
      expect(moved.ok, target).toBe(false);
      if (moved.ok) return;
      expect(moved.error.code).toBe("VAULT_CONTAINMENT");
    }
    expect(statusPathOf(home)).toBe(vault);
  });

  it("aborts when the managed file set changes during the move (epic audit F001)", () => {
    const { home, vault } = initializedHome("sorage-move-raced-");
    const target = join(home, "moved-vault");
    seedArtifact(vault, "h-1/a-1/doc.md", "document one");
    const racing = createNodeVaultCommandPorts({
      env: { SORAGE_HOME: home },
      userHome: home,
      targetPath: target,
      afterStagedCopy: () => {
        // A concurrent process lands one more managed file after the listing.
        seedArtifact(vault, "h-9/a-1/late.md", "late arrival");
      },
    });
    const movePorts = racing.movePorts();
    if (!movePorts.ok) throw new Error("move ports must build");
    const moved = moveVault(movePorts.value);
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.error.code).toBe("INTERNAL_ERROR");
    expect(moved.error.message).toContain("changed during the move");
    // The original stays active and configured; nothing switched.
    expect(statusPathOf(home)).toBe(vault);
    expect(readFileSync(join(vault, "artifacts/h-1/a-1/doc.md"), "utf8")).toBe("document one");
  });
});

describe("vaultVerify direct sweep report", () => {
  it("names an aged staging leftover when no drain ran first (section 6.2)", () => {
    const { home, vault } = initializedHome("sorage-verify-direct-");
    const leftover = join(vault, "staging", "leftover");
    writeFileSync(leftover, "sweep me");
    const aged = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(leftover, aged, aged);
    const ports = createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home });
    const verifyPorts = ports.verifyPorts();
    if (!verifyPorts.ok) throw new Error("verify ports must build");
    const report = vaultVerify(verifyPorts.value, { now: new Date("2026-06-02T00:00:00.000Z") });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.findings.some((finding) => finding.includes("leftover"))).toBe(true);
    expect(report.value.checked.stagedFiles).toBe(1);
    expect(report.value.checked.artifacts).toBe(0);
  });
});

describe("moveVault intent fencing (epic audit round 2)", () => {
  it("drains a pre-committed staged intent under the lock and relocates the resolved artifact", () => {
    const { home, vault } = initializedHome("sorage-move-pre-drain-");
    const target = join(home, "moved-vault");
    // A concurrent process staged bytes and committed its activate intent just
    // before the mover took the lock.
    writeFileSync(join(vault, "staging", "staged-1"), "committed bytes");
    const { DatabaseSync: Db } = { DatabaseSync } as typeof import("node:sqlite");
    const database = new Db(join(home, "state", "sorage.sqlite3"));
    try {
      database
        .prepare(
          "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES ('i-1', 'activate', 'staging/staged-1', 'artifacts/h-1/a-1/doc.md', 'a-1', '2026-05-01T00:00:00.000Z', 0)",
        )
        .run();
    } finally {
      database.close();
    }
    const ports = createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home, targetPath: target });
    const movePorts = ports.movePorts();
    if (!movePorts.ok) throw new Error("move ports must build");
    const moved = moveVault(movePorts.value);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.artifactsMoved).toBe(1);
    expect(readFileSync(join(target, "artifacts/h-1/a-1/doc.md"), "utf8")).toBe("committed bytes");
    // The promise is fully resolved: no row survives in the relocated Vault.
    const after = new Db(join(home, "state", "sorage.sqlite3"));
    try {
      const rows = after.prepare("SELECT COUNT(*) AS count FROM pending_fs_ops").get() as { count: number };
      expect(rows.count).toBe(0);
    } finally {
      after.close();
    }
  });

  it("refuses to relocate a Vault whose intents cannot resolve", () => {
    const { home, vault } = initializedHome("sorage-move-unresolvable-");
    const target = join(home, "moved-vault");
    const { DatabaseSync: Db } = { DatabaseSync } as typeof import("node:sqlite");
    const database = new Db(join(home, "state", "sorage.sqlite3"));
    try {
      database
        .prepare(
          "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES ('i-1', 'activate', 'staging/gone', 'artifacts/h-1/a-9/none.md', 'a-9', '2026-05-01T00:00:00.000Z', 0)",
        )
        .run();
    } finally {
      database.close();
    }
    const ports = createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home, targetPath: target });
    const movePorts = ports.movePorts();
    if (!movePorts.ok) throw new Error("move ports must build");
    const moved = moveVault(movePorts.value);
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.error.message).toContain("unresolved filesystem intent");
    expect(statusPathOf(home)).toBe(vault);
  });

  it("rejects an aliased nested target a lexical comparison would miss (darwin /private)", () => {
    const { home, vault } = initializedHome("sorage-move-alias-");
    // /var/folders/... is served as /private/var/folders/... on darwin; the two
    // spellings share no string prefix, so only physical resolution catches it.
    const aliased = `/private${vault}/nested`;
    const ports = createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home, targetPath: aliased });
    const movePorts = ports.movePorts();
    if (!movePorts.ok) throw new Error("move ports must build");
    const moved = moveVault(movePorts.value);
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.error.code).toBe("VAULT_CONTAINMENT");
    expect(existsSync(join(vault, "nested"))).toBe(false);
  });
});

describe("moveVault switch fencing (cold validation round 1)", () => {
  it("refuses the switch when an intent lands after the mover's drain, then relocates once it drains", () => {
    const { home, vault } = initializedHome("sorage-move-postdrain-");
    const target = join(home, "moved-vault");
    seedArtifact(vault, "h-1/a-1/doc.md", "document one");
    const racing = createNodeVaultCommandPorts({
      env: { SORAGE_HOME: home },
      userHome: home,
      targetPath: target,
      afterStagedCopy: () => {
        // A concurrent process commits an unlink intent after the mover's drain
        // already listed the table; its target is already gone, so the next
        // drain resolves it, but the switch must not outrun the promise.
        const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
        try {
          database
            .prepare(
              "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES ('i-late', 'unlink', NULL, 'artifacts/h-9/a-9/gone.md', 'a-9', '2026-05-01T00:00:00.000Z', 0)",
            )
            .run();
        } finally {
          database.close();
        }
      },
    });
    const movePorts = racing.movePorts();
    if (!movePorts.ok) throw new Error("move ports must build");
    const moved = moveVault(movePorts.value);
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.error.code).toBe("INTERNAL_ERROR");
    expect(moved.error.message).toContain("became pending after the drain");
    // The original stays active and configured; nothing switched.
    expect(statusPathOf(home)).toBe(vault);
    expect(readFileSync(join(vault, "artifacts/h-1/a-1/doc.md"), "utf8")).toBe("document one");
    // The late intent's target is gone, so the next drain resolves it, and the
    // retried move relocates cleanly.
    const base = createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home });
    expect(base.drainAtStart().ok).toBe(true);
    const retrying = createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home, targetPath: target });
    const retryPorts = retrying.movePorts();
    if (!retryPorts.ok) throw new Error("retry ports must build");
    const retried = moveVault(retryPorts.value);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.artifactsMoved).toBe(1);
    expect(statusPathOf(home)).toBe(target);
    expect(readFileSync(join(target, "artifacts/h-1/a-1/doc.md"), "utf8")).toBe("document one");
  });

  it("refuses rather than silently skipping an unreadable managed directory (cold validation round 2)", () => {
    const { home, vault } = initializedHome("sorage-move-unreadable-");
    const target = join(home, "moved-vault");
    seedArtifact(vault, "h-1/a-1/doc.md", "document one");
    seedArtifact(vault, "h-2/a-1/doc.md", "document two");
    // A permissions-tampered handoff directory must fail the census loudly; a
    // silent omission would let the move switch while the copy is incomplete.
    // 0o333 keeps write+execute but removes read, so listing it fails.
    const handoffDir = join(vault, "artifacts", "h-2");
    chmodSync(handoffDir, 0o333);
    let moved: ReturnType<typeof moveVault>;
    try {
      const ports = createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home, targetPath: target });
      const movePorts = ports.movePorts();
      if (!movePorts.ok) throw new Error("move ports must build");
      moved = moveVault(movePorts.value);
    } finally {
      chmodSync(handoffDir, 0o755);
    }
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.error.code).toBe("INTERNAL_ERROR");
    expect(statusPathOf(home)).toBe(vault);
    expect(readFileSync(join(vault, "artifacts/h-2/a-1/doc.md"), "utf8")).toBe("document two");
    // With the directory readable again the move relocates every managed byte.
    const retrying = createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home, targetPath: target });
    const retryPorts = retrying.movePorts();
    if (!retryPorts.ok) throw new Error("retry ports must build");
    const retried = moveVault(retryPorts.value);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.artifactsMoved).toBe(2);
    expect(readFileSync(join(target, "artifacts/h-2/a-1/doc.md"), "utf8")).toBe("document two");
  });
});
