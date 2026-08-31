import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CheckOutcome, DoctorCheckId, DoctorPorts } from "@sorage/core";
import {
  type BackupRunRow,
  type Configuration,
  isManagedVaultPath,
  nextDueAt,
  parseConfigurationFile,
  parseVaultMarker,
  validateVaultMarkerForInstallation,
  vaultGitattributesContent,
  vaultGitignoreContent,
  verifyVaultArtifacts,
} from "@sorage/core";
import { createNodeArtifactStore } from "./artifact-store";
import { createConfigStore } from "./config-store";
import { createHomePaths, type HomeEnvironment } from "./home";
import { launchAgentPlistPath, launchAgentsDirectory, launchAgentUid, plistPointsAtBinary } from "./launchagent-ports";
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
  "daemon.reachable": "sorage daemon start, or delete a stale ~/.sorage/run/daemon.json",
  "token.permissions": "sorage token rotate --as-user",
  "daemon.port": "Change server.port in the configuration, then restart the daemon",
  "service.installed": "launchctl bootstrap gui/$UID ~/Library/LaunchAgents/xyz.rootkernel.sorage.plist",
  "backup.schedule": "sorage backup run, then read sorage backup status",
  "git.state": "Resolve the repository state manually; Sorage never rebases or merges",
};

const GITATTRIBUTES = vaultGitattributesContent();

const GITIGNORE = vaultGitignoreContent();

export interface NodeDoctorPortsOptions {
  env?: HomeEnvironment | undefined;
  userHome?: string | undefined;
  /** True when something already accepts connections at the address; tests inject a fake. */
  portProbe?: ((host: string, port: number) => boolean) | undefined;
}

export function createNodeDoctorPorts(options: NodeDoctorPortsOptions = {}): DoctorPorts {
  const env = options.env ?? process.env;
  const portProbe =
    options.portProbe ??
    ((host: string, port: number) => {
      // The CLI process blocks synchronously (CLI-020), so the connect attempt runs
      // as the command's own `__port-probe` subprocess exactly like the web probe.
      const scriptArgs =
        process.argv[1] !== undefined && process.argv[1].endsWith("main.ts")
          ? [process.argv[1] as string, "__port-probe", host, String(port)]
          : ["__port-probe", host, String(port)];
      const probe = spawnSync(process.execPath, scriptArgs, { timeout: 5000 });
      return probe.status === 0;
    });
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
        try {
          const db = openSorageDatabase(databasePath);
          try {
            const table = db
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_fs_ops'")
              .get() as { name: string } | null | undefined;
            if (!table) return ok("No pending filesystem intents are recorded in this schema version.");
            const row = db.prepare("SELECT COUNT(*) AS count FROM pending_fs_ops").get() as
              | Record<string, unknown>
              | undefined;
            // bun:sqlite returns null-shaped rows as null and the test alias as
            // undefined; both shapes mean absence here only when the row itself
            // is missing, which COUNT(*) never is.
            const count = Number(row?.["count"] ?? 0);
            if (count > 0) {
              return warning(
                `${count} pending filesystem intent${count === 1 ? "" : "s"} remain${count === 1 ? "s" : ""} unresolved after the start drain; the affected Handoffs are integrity-failed.`,
              );
            }
            return ok("No pending filesystem intents remain after the start drain.");
          } finally {
            db.close();
          }
        } catch (error) {
          return blocking(
            `pending_fs_ops could not be read: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
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
        const config = configuration();
        const vault = vaultPath(config);
        if (config === null || vault === null) {
          return blocking("Artifact checksums cannot be checked without a valid configuration.");
        }
        try {
          const db = openSorageDatabase(databasePath);
          let records: Array<{ storage_key: string; sha256: string }> = [];
          try {
            // The artifacts registry arrives with the TASK-027 migration; until
            // then no Artifact is recorded and the exhaustive pass is vacuously
            // clean (INIT-017, SEC-014).
            const table = db
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'")
              .get() as { name: string } | null | undefined;
            if (table) {
              records = db
                .prepare("SELECT storage_key, sha256 FROM artifacts WHERE materialized = 1")
                .all() as unknown as Array<{ storage_key: string; sha256: string }>;
            }
          } finally {
            db.close();
          }
          if (records.length === 0) return ok("No Artifacts are recorded yet on this installation.");
          const store = createNodeArtifactStore({ vaultPath: vault, installationId: config.installationId });
          const findings = verifyVaultArtifacts(
            { artifactStore: store },
            records.map((row) => ({ storageKey: row.storage_key, sha256: row.sha256 })),
          );
          if (!findings.ok) return blocking(findings.error.message);
          if (findings.value.length > 0) {
            return blocking(findings.value.map((finding) => finding.message).join(" "));
          }
          return ok("Every recorded current Artifact exists and matches its recorded SHA-256.");
        } catch (error) {
          return blocking(
            `Artifact checksums could not be verified: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
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
        // One identity probe per distinct directory, before the pair loop: the
        // comment and the resolver's mechanism stay honest, and no directory is
        // stat once per pair it participates in.
        const identityOf = new Map<string, string | null>();
        const identityFor = (directory: string): string | null => {
          if (!identityOf.has(directory)) {
            try {
              const stats = statSync(directory);
              identityOf.set(directory, `${stats.dev}:${stats.ino}`);
            } catch {
              identityOf.set(directory, null);
            }
          }
          return identityOf.get(directory) ?? null;
        };
        for (let i = 0; i < bindings.length; i++) {
          for (let j = i + 1; j < bindings.length; j++) {
            const first = bindings[i] as (typeof bindings)[number];
            const second = bindings[j] as (typeof bindings)[number];
            // Identical spellings under two different Projects are the resolver's
            // owner-conflict ambiguity too, so they must warn; under one Project
            // they are a duplicate the registry forbids and resolution collapses.
            // Genuine same-inode aliases warn at any depth: section 35 scopes
            // this check to aliased bindings as a data-quality condition ahead
            // of time, and a firmlink alias genuinely differs in path depth.
            if (
              first.binding_kind !== second.binding_kind ||
              (first.directory === second.directory && first.project_id === second.project_id)
            ) {
              continue;
            }
            // The same dev:ino comparison the resolver's step 6 uses, so the
            // warning actually predicts the condition that raises
            // AMBIGUOUS_PROJECT: realpath cannot collapse a bind mount or an
            // APFS firmlink, but their inode identity is still one directory.
            // One stat per directory, mirroring the resolver's single probe.
            const firstIdentity = identityFor(first.directory);
            const secondIdentity = identityFor(second.directory);
            if (firstIdentity === null || secondIdentity === null) {
              // An unanswerable probe matters only to a pair the resolver's
              // same-depth tie can actually reach, and the registry's unique
              // (installation, directory) constraint leaves identical stored
              // spellings as the sole such pair, reachable only through
              // restored or directly edited data. A missing directory of a
              // distinct spelling already warns through bindings.exist, and
              // warning here too would name unrelated Projects as ambiguous.
              if (first.directory === second.directory) {
                aliases.push(`'${first.directory}' cannot be physically compared while its directory is unreachable`);
              }
              continue;
            }
            if (firstIdentity === secondIdentity && first.project_id !== second.project_id) {
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

      case "daemon.reachable": {
        const recordPath = join(home.runDir, "daemon.json");
        const daemon = readDaemonRecord(recordPath);
        if (daemon === null) {
          if (existsSync(recordPath)) {
            return warning("run/daemon.json exists but cannot be parsed; delete it and start the daemon again.");
          }
          return ok("No daemon is recorded; start one with sorage daemon start when the API is needed.");
        }
        if (!isPidAlive(daemon.pid)) {
          return warning(`run/daemon.json names pid ${String(daemon.pid)}, which is not running; the record is stale.`);
        }
        const config = configuration();
        if (config === null) {
          return warning("The daemon record cannot be checked without a valid configuration.");
        }
        // The CLI process blocks synchronously (CLI-020), so the health check
        // runs as the command's own subprocess exactly like the web probe; the
        // expected installationId is the configuration's, not the record's.
        const scriptArgs =
          process.argv[1] !== undefined && process.argv[1].endsWith("main.ts")
            ? [process.argv[1], "__health-probe", daemon.host, String(daemon.port), config.installationId]
            : ["__health-probe", daemon.host, String(daemon.port), config.installationId];
        const probe = spawnSync(process.execPath, scriptArgs, { timeout: 5000, encoding: "utf8" });
        if (probe.status === 0) {
          return ok("The daemon answers /api/v1/health with the expected installationId.");
        }
        return warning("The daemon's pid is alive but /api/v1/health does not confirm this installation.");
      }

      case "token.permissions": {
        const tokenPath = join(home.stateDir, "api-token");
        if (!existsSync(tokenPath)) {
          return warning("The API token file does not exist yet; it is created at init or by a rotation.");
        }
        try {
          const stats = statSync(tokenPath);
          const mode = stats.mode & 0o777;
          if (mode !== 0o600) {
            return blocking(`The API token file mode is ${mode.toString(8)}, not 0600.`);
          }
          if (stats.size < 32) {
            return blocking("The API token file holds fewer than 32 bytes.");
          }
          return ok("The API token file is owner-only and holds at least 32 bytes.");
        } catch {
          return blocking("The API token file could not be inspected.");
        }
      }

      case "daemon.port": {
        const config = configuration();
        if (config === null) return warning("The daemon port cannot be checked without a valid configuration.");
        if (!portProbe(config.server.host, config.server.port)) {
          return ok(`Nothing is listening on ${config.server.host}:${config.server.port} yet.`);
        }
        const daemon = readDaemonRecord(join(home.runDir, "daemon.json"));
        if (
          daemon !== null &&
          isPidAlive(daemon.pid) &&
          daemon.host === config.server.host &&
          daemon.port === config.server.port
        ) {
          return ok("This installation's daemon is listening on the configured port.");
        }
        return warning(
          `Another process is listening on ${config.server.host}:${config.server.port}, so the daemon cannot bind it.`,
        );
      }

      case "service.installed": {
        const agentsDirectory = launchAgentsDirectory(userHome);
        const plistPath = launchAgentPlistPath(agentsDirectory);
        const plist = existsSync(plistPath) ? readFileSync(plistPath, "utf8") : null;
        if (plist === null) {
          return warning("The xyz.rootkernel.sorage LaunchAgent is not installed.");
        }
        const candidates = [process.execPath];
        if (process.argv[1] !== undefined && process.argv[1].endsWith("main.ts")) {
          candidates.push(process.argv[1]);
        }
        if (!candidates.some((candidate) => plistPointsAtBinary(plist, candidate))) {
          return warning("The installed LaunchAgent plist points at a different sorage binary.");
        }
        const print = spawnSync("launchctl", ["print", `gui/${launchAgentUid()}/xyz.rootkernel.sorage`], {
          timeout: 5000,
          encoding: "utf8",
        });
        if (print.status !== 0) {
          return warning("The LaunchAgent plist exists but the agent is not bootstrapped in gui/$UID.");
        }
        return ok("The xyz.rootkernel.sorage LaunchAgent is bootstrapped and points at this binary.");
      }

      case "backup.schedule": {
        const config = configuration();
        if (config === null) return warning("The backup schedule cannot be checked without a valid configuration.");
        const spec = {
          enabled: config.gitBackup.enabled,
          at: config.gitBackup.schedule.at,
          timezone: config.gitBackup.schedule.timezone,
          catchUpAfterMissedRun: config.gitBackup.schedule.catchUpAfterMissedRun,
        };
        if (!spec.enabled) return ok("The backup schedule is disabled.");
        let due: string | null;
        try {
          due = nextDueAt(spec, new Date());
        } catch {
          return warning(
            `The next due time is not computable in the configured zone ${spec.timezone}; sorage config validate names the accepted zones.`,
          );
        }
        if (due === null) {
          return warning("The next due time is not computable; check the schedule configuration.");
        }
        const history = backupRunRows(home);
        const lastFailure = history.findLast((row) => row.outcome === "failure");
        if (lastFailure !== undefined) {
          return warning(`The last backup run failed with ${String(lastFailure.failureCode)}.`);
        }
        const lastSuccess = history.findLast((row) => row.outcome !== "failure");
        if (lastSuccess !== undefined && Date.now() - Date.parse(lastSuccess.startedAt) > 25 * 3_600_000) {
          return warning(
            `The last successful backup is older than the configured cadence (last success ${lastSuccess.startedAt}).`,
          );
        }
        return ok(`The next backup is due at ${due}.`);
      }

      case "git.state": {
        const config = configuration();
        if (config === null) return warning("The Vault repository cannot be checked without a valid configuration.");
        const vault = vaultPath(config);
        if (vault === null) return warning("The Vault repository cannot be checked without a valid configuration.");
        if (!existsSync(join(vault, ".git"))) return ok("The Vault has no Git repository yet.");
        const completed = spawnSync("git", ["-C", vault, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" });
        const branch = completed.status === 0 ? String(completed.stdout ?? "").trim() : "";
        if (branch !== config.gitBackup.push.branch) {
          return warning(
            `The Vault repository is on '${branch === "" ? "a detached HEAD" : branch}', not the configured branch '${config.gitBackup.push.branch}'.`,
          );
        }
        if (
          existsSync(join(vault, ".git", "MERGE_HEAD")) ||
          existsSync(join(vault, ".git", "rebase-merge")) ||
          existsSync(join(vault, ".git", "rebase-apply"))
        ) {
          return warning("The Vault repository has a merge or rebase in progress.");
        }
        const staged = spawnSync("git", ["-C", vault, "diff", "--cached", "--name-only"], { encoding: "utf8" });
        const stagedPaths = String(staged.stdout ?? "")
          .split("\n")
          .filter((line) => line !== "");
        const unmanaged = stagedPaths.filter((path) => !isManagedVaultPath(path));
        if (unmanaged.length > 0) {
          return warning(`The index holds staged work outside the managed pathspecs: ${unmanaged.join(", ")}.`);
        }
        const listed = spawnSync("git", ["-C", vault, "remote"], { encoding: "utf8" });
        const remotes =
          listed.status === 0
            ? String(listed.stdout ?? "")
                .split("\n")
                .filter((line) => line !== "")
            : [];
        if (config.gitBackup.push.enabled && !remotes.includes(config.gitBackup.push.remote)) {
          return warning(
            `Push is enabled for remote '${config.gitBackup.push.remote}' but the repository does not know that remote.`,
          );
        }
        return ok(`The Vault repository is on '${branch}' with a clean index.`);
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

/** Reads `run/daemon.json`; null when absent or malformed. */
function backupRunRows(home: { stateDir: string }): BackupRunRow[] {
  try {
    const db = openSorageDatabase(join(home.stateDir, "sorage.sqlite3"));
    try {
      const rows = db.prepare("SELECT * FROM backup_runs").all() as unknown as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: String(row["id"] ?? ""),
        triggeredBy: (row["triggered_by"] ?? "manual") as BackupRunRow["triggeredBy"],
        startedAt: String(row["started_at"] ?? ""),
        finishedAt: row["finished_at"] === null ? null : String(row["finished_at"] ?? ""),
        outcome: (row["outcome"] ?? "failure") as BackupRunRow["outcome"],
        snapshotOutcome: (row["snapshot_outcome"] ?? "failure") as BackupRunRow["snapshotOutcome"],
        commitOutcome: (row["commit_outcome"] ?? "failure") as BackupRunRow["commitOutcome"],
        pushOutcome: (row["push_outcome"] ?? "disabled") as BackupRunRow["pushOutcome"],
        commitSha: row["commit_sha"] === null ? null : String(row["commit_sha"]),
        failureCode: row["failure_code"] === null ? null : String(row["failure_code"]),
        failureMessage: row["failure_message"] === null ? null : String(row["failure_message"]),
      }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function readDaemonRecord(path: string): { pid: number; host: string; port: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; host?: unknown; port?: unknown };
    // The staleness evaluator treats out-of-domain pids as malformed, because
    // kill(-1, 0) and kill(0, 0) probe the caller's set rather than one daemon;
    // the same domain rules keep the doctor from framing a corrupt record as a
    // live-but-unhealthy daemon.
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.host !== "string" ||
      typeof parsed.port !== "number" ||
      !Number.isInteger(parsed.port) ||
      parsed.port <= 0 ||
      parsed.port > 65535
    ) {
      return null;
    }
    return parsed as { pid: number; host: string; port: number };
  } catch {
    return null;
  }
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
