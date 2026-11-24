import { buildStorageKey, isManagedStorageKey, isValidStorageKeySegment } from "../content/artifacts";
import { isCanonicalUuid } from "../primitives/identity";
import { type AppError, appError, err, ok, type Result } from "../shared/errors";
import type { VaultMarker } from "../vault/vault";
import { type SnapshotArtifact, type SnapshotData, snapshotCounts } from "./snapshot/backup-snapshot";
import { validateSnapshotChannelContent, validateSnapshotChannelHistory } from "./snapshot/channel-snapshot";
import {
  classifySnapshotArtifactBody,
  classifySnapshotEvent,
  type SnapshotArtifactV3,
  type SnapshotDataV3,
  validateSnapshotCommonEvent,
  validateSnapshotHandoffV3,
  validateSnapshotMemoContent,
  validateSnapshotProjectV3,
} from "./snapshot/content-snapshot";
import { type SnapshotDataV5, validateExchangeInventory } from "./snapshot/exchange-snapshot";
import {
  reportingSnapshotDataBase,
  type SnapshotDataV4,
  type SnapshotHandoffV4,
  validateReportingSnapshotEvent,
  validateSnapshotHandoffV4,
} from "./snapshot/handoff-reporting-snapshot";
import {
  parseMemoEventAssociation,
  type VersionedSnapshotManifest,
  validateMemoInventory,
} from "./snapshot/memo-snapshot";

/**
 * The TASK-052 restore use case (BKP-005, BKP-021, BKP-023, BKP-024, VLT-019,
 * RUN-014, SEC-011, SEC-014): `backupRestore` is the audited importer that
 * rebuilds an empty installation from a Vault copy, adopts the marker's
 * `installationId`, and never invents redacted local paths back.
 */

export interface RestorePlan {
  dryRun: true;
  sourcePath: string;
  adoptedInstallationId: string;
  wouldCreate: { projects: number; handoffs: number; reviewNotes: number; artifacts: number; events: number };
}

export interface RestoreOutcome {
  dryRun: false;
  sourcePath: string;
  adoptedInstallationId: string;
  restored: { projects: number; handoffs: number; reviewNotes: number; artifacts: number; events: number };
  /** Bindings are machine-local and never restored; the User re-binds (section 32). */
  bindingsRestored: 0;
  events: ["VAULT_ADOPTED", "RESTORE_COMPLETED"];
  apiTokenRegenerated: true;
}

export type BackupSnapshotData = SnapshotData | SnapshotDataV3 | SnapshotDataV4 | SnapshotDataV5;

export interface BackupRestorePorts {
  sourcePath: string;
  installationId: string;
  /** True while a daemon holds its lifetime lock; restore requires it stopped (section 32). */
  daemonRunning(): Result<boolean, AppError>;
  /** `vault-move.lock`, so every other storage mutation pauses with SERVICE_PAUSED (RUN-014). */
  lock: {
    acquire(): Result<{ release: () => void }, AppError>;
  };
  /** Parses the source Vault marker; a newer schemaVersion is VAULT_SCHEMA_UNSUPPORTED (VLT-019). */
  readSourceMarker(): Result<VaultMarker, AppError>;
  /** Reads and parses `snapshots/` from the source Vault into one snapshot set. */
  readSourceSnapshot(): Result<BackupSnapshotData, AppError>;
  /** Cross-checks the manifest counts against the parsed snapshot (BKP-005). */
  readSourceManifest(): Result<VersionedSnapshotManifest, AppError>;
  /**
   * Optional single-pass reader that parses and validates the source manifest
   * and snapshot once; when supplied, `backupRestore` avoids re-reading the
   * manifest and re-running `validateSnapshot`.
   */
  readValidatedSourceSnapshot?(): Result<
    { data: BackupSnapshotData; manifest: VersionedSnapshotManifest; reviewNotes: number },
    AppError
  >;
  /** False once any domain row or ledger row exists; the empty rule of section 32 (BKP-021). */
  targetIsEmpty(): Result<boolean, AppError>;
  /**
   * Hashes every materialized Artifact's source bytes against its recorded
   * SHA-256; a missing file or one altered byte is ARTIFACT_CORRUPTED and
   * aborts the restore (SEC-014, VLT-023).
   */
  verifyArtifacts(data: BackupSnapshotData): Result<{ verified: number }, AppError>;
  /** Copies Artifact bytes into the target Vault, re-verifying in pass and setting 0444. */
  copyArtifacts(data: BackupSnapshotData): Result<{ copied: number }, AppError>;
  /** Rewrites the target Vault marker with the adopted installationId (VLT-019). */
  adoptMarker(marker: VaultMarker): Result<void, AppError>;
  /** Adopts the installationId in config.yaml, fenced on the etag that was read. */
  adoptInstallationId(installationId: string): Result<void, AppError>;
  /**
   * Rebuilds Projects, Handoffs, Review Notes, deletion requests, and the
   * exported ledger verbatim in one write transaction, swaps the installation
   * identity, and appends VAULT_ADOPTED followed by RESTORE_COMPLETED.
   */
  rebuildDatabase(data: BackupSnapshotData, marker: VaultMarker): Result<void, AppError>;
  /** Regenerates the API token; it is the only credential restore creates (BKP-021). */
  regenerateApiToken(): Result<void, AppError>;
}

function snapshotProblem(message: string): Result<never, AppError> {
  return err(appError("VAULT_INTEGRITY_ERROR", message));
}

/**
 * Validates the internal consistency restore depends on before any write:
 * every Project reference resolves, the ledger only names known Handoffs, the
 * manifest counts match what was parsed, and the format-3 record families stay
 * inside what this schema can faithfully import — a recognized later
 * representation fails closed with `VAULT_SCHEMA_UNSUPPORTED` before import
 * rather than as corruption, partial restore, fallback, or silent omission,
 * while a malformed record of a supported family, the Channel family included
 * with its shards, content inventory, and complete ledger reconciliation at
 * TASK-109, fails as `VAULT_INTEGRITY_ERROR` — so a truncated or hand-edited
 * snapshot fails before the rebuild rather than as a foreign-key error
 * halfway through it.
 */
export function validateSnapshot(
  input: BackupSnapshotData,
  manifest: VersionedSnapshotManifest,
): Result<{ reviewNotes: number }, AppError> {
  if (manifest.formatVersion === 5) {
    if (!("exchanges" in input)) return snapshotProblem("A format-5 snapshot must provide an Exchange inventory.");
    const { exchanges, ...previous } = input;
    const valid = validateExchangeInventory(
      exchanges,
      previous.projects,
      manifest.counts.exchanges,
      input.exchangeRepresentation,
    );
    if (!valid.ok) return valid;
    const { exchanges: _exchangeCount, ...counts } = manifest.counts;
    return validateSnapshot(previous, { ...manifest, counts, formatVersion: 4 });
  }
  if ("exchanges" in input) return snapshotProblem("A legacy snapshot cannot contain Exchange records.");
  if (manifest.formatVersion === 4) {
    const handoffsById = new Map<string, SnapshotHandoffV4>();
    for (const handoff of input.handoffs) {
      const shape = validateSnapshotHandoffV4(handoff);
      if (!shape.ok) return shape;
      const typed = handoff as SnapshotHandoffV4;
      if (!handoffsById.has(typed.id)) handoffsById.set(typed.id, typed);
    }
    for (const event of input.events) {
      const valid = validateReportingSnapshotEvent(event, handoffsById);
      if (!valid.ok) return valid;
    }
  }
  const data =
    manifest.formatVersion === 4
      ? reportingSnapshotDataBase(input as SnapshotDataV4)
      : (input as SnapshotData | SnapshotDataV3);

  if (manifest.formatVersion === 3 || manifest.formatVersion === 4) {
    const content = validateSnapshotMemoContent(data as SnapshotDataV3, manifest.contentDigests);
    if (!content.ok) return content;
    // The Channel family joins the format-3 inventory at TASK-109 (SHR-010,
    // section 38.9): the manifest's Channel count, the globally unique record
    // identities, the closed shard contracts, the exact Memo-and-Channel
    // content inventory with the whole-bytes body proofs, and the complete
    // Channel-domain ledger reconciliation all run before any association,
    // count, or adoption step can accept the snapshot.
    const channelContent = validateSnapshotChannelContent(data as SnapshotDataV3, manifest);
    if (!channelContent.ok) return channelContent;
    const channelHistory = validateSnapshotChannelHistory(data.events, (data as SnapshotDataV3).channels ?? []);
    if (!channelHistory.ok) return channelHistory;
    const ids = new Set<string>();
    const slugs = new Set<string>();
    for (const project of data.projects) {
      const shape = validateSnapshotProjectV3(project);
      if (!shape.ok) return shape;
      if (ids.has(project.id) || slugs.has(project.slug.replace(/[A-Z]/g, (letter) => letter.toLowerCase())))
        return snapshotProblem("The format-3 snapshot repeats a Project identity or slug.");
      ids.add(project.id);
      slugs.add(project.slug.replace(/[A-Z]/g, (letter) => letter.toLowerCase()));
    }
  }
  const memoInventory = validateMemoInventory(data, manifest);
  if (!memoInventory.ok) return memoInventory;
  const projectIds = new Set(data.projects.map((project) => project.id));
  for (const handoff of data.handoffs) {
    if (manifest.formatVersion === 3 || manifest.formatVersion === 4) {
      const shape = validateSnapshotHandoffV3(handoff);
      if (!shape.ok) return shape;
    }
    if (!isValidStorageKeySegment(handoff.id)) {
      return snapshotProblem(`Handoff ${String(handoff.id)} has an invalid identifier.`);
    }
    if (handoff.artifact !== null) {
      const artifact = handoff.artifact as SnapshotArtifact | SnapshotArtifactV3;
      if (
        typeof artifact !== "object" ||
        !isValidStorageKeySegment(artifact.id) ||
        artifact.handoffId !== handoff.id ||
        !isValidStorageKeySegment(artifact.storedName) ||
        !Number.isSafeInteger(artifact.sizeBytes) ||
        artifact.sizeBytes < 0 ||
        !/^[0-9a-f]{64}$/i.test(artifact.sha256) ||
        typeof artifact.materialized !== "boolean"
      ) {
        return snapshotProblem(`Handoff ${handoff.id} carries a malformed Artifact record.`);
      }
      const raw = artifact as unknown as Record<string, unknown>;
      if (manifest.formatVersion === 3 || manifest.formatVersion === 4) {
        // Format 3 accepts both closed representations of section 38.8: the
        // file-backed baseline and this build's inline body, whose exact
        // stored text the shape validator already matched against the
        // recorded size and digest.
        const classified = classifySnapshotArtifactBody(raw);
        if (!classified.ok) return classified;
      } else if (Object.hasOwn(raw, "inlineBody")) {
        // Formats 1 and 2 keep their frozen closed Artifact shapes: the
        // explicit containing field of format 3 is an unknown field there.
        return snapshotProblem(
          `Handoff ${handoff.id} carries an Artifact record with a field this snapshot format does not define.`,
        );
      }
      if (artifact.storageKey === null) {
        // A null key exists only as a format-3 inline record: earlier formats
        // and an unclosed shape never reach this branch.
        if (manifest.formatVersion !== 3 && manifest.formatVersion !== 4) {
          return snapshotProblem(`Handoff ${handoff.id} carries a malformed Artifact record.`);
        }
      } else {
        if (!isManagedStorageKey(artifact.storageKey)) {
          return snapshotProblem(`Handoff ${handoff.id} carries a malformed Artifact record.`);
        }
        const canonical = buildStorageKey({
          handoffId: handoff.id,
          artifactId: artifact.id,
          storedName: artifact.storedName,
        });
        if (!canonical.ok || artifact.storageKey !== canonical.value) {
          return snapshotProblem(
            `Artifact ${artifact.id} has storageKey ${artifact.storageKey}, which does not match its Handoff, Artifact, and stored-name identity.`,
          );
        }
      }
      if (handoff.currentArtifactId !== artifact.id) {
        return snapshotProblem(
          `Handoff ${handoff.id} names current Artifact ${String(handoff.currentArtifactId)} but carries ${artifact.id}.`,
        );
      }
    } else if (handoff.currentArtifactId !== null) {
      return snapshotProblem(
        `Handoff ${handoff.id} names current Artifact ${String(handoff.currentArtifactId)} but carries no Artifact record.`,
      );
    }
    if (handoff.recipientProjectId !== null && !projectIds.has(handoff.recipientProjectId)) {
      return snapshotProblem(
        `Handoff ${handoff.id} names recipient project ${handoff.recipientProjectId}, which the snapshot does not contain.`,
      );
    }
    if (handoff.senderProjectId !== null && !projectIds.has(handoff.senderProjectId)) {
      return snapshotProblem(
        `Handoff ${handoff.id} names sender project ${handoff.senderProjectId}, which the snapshot does not contain.`,
      );
    }
  }
  const handoffIds = new Set(data.handoffs.map((handoff) => handoff.id));
  const memoOwners = new Map((data.memos ?? []).map((memo) => [memo.id, memo]));
  for (const event of data.events) {
    const classification = classifySnapshotEvent(event.eventType, manifest.formatVersion);
    if (classification === "unknown") {
      return snapshotProblem("The snapshot ledger carries an event type this format does not define.");
    }
    if (manifest.formatVersion === 3 || manifest.formatVersion === 4) {
      const row = parseMemoEventAssociation(event, manifest.formatVersion, memoOwners);
      if (!row.ok) return row;
      if (
        event.actorKind === "registered_project"
          ? !isCanonicalUuid(event.actorId)
          : event.actorKind === "unregistered_workspace"
            ? typeof event.actorId !== "string"
            : event.actorId !== null
      )
        return snapshotProblem("The format-3 snapshot event does not carry its ActorRef identity.");
    }
    if (event.handoffId !== null && !handoffIds.has(event.handoffId)) {
      return snapshotProblem(
        `Ledger event ${event.id} names handoff ${event.handoffId}, which the snapshot does not contain.`,
      );
    }
    if (
      classification === "family" &&
      (manifest.formatVersion === 3 || manifest.formatVersion === 4) &&
      event.eventType.startsWith("CONTENT_")
    ) {
      if (
        event.actorKind !== "system" ||
        event.actorId !== null ||
        event.rowVersion !== null ||
        event.handoffId !== null ||
        event.memoId !== null
      ) {
        return snapshotProblem(`The ${event.eventType} snapshot event does not carry its fixed system header.`);
      }
      const common = validateSnapshotCommonEvent(event.eventType, event.metadata);
      if (!common.ok) return common;
    }
  }
  const artifactCount = data.handoffs.filter((handoff) => handoff.artifact !== null).length;
  const counts = snapshotCounts(data);
  if (
    counts.projects !== manifest.counts.projects ||
    counts.handoffs !== manifest.counts.handoffs ||
    counts.events !== manifest.counts.events ||
    artifactCount !== manifest.counts.artifacts
  ) {
    return snapshotProblem(
      `The backup manifest counts do not match the snapshot content: manifest ${JSON.stringify(manifest.counts)} against parsed ${JSON.stringify({ ...counts, artifacts: artifactCount })}.`,
    );
  }
  return ok({ reviewNotes: data.handoffs.filter((handoff) => handoff.reviewNote !== null).length });
}

/**
 * The section-32 sequence: refuse a running daemon, hold `vault-move.lock`,
 * validate the source marker and snapshot, refuse a populated target, verify
 * every checksum, and only then — never in `--dry-run` — adopt the marker and
 * configuration, rebuild the database in one transaction, and regenerate the
 * API token. The writes run in the crash-convergent order: every failure
 * before the rebuild leaves the target installation still empty, so a retry
 * converges instead of wedging between two identities.
 */
export function backupRestore(
  ports: BackupRestorePorts,
  options: { dryRun: boolean },
): Result<RestorePlan | RestoreOutcome, AppError> {
  const daemon = ports.daemonRunning();
  if (!daemon.ok) return err(daemon.error);
  if (daemon.value) {
    return err(
      appError(
        "SERVICE_PAUSED",
        "The daemon is running; sorage backup restore requires the daemon stopped, because it rebuilds storage underneath it.",
        { suggestedCommand: "sorage daemon stop" },
      ),
    );
  }

  const lock = ports.lock.acquire();
  if (!lock.ok) return err(lock.error);

  let outcome: Result<RestorePlan | RestoreOutcome, AppError>;
  try {
    outcome = restoreUnderLock(ports, options);
  } finally {
    lock.value.release();
  }
  return outcome;
}

function restoreUnderLock(
  ports: BackupRestorePorts,
  options: { dryRun: boolean },
): Result<RestorePlan | RestoreOutcome, AppError> {
  const marker = ports.readSourceMarker();
  if (!marker.ok) return err(marker.error);
  let dataValue: BackupSnapshotData;
  let reviewNotes: number;
  if (ports.readValidatedSourceSnapshot !== undefined) {
    const validated = ports.readValidatedSourceSnapshot();
    if (!validated.ok) return err(validated.error);
    dataValue = validated.value.data;
    reviewNotes = validated.value.reviewNotes;
  } else {
    const data = ports.readSourceSnapshot();
    if (!data.ok) return err(data.error);
    const manifest = ports.readSourceManifest();
    if (!manifest.ok) return err(manifest.error);
    const valid = validateSnapshot(data.value, manifest.value);
    if (!valid.ok) return err(valid.error);
    dataValue = data.value;
    reviewNotes = valid.value.reviewNotes;
  }

  const empty = ports.targetIsEmpty();
  if (!empty.ok) return err(empty.error);
  if (!empty.value) {
    return err(
      appError(
        "RESTORE_TARGET_NOT_EMPTY",
        "The target installation already holds Sorage data; restore rebuilds only an empty installation.",
        { suggestedCommand: "sorage init (in a fresh SORAGE_HOME), then sorage backup restore --from <vault-path>" },
      ),
    );
  }

  const verified = ports.verifyArtifacts(dataValue);
  if (!verified.ok) return err(verified.error);

  const plan: RestorePlan = {
    dryRun: true,
    sourcePath: ports.sourcePath,
    adoptedInstallationId: marker.value.installationId,
    wouldCreate: {
      projects: dataValue.projects.length,
      handoffs: dataValue.handoffs.length,
      reviewNotes,
      artifacts: dataValue.handoffs.filter((handoff) => handoff.artifact !== null).length,
      events: dataValue.events.length,
    },
  };
  if (options.dryRun) return ok(plan);

  const copied = ports.copyArtifacts(dataValue);
  if (!copied.ok) return err(copied.error);
  // The marker and the configuration adopt adjacent to each other and before
  // the rebuild: a crash between them leaves the target still empty of domain
  // rows, so a retry re-reads the source, re-adopts, and converges.
  const marked = ports.adoptMarker(marker.value);
  if (!marked.ok) return err(marked.error);
  const configured = ports.adoptInstallationId(marker.value.installationId);
  if (!configured.ok) return err(configured.error);
  const rebuilt = ports.rebuildDatabase(dataValue, marker.value);
  if (!rebuilt.ok) return err(rebuilt.error);
  const token = ports.regenerateApiToken();
  if (!token.ok) return err(token.error);

  return ok({
    ...plan,
    dryRun: false,
    restored: plan.wouldCreate,
    bindingsRestored: 0,
    events: ["VAULT_ADOPTED", "RESTORE_COMPLETED"],
    apiTokenRegenerated: true,
  });
}
