import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  admitAppliedHistory,
  type AppError,
  type BackupRunRow,
  type Configuration,
  CONFIG_ACCESS_REPAIR,
  CONFIG_PATH_REPAIR,
  configurationPathState,
  KNOWN_SCHEMA_HISTORY,
  VAULT_OPEN_RECOVERY,
} from "@sorage/core";
import { parseConfigurationFile, probeConfigurationPath } from "./config-codec";
import { CONFIG_REPAIR, openRefusalRecovery } from "./doctor-recoveries";
import { createHomePaths, type HomeEnvironment, type HomePaths } from "./home";
import { openSorageDatabase, type SorageSqlite } from "./sqlite/connection";
import { inspectAppliedHistory } from "./sqlite/history-inspection";
import { SchemaAdmissionError } from "./sqlite/migrator";
import { openVault } from "./vault";

export interface NodeDoctorPortsOptions {
  env?: HomeEnvironment | undefined;
  userHome?: string | undefined;
  /** True when something already accepts connections at the address; tests inject a fake. */
  portProbe?: ((host: string, port: number) => boolean) | undefined;
}

export type Admission =
  | { kind: "admitted" }
  | { kind: "unsupported"; error: AppError }
  | { kind: "known-history-finding"; message: string }
  | { kind: "unavailable"; message: string };

export type ConfigurationState =
  | { kind: "valid"; config: Configuration }
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "unsafe-path" }
  | { kind: "malformed"; errorMessage: string };

export type VaultState =
  | { kind: "opens" }
  | { kind: "refused"; message: string; recovery: string }
  | { kind: "unconfigured" };

export interface ProjectRow {
  id: string;
  slug: string;
  status: string;
}

export interface BindingRow {
  id: string;
  project_id: string;
  directory: string;
  binding_kind: string;
}

export interface DoctorContext {
  readonly userHome: string;
  readonly home: HomePaths;
  readonly portProbe: (host: string, port: number) => boolean;
  readonly isSessionActive: () => boolean;
  readonly fileDigestCache: Map<string, string>;
  configurationState(): ConfigurationState;
  establishAdmission(): Admission;
  withDoctorDb<T>(fn: (db: SorageSqlite) => T): { ok: true; value: T } | { ok: false; blocking: string };
  configuration(): Configuration | null;
  configurationRecovery(state: ConfigurationState): string;
  vaultPath(config: Configuration | null): string | null;
  vaultState(): VaultState;
  statDirectory(directory: string): Stats | null;
  backupRunRows(): BackupRunRow[] | "unavailable";
  bindingRegistry(): { projects: ProjectRow[]; bindings: BindingRow[] } | null | "unavailable";
  beginSession(): void;
  close(): void;
}

/** Request-scoped per-run cache (ADR-0036: no global singletons, pools, or DI containers). */
interface DoctorSessionState {
  sessionActive: boolean;
  configState: ConfigurationState | null;
  vaultState: VaultState | null;
  sharedDb: SorageSqlite | null;
  sharedDbBlocking: string | null;
  registry: { projects: ProjectRow[]; bindings: BindingRow[] } | null | "unavailable" | undefined;
  dirStatCache: Map<string, Stats | null>;
  fileDigestCache: Map<string, string>;
}

export function createDoctorContext(options: NodeDoctorPortsOptions = {}): DoctorContext {
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
  const databasePath = join(home.stateDir, "sorage.sqlite3");

  const ctx: DoctorSessionState = {
    sessionActive: false,
    configState: null,
    vaultState: null,
    sharedDb: null,
    sharedDbBlocking: null,
    registry: undefined,
    dirStatCache: new Map(),
    fileDigestCache: new Map(),
  };

  let admission: Admission | null = null;

  function configurationState(): ConfigurationState {
    if (ctx.sessionActive && ctx.configState !== null) return ctx.configState;
    const path = configurationPathState(
      probeConfigurationPath(
        () => statSync(home.configFile),
        () => lstatSync(home.configFile),
      ),
    );
    let resolved: ConfigurationState;
    if (path === "absent") {
      resolved = { kind: "absent" };
    } else if (path === "access-failure") {
      resolved = { kind: "unreadable" };
    } else if (path === "path-fault") {
      resolved = { kind: "unsafe-path" };
    } else {
      let text: string | null = null;
      try {
        text = readFileSync(home.configFile, "utf8");
      } catch {
        text = null;
      }
      if (text === null) {
        resolved = { kind: "unreadable" };
      } else {
        const parsed = parseConfigurationFile(text);
        resolved = parsed.ok
          ? { kind: "valid", config: parsed.value.config }
          : { kind: "malformed", errorMessage: parsed.error.message };
      }
    }
    if (ctx.sessionActive) ctx.configState = resolved;
    return resolved;
  }

  function establishAdmission(): Admission {
    if (admission !== null) return admission;
    // K15/K18: never open a non-regular configuration path (a FIFO would
    // block). Only a readable regular file has a doctor DB contract to guard.
    const cfgState = configurationState();
    if (cfgState.kind !== "valid" && cfgState.kind !== "malformed") {
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

  function withDoctorDb<T>(fn: (db: SorageSqlite) => T): { ok: true; value: T } | { ok: false; blocking: string } {
    if (ctx.sessionActive) {
      if (ctx.sharedDbBlocking !== null) {
        return { ok: false, blocking: ctx.sharedDbBlocking };
      }
      if (ctx.sharedDb === null) {
        const opened = doctorOpenDatabase();
        if (!opened.ok) {
          ctx.sharedDbBlocking = opened.blocking;
          return opened;
        }
        ctx.sharedDb = opened.db;
      }
      return { ok: true, value: fn(ctx.sharedDb) };
    }
    const opened = doctorOpenDatabase();
    if (!opened.ok) return opened;
    try {
      return { ok: true, value: fn(opened.db) };
    } finally {
      opened.db.close();
    }
  }

  function configuration(): Configuration | null {
    const state = configurationState();
    return state.kind === "valid" ? state.config : null;
  }

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

  function vaultState(): VaultState {
    if (ctx.sessionActive && ctx.vaultState !== null) return ctx.vaultState;
    const config = configuration();
    const vault = vaultPath(config);
    let resolved: VaultState;
    if (config === null || vault === null) {
      resolved = { kind: "unconfigured" };
    } else {
      try {
        const opened = openVault(vault, config.installationId);
        resolved = opened.ok
          ? { kind: "opens" }
          : {
              kind: "refused",
              message: opened.error.message,
              recovery: openRefusalRecovery(opened.error) ?? VAULT_OPEN_RECOVERY.unreadableDirectory,
            };
      } catch {
        resolved = {
          kind: "refused",
          message: `The Vault directory at ${vault} cannot be inspected.`,
          recovery: VAULT_OPEN_RECOVERY.unreadableDirectory,
        };
      }
    }
    if (ctx.sessionActive) ctx.vaultState = resolved;
    return resolved;
  }

  function statDirectory(directory: string): Stats | null {
    if (ctx.sessionActive && ctx.dirStatCache.has(directory)) {
      return ctx.dirStatCache.get(directory) ?? null;
    }
    let stats: Stats | null;
    try {
      stats = statSync(directory);
    } catch {
      stats = null;
    }
    if (ctx.sessionActive) ctx.dirStatCache.set(directory, stats);
    return stats;
  }

  function backupRunRows(): BackupRunRow[] | "unavailable" {
    try {
      const result = withDoctorDb((db) => {
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
      });
      if (!result.ok) {
        if (admission !== null && admission.kind === "unavailable") return "unavailable";
        return [];
      }
      return result.value;
    } catch {
      return [];
    }
  }

  function bindingRegistry(): { projects: ProjectRow[]; bindings: BindingRow[] } | null | "unavailable" {
    if (ctx.sessionActive && ctx.registry !== undefined) return ctx.registry;
    let resolved: { projects: ProjectRow[]; bindings: BindingRow[] } | null | "unavailable";
    try {
      const result = withDoctorDb((db) => {
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
      });
      if (!result.ok) {
        resolved = admission !== null && admission.kind === "unavailable" ? "unavailable" : null;
      } else {
        resolved = result.value;
      }
    } catch {
      resolved = null;
    }
    if (ctx.sessionActive) ctx.registry = resolved;
    return resolved;
  }

  return {
    userHome,
    home,
    portProbe,
    isSessionActive: () => ctx.sessionActive,
    fileDigestCache: ctx.fileDigestCache,
    configurationState,
    establishAdmission,
    withDoctorDb,
    configuration,
    configurationRecovery,
    vaultPath,
    vaultState,
    statDirectory,
    backupRunRows,
    bindingRegistry,
    beginSession() {
      ctx.sessionActive = true;
    },
    close() {
      ctx.sessionActive = false;
      const db = ctx.sharedDb;
      ctx.sharedDb = null;
      ctx.sharedDbBlocking = null;
      ctx.configState = null;
      ctx.vaultState = null;
      ctx.registry = undefined;
      ctx.dirStatCache.clear();
      ctx.fileDigestCache.clear();
      if (db !== null) {
        try {
          db.close();
        } catch {
          // Best-effort close on session end.
        }
      }
    },
  };
}
