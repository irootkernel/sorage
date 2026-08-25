import { appError, err, ok, type AppError, type Result } from "./errors";
import { buildStorageKey, type ArtifactStore, type StagedFile } from "./artifacts";

/**
 * The import safety policy (VLT-008, VLT-015, VLT-016, VLT-017, VLT-018, SEC-006,
 * SEC-007): a stored name is sanitized while the original name is recorded
 * verbatim, MIME follows the extension allowlist without sniffing, a source
 * outside the resolved sender workspace needs the explicit override, and a Vault
 * and a Project directory may never contain one another. The filesystem halves
 * (realpath resolution, special-file detection, read-only marks) live in
 * adapters; every path handed to this module must already be realpath-resolved.
 */
export type ExternalSourcePolicy = "workspace_only" | "workspace_or_explicit";

export interface ExternalSourceCheck {
  resolvedSourcePath: string;
  workspaceRoot: string | null;
  policy: ExternalSourcePolicy;
  allowExternalSource: boolean;
}

/**
 * Enforces the external-source rule (VLT-016): a source inside the resolved
 * sender workspace imports normally; a source outside it requires the explicit
 * override and fails with `SOURCE_OUTSIDE_WORKSPACE` otherwise; under
 * `workspace_only` the override does not exist and the import always fails.
 */
export function checkExternalSource(check: ExternalSourceCheck): Result<{ insideWorkspace: boolean }, AppError> {
  const inside =
    check.workspaceRoot !== null &&
    (check.resolvedSourcePath === check.workspaceRoot ||
      check.resolvedSourcePath.startsWith(`${check.workspaceRoot}/`));
  if (inside) return ok({ insideWorkspace: true });
  if (check.policy === "workspace_or_explicit" && check.allowExternalSource) {
    return ok({ insideWorkspace: false });
  }
  return err(
    appError(
      "SOURCE_OUTSIDE_WORKSPACE",
      `The source ${check.resolvedSourcePath} is outside the resolved sender workspace${
        check.workspaceRoot === null ? "" : ` ${check.workspaceRoot}`
      }.`,
      {
        resolvedSourcePath: check.resolvedSourcePath,
        workspaceRoot: check.workspaceRoot,
        policy: check.policy,
      },
    ),
  );
}

export interface ContainmentCheck {
  resolvedVaultPath: string;
  resolvedBindingDirectories: string[];
}

/**
 * Rejects Vault and Project containment cycles (VLT-017): a Vault inside a bound
 * Project directory, or a Project directory inside the Vault, fails with
 * `VAULT_CONTAINMENT` at configuration time, because either layout makes the
 * Vault's content subject to another Project's Git and its cleanups.
 */
export function checkVaultContainment(check: ContainmentCheck): Result<{ safe: true }, AppError> {
  const vault = check.resolvedVaultPath;
  for (const directory of check.resolvedBindingDirectories) {
    if (vault === directory || vault.startsWith(`${directory}/`)) {
      return err(
        appError("VAULT_CONTAINMENT", `The Vault ${vault} lies inside the bound Project directory ${directory}.`, {
          resolvedVaultPath: vault,
          bindingDirectory: directory,
          side: "vault-inside-project",
        }),
      );
    }
    if (directory === vault || directory.startsWith(`${vault}/`)) {
      return err(
        appError("VAULT_CONTAINMENT", `The bound Project directory ${directory} lies inside the Vault ${vault}.`, {
          resolvedVaultPath: vault,
          bindingDirectory: directory,
          side: "project-inside-vault",
        }),
      );
    }
  }
  return ok({ safe: true });
}

/**
 * Sanitizes one stored name (VLT-018): path separators become dashes, control
 * bytes are dropped, and a name that would collapse to a traversal segment or to
 * nothing gets a safe fallback, so traversal sequences and control characters
 * never reach the filesystem. The recorded `originalName` is the caller's
 * verbatim copy and is never derived from this function.
 */
export function sanitizeStoredName(originalName: string): string {
  let sanitized = "";
  for (const character of originalName) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if (character === "/" || character === "\\") {
      sanitized += "-";
      continue;
    }
    sanitized += character;
  }
  if (sanitized === "") return "unnamed";
  if (sanitized === "." || sanitized === "..") return `_${sanitized}`;
  return sanitized;
}

/** The MIME allowlist of section 11.2: extension only, never sniffed. */
export function classifyMimeType(storedName: string): string {
  if (storedName.endsWith(".md")) return "text/markdown";
  if (storedName.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

export interface ImportRequest {
  /** The path exactly as supplied; recorded in `importedFromPath`. */
  sourcePath: string;
  /** The realpath-resolved source; every policy check runs against it (SEC-006). */
  resolvedSourcePath: string;
  originalName: string;
  workspaceRoot: string | null;
  externalPolicy: ExternalSourcePolicy;
  allowExternalSource: boolean;
  maxBytes: number;
  handoffId: string;
  artifactId: string;
  resolvedVaultPath: string;
  resolvedBindingDirectories: string[];
}

/** The Artifact metadata of VLT-007 plus the staged path for later activation. */
export interface PreparedImport extends StagedFile {
  originalName: string;
  storedName: string;
  mimeType: string;
  storageKey: string;
  importedFromPath: string;
}

/**
 * Runs the full import policy and stages the copy: containment, then the
 * external-source rule, then sanitization and MIME classification, then the
 * streaming stage. Special-file and unreadable-source rejection happen in the
 * adapter's source inspection before this use case runs.
 */
export function prepareArtifactImport(
  ports: { artifactStore: ArtifactStore },
  request: ImportRequest,
): Result<PreparedImport, AppError> {
  const contained = checkVaultContainment({
    resolvedVaultPath: request.resolvedVaultPath,
    resolvedBindingDirectories: request.resolvedBindingDirectories,
  });
  if (!contained.ok) return err(contained.error);
  const external = checkExternalSource({
    resolvedSourcePath: request.resolvedSourcePath,
    workspaceRoot: request.workspaceRoot,
    policy: request.externalPolicy,
    allowExternalSource: request.allowExternalSource,
  });
  if (!external.ok) return err(external.error);
  const storedName = sanitizeStoredName(request.originalName);
  const storageKey = buildStorageKey({
    handoffId: request.handoffId,
    artifactId: request.artifactId,
    storedName,
  });
  if (!storageKey.ok) return err(storageKey.error);
  const staged = ports.artifactStore.stage({
    sourcePath: request.resolvedSourcePath,
    maxBytes: request.maxBytes,
  });
  if (!staged.ok) return err(staged.error);
  return ok({
    ...staged.value,
    originalName: request.originalName,
    storedName,
    mimeType: classifyMimeType(storedName),
    storageKey: storageKey.value,
    importedFromPath: request.sourcePath,
  });
}
