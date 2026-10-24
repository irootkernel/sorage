import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type AppError, appError, err, expandConfigurationPath, ok, type Result } from "@sorage/core";
import { createConfigStore } from "./config-store";
import { createHomePaths, type HomeEnvironment, type HomePaths } from "./home";
import { createNodeLockProbePorts, vaultMoveLockHeld, vaultMovePauseRefusal } from "./lockfile";
import type { ContentionSurface } from "./storage-contention";
import { type CoveredReadConnection, openCoveredReadConnection } from "./sqlite/read-admission";
import { openVault } from "./vault";

/**
 * The composition entry of the covered zero-write reads (RDR-001, RDR-002):
 * the CLI opens storage here, injects the returned connection into the
 * existing domain port factories through their `database` seam, and closes it
 * when the command ends. Nothing on this path drains intents, migrates,
 * sweeps a spool, cleans up, or writes a log; the initialization gate is the
 * same operational configuration read every composition performs, and the
 * storage state matrix lives in the shared primitive.
 *
 * `vaultAdmission` preserves, read-only and write-free, exactly the admission
 * sequence a covered read's pre-Task path performed: the Memo reads' startup
 * drain checked the vault-move fence and then opened the Vault before serving,
 * so the covered Memo reads keep both checks with their existing refusal
 * envelopes — `SERVICE_PAUSED` under a live `vault-move.lock`, then
 * `openVault`'s state-specific refusal (RDR-005 keeps the existing exits;
 * `vaultMoveLockHeld` only reads the lock and probes the pid, and `openVault`
 * writes nothing). The Handoff and Project reads never ran the drain and pass
 * no flag.
 */

export interface CoveredReadStorageOptions {
  env?: HomeEnvironment | undefined;
  userHome?: string | undefined;
  /**
   * The invoking command family whose stamped refusal a storage-state failure
   * carries (SHR-015); the Memo composition has no surface and keeps its
   * existing unclassified `INTERNAL_ERROR` for residual failures.
   */
  surface?: ContentionSurface | undefined;
  /**
   * Perform the read-only vault-move fence check and Vault admission after
   * storage opens. Reserved for the covered reads whose pre-Task path made
   * these checks (today the Memo reads, through their drain); callers whose
   * path did not must not pass this.
   */
  vaultAdmission?: boolean;
}

export interface CoveredReadStorage extends CoveredReadConnection {
  home: HomePaths;
  databasePath: string;
}

export function openCoveredReadStorage(options: CoveredReadStorageOptions = {}): Result<CoveredReadStorage, AppError> {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const config = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
  const read = config.readForOperation();
  if (!read.ok) return err(read.error);
  if (read.value === null) {
    return err(
      appError("NOT_INITIALIZED", "Sorage has not been initialized.", { expectedConfigPath: home.configFile }),
    );
  }
  const databasePath = resolve(home.stateDir, "sorage.sqlite3");
  const connection = openCoveredReadConnection(databasePath, options.surface);
  if (!connection.ok) return err(connection.error);
  if (options.vaultAdmission === true) {
    // The pre-Task drain's order, kept read-only: the vault-move fence first,
    // then the Vault admission. `vaultMoveLockHeld` reads the lock and probes
    // the pid; the shared refusal builder keeps the drain's envelope verbatim.
    if (vaultMoveLockHeld(home.runDir)) {
      connection.value.close();
      return err(vaultMovePauseRefusal(join(home.runDir, "vault-move.lock")));
    }
    // The same expanded path and installation identity the drain's admission
    // used; the refusal keeps openVault's state-specific recovery verbatim.
    const vaultPath = expandConfigurationPath(read.value.config.vault.path, userHome, home.home);
    const vault = openVault(vaultPath, read.value.config.installationId);
    if (!vault.ok) {
      connection.value.close();
      return err(vault.error);
    }
  }
  return ok({ ...connection.value, home, databasePath });
}
