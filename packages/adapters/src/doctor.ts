import { digestManagedFile } from "./managed-paths";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CheckOutcome, DoctorCheckId, DoctorPorts } from "@sorage/core";
import {
  type BackupRunRow,
  type Configuration,
  CONFIG_ACCESS_REPAIR,
  CONFIG_PATH_REPAIR,
  configurationPathState,
  errorSpec,
  isManagedContentStorageKey,
  isManagedStorageKey,
  isManagedVaultPath,
  nextDueAt,
  parseConfigurationFile,
  KNOWN_SCHEMA_HISTORY,
  probeConfigurationPath,
  VAULT_OPEN_RECOVERY,
  verifyVaultPolicyFiles,
  verifyVaultArtifacts,
  type AppError,
  type Result,
  appError,
} from "@sorage/core";
import { createNodeArtifactStore } from "./artifact-store";
import { createConfigStore } from "./config-store";
import {
  inspectArtifactStorageLayout,
  validateArtifactContentLinks,
  validateChannelContentLinks,
  validateMemoContentLinks,
} from "./content-store";
import { createHomePaths, type HomeEnvironment } from "./home";
import { launchAgentPlistPath, launchAgentsDirectory, launchAgentUid, plistPointsAtBinary } from "./launchagent-ports";
import { evaluateStaleness, isPidAlive, parseLockRecord } from "./lockfile";
import { openSorageDatabase, type SorageSqlite } from "./sqlite/connection";
import { inspectAppliedHistory } from "./sqlite/history-inspection";
import { SchemaAdmissionError } from "./sqlite/migrator";
import { admitAppliedHistory } from "@sorage/core";
import { openVault } from "./vault";

/**
 * The production doctor probes over the live installation: every check the M1
 * snapshot can perform, with the recovery guidance of section 35 attached to every
 * non-ok outcome. Checks whose domain tables arrive with later epics report honest
 * vacuous passes instead of pretending to verify data that cannot exist yet.
 *
 * TASK-118 policy: a readable but malformed configuration carries the
 * configuration-repair text, an unreadable configuration or untraversable home
 * carries the owner-only access repair, a path fault at the configuration path
 * (a non-regular entry, a dangling symlink, or a symlink loop; a live symlink
 * to a regular file is accepted) carries the path repair, and a check that
 * cannot establish its result because the Vault cannot open carries that
 * refusal's own recovery.
 */
const CONFIG_REPAIR = "sorage config validate, then repair the reported keys";
const VAULT_GITATTRIBUTES =
  "Backfill both files with sorage init --reconfigure --non-interactive; set the git configuration in the Vault repository";
const GITIGNORE_ENTRY =
  "Add the missing staging/ entry to .gitignore by hand; reconfiguration creates only a missing .gitignore";
const GITATTRIBUTES_AND_GITIGNORE =
  "Backfill .gitattributes with sorage init --reconfigure --non-interactive, and add the missing staging/ entry to .gitignore by hand; reconfiguration creates only a missing .gitignore";
const POLICY_PATH_REPAIR =
  "Repair the policy file path and its permissions; reconfiguration cannot backfill a symlink, directory, or unreadable file";
const POLICY_PATH_AND_RECONFIGURE =
  "Repair the unsafe or unreadable policy path and backfill the missing policy file or .gitattributes line with sorage init --reconfigure --non-interactive; reconfiguration cannot backfill a symlink, directory, or unreadable file";
const POLICY_PATH_AND_GITIGNORE =
  "Repair the unsafe or unreadable policy path and add the missing staging/ entry to .gitignore by hand";
const POLICY_PATH_RECONFIGURE_AND_GITIGNORE =
  "Repair the unsafe or unreadable policy path, backfill the missing policy file or .gitattributes line with sorage init --reconfigure --non-interactive, and add the missing staging/ entry to .gitignore by hand; reconfiguration cannot backfill a symlink, directory, or unreadable file";

const RECOVERIES: Record<DoctorCheckId, string> = {
  "home.permissions": CONFIG_ACCESS_REPAIR,
  "config.schema": CONFIG_REPAIR,
  "config.lock": "Remove ~/.sorage/run/config.lock once no sorage process is running",
  "vault.marker":
    "Check the configured vault.path and confirm its volume is mounted; restore a verified backup into a fresh installation; adopt a foreign Vault only through the audited restore",
  "vault.gitattributes": VAULT_GITATTRIBUTES,
  "vault.writable": "Fix the directory permissions, or remount the volume read-write",
  "db.integrity": "Restore from ~/.sorage/state/backups/, or sorage backup restore into a fresh installation",
  "db.pendingIntents":
    "Inspect the ARTIFACT_INTEGRITY_FAILED events for the affected Handoffs and restore them from backup",
  "db.migrations": "Install the matching sorage build; remove a stale ~/.sorage/run/migration.lock",
  "artifacts.checksums": "sorage vault verify, then restore the affected Handoff from backup",
  "content.checksums": "sorage vault verify, then restore the affected records from backup",
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
      const scriptArgs = process.argv[1]?.endsWith("main.ts")
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

  // The eager readonly history-admission guard (SHR-009): every DB open the
  // doctor performs — including the indirect bindingRegistry and backupRunRows
  // helpers — routes through this saved admission boundary, so no per-check or
  // helper catch can cause a writable retry after a refusal or an unreadable
  // history. A confirmed future maximum throws the typed SchemaAdmissionError
  // before any probe runs; the CLI's runCli catch renders it as
  // STORAGE_SCHEMA_UNSUPPORTED/78. A supported maximum with a malformed known
  // history does not throw: the db.migrations probe reports the actual finding
  // as its stable blocking diagnostic. A failed readonly read or open caches
  // the failure and every DB-dependent check reports honestly unavailable
  // without a writable fallback; independent non-DB diagnostics continue.
  type Admission =
    | { kind: "admitted" }
    | { kind: "unsupported"; error: AppError }
    | { kind: "known-history-finding"; message: string }
    | { kind: "unavailable"; message: string };
  let admission: Admission | null = null;
  function establishAdmission(): Admission {
    if (admission !== null) return admission;
    // K15/K18: never open a non-regular configuration path (a FIFO would
    // block). Only a regular file has a doctor DB contract to guard.
    const configPath = configurationPathState(
      probeConfigurationPath(
        () => statSync(home.configFile),
        () => lstatSync(home.configFile),
      ),
    );
    if (configPath !== "valid" || store.readText() === null) {
      // Before initialization (or without a readable regular file) there is no
      // doctor DB contract to guard.
      admission = { kind: "admitted" };
      return admission;
    }
    let verdict: ReturnType<typeof admitAppliedHistory>;
    try {
      const rows = inspectAppliedHistory(databasePath);
      verdict = admitAppliedHistory(rows ?? [], KNOWN_SCHEMA_HISTORY);
    } catch (error) {
      admission = {
        kind: "unavailable",
        message: `The database history could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      };
      return admission;
    }
    if (verdict.kind === "unsupported") {
      admission = { kind: "unsupported", error: verdict.error };
      throw new SchemaAdmissionError(verdict.error);
    }
    if (verdict.kind === "ok") {
      admission = { kind: "admitted" };
      return admission;
    }
    admission = { kind: "known-history-finding", message: verdict.error.message };
    return admission;
  }
  establishAdmission();

  /**
   * The single DB-opening boundary every doctor probe and helper uses. A
   * confirmed future refusal or an unreadable/uncertain history stops every
   * writable open; a supported maximum whose known history has a malformed
   * finding allows the other operational diagnostics to proceed and only the
   * db.migrations probe reports the finding as its stable blocking message.
   * Operational open failures (busy, permissions, WAL configuration) are
   * returned as an ordinary `blocking` result so each probe's existing
   * diagnostic catalog reports them, never as an admission exception.
   */
  function doctorOpenDatabase(): { ok: true; db: SorageSqlite } | { ok: false; blocking: string } {
    const state = establishAdmission();
    if (state.kind === "unsupported") {
      return { ok: false, blocking: state.error.message };
    }
    if (state.kind === "unavailable") {
      return { ok: false, blocking: state.message };
    }
    try {
      return { ok: true, db: openSorageDatabase(databasePath) };
    } catch (error) {
      return {
        ok: false,
        blocking: `The database could not be opened: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * The configuration state as observed (TASK-118, Z2): only a confirmed ENOENT
   * is pre-initialization, where `sorage init` is the right action. A
   * configuration file that cannot be read, or a home directory that cannot be
   * traversed, is an access failure whose recovery restores owner-only access
   * and never suggests initialization; a non-regular entry, a dangling symlink,
   * or a symlink loop at the configuration path is a path fault, while a live
   * symlink to a regular file is accepted; a readable but invalid file is the
   * configuration-repair case where `sorage config validate` runs.
   */
  type ConfigurationState =
    | { kind: "valid"; config: Configuration }
    | { kind: "absent" }
    | { kind: "unreadable" }
    | { kind: "unsafe-path" }
    | { kind: "malformed" };

  function configurationState(): ConfigurationState {
    const path = configurationPathState(
      probeConfigurationPath(
        () => statSync(home.configFile),
        () => lstatSync(home.configFile),
      ),
    );
    if (path === "absent") return { kind: "absent" };
    if (path === "access-failure") return { kind: "unreadable" };
    if (path === "path-fault") return { kind: "unsafe-path" };
    let text: string;
    try {
      text = readFileSync(home.configFile, "utf8");
    } catch {
      return { kind: "unreadable" };
    }
    const parsed = parseConfigurationFile(text);
    return parsed.ok ? { kind: "valid", config: parsed.value.config } : { kind: "malformed" };
  }

  function configuration(): Configuration | null {
    const state = configurationState();
    return state.kind === "valid" ? state.config : null;
  }

  /** The recovery for a configuration a check cannot use, by the observed state. */
  function configurationRecovery(state: ConfigurationState): string {
    if (state.kind === "unreadable") return CONFIG_ACCESS_REPAIR;
    if (state.kind === "unsafe-path") return CONFIG_PATH_REPAIR;
    return CONFIG_REPAIR;
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

  /**
   * The Vault-open state every Vault-dependent check reuses (TASK-118): one
   * `openVault` call per doctor instance, so every check reports the same
   * refusal and none of them inspects Vault content the guard would refuse.
   */
  type VaultState =
    | { kind: "opens" }
    | { kind: "refused"; message: string; recovery: string }
    | { kind: "unconfigured" };
  let vaultStateCache: VaultState | null = null;

  function vaultState(): VaultState {
    if (vaultStateCache !== null) return vaultStateCache;
    const config = configuration();
    const vault = vaultPath(config);
    if (config === null || vault === null) {
      vaultStateCache = { kind: "unconfigured" };
      return vaultStateCache;
    }
    try {
      const opened = openVault(vault, config.installationId);
      vaultStateCache = opened.ok
        ? { kind: "opens" }
        : {
            kind: "refused",
            message: opened.error.message,
            recovery: openRefusalRecovery(opened.error) ?? VAULT_OPEN_RECOVERY.unreadableDirectory,
          };
    } catch {
      vaultStateCache = {
        kind: "refused",
        message: `The Vault directory at ${vault} cannot be inspected.`,
        recovery: VAULT_OPEN_RECOVERY.unreadableDirectory,
      };
    }
    return vaultStateCache;
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

  /** Reads backup run history through the admission boundary; "unavailable" when the history cannot be established, empty only when genuinely no rows exist. */
  function backupRunRows(): BackupRunRow[] | "unavailable" {
    const opened = doctorOpenDatabase();
    if (!opened.ok) {
      if (admission !== null && admission.kind === "unavailable") return "unavailable";
      return [];
    }
    try {
      const db = opened.db;
      try {
        const rows = db.prepare("SELECT * FROM backup_runs").all() as unknown as Array<Record<string, unknown>>;
        return rows.map((row) => ({
          id: String(row.id ?? ""),
          triggeredBy: (row.triggered_by ?? "manual") as BackupRunRow["triggeredBy"],
          startedAt: String(row.started_at ?? ""),
          finishedAt: row.finished_at === null ? null : String(row.finished_at ?? ""),
          outcome: (row.outcome ?? "failure") as BackupRunRow["outcome"],
          snapshotOutcome: (row.snapshot_outcome ?? "failure") as BackupRunRow["snapshotOutcome"],
          commitOutcome: (row.commit_outcome ?? "failure") as BackupRunRow["commitOutcome"],
          pushOutcome: (row.push_outcome ?? "disabled") as BackupRunRow["pushOutcome"],
          commitSha: row.commit_sha === null ? null : String(row.commit_sha),
          failureCode: row.failure_code === null ? null : String(row.failure_code),
          failureMessage: row.failure_message === null ? null : String(row.failure_message ?? ""),
        }));
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  }

  /** Reads the Project registry once per probe; null only when genuinely absent. When admission is unavailable, returns a marker the bindings checks report as an honest warning instead of a vacuous ok. */
  function bindingRegistry(): { projects: ProjectRow[]; bindings: BindingRow[] } | null | "unavailable" {
    const opened = doctorOpenDatabase();
    if (!opened.ok) {
      if (admission !== null && admission.kind === "unavailable") return "unavailable";
      return null;
    }
    try {
      const db = opened.db;
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
        const configPathState = configurationPathState(
          probeConfigurationPath(
            () => statSync(home.configFile),
            () => lstatSync(home.configFile),
          ),
        );
        if (!homeExists || configPathState === "absent" || configPathState === "access-failure") {
          return withRecovery(blocking("The home directory or config.yaml is missing."), CONFIG_ACCESS_REPAIR);
        }
        // K15: a live symlink to a regular file is followed; only a directory,
        // dangling symlink, loop, or other non-regular entry is a path fault.
        if (configPathState === "path-fault") {
          return withRecovery(
            blocking("The configuration path is not a regular config.yaml file."),
            CONFIG_PATH_REPAIR,
          );
        }
        const configMode = statSync(home.configFile).mode & 0o777;
        if (configMode !== 0o600) {
          return withRecovery(
            blocking(`config.yaml is mode ${configMode.toString(8)}, expected owner-only 600.`),
            CONFIG_ACCESS_REPAIR,
          );
        }
        return ok("The home tree exists and config.yaml is owner-only.");
      }

      case "config.schema": {
        const state = configurationState();
        if (state.kind === "unreadable") {
          return withRecovery(blocking("config.yaml cannot be read."), CONFIG_ACCESS_REPAIR);
        }
        if (state.kind === "unsafe-path") {
          return withRecovery(
            blocking("The configuration path is not a regular config.yaml file."),
            CONFIG_PATH_REPAIR,
          );
        }
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
        const state = configurationState();
        if (state.kind !== "valid") {
          return withRecovery(
            blocking("The Vault marker cannot be checked without a valid configuration."),
            configurationRecovery(state),
          );
        }
        const opened = vaultState();
        if (opened.kind === "refused") return blocking(opened.message);
        if (opened.kind === "unconfigured") {
          return withRecovery(
            blocking("The Vault marker cannot be checked without a valid configuration."),
            CONFIG_REPAIR,
          );
        }
        return ok("The Vault marker matches this installation.");
      }

      case "vault.gitattributes": {
        const state = configurationState();
        if (state.kind !== "valid") {
          return withRecovery(
            warning("The Vault policy files cannot be checked without a valid configuration."),
            configurationRecovery(state),
          );
        }
        const opened = vaultState();
        if (opened.kind === "refused") return warning(opened.message);
        const vault = vaultPath(state.config);
        if (vault === null) {
          return withRecovery(
            warning("The Vault policy files cannot be checked without a valid configuration."),
            CONFIG_REPAIR,
          );
        }
        const attributes = readPolicyFile(join(vault, ".gitattributes"));
        const ignore = readPolicyFile(join(vault, ".gitignore"));
        // K8/K13: collect every finding from both files — including an unsafe or
        // unreadable path — before choosing one recovery, so each state names
        // every action it actually needs.
        const findings: string[] = [];
        let pathIssue = false;
        let attributesIssue = false;
        let ignoreEntryIssue = false;
        let ignoreMissing = false;
        if (attributes.kind === "unsafe") {
          findings.push(".gitattributes is unreadable or unsafe at its path.");
          pathIssue = true;
        } else if (attributes.kind === "missing") {
          findings.push(".gitattributes is missing from the Vault.");
          attributesIssue = true;
        } else {
          // The required lines and their stated order, exactly as `vault verify`
          // and `backup verify` assert them (VLT-024, BKP-022, section 6).
          const problems = verifyVaultPolicyFiles(attributes.text, null).filter((problem) =>
            problem.startsWith(".gitattributes"),
          );
          findings.push(...problems);
          attributesIssue = problems.length > 0;
        }
        if (ignore.kind === "unsafe") {
          findings.push(".gitignore is unreadable or unsafe at its path.");
          pathIssue = true;
        } else if (ignore.kind === "missing") {
          findings.push(".gitignore is missing from the Vault.");
          ignoreMissing = true;
        } else {
          const problems = verifyVaultPolicyFiles(null, ignore.text).filter((problem) =>
            problem.startsWith(".gitignore"),
          );
          findings.push(...problems);
          ignoreEntryIssue = problems.length > 0;
        }
        if (findings.length === 0) {
          return ok("The Vault policy files carry every required line in its stated order.");
        }
        const needsReconfigure = attributesIssue || ignoreMissing;
        let recovery: string;
        if (!pathIssue) {
          recovery =
            needsReconfigure && ignoreEntryIssue
              ? GITATTRIBUTES_AND_GITIGNORE
              : needsReconfigure
                ? VAULT_GITATTRIBUTES
                : GITIGNORE_ENTRY;
        } else if (needsReconfigure && ignoreEntryIssue) {
          recovery = POLICY_PATH_RECONFIGURE_AND_GITIGNORE;
        } else if (needsReconfigure) {
          recovery = POLICY_PATH_AND_RECONFIGURE;
        } else if (ignoreEntryIssue) {
          recovery = POLICY_PATH_AND_GITIGNORE;
        } else {
          recovery = POLICY_PATH_REPAIR;
        }
        return withRecovery(warning(findings.join(" ")), recovery);
      }

      case "vault.writable": {
        const state = configurationState();
        if (state.kind !== "valid") {
          return withRecovery(
            blocking("The Vault cannot be checked without a valid configuration."),
            configurationRecovery(state),
          );
        }
        const opened = vaultState();
        if (opened.kind === "refused") {
          return blocking("The Vault root, artifacts/, or staging/ is not writable by this user.");
        }
        const vault = vaultPath(state.config);
        if (vault === null) {
          return withRecovery(blocking("The Vault cannot be checked without a valid configuration."), CONFIG_REPAIR);
        }
        try {
          for (const directory of [vault, join(vault, "artifacts"), join(vault, "staging")]) {
            accessSync(directory, constants.W_OK);
          }
        } catch {
          return withRecovery(
            blocking("The Vault root, artifacts/, or staging/ is not writable by this user."),
            RECOVERIES["vault.writable"],
          );
        }
        return ok("The Vault root, artifacts/, and staging/ are writable.");
      }

      case "db.integrity": {
        const opened = doctorOpenDatabase();
        if (!opened.ok) return blocking(opened.blocking);
        try {
          const db = opened.db;
          try {
            const integrity = db.prepare("PRAGMA integrity_check").get() as unknown;
            const row = integrity as Record<string, unknown> | undefined;
            const verdict = row === undefined ? undefined : row.integrity_check;
            const journal = (db.prepare("PRAGMA journal_mode").get() as Record<string, unknown> | undefined)
              ?.journal_mode;
            const foreignKeys = (db.prepare("PRAGMA foreign_keys").get() as Record<string, unknown> | undefined)
              ?.foreign_keys;
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
        const opened = doctorOpenDatabase();
        if (!opened.ok) return blocking(opened.blocking);
        try {
          const db = opened.db;
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
            const count = Number(row?.count ?? 0);
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
        // A supported maximum whose known history has a malformed finding gets
        // reported here as the stable blocking diagnostic — not as a typed
        // integrity refusal of the whole command — while the other supported
        // diagnostics continue through their own opens.
        const admissionState = establishAdmission();
        if (admissionState.kind === "known-history-finding") {
          return blocking(admissionState.message);
        }
        const opened = doctorOpenDatabase();
        if (!opened.ok) return blocking(opened.blocking);
        try {
          const db = opened.db;
          try {
            const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
              | Record<string, unknown>
              | undefined;
            const expected = KNOWN_SCHEMA_HISTORY[KNOWN_SCHEMA_HISTORY.length - 1]?.version ?? 0;
            if (row?.version !== expected) {
              return blocking(`schema_migrations is at ${String(row?.version)}, expected ${expected}.`);
            }
          } finally {
            db.close();
          }
        } catch (error) {
          return blocking(
            `schema_migrations could not be read: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // The transactional runner never acquires the legacy run/migration.lock
        // file (NFR-009 as resolved by M9, architecture section 19): a live-looking
        // owner means an older executable may still be running against this home,
        // and stale evidence is preserved for manual removal, never deleted here.
        let lockBody: string;
        try {
          lockBody = readFileSync(home.lockFile("migration"), "utf8");
        } catch {
          return ok("schema_migrations is at the version this build expects.");
        }
        const verdict = evaluateStaleness("migration", parseLockRecord(lockBody), new Date(), isPidAlive);
        if (verdict.stale) {
          return blocking(
            `migration.lock is stale (${verdict.reason}); this build's runner does not acquire the legacy file, so remove it manually once no old sorage process is running.`,
          );
        }
        return blocking(
          "migration.lock records a live owner; this build's migration runner does not acquire the legacy file, so an old sorage executable may be running against this installation. Stop it before further work.",
        );
      }

      case "content.checksums": {
        const state = configurationState();
        const config = state.kind === "valid" ? state.config : null;
        const vault = vaultPath(config);
        if (config === null || vault === null) {
          return withRecovery(
            blocking("Content checksums cannot be checked without a valid configuration."),
            configurationRecovery(state),
          );
        }
        const opened = doctorOpenDatabase();
        if (!opened.ok) return blocking(opened.blocking);
        try {
          const db = opened.db;
          let records: Array<{ storage_key: string | null; inline_text: string | null; sha256: string }> = [];
          try {
            // The Memo link guard runs before any census conclusion and inside
            // the connection-close ownership: a schema-10 database whose Memo
            // rows lost their record references is a blocking integrity
            // finding, never a healthy empty census (SHR-004, SHR-014), and
            // the refusal path releases this check's own connection.
            const memoLinks = validateMemoContentLinks(db);
            if (!memoLinks.ok) return blocking(memoLinks.error.message);
            // The Channel link guard joins the same census boundary: a
            // schema-11 database whose message rows lost their record
            // references is a blocking finding under the same rule, never a
            // healthy empty census (SHR-004, the TASK-109 reviewed plan).
            const channelLinks = validateChannelContentLinks(db);
            if (!channelLinks.ok) return blocking(channelLinks.error.message);
            const table = db
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_records'")
              .get() as { name: string } | null | undefined;
            if (table) {
              records = db
                .prepare("SELECT storage_key, inline_text, sha256 FROM content_records WHERE materialized = 1")
                .all() as unknown as Array<{ storage_key: string | null; inline_text: string | null; sha256: string }>;
            }
          } finally {
            db.close();
          }
          if (records.length === 0) return ok("No content records are recorded yet on this installation.");
          // A Vault that cannot open is reported as that refusal, never as
          // missing content bytes (TASK-118, section 3.4).
          const openedVault = vaultState();
          if (openedVault.kind === "refused") return blocking(openedVault.message);
          const findings = verifyContentRecords({ vault }, records);
          if (!findings.ok) return blocking(findings.error.message);
          if (findings.value.length > 0) {
            return blocking(findings.value.join(" "));
          }
          return ok("Every recorded content record exists and matches its recorded SHA-256.");
        } catch (error) {
          return blocking(
            `Content checksums could not be verified: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      case "artifacts.checksums": {
        const state = configurationState();
        const config = state.kind === "valid" ? state.config : null;
        const vault = vaultPath(config);
        if (config === null || vault === null) {
          return withRecovery(
            blocking("Artifact checksums cannot be checked without a valid configuration."),
            configurationRecovery(state),
          );
        }
        const opened = doctorOpenDatabase();
        if (!opened.ok) return blocking(opened.blocking);
        try {
          const db = opened.db;
          let records: Array<{ storage_key: string | null; inline_text: string | null; sha256: string }> = [];
          try {
            // The shared content-link guard runs before any census filter: an
            // Artifact whose authoritative record row is missing must surface as
            // a blocking finding, never as a false healthy empty census (SHR-004,
            // SEC-014, section 35).
            const links = validateArtifactContentLinks(db);
            if (!links.ok) {
              return blocking(links.error.message);
            }
            // The census covers every current Artifact in the layout the applied
            // history actually established (INIT-017, SEC-014, section 35): a
            // legitimate pre-adoption database keeps the legacy Artifact columns
            // and is censused through them — its file-backed bytes still verify
            // healthy while db.migrations separately reports the ordinary
            // 8-expected-9 finding — while an adoption-version database reads
            // each Artifact through its normalized content record, file-backed
            // bytes at their managed key and an inline record's stored text in
            // place. A database at or above the adoption version whose required
            // artifacts table or reference column is missing is inconsistent and
            // reported as a visible blocking finding, never as the vacuous
            // no-Artifacts pass or silently treated as legacy (SHR-004: a
            // history-only admission check does not establish the required
            // structure of an already-current database).
            const layout = inspectArtifactStorageLayout(db);
            if (layout === "content-records") {
              records = db
                .prepare(
                  "SELECT c.storage_key AS storage_key, c.inline_text AS inline_text, c.sha256 AS sha256 FROM artifacts a JOIN content_records c ON c.id = a.content_record_id WHERE c.materialized = 1",
                )
                .all() as unknown as Array<{
                storage_key: string | null;
                inline_text: string | null;
                sha256: string;
              }>;
            } else if (layout === "legacy-columns") {
              records = db
                .prepare("SELECT storage_key, NULL AS inline_text, sha256 FROM artifacts WHERE materialized = 1")
                .all() as unknown as Array<{
                storage_key: string | null;
                inline_text: string | null;
                sha256: string;
              }>;
            }
            // A pre-adoption database without the artifacts table keeps the
            // honest vacuous pass: no Artifact can be recorded yet.
          } finally {
            db.close();
          }
          if (records.length === 0) return ok("No Artifacts are recorded yet on this installation.");
          // A Vault that cannot open is reported as that refusal, never as
          // missing Artifact bytes (TASK-118, section 3.4).
          const openedVault = vaultState();
          if (openedVault.kind === "refused") return blocking(openedVault.message);
          const inlineFindings: string[] = [];
          const fileRecords: Array<{ storage_key: string; sha256: string }> = [];
          for (const row of records) {
            if (row.inline_text !== null) {
              const recomputed = createHash("sha256").update(Buffer.from(row.inline_text, "utf8")).digest("hex");
              if (recomputed !== row.sha256) {
                inlineFindings.push(
                  `An inline Artifact body records SHA-256 ${row.sha256} but its stored text digests to ${recomputed}.`,
                );
              }
              continue;
            }
            if (row.storage_key !== null) fileRecords.push({ storage_key: row.storage_key, sha256: row.sha256 });
          }
          if (inlineFindings.length > 0) return blocking(inlineFindings.join(" "));
          const store = createNodeArtifactStore({ vaultPath: vault, installationId: config.installationId });
          const findings = verifyVaultArtifacts(
            { artifactStore: store },
            fileRecords.map((row) => ({ storageKey: row.storage_key, sha256: row.sha256 })),
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
        if (registry === "unavailable")
          return warning("Project bindings cannot be verified because the database history could not be inspected.");
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
        if (registry === "unavailable")
          return warning("Project bindings cannot be verified because the database history could not be inspected.");
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
        if (registry === "unavailable")
          return warning("Project bindings cannot be verified because the database history could not be inspected.");
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
        const state = configurationState();
        const vault = vaultPath(state.kind === "valid" ? state.config : null);
        if (vault === null) {
          return withRecovery(
            warning("Platform readability cannot be checked without a valid configuration."),
            configurationRecovery(state),
          );
        }
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
        const state = configurationState();
        if (state.kind !== "valid") {
          return withRecovery(
            warning("The daemon record cannot be checked without a valid configuration."),
            configurationRecovery(state),
          );
        }
        const config = state.config;
        // The CLI process blocks synchronously (CLI-020), so the health check
        // runs as the command's own subprocess exactly like the web probe; the
        // expected installationId is the configuration's, not the record's.
        const scriptArgs = process.argv[1]?.endsWith("main.ts")
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
        const state = configurationState();
        if (state.kind !== "valid") {
          return withRecovery(
            warning("The daemon port cannot be checked without a valid configuration."),
            configurationRecovery(state),
          );
        }
        const config = state.config;
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
        if (process.argv[1]?.endsWith("main.ts")) {
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
        const state = configurationState();
        if (state.kind !== "valid") {
          return withRecovery(
            warning("The backup schedule cannot be checked without a valid configuration."),
            configurationRecovery(state),
          );
        }
        const config = state.config;
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
        const history = backupRunRows();
        if (history === "unavailable") {
          return warning("The backup schedule cannot be verified because the database history could not be inspected.");
        }
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
        const state = configurationState();
        const config = state.kind === "valid" ? state.config : null;
        if (config === null) {
          return withRecovery(
            warning("The Vault repository cannot be checked without a valid configuration."),
            configurationRecovery(state),
          );
        }
        const vault = vaultPath(config);
        if (vault === null) {
          return withRecovery(
            warning("The Vault repository cannot be checked without a valid configuration."),
            CONFIG_REPAIR,
          );
        }
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

  /**
   * Section 35 attaches its recovery guidance to every non-ok outcome
   * (TASK-118): an explicit branch recovery wins, a Vault-dependent check whose
   * Vault cannot open carries that refusal's own recovery, and otherwise the
   * static catalog text applies. A static `sorage vault verify` is therefore
   * only reachable while the Vault actually opens.
   */
  function attachRecovery(id: DoctorCheckId, outcome: CheckOutcome): CheckOutcome {
    if (outcome.severity === "ok") return outcome;
    if (outcome.recovery !== undefined) return outcome;
    if (VAULT_DEPENDENT.has(id)) {
      const opened = vaultState();
      if (opened.kind === "refused") {
        return { ...outcome, recovery: { suggestedCommand: opened.recovery } };
      }
    }
    return { ...outcome, recovery: { suggestedCommand: RECOVERIES[id] } };
  }

  return {
    // TASK-118 K1/Z2: only a confirmed ENOENT is pre-initialization. A present
    // but unreadable file, a denied parent traversal, or a path fault (a
    // non-regular entry, a dangling symlink, or a symlink loop) at the path all
    // run the catalog with their own repair.
    initialized() {
      return configurationState().kind !== "absent";
    },

    probe(id: DoctorCheckId): CheckOutcome {
      return attachRecovery(id, perform(id));
    },
  };
}

/** One policy-file read: present, absent, or present at an unsafe/unreadable path. */
type PolicyRead = { kind: "present"; text: string } | { kind: "missing" } | { kind: "unsafe" };

function readPolicyFile(path: string): PolicyRead {
  try {
    if (!lstatSync(path).isFile()) return { kind: "unsafe" };
    return { kind: "present", text: readFileSync(path, "utf8") };
  } catch (error) {
    return isNotFound(error) ? { kind: "missing" } : { kind: "unsafe" };
  }
}

/** The checks whose result depends on the Vault opening (TASK-118, section 3.4). */
const VAULT_DEPENDENT = new Set<DoctorCheckId>([
  "vault.marker",
  "vault.gitattributes",
  "vault.writable",
  "artifacts.checksums",
  "content.checksums",
  "platform.tcc",
]);

/** The recovery a Vault-open refusal carries, or null when it is a different failure. */
function openRefusalRecovery(error: AppError): string | null {
  if (typeof error.details?.vaultPath !== "string") return null;
  return error.recovery?.suggestedCommand ?? errorSpec(error.code).recovery?.suggestedCommand ?? null;
}

function withRecovery(outcome: CheckOutcome, recovery: string): CheckOutcome {
  if (outcome.severity === "ok") return outcome;
  return { ...outcome, recovery: { suggestedCommand: recovery } };
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * The `content.checksums` census (SHR-011, section 35): every live content
 * record's bytes match its recorded SHA-256 — an inline record by recomputing
 * the digest over its stored text, a file-backed record by recomputing it over
 * the bytes at the managed key. Read-only, never repairing.
 */
function verifyContentRecords(
  ports: { vault: string },
  records: Array<{ storage_key: string | null; inline_text: string | null; sha256: string }>,
): Result<string[], AppError> {
  const findings: string[] = [];
  try {
    for (const record of records) {
      if (record.storage_key === null) {
        const recomputed = createHash("sha256")
          .update(Buffer.from(record.inline_text ?? "", "utf8"))
          .digest("hex");
        if (recomputed !== record.sha256) {
          findings.push(
            `An inline content record records SHA-256 ${record.sha256} but its stored text digests to ${recomputed}.`,
          );
        }
        continue;
      }
      if (!isManagedContentStorageKey(record.storage_key) && !isManagedStorageKey(record.storage_key)) {
        findings.push(`A content record names the non-managed storage key ${record.storage_key}.`);
        continue;
      }
      try {
        const recomputed = digestManagedFile(ports.vault, record.storage_key).sha256;
        if (recomputed.toLowerCase() !== record.sha256.toLowerCase()) {
          findings.push(
            `The content bytes at ${record.storage_key} do not match their recorded SHA-256 ${record.sha256}.`,
          );
        }
      } catch {
        findings.push(`Content is missing, unsafe, or unreadable at the managed key ${record.storage_key}.`);
      }
    }
    return { ok: true, value: findings };
  } catch (error) {
    return {
      ok: false,
      error: appError(
        "INTERNAL_ERROR",
        `Verifying content records failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
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
