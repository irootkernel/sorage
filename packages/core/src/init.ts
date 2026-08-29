import { defaultConfiguration, expandConfigurationPath, type Configuration } from "./config";
import { ok, type AppError, type Result } from "./errors";
import type { Clock, IdGenerator } from "./ids";
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

export interface InitPorts {
  paths: InitPathsPort;
  userHome: string;
  clock: Clock;
  ids: IdGenerator;
  config: InitConfigStorePort;
  database: InitDatabasePort;
  vault: InitVaultPort;
  filesystem: InitFilesystemPort;
  /** From milestone 0.2, init also creates the API token at `state/api-token` (INIT-003). */
  token?: ApiTokenStorePort | undefined;
}

export interface InitOptions {
  /** The literal `--vault <path>` value; a tilde prefix is expanded for placement. */
  vaultPath?: string | undefined;
  /** `--reconfigure`: backfill missing pieces of an existing installation. */
  reconfigure?: boolean | undefined;
}

export interface InitResult {
  outcome: "created" | "already-initialized";
  installationId: string;
  /** The expanded, normalized Vault directory. */
  vaultPath: string;
  home: string;
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
      const token = ports.token?.ensure();
      if (token !== undefined && !token.ok) return token;
      const migrated = ports.database.migrate();
      if (!migrated.ok) return migrated;
      const vaultPath = expandConfigurationPath(existing.vault.path, ports.userHome, ports.paths.home);
      const vault = ports.vault.initialize(vaultPath, existing.installationId);
      if (!vault.ok) return vault;
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

  ensureHomeTree(ports);
  const token = ports.token?.ensure();
  if (token !== undefined && !token.ok) return token;
  const migrated = ports.database.migrate();
  if (!migrated.ok) return migrated;
  const vaultPath = expandConfigurationPath(config.vault.path, ports.userHome, ports.paths.home);
  const vault = ports.vault.initialize(vaultPath, installationId);
  if (!vault.ok) return vault;
  // The creating write is fenced on revision 0 so a concurrent init that won the
  // race fails with CONFIG_CONFLICT instead of silently replacing the identity.
  const written = ports.config.write(config, { revision: 0 });
  if (!written.ok) return written;
  return ok({ outcome: "created", installationId, vaultPath, home: ports.paths.home });
}

function ensureHomeTree(ports: InitPorts): void {
  ports.filesystem.ensureDirectory(ports.paths.home);
  ports.filesystem.ensureDirectory(ports.paths.stateDir);
  ports.filesystem.ensureDirectory(ports.paths.logsDir);
  ports.filesystem.ensureDirectory(ports.paths.runDir);
}
