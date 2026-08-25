import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CheckOutcome, DoctorCheckId, DoctorPorts } from "@sorage/core";
import {
  type Configuration,
  parseConfigurationFile,
  parseVaultMarker,
  validateVaultMarkerForInstallation,
  vaultGitattributesContent,
  vaultGitignoreContent,
} from "@sorage/core";
import { createConfigStore } from "./config-store";
import { createHomePaths, type HomeEnvironment } from "./home";
import { evaluateStaleness, isPidAlive, parseLockRecord } from "./lockfile";
import { openSorageDatabase } from "./sqlite/connection";
import { MIGRATIONS } from "./sqlite/migrations";

/**
 * The production doctor probes over the live installation: every check the 0.1
 * snapshot can perform, with the recovery guidance of section 35 attached to every
 * non-ok outcome. Checks whose domain tables arrive with later epics report honest
 * vacuous passes instead of pretending to verify data that cannot exist yet.
 */
const RECOVERIES: Record<DoctorCheckId, string> = {
  "home.permissions": "sorage init --reconfigure, or restore owner-only permissions",
  "config.schema": "sorage config validate, then repair the reported keys",
  "config.lock": "Remove ~/.sorage/run/config.lock once no sorage process is running",
  "vault.marker":
    "sorage vault verify; adopt a foreign Vault only through sorage backup restore --from <vault-path> --as-user --confirm",
  "vault.gitattributes": "sorage init --reconfigure backfills both files",
  "vault.writable": "Fix the directory permissions, or remount the volume read-write",
  "db.integrity": "Restore from ~/.sorage/state/backups/, or sorage backup restore into a fresh installation",
  "db.pendingIntents":
    "Inspect the ARTIFACT_INTEGRITY_FAILED events for the affected Handoffs and restore them from backup",
  "db.migrations": "Install the matching sorage build; remove a stale ~/.sorage/run/migration.lock",
  "artifacts.checksums": "sorage vault verify, then restore the affected Handoff from backup",
  "bindings.exist":
    "sorage project bind <project> --dir <path> for an unbound Project, or sorage project unbind <project> --dir <the recorded directory this warning names> for a binding whose directory vanished",
  "bindings.nested": "Pass --as <project-slug> wherever the deepest match is not the intended Project",
  "bindings.ambiguous": "sorage project unbind the aliased path, or always pass --as <project-slug> from it",
  "platform.tcc": "Grant Full Disk Access to the invoking terminal, or keep the Vault under ~/.sorage",
};

const GITATTRIBUTES = vaultGitattributesContent();

const GITIGNORE = vaultGitignoreContent();

export interface NodeDoctorPortsOptions {
  env?: HomeEnvironment | undefined;
  userHome?: string | undefined;
}

export function createNodeDoctorPorts(options: NodeDoctorPortsOptions = {}): DoctorPorts {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const store = createConfigStore({
    home,
    lockPorts: { clock: { now: () => new Date() }, hostname: () => "", isPidAlive },
    userHome,
  });
  const databasePath = join(home.stateDir, "sorage.sqlite3");

  function configuration(): Configuration | null {
    const text = store.readText();
    if (text === null) return null;
    const parsed = parseConfigurationFile(text);
    return parsed.ok ? parsed.value.config : null;
  }

  function vaultPath(config: Configuration | null): string | null {
    if (config === null) return null;
    const raw = config.vault.path;
    if (raw === "~") return userHome;
    if (raw === "~/.sorage") return home.home;
    if (raw.startsWith("~/.sorage/")) return join(home.home, raw.slice("~/.sorage/".length));
    if (raw.startsWith("~/")) return join(userHome, raw.slice(2));
    return raw;
  }

  interface ProjectRow {
    id: string;
    slug: string;
    status: string;
  }

  interface BindingRow {
    id: string;
    project_id: string;
    directory: string;
    binding_kind: string;
  }

  /** Reads the Project registry once per probe; null before any table exists. */
  function bindingRegistry(): { projects: ProjectRow[]; bindings: BindingRow[] } | null {
    try {
      const db = openSorageDatabase(databasePath);
      try {
        // bun:sqlite returns null for a no-row get and node:sqlite returns
        // undefined; both mean the registry tables are not there yet.
        const table = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_bindings'")
          .get() as { name: string } | null | undefined;
        if (!table) return null;
        const projects = db.prepare("SELECT id, slug, status FROM projects").all() as unknown as ProjectRow[];
        const bindings = db
          .prepare("SELECT id, project_id, directory, binding_kind FROM project_bindings")
          .all() as unknown as BindingRow[];
        return { projects, bindings };
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }

  function projectSlugOf(projects: ProjectRow[], binding: BindingRow): string {
    return projects.find((project) => project.id === binding.project_id)?.slug ?? binding.project_id;
  }

  function perform(id: DoctorCheckId): CheckOutcome {
    switch (id) {
      case "home.permissions": {
        let homeExists = false;
        try {
          homeExists = statSync(home.home).isDirectory();
        } catch {
          homeExists = false;
        }
        let mode: number | null = null;
        try {
          mode = statSync(home.configFile).mode & 0o777;
        } catch {
          mode = null;
        }
        if (!homeExists || mode === null) {
          return blocking("The home directory or config.yaml is missing.");
        }
        if (mode !== 0o600) {
          return blocking(`config.yaml is mode ${mode.toString(8)}, expected owner-only 600.`);
        }
        return ok("The home tree exists and config.yaml is owner-only.");
      }

      case "config.schema": {
        const parsed = parseConfigurationFile(store.readText() ?? "");
        if (!parsed.ok) {
          return blocking(`config.yaml is invalid: ${parsed.error.message}`);
        }
        return ok("config.yaml parses and validates against the schema.");
      }

      case "config.lock": {
        let body: string;
        try {
          body = readFileSync(home.lockFile("config"), "utf8");
        } catch {
          return ok("No config.lock is present.");
        }
        const verdict = evaluateStaleness("config", parseLockRecord(body), new Date(), isPidAlive);
        if (verdict.stale) {
          return warning(`config.lock is stale (${verdict.reason}).`);
        }
        return ok("config.lock is absent or held by a live process inside its window.");
      }

      case "vault.marker": {
        const config = configuration();
        const vault = vaultPath(config);
        if (config === null || vault === null) {
          return blocking("The Vault marker cannot be checked without a valid configuration.");
        }
        let body: string;
        try {
          body = readFileSync(join(vault, ".sorage-vault.json"), "utf8");
        } catch {
          return blocking("The Vault marker is missing or unparseable.");
        }
        const marker = parseVaultMarker(body);
        if (!marker.ok) return blocking(marker.error.message);
        const owned = validateVaultMarkerForInstallation(marker.value, config.installationId);
        if (!owned.ok) return blocking(owned.error.message);
        return ok("The Vault marker matches this installation.");
      }

      case "vault.gitattributes": {
        const vault = vaultPath(configuration());
        if (vault === null) return warning("The Vault policy files cannot be checked without a valid configuration.");
        let attributes = false;
        let ignore = false;
        try {
          attributes = readFileSync(join(vault, ".gitattributes"), "utf8") === GITATTRIBUTES;
          ignore = readFileSync(join(vault, ".gitignore"), "utf8") === GITIGNORE;
        } catch {
          return warning("The Vault policy files are missing.");
        }
        if (!attributes || !ignore) return warning("The Vault policy files do not match section 6 verbatim.");
        return ok("The Vault policy files match the documented bytes.");
      }

      case "vault.writable": {
        const vault = vaultPath(configuration());
        if (vault === null) return blocking("The Vault cannot be checked without a valid configuration.");
        try {
          for (const directory of [vault, join(vault, "artifacts"), join(vault, "staging")]) {
            accessSync(directory, constants.W_OK);
          }
        } catch {
          return blocking("The Vault root, artifacts/, or staging/ is not writable by this user.");
        }
        return ok("The Vault root, artifacts/, and staging/ are writable.");
      }

      case "db.integrity": {
        try {
          const db = openSorageDatabase(databasePath);
          try {
            const integrity = db.prepare("PRAGMA integrity_check").get() as unknown;
            const row = integrity as Record<string, unknown> | undefined;
            const verdict = row === undefined ? undefined : row["integrity_check"];
            const journal = (db.prepare("PRAGMA journal_mode").get() as Record<string, unknown> | undefined)?.[
              "journal_mode"
            ];
            const foreignKeys = (db.prepare("PRAGMA foreign_keys").get() as Record<string, unknown> | undefined)?.[
              "foreign_keys"
            ];
            if (verdict !== "ok") return blocking(`PRAGMA integrity_check reported: ${String(verdict)}`);
            if (journal !== "wal") return blocking(`The database journal mode is ${String(journal)}, expected wal.`);
            if (foreignKeys !== 1) return blocking("Foreign keys are not enabled on this build's connections.");
            return ok("The database passes integrity_check in WAL mode with foreign keys enabled.");
          } finally {
            db.close();
          }
        } catch (error) {
          return blocking(
            `The database could not be opened or checked: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      case "db.pendingIntents": {
        return ok("No pending filesystem intents are recorded in this schema version.");
      }

      case "db.migrations": {
        try {
          const db = openSorageDatabase(databasePath);
          try {
            const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
              | Record<string, unknown>
              | undefined;
            const expected = Math.max(...MIGRATIONS.map((migration) => migration.version));
            if (row?.["version"] !== expected) {
              return blocking(`schema_migrations is at ${String(row?.["version"])}, expected ${expected}.`);
            }
          } finally {
            db.close();
          }
        } catch (error) {
          return blocking(
            `schema_migrations could not be read: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        let lockBody: string;
        try {
          lockBody = readFileSync(home.lockFile("migration"), "utf8");
        } catch {
          return ok("schema_migrations is at the version this build expects.");
        }
        const verdict = evaluateStaleness("migration", parseLockRecord(lockBody), new Date(), isPidAlive);
        if (verdict.stale) return blocking(`migration.lock is stale (${verdict.reason}).`);
        return ok("schema_migrations is at the version this build expects.");
      }

      case "artifacts.checksums": {
        return ok("No Artifacts are recorded yet on this installation.");
      }

      case "bindings.exist": {
        const registry = bindingRegistry();
        if (registry === null) return ok("No Project bindings are recorded yet on this installation.");
        const { projects, bindings } = registry;
        const problems: string[] = [];
        for (const project of projects) {
          if (project.status !== "active") continue;
          if (!bindings.some((binding) => binding.project_id === project.id)) {
            problems.push(`Project '${project.slug}' has no directory binding on this installation.`);
          }
        }
        for (const binding of bindings) {
          let exists = false;
          try {
            exists = statSync(binding.directory).isDirectory();
          } catch {
            exists = false;
          }
          if (!exists)
            problems.push(
              `Project '${projectSlugOf(projects, binding)}' binding '${binding.directory}' no longer exists.`,
            );
        }
        if (problems.length > 0) return warning(problems.join(" "));
        return ok("Every active Project has a binding and every binding directory exists.");
      }

      case "bindings.nested": {
        const registry = bindingRegistry();
        if (registry === null) return ok("No Project bindings are recorded yet on this installation.");
        const { projects, bindings } = registry;
        const nested: string[] = [];
        const directories = bindings.filter((binding) => binding.binding_kind === "directory");
        for (const inner of directories) {
          for (const outer of directories) {
            if (outer.id === inner.id || outer.directory === inner.directory) continue;
            if (inner.directory.startsWith(`${outer.directory}/`)) {
              nested.push(
                `'${inner.directory}' (${projectSlugOf(projects, inner)}) is nested inside '${outer.directory}' (${projectSlugOf(projects, outer)}); the deepest match wins`,
              );
            }
          }
        }
        if (nested.length > 0) return warning([...new Set(nested)].join(" "));
        return ok("No directory binding is nested inside another.");
      }

      case "bindings.ambiguous": {
        const registry = bindingRegistry();
        if (registry === null) return ok("No Project bindings are recorded yet on this installation.");
        const { projects, bindings } = registry;
        const aliases: string[] = [];
        for (let i = 0; i < bindings.length; i++) {
          for (let j = i + 1; j < bindings.length; j++) {
            const first = bindings[i] as (typeof bindings)[number];
            const second = bindings[j] as (typeof bindings)[number];
            if (first.binding_kind !== second.binding_kind || first.directory === second.directory) continue;
            let firstReal: string | null = null;
            let secondReal: string | null = null;
            try {
              firstReal = realpathSync(first.directory);
              secondReal = realpathSync(second.directory);
            } catch {
              continue;
            }
            if (firstReal === secondReal) {
              aliases.push(
                `'${first.directory}' (${projectSlugOf(projects, first)}) and '${second.directory}' (${projectSlugOf(projects, second)}) alias one directory`,
              );
            }
          }
        }
        if (aliases.length > 0) return warning([...new Set(aliases)].join(" "));
        return ok("No two bindings of the same kind alias one directory.");
      }

      case "platform.tcc": {
        const vault = vaultPath(configuration());
        if (vault === null) return warning("Platform readability cannot be checked without a valid configuration.");
        try {
          accessSync(vault, constants.R_OK);
        } catch {
          return warning("The Vault is not readable without a macOS privacy prompt.");
        }
        return ok("The Vault is readable without a privacy prompt.");
      }
    }
  }

  return {
    initialized() {
      return store.readText() !== null;
    },

    probe(id: DoctorCheckId): CheckOutcome {
      return attachRecovery(id, perform(id));
    },
  };
}

/** Section 35 attaches its recovery guidance to every non-ok outcome. */
function attachRecovery(id: DoctorCheckId, outcome: CheckOutcome): CheckOutcome {
  if (outcome.severity === "ok") return outcome;
  return { ...outcome, recovery: { suggestedCommand: RECOVERIES[id] } };
}

function ok(message: string): CheckOutcome {
  return { severity: "ok", message };
}

function warning(message: string): CheckOutcome {
  return { severity: "warning", message, recovery: undefined };
}

function blocking(message: string): CheckOutcome {
  return { severity: "blocking", message, recovery: undefined };
}
