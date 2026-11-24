import {
  CONFIG_ACCESS_REPAIR,
  CONFIG_PATH_REPAIR,
  type Configuration,
  defaultConfiguration,
  expandConfigurationPath,
} from "../config/config";
import { type AppError, ok, type Result } from "../shared/errors";
import type { Clock, IdGenerator } from "../primitives/ids";
import type { ApiTokenStorePort } from "./tokens";

/**
 * The non-interactive initialization use case (INIT-003, INIT-005, INIT-006,
 * INIT-013, CFG-003, VLT-001, VLT-002, VLT-024): creates the home tree, the migrated
 * database, and the Vault with its marker files, and writes `config.yaml` through the
 * atomic store last so the file is the completion marker of a fully created
 * installation. A crashed init therefore leaves no configuration behind, and a rerun
 * completes idempotently. An existing valid installation is reported and never
 * modified; a malformed configuration stops the run before anything is rewritten.
 */
export interface InitPathsPort {
  home: string;
  stateDir: string;
  logsDir: string;
  runDir: string;
}

export interface InitConfigStorePort {
  read(): Result<{ config: Configuration; etag: string; revision: number } | null, AppError>;
  write(
    config: Configuration,
    expect?: { revision?: number; etag?: string },
  ): Result<{ config: Configuration; etag: string }, AppError>;
}

export interface InitDatabasePort {
  migrate(): Result<{ appliedVersions: number[]; alreadyUpToDate: boolean }, AppError>;
}

export interface InitVaultPort {
  /** Creates the Vault layout and marker, never overwriting what already exists. */
  initialize(vaultPath: string, installationId: string): Result<{ markerCreated: boolean }, AppError>;
}

export interface InitFilesystemPort {
  ensureDirectory(path: string): void;
}

/** From milestone M3, `sorage init --initialize-git` also brings up the Vault repository (INIT-007, BKP-022). */
export interface InitGitPort {
  ensureRepository(vaultPath: string): Result<{ initialized: boolean; existingReported: boolean }, AppError>;
}

export interface InitPorts {
  paths: InitPathsPort;
  userHome: string;
  clock: Clock;
  ids: IdGenerator;
  config: InitConfigStorePort;
  database: InitDatabasePort;
  vault: InitVaultPort;
  filesystem: InitFilesystemPort;
  /** From milestone M2, init also creates the API token at `state/api-token` (INIT-003). */
  token?: ApiTokenStorePort | undefined;
  git?: InitGitPort | undefined;
}

export interface InitOptions {
  /** The literal `--vault <path>` value; a tilde prefix is expanded for placement. */
  vaultPath?: string | undefined;
  /** `--reconfigure`: backfill missing pieces of an existing installation. */
  reconfigure?: boolean | undefined;
  /** `--initialize-git`: initialize the Vault Git repository (INIT-007, BKP-022). */
  initializeGit?: boolean | undefined;
  /** `--port <n>`: sets `server.port` in the creating write (section 3.1). */
  serverPort?: number | undefined;
}

export interface InitResult {
  outcome: "created" | "already-initialized";
  installationId: string;
  /** The expanded, normalized Vault directory. */
  vaultPath: string;
  home: string;
  /** Present only when `--initialize-git` ran (INIT-007). */
  git?: { initialized: boolean; existingReported: boolean } | undefined;
}

export function initializeInstallation(ports: InitPorts, options: InitOptions = {}): Result<InitResult, AppError> {
  const current = ports.config.read();
  if (!current.ok) return current;

  if (current.value !== null) {
    const existing = current.value.config;
    if (options.reconfigure === true) {
      // Explicit repair: backfill directories, migrations, and Vault files without
      // touching the configuration, the identity, or any existing Vault content.
      ensureHomeTree(ports);
      const migrated = ports.database.migrate();
      if (!migrated.ok) return migrated;
      const token = ports.token?.ensure();
      if (token !== undefined && !token.ok) return token;
      const vaultPath = expandConfigurationPath(existing.vault.path, ports.userHome, ports.paths.home);
      const vault = ports.vault.initialize(vaultPath, existing.installationId);
      if (!vault.ok) return vault;
      if (options.initializeGit === true && ports.git !== undefined) {
        const git = ports.git.ensureRepository(vaultPath);
        if (!git.ok) return git;
        return ok({
          outcome: "already-initialized",
          installationId: existing.installationId,
          vaultPath,
          home: ports.paths.home,
          git: git.value,
        });
      }
    }
    return ok({
      outcome: "already-initialized",
      installationId: existing.installationId,
      vaultPath: expandConfigurationPath(existing.vault.path, ports.userHome, ports.paths.home),
      home: ports.paths.home,
    });
  }

  const installationId = ports.ids.next();
  const config = defaultConfiguration(installationId);
  if (options.vaultPath !== undefined && options.vaultPath.trim() !== "") {
    config.vault.path = options.vaultPath;
  }
  if (options.serverPort !== undefined) {
    config.server.port = options.serverPort;
  }

  ensureHomeTree(ports);
  const migrated = ports.database.migrate();
  if (!migrated.ok) return migrated;
  const token = ports.token?.ensure();
  if (token !== undefined && !token.ok) return token;
  const vaultPath = expandConfigurationPath(config.vault.path, ports.userHome, ports.paths.home);
  const vault = ports.vault.initialize(vaultPath, installationId);
  if (!vault.ok) return vault;
  // The creating write is fenced on revision 0 so a concurrent init that won the
  // race fails with CONFIG_CONFLICT instead of silently replacing the identity.
  const written = ports.config.write(config, { revision: 0 });
  if (!written.ok) return written;
  if (options.initializeGit === true && ports.git !== undefined) {
    const git = ports.git.ensureRepository(vaultPath);
    if (!git.ok) return git;
    return ok({ outcome: "created", installationId, vaultPath, home: ports.paths.home, git: git.value });
  }
  return ok({ outcome: "created", installationId, vaultPath, home: ports.paths.home });
}

function ensureHomeTree(ports: InitPorts): void {
  ports.filesystem.ensureDirectory(ports.paths.home);
  ports.filesystem.ensureDirectory(ports.paths.stateDir);
  ports.filesystem.ensureDirectory(ports.paths.logsDir);
  ports.filesystem.ensureDirectory(ports.paths.runDir);
}

/** Observed state of an existing configuration before initialization writes anything (INIT-017). */
export type ExistingConfigurationState = "absent" | "present" | "unreadable" | "unsafe-path";

export interface InitChoicesInput {
  vaultPath: string;
  createVault: boolean;
  serverPort: number;
  installService: boolean;
  startDaemon: boolean;
  initializeGit: boolean;
  enableDailyBackup: boolean;
  backupAt: string;
  backupTimezone: string;
  enablePush: boolean;
  pushRemote: string;
  pushBranch: string;
  registerProject: boolean;
  projectName: string;
  projectDir: string;
}

export interface ApplyInitChoicesPorts {
  configFile: string;
  /** Default Vault path under the active home, used to decide whether `vaultOption` is preserved verbatim. */
  defaultVaultPath: string;
  existingConfiguration(): ExistingConfigurationState;
  vaultExists(path: string): boolean;
  initialize(options: InitOptions): Result<InitResult, AppError>;
  configuredVaultOpens(): boolean;
  configureBackup(
    input:
      | { action: "enable"; asUser: true; dailyAt: string; timezone: string }
      | { action: "enable-push"; asUser: true; remote: string; branch: string },
  ): Result<unknown, AppError>;
  addProject(input: { name: string; dir: string }): Result<
    {
      project: { slug: string; displayName: string };
      binding: { bindingKind: string; directory: string };
    },
    AppError
  >;
  installService(): Result<{ plistPath: string; bootstrapped: boolean }, AppError>;
  startDaemon(): { ok: true } | { ok: false; exitCode: number };
}

export type ApplyInitChoicesOutcome =
  | { kind: "declined-missing-vault"; vaultPath: string }
  | { kind: "error"; error: AppError; recoveryOverride?: string | undefined }
  | { kind: "daemon-start-failed"; exitCode: number }
  | { kind: "already-initialized"; init: InitResult; vaultOpens?: boolean | undefined }
  | {
      kind: "completed";
      created: boolean;
      init: InitResult;
      backup?: { enabled: true; at: string; timezone: string } | undefined;
      push?: { remote: string; branch: string } | undefined;
      project?: { slug: string; displayName: string; bindingKind: string; binding: string } | undefined;
      service?:
        | {
            label: "xyz.rootkernel.sorage";
            plistPath: string;
            bootstrapped: boolean;
            subsumedStartDaemon: boolean;
          }
        | undefined;
      daemonStarted?: boolean | undefined;
    };

/**
 * Applies one confirmed set of init choices (INIT-004, section 3.1 and 3.2): base
 * installation first, then optional pieces in configuration order — backup schedule,
 * remote push, first Project, LaunchAgent, and daemon start — so a failure reports
 * exactly where the sequence stopped and the CLI remains a pure renderer.
 */
export function applyInitChoices(
  ports: ApplyInitChoicesPorts,
  input: {
    choices: InitChoicesInput;
    vaultOption: string | undefined;
    reconfigure?: boolean | undefined;
    probeVaultOpens?: boolean | undefined;
  },
): ApplyInitChoicesOutcome {
  const { choices, vaultOption } = input;
  const reconfigure = input.reconfigure === true;
  const wizardDefault = vaultOption ?? ports.defaultVaultPath;
  const vaultForUseCase = choices.vaultPath === wizardDefault ? vaultOption : choices.vaultPath;

  const existing = ports.existingConfiguration();
  if (existing === "unreadable" || existing === "unsafe-path") {
    const message =
      existing === "unsafe-path"
        ? `The configuration path ${ports.configFile} is not a regular file.`
        : `The configuration at ${ports.configFile} cannot be read.`;
    const recovery = existing === "unsafe-path" ? CONFIG_PATH_REPAIR : CONFIG_ACCESS_REPAIR;
    return {
      kind: "error",
      error: { code: "CONFIG_INVALID", message, recovery: { suggestedCommand: recovery } },
    };
  }

  if (!choices.createVault && !ports.vaultExists(choices.vaultPath)) {
    return { kind: "declined-missing-vault", vaultPath: choices.vaultPath };
  }

  const result = ports.initialize({
    vaultPath: vaultForUseCase,
    reconfigure,
    initializeGit: choices.initializeGit,
    serverPort: choices.serverPort,
  });
  if (!result.ok) {
    return {
      kind: "error",
      error: result.error,
      recoveryOverride: result.error.code === "CONFIG_INVALID" ? "sorage doctor" : undefined,
    };
  }

  const created = result.value.outcome === "created";
  const installsServiceOnExisting = !created && reconfigure && choices.installService;
  if (!created && !installsServiceOnExisting) {
    return {
      kind: "already-initialized",
      init: result.value,
      ...(result.value.git === undefined && input.probeVaultOpens !== false
        ? { vaultOpens: ports.configuredVaultOpens() }
        : {}),
    };
  }

  let backup: { enabled: true; at: string; timezone: string } | undefined;
  let push: { remote: string; branch: string } | undefined;
  let project: { slug: string; displayName: string; bindingKind: string; binding: string } | undefined;
  let service:
    | {
        label: "xyz.rootkernel.sorage";
        plistPath: string;
        bootstrapped: boolean;
        subsumedStartDaemon: boolean;
      }
    | undefined;
  let daemonStarted: boolean | undefined;

  if (created && choices.enableDailyBackup) {
    const enabled = ports.configureBackup({
      action: "enable",
      asUser: true,
      dailyAt: choices.backupAt,
      timezone: choices.backupTimezone,
    });
    if (!enabled.ok) return { kind: "error", error: enabled.error };
    backup = { enabled: true, at: choices.backupAt, timezone: choices.backupTimezone };
  }
  if (created && choices.enablePush) {
    const configured = ports.configureBackup({
      action: "enable-push",
      asUser: true,
      remote: choices.pushRemote,
      branch: choices.pushBranch,
    });
    if (!configured.ok) return { kind: "error", error: configured.error };
    push = { remote: choices.pushRemote, branch: choices.pushBranch };
  }
  if (created && choices.registerProject) {
    const registered = ports.addProject({ name: choices.projectName, dir: choices.projectDir });
    if (!registered.ok) return { kind: "error", error: registered.error };
    project = {
      slug: registered.value.project.slug,
      displayName: registered.value.project.displayName,
      bindingKind: registered.value.binding.bindingKind,
      binding: registered.value.binding.directory,
    };
  }
  if (choices.installService) {
    const installed = ports.installService();
    if (!installed.ok) return { kind: "error", error: installed.error };
    service = {
      label: "xyz.rootkernel.sorage",
      plistPath: installed.value.plistPath,
      bootstrapped: installed.value.bootstrapped,
      subsumedStartDaemon: choices.startDaemon,
    };
  }
  if (created && choices.startDaemon && !choices.installService) {
    const started = ports.startDaemon();
    if (!started.ok) return { kind: "daemon-start-failed", exitCode: started.exitCode };
    daemonStarted = true;
  }

  return {
    kind: "completed",
    created,
    init: result.value,
    ...(backup !== undefined ? { backup } : {}),
    ...(push !== undefined ? { push } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(service !== undefined ? { service } : {}),
    ...(daemonStarted !== undefined ? { daemonStarted } : {}),
  };
}
