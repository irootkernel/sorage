import type { AppError, ArtifactReadHandle, ContentBodyOpenPolicy, ContentLocalPathPolicy } from "@sorage/core";
import { appError, err, ok, type Result } from "@sorage/core";
import { createSqliteContentStore } from "./content-store";
import type { SorageSqlite } from "./sqlite/connection";

/**
 * The private ArtifactID-to-content-record body seam of section 38.2
 * (SHR-005, SHR-006): every operation resolves one Artifact's authoritative
 * immutable record by the Artifact id — never by a storage key, which an
 * inline row does not carry — and the content-record identity never leaves
 * this adapter. Reads run through the shared ContentStore's validated
 * bounded reader, digest policy, and derived fetch-cache materialization;
 * content-family failures map onto the Handoff error families at this
 * boundary so no content-store code escapes upward.
 */
export interface ArtifactBodyPortsOptions {
  db: SorageSqlite;
  vaultPath: string;
  installationId: string;
  /** The resolved home state tree that carries the inline fetch cache (SHR-006). */
  stateDir: string;
}

export interface ArtifactBodyPorts {
  openArtifactBody(artifactId: string, policy: ContentBodyOpenPolicy): Result<ArtifactReadHandle, AppError>;
  localPathOfArtifact(artifactId: string): Result<string, AppError>;
  verifyArtifactBody(artifactId: string, policy: ContentBodyOpenPolicy): Result<void, AppError>;
}

/** Maps the shared content-family failures onto the Handoff families (section 4). */
function handoffBodyError(error: AppError): Pick<AppError, "code" | "message"> {
  if (error.code === "CONTENT_MATERIALIZING") {
    return {
      code: "ARTIFACT_MATERIALIZING",
      message:
        "the current Artifact has not reached its storage key yet; retry after the next process start drains the intent",
    };
  }
  if (error.code === "CONTENT_CORRUPTED") {
    return {
      code: "ARTIFACT_CORRUPTED",
      message: "the current Artifact body is missing or mismatched; run sorage vault verify and restore from backup",
    };
  }
  return error;
}

export function createArtifactBodyPorts(options: ArtifactBodyPortsOptions): ArtifactBodyPorts {
  const store = createSqliteContentStore({
    db: options.db,
    vaultPath: options.vaultPath,
    installationId: options.installationId,
  });
  const localPathPolicy: ContentLocalPathPolicy = { stateDir: options.stateDir };
  const recordIdOf = (artifactId: string): Result<string, AppError> => {
    try {
      const row = options.db.prepare("SELECT content_record_id FROM artifacts WHERE id = ?").get(artifactId) as
        | { content_record_id: string }
        | null
        | undefined;
      if (row === null || row === undefined) {
        return err(
          appError("ARTIFACT_CORRUPTED", "the current Artifact row is missing its content reference.", {
            artifactId,
          }),
        );
      }
      return ok(row.content_record_id);
    } catch (error) {
      return err(
        appError("INTERNAL_ERROR", `Resolving the Artifact's content record failed: ${String(error)}.`, {
          artifactId,
        }),
      );
    }
  };
  return {
    openArtifactBody(artifactId, policy) {
      const recordId = recordIdOf(artifactId);
      if (!recordId.ok) return recordId;
      const opened = store.openBody(recordId.value, policy);
      if (!opened.ok) return err(mappedBodyError(artifactId, opened.error));
      return ok(opened.value);
    },
    localPathOfArtifact(artifactId) {
      const recordId = recordIdOf(artifactId);
      if (!recordId.ok) return recordId;
      const path = store.materializeLocalPath(recordId.value, localPathPolicy);
      if (!path.ok) return err(mappedBodyError(artifactId, path.error));
      return ok(path.value);
    },
    verifyArtifactBody(artifactId, policy) {
      const recordId = recordIdOf(artifactId);
      if (!recordId.ok) return recordId as Result<void, AppError>;
      const opened = store.openBody(recordId.value, policy);
      if (!opened.ok) return err(mappedBodyError(artifactId, opened.error));
      try {
        opened.value.close();
      } catch {
        // The digest verification already answered; descriptor disposal here is
        // best-effort because the caller never holds this handle.
      }
      return ok(undefined);
    },
  };
}

/**
 * Rebuilds one mapped error as a real AppError with public Artifact identity:
 * the typed code and message come from the Handoff mapping, useful public
 * details such as the storage key and cause are preserved, and the private
 * content-record identity never rides a public Handoff error (SHR-004,
 * SHR-013). Ordinary internal failures keep their honest pass-through.
 */
function mappedBodyError(artifactId: string, error: AppError): AppError {
  const mapped = handoffBodyError(error);
  const details: Record<string, unknown> = { artifactId };
  if (error.details !== null && typeof error.details === "object") {
    for (const [name, value] of Object.entries(error.details as Record<string, unknown>)) {
      if (name === "recordId") continue;
      details[name] = value;
    }
  }
  return appError(mapped.code, mapped.message, details);
}
