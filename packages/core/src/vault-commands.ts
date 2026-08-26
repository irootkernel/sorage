import { appError, err, ok, type AppError, type Result } from "./errors";
import type { ArtifactStore } from "./artifacts";
import { verifyVaultArtifacts } from "./artifact-integrity";
import type { DrainReport } from "./intent-log";
import { checkVaultContainment } from "./import-policy";
import type { VaultMarker } from "./vault";

/**
 * The Vault command use cases (CFG-013, CFG-014, RUN-014, VLT-019, CLI-019):
 * status reports path, marker, counts, and sizes; verify names every missing or
 * mismatched Artifact and never repairs; move relocates the Vault under
 * `vault-move.lock` through the ten-step sequence of section 7, so a failure
 * before the configuration switch leaves the original Vault active and a retry
 * tolerates the scratch a failed attempt left behind.
 */
export interface OpenedVaultInfo {
  marker: VaultMarker;
  layoutProblems: string[];
}

export interface VaultFileStats {
  count: number;
  bytes: number;
}

export interface VaultStatusPorts {
  vaultPath: string;
  openVault(): Result<OpenedVaultInfo, AppError>;
  artifactsStats(): Result<VaultFileStats, AppError>;
  stagingStats(): Result<VaultFileStats, AppError>;
  pendingIntentCount(): Result<number, AppError>;
}

export interface VaultStatusReport {
  path: string;
  marker: VaultMarker;
  layoutProblems: string[];
  counts: { artifacts: number; stagedFiles: number; pendingIntents: number };
  sizes: { artifactsBytes: number; stagingBytes: number };
}

export function vaultStatus(ports: VaultStatusPorts): Result<VaultStatusReport, AppError> {
  const opened = ports.openVault();
  if (!opened.ok) return err(opened.error);
  const artifacts = ports.artifactsStats();
  if (!artifacts.ok) return err(artifacts.error);
  const staging = ports.stagingStats();
  if (!staging.ok) return err(staging.error);
  const pendingIntents = ports.pendingIntentCount();
  if (!pendingIntents.ok) return err(pendingIntents.error);
  return ok({
    path: ports.vaultPath,
    marker: opened.value.marker,
    layoutProblems: opened.value.layoutProblems,
    counts: {
      artifacts: artifacts.value.count,
      stagedFiles: staging.value.count,
      pendingIntents: pendingIntents.value,
    },
    sizes: { artifactsBytes: artifacts.value.bytes, stagingBytes: staging.value.bytes },
  });
}

export interface VaultVerifyPorts extends VaultStatusPorts {
  artifactStore: ArtifactStore;
  /** The configured `gc.graceHours`, for the staging grace-window finding. */
  graceHours: number;
  /** The recorded current Artifacts; empty while the TASK-027 registry is absent. */
  recordedArtifacts(): Result<Array<{ storageKey: string; sha256: string }>, AppError>;
  /** One entry per staged file with its age, for the grace-window finding. */
  stagingEntries(): Result<Array<{ name: string; mtimeMs: number }>, AppError>;
}

export interface VaultVerifyReport {
  findings: string[];
  checked: { artifacts: number; recordedArtifacts: number; stagedFiles: number };
}

export function vaultVerify(ports: VaultVerifyPorts, options: { now: Date }): Result<VaultVerifyReport, AppError> {
  const opened = ports.openVault();
  if (!opened.ok) return err(opened.error);
  const findings = [...opened.value.layoutProblems];
  const recorded = ports.recordedArtifacts();
  if (!recorded.ok) return err(recorded.error);
  const integrity = verifyVaultArtifacts({ artifactStore: ports.artifactStore }, recorded.value);
  if (!integrity.ok) return err(integrity.error);
  findings.push(...integrity.value.map((finding) => finding.message));
  const cutoffMs = options.now.getTime() - ports.graceHours * 3_600_000;
  const entries = ports.stagingEntries();
  if (!entries.ok) return err(entries.error);
  for (const entry of entries.value) {
    if (entry.mtimeMs < cutoffMs) {
      findings.push(`staging/${entry.name} is older than the gc.graceHours window.`);
    }
  }
  // The on-disk census, next to the recorded count, so the two diverge visibly
  // when files exist that no row names.
  const onDisk = ports.artifactsStats();
  if (!onDisk.ok) return err(onDisk.error);
  return ok({
    findings,
    checked: {
      artifacts: onDisk.value.count,
      recordedArtifacts: recorded.value.length,
      stagedFiles: entries.value.length,
    },
  });
}

export interface VaultMovePorts {
  vaultPath: string;
  targetPath: string;
  installationId: string;
  /** Physically resolved spellings (nearest existing ancestor), for alias-proof containment. */
  resolvedVaultPath: string;
  resolvedTargetPath: string;
  /** Validates one directory as this Installation's Vault (VLT-019). */
  openVault(path: string): Result<OpenedVaultInfo, AppError>;
  /** Resolved Project binding directories for the containment check (VLT-017). */
  bindingDirectories(): Result<string[], AppError>;
  /**
   * Drains outstanding intents as the lock owner, after the lock is acquired and
   * before the copy begins, so a promise committed just before the lock cannot
   * survive the switch as a false integrity failure in the relocated Vault.
   */
  drainUnderLock(): Result<DrainReport, AppError>;
  lock: {
    /** Acquires vault-move.lock; a live holder fails with SERVICE_PAUSED (RUN-014). */
    acquire(): Result<{ release: () => void }, AppError>;
  };
  target: {
    /** Validates the target and prepares its directories, clearing scratch a failed attempt left behind. */
    prepare(): Result<{ reusedScratch: boolean }, AppError>;
    /** Relative paths of every managed file under the source artifacts/ tree. */
    managedFiles(): Result<string[], AppError>;
    /** Copies one managed file into the target's staging area, hashing in the same pass. */
    stageCopy(relativePath: string): Result<{ stagedPath: string; sha256: string }, AppError>;
    /** Recomputes the source file's SHA-256 for the copy verification of step 6. */
    sourceChecksum(relativePath: string): Result<string, AppError>;
    /** Moves a staged copy to its managed path in the target and fsyncs the parent directory. */
    activate(relativePath: string, stagedPath: string): Result<void, AppError>;
    /** Writes the marker with the same installationId and the policy files (VLT-024). */
    finalize(): Result<void, AppError>;
  };
  config: {
    current(): Result<{ vaultPath: string; etag: string }, AppError>;
    /** Atomically switches vault.path fenced on the etag the move read (CFG-014). */
    updateVaultPath(nextPath: string, etag: string): Result<void, AppError>;
  };
  /** Emits the VAULT_MOVED audit event; the ledger append lands with TASK-028. */
  emitMoved(fromPath: string, toPath: string, artifactsMoved: number): void;
  /** Test seam for the injected mid-move failure of AJ-09. */
  afterStagedCopy?: ((relativePath: string) => void) | undefined;
}

/**
 * The ten-step relocation of section 7: validate the source marker, validate the
 * target and its containment against Project bindings, acquire the lock, copy
 * the managed content into the target's staging area, verify every checksum,
 * activate the copies, write the target marker and policy files, switch
 * `vault.path` atomically, and release. Any failure before the configuration
 * switch leaves the original Vault active and the configuration untouched, so
 * exactly one usable Vault exists; the old Vault is retained after success.
 */
export function moveVault(
  ports: VaultMovePorts,
): Result<{ fromPath: string; toPath: string; artifactsMoved: number; event: "VAULT_MOVED" }, AppError> {
  const source = ports.openVault(ports.vaultPath);
  if (!source.ok) return err(source.error);

  // The target may never be the current Vault or live inside it, and the
  // current Vault may never live inside the target: either layout would make
  // the move copy its own scratch and pollute the retained original. The
  // comparison runs on physically resolved spellings, so an alias such as a
  // symlink or a /private prefix cannot slip a nested target past it.
  if (
    ports.resolvedTargetPath === ports.resolvedVaultPath ||
    ports.resolvedTargetPath.startsWith(`${ports.resolvedVaultPath}/`) ||
    ports.resolvedVaultPath.startsWith(`${ports.resolvedTargetPath}/`)
  ) {
    return err(
      appError(
        "VAULT_CONTAINMENT",
        `The move target ${ports.targetPath} and the current Vault ${ports.vaultPath} would contain one another.`,
        {
          resolvedVaultPath: ports.resolvedTargetPath,
          currentVaultPath: ports.resolvedVaultPath,
          side: "move-target-overlaps-source",
        },
      ),
    );
  }

  const bindings = ports.bindingDirectories();
  if (!bindings.ok) return err(bindings.error);
  const contained = checkVaultContainment({
    resolvedVaultPath: ports.resolvedTargetPath,
    resolvedBindingDirectories: bindings.value,
  });
  if (!contained.ok) return err(contained.error);

  const lock = ports.lock.acquire();
  if (!lock.ok) return err(lock.error);

  // As the lock owner, finish every outstanding promise against the source
  // Vault before copying it; a Vault whose intents cannot resolve is not
  // relocatable, and running this drain now means no committed promise can
  // outlive the switch as a false integrity failure.
  const preDrain = ports.drainUnderLock();
  if (!preDrain.ok) {
    lock.value.release();
    return err(preDrain.error);
  }
  if (preDrain.value.integrityFailed.length > 0) {
    lock.value.release();
    return err(
      appError(
        "INTERNAL_ERROR",
        `The Vault has ${preDrain.value.integrityFailed.length} unresolved filesystem intent(s); run sorage vault verify and resolve them before relocating.`,
        { unresolvedIntents: preDrain.value.integrityFailed.length },
      ),
    );
  }

  let staged: Array<{ relativePath: string; stagedPath: string; sha256: string }> = [];
  let activated = 0;
  try {
    const prepared = ports.target.prepare();
    if (!prepared.ok) return err(prepared.error);

    const files = ports.target.managedFiles();
    if (!files.ok) return err(files.error);
    staged = [];
    for (const relativePath of files.value) {
      const copy = ports.target.stageCopy(relativePath);
      if (!copy.ok) return err(copy.error);
      staged.push({ relativePath, stagedPath: copy.value.stagedPath, sha256: copy.value.sha256 });
      if (ports.afterStagedCopy !== undefined) ports.afterStagedCopy(relativePath);
    }
    // A concurrent process may have renamed a file into the source after the
    // listing; re-list and refuse to switch when the managed set moved, so the
    // relocation's every-byte contract cannot pass on a stale census.
    const relisted = ports.target.managedFiles();
    if (!relisted.ok) return err(relisted.error);
    if (JSON.stringify([...relisted.value].sort()) !== JSON.stringify([...files.value].sort())) {
      return err(
        appError("INTERNAL_ERROR", "The managed file set changed during the move; the original Vault stays active.", {
          listed: files.value.length,
          relisted: relisted.value.length,
        }),
      );
    }
    for (const entry of staged) {
      const expected = ports.target.sourceChecksum(entry.relativePath);
      if (!expected.ok) return err(expected.error);
      if (expected.value.toLowerCase() !== entry.sha256.toLowerCase()) {
        return err(
          appError(
            "ARTIFACT_CORRUPTED",
            `The copied bytes for ${entry.relativePath} do not match the source during the move.`,
            { relativePath: entry.relativePath },
          ),
        );
      }
    }
    for (const entry of staged) {
      const placed = ports.target.activate(entry.relativePath, entry.stagedPath);
      if (!placed.ok) return err(placed.error);
      activated++;
    }
    const finalized = ports.target.finalize();
    if (!finalized.ok) return err(finalized.error);

    const current = ports.config.current();
    if (!current.ok) return err(current.error);
    if (current.value.vaultPath !== ports.vaultPath) {
      return err(
        appError("CONFIG_CONFLICT", "The Vault path changed while the move was running.", {
          expected: ports.vaultPath,
          actual: current.value.vaultPath,
        }),
      );
    }
    const switched = ports.config.updateVaultPath(ports.targetPath, current.value.etag);
    if (!switched.ok) return err(switched.error);
  } catch (error) {
    // An unexpected throw mid-move (an injected failure, an fs surprise) keeps
    // the original Vault active and the configuration untouched, because the
    // switch has not run; it surfaces as one typed error.
    return err(
      appError("INTERNAL_ERROR", `The Vault move failed before the configuration switch: ${messageOf(error)}.`, {
        cause: String(error),
      }),
    );
  } finally {
    lock.value.release();
  }

  ports.emitMoved(ports.vaultPath, ports.targetPath, activated);
  return ok({ fromPath: ports.vaultPath, toPath: ports.targetPath, artifactsMoved: activated, event: "VAULT_MOVED" });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
