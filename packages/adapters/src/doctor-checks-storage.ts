import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type AppError,
  appError,
  type CheckOutcome,
  isManagedContentStorageKey,
  isManagedStorageKey,
  KNOWN_SCHEMA_HISTORY,
  type Result,
  verifyVaultArtifacts,
} from "@sorage/core";
import { createNodeArtifactStore } from "./artifact-store";
import {
  inspectArtifactStorageLayout,
  validateArtifactContentLinks,
  validateChannelContentLinks,
  validateMemoContentLinks,
} from "./content-layout";
import type { DoctorContext } from "./doctor-context";
import { blocking, ok, warning, withRecovery } from "./doctor-recoveries";
import { evaluateStaleness, isPidAlive, parseLockRecord } from "./lockfile";
import { digestManagedFile } from "./managed-paths";

/**
 * The `content.checksums` census (SHR-011, section 35): every live content
 * record's bytes match its recorded SHA-256 — an inline record by recomputing
 * the digest over its stored text, a file-backed record by recomputing it over
 * the bytes at the managed key. Read-only, never repairing.
 */
function verifyContentRecords(
  ports: { vault: string; fileDigestCache?: Map<string, string> },
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
        const cacheKey = `${ports.vault}\0${record.storage_key}`;
        let recomputed = ports.fileDigestCache?.get(cacheKey);
        if (recomputed === undefined) {
          recomputed = digestManagedFile(ports.vault, record.storage_key).sha256;
          ports.fileDigestCache?.set(cacheKey, recomputed);
        }
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

export const storageDoctorChecks: Record<
  "db.integrity" | "db.pendingIntents" | "db.migrations" | "artifacts.checksums" | "content.checksums",
  (context: DoctorContext) => CheckOutcome
> = {
  "db.integrity"(context) {
    try {
      const checked = context.withDoctorDb((db) => {
        const integrity = db.prepare("PRAGMA integrity_check").get() as unknown;
        const row = integrity as Record<string, unknown> | undefined;
        const verdict = row === undefined ? undefined : row.integrity_check;
        const journal = (db.prepare("PRAGMA journal_mode").get() as Record<string, unknown> | undefined)?.journal_mode;
        const foreignKeys = (db.prepare("PRAGMA foreign_keys").get() as Record<string, unknown> | undefined)
          ?.foreign_keys;
        if (verdict !== "ok") return blocking(`PRAGMA integrity_check reported: ${String(verdict)}`);
        if (journal !== "wal") return blocking(`The database journal mode is ${String(journal)}, expected wal.`);
        if (foreignKeys !== 1) return blocking("Foreign keys are not enabled on this build's connections.");
        return ok("The database passes integrity_check in WAL mode with foreign keys enabled.");
      });
      return checked.ok ? checked.value : blocking(checked.blocking);
    } catch (error) {
      return blocking(
        `The database could not be opened or checked: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },

  "db.pendingIntents"(context) {
    try {
      const checked = context.withDoctorDb((db) => {
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
      });
      return checked.ok ? checked.value : blocking(checked.blocking);
    } catch (error) {
      return blocking(`pending_fs_ops could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  "db.migrations"(context) {
    // A supported maximum whose known history has a malformed finding gets
    // reported here as the stable blocking diagnostic — not as a typed
    // integrity refusal of the whole command — while the other supported
    // diagnostics continue through their own opens.
    const admissionState = context.establishAdmission();
    if (admissionState.kind === "known-history-finding") {
      return blocking(admissionState.message);
    }
    try {
      const checked = context.withDoctorDb((db) => {
        const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
          | Record<string, unknown>
          | undefined;
        const expected = KNOWN_SCHEMA_HISTORY[KNOWN_SCHEMA_HISTORY.length - 1]?.version ?? 0;
        if (row?.version !== expected) {
          return blocking(`schema_migrations is at ${String(row?.version)}, expected ${expected}.`);
        }
        return null;
      });
      if (!checked.ok) return blocking(checked.blocking);
      if (checked.value !== null) return checked.value;
    } catch (error) {
      return blocking(`schema_migrations could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The transactional runner never acquires the legacy run/migration.lock
    // file (NFR-009 as resolved by M9, architecture section 19): a live-looking
    // owner means an older executable may still be running against this home,
    // and stale evidence is preserved for manual removal, never deleted here.
    let lockBody: string;
    try {
      lockBody = readFileSync(context.home.lockFile("migration"), "utf8");
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
  },

  "artifacts.checksums"(context) {
    const state = context.configurationState();
    const config = state.kind === "valid" ? state.config : null;
    const vault = context.vaultPath(config);
    if (config === null || vault === null) {
      return withRecovery(
        blocking("Artifact checksums cannot be checked without a valid configuration."),
        context.configurationRecovery(state),
      );
    }
    try {
      const loaded = context.withDoctorDb((db) => {
        // The shared content-link guard runs before any census filter: an
        // Artifact whose authoritative record row is missing must surface as
        // a blocking finding, never as a false healthy empty census (SHR-004,
        // SEC-014, section 35).
        const links = validateArtifactContentLinks(db);
        if (!links.ok) {
          return { kind: "blocked" as const, message: links.error.message };
        }
        const layout = inspectArtifactStorageLayout(db);
        let records: Array<{ storage_key: string | null; inline_text: string | null; sha256: string }> = [];
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
        return { kind: "records" as const, records };
      });
      if (!loaded.ok) return blocking(loaded.blocking);
      if (loaded.value.kind === "blocked") return blocking(loaded.value.message);
      const { records } = loaded.value;
      if (records.length === 0) return ok("No Artifacts are recorded yet on this installation.");
      // A Vault that cannot open is reported as that refusal, never as
      // missing Artifact bytes (TASK-118, section 3.4).
      const openedVault = context.vaultState();
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
      // Cache only successful SHA-256 digests so `content.checksums` reuses
      // them without re-hashing while error paths keep their own wording.
      const cachedArtifactStore = context.isSessionActive()
        ? {
            ...store,
            checksum(storageKey: string) {
              const cacheKey = `${vault}\0${storageKey}`;
              const cached = context.fileDigestCache.get(cacheKey);
              if (cached !== undefined) return { ok: true as const, value: cached };
              const computed = store.checksum(storageKey);
              if (computed.ok) context.fileDigestCache.set(cacheKey, computed.value);
              return computed;
            },
          }
        : store;
      const findings = verifyVaultArtifacts(
        { artifactStore: cachedArtifactStore },
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
  },

  "content.checksums"(context) {
    const state = context.configurationState();
    const config = state.kind === "valid" ? state.config : null;
    const vault = context.vaultPath(config);
    if (config === null || vault === null) {
      return withRecovery(
        blocking("Content checksums cannot be checked without a valid configuration."),
        context.configurationRecovery(state),
      );
    }
    try {
      const loaded = context.withDoctorDb((db) => {
        // The Memo link guard runs before any census conclusion and inside
        // the connection-close ownership: a schema-10 database whose Memo
        // rows lost their record references is a blocking integrity
        // finding, never a healthy empty census (SHR-004, SHR-014).
        const memoLinks = validateMemoContentLinks(db);
        if (!memoLinks.ok) return { kind: "blocked" as const, message: memoLinks.error.message };
        // The Channel link guard joins the same census boundary: a
        // schema-11 database whose message rows lost their record
        // references is a blocking finding under the same rule, never a
        // healthy empty census (SHR-004, the TASK-109 reviewed plan).
        const channelLinks = validateChannelContentLinks(db);
        if (!channelLinks.ok) return { kind: "blocked" as const, message: channelLinks.error.message };
        const table = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_records'")
          .get() as { name: string } | null | undefined;
        const records = table
          ? (db
              .prepare("SELECT storage_key, inline_text, sha256 FROM content_records WHERE materialized = 1")
              .all() as unknown as Array<{
              storage_key: string | null;
              inline_text: string | null;
              sha256: string;
            }>)
          : [];
        return { kind: "records" as const, records };
      });
      if (!loaded.ok) return blocking(loaded.blocking);
      if (loaded.value.kind === "blocked") return blocking(loaded.value.message);
      const { records } = loaded.value;
      if (records.length === 0) return ok("No content records are recorded yet on this installation.");
      // A Vault that cannot open is reported as that refusal, never as
      // missing content bytes (TASK-118, section 3.4).
      const openedVault = context.vaultState();
      if (openedVault.kind === "refused") return blocking(openedVault.message);
      const findings = verifyContentRecords(
        { vault, ...(context.isSessionActive() ? { fileDigestCache: context.fileDigestCache } : {}) },
        records,
      );
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
  },
};
