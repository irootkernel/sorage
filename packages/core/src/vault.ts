import { appError, err, ok, type AppError, type Result } from "./errors";

/**
 * The Vault marker and layout contract (VLT-002, VLT-003, VLT-019, VLT-024): the
 * marker identifies the Vault's schema version and its Installation, a directory
 * without a valid marker is never adopted as a Vault, and the policy files
 * initialization writes are fixed content that later tasks verify. This module
 * holds the pure validation halves; the filesystem reads live in adapters and
 * every mutation path funnels through them before touching Vault content.
 */
export interface VaultMarker {
  type: "sorage-vault";
  schemaVersion: number;
  installationId: string;
  createdAt: string;
}

/** The marker schemaVersion this build reads and writes. */
export const SUPPORTED_VAULT_MARKER_SCHEMA = 1;

/** The only audited route to adopt a Vault of another installation (VLT-019). */
export const VAULT_ADOPTION_COMMAND = "sorage backup restore --from <vault-path> --as-user --confirm";

/**
 * The state-specific recovery guidance a Vault-open refusal carries (VLT-002,
 * VLT-003, VLT-019; TASK-118): every action named here can run while the Vault
 * cannot open, so none of them is `sorage vault verify`, which drains and
 * refuses identically, and none is plain `sorage init`, which is a no-op on an
 * existing configuration. Only the empty-uninitialized state may name
 * `sorage init --reconfigure --non-interactive`, and only for a genuinely new
 * installation with no prior Vault data.
 */
export const VAULT_OPEN_RECOVERY = {
  missingDirectory:
    "Check the configured vault.path with sorage config show and confirm the Vault directory is present and its volume is mounted; if the Vault is lost, restore a verified backup into a fresh installation. Do not initialize the configured path or replace a Vault that may only be unmounted",
  unreadableDirectory:
    "Confirm the Vault directory is readable and reachable without a symlink loop, and, when its marker is missing or unreadable, that its entries can be listed and its volume is mounted; if the Vault is lost, restore a verified backup into a fresh installation. Do not initialize the configured path or replace a Vault that may only be unmounted",
  filePath:
    "Check the configured vault.path with sorage config show; it must name the Vault directory, not a file. If a stray file occupies the intended Vault path, move it aside only after confirming it is not the Vault; do not initialize over it or replace an existing Vault",
  unreadableMarker:
    "Confirm the Vault directory and its marker are readable by this user and that the Vault volume is mounted; if the marker is lost, restore a verified backup into a fresh installation. Never replace the marker by hand or initialize over the existing Vault",
  nonEmptyWithoutMarker:
    "Check the configured vault.path and confirm its volume is mounted; if this is the intended Vault and its marker was lost, restore a verified backup into a fresh installation. Never create a marker by hand, initialize over a populated directory, or replace a populated Vault",
  emptyUninitialized:
    "Check the configured vault.path and confirm its volume is mounted; if this installation has prior data, restore a verified backup into a fresh installation. Only for a genuinely new installation with no prior Vault data may sorage init --reconfigure --non-interactive backfill this empty directory",
  invalidMarker:
    "Check the configured vault.path and confirm its volume is mounted; if the marker is damaged, restore a verified backup into a fresh installation. Never rewrite the marker by hand or initialize over the existing Vault",
  foreignMarker: `Adopt this Vault only by restoring it into a fresh installation with ${VAULT_ADOPTION_COMMAND}; never rewrite the marker in place`,
} as const;

/**
 * The `.gitattributes` lines Vault initialization writes verbatim (VLT-024, as
 * amended by SHR-011): the managed binary trees carry `-text -diff`, the general
 * snapshot tree normalizes to LF text, and the more-specific raw snapshot-content
 * exception follows the general rule so Git preserves accepted payload bytes even
 * when they contain a BOM, CRLF, or no final newline.
 */
export const REQUIRED_GITATTRIBUTES_LINES = [
  "artifacts/** -text -diff",
  "content/** -text -diff",
  "snapshots/** text eol=lf",
  "snapshots/content/** -text -diff",
  ".sorage-vault.json text eol=lf",
] as const;

/** The `.gitignore` entries Vault initialization writes verbatim (VLT-024). */
export const REQUIRED_GITIGNORE_LINES = ["staging/"] as const;

/** The exact `.gitattributes` bytes initialization writes (VLT-024). */
export function vaultGitattributesContent(): string {
  return `${REQUIRED_GITATTRIBUTES_LINES.join("\n")}\n`;
}

/** The exact `.gitignore` bytes initialization writes (VLT-024). */
export function vaultGitignoreContent(): string {
  return `${REQUIRED_GITIGNORE_LINES.join("\n")}\n`;
}

function invalidMarker(message: string): Result<never, AppError> {
  return err(appError("VAULT_INTEGRITY_ERROR", message));
}

/**
 * Parses and classifies one marker file body. A body that is not JSON, is not a
 * Sorage marker object, or carries an impossible schemaVersion is a
 * `VAULT_INTEGRITY_ERROR`; a schemaVersion newer than this build is the
 * distinct `VAULT_SCHEMA_UNSUPPORTED`, because the answer is to upgrade Sorage
 * rather than to repair the Vault.
 */
export function parseVaultMarker(raw: string): Result<VaultMarker, AppError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return invalidMarker("The Vault marker is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalidMarker("The Vault marker is not a JSON object.");
  }
  const marker = parsed as Record<string, unknown>;
  if (marker.type !== "sorage-vault") {
    return invalidMarker("The marker's type is not 'sorage-vault'.");
  }
  const schemaVersion = marker.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    return invalidMarker(`The Vault marker schemaVersion is not a positive integer: ${String(schemaVersion)}.`);
  }
  if (schemaVersion > SUPPORTED_VAULT_MARKER_SCHEMA) {
    return err(
      appError(
        "VAULT_SCHEMA_UNSUPPORTED",
        `The Vault marker schemaVersion ${schemaVersion} is newer than this build's ${SUPPORTED_VAULT_MARKER_SCHEMA}; Sorage never downgrades a Vault.`,
      ),
    );
  }
  if (typeof marker.installationId !== "string" || marker.installationId === "") {
    return invalidMarker("The Vault marker has no installationId.");
  }
  if (typeof marker.createdAt !== "string" || marker.createdAt === "") {
    return invalidMarker("The Vault marker has no createdAt.");
  }
  return ok({
    type: "sorage-vault",
    schemaVersion,
    installationId: marker.installationId,
    createdAt: marker.createdAt,
  });
}

/**
 * Enforces marker ownership (VLT-019): a marker of another Installation blocks
 * every mutation, and the only route to adopting it is the audited restore, so
 * the error names that command instead of suggesting an in-place rewrite.
 */
export function validateVaultMarkerForInstallation(
  marker: VaultMarker,
  installationId: string,
): Result<VaultMarker, AppError> {
  if (marker.installationId !== installationId) {
    return err(
      appError(
        "VAULT_INTEGRITY_ERROR",
        `The Vault marker belongs to installation ${marker.installationId}, not this installation ${installationId}; adopt it only through the audited ${VAULT_ADOPTION_COMMAND}.`,
      ),
    );
  }
  return ok(marker);
}

/**
 * Verifies the policy-file content initialization writes (VLT-024). The check
 * is per required line and per relative order, because a reportable Vault may
 * carry additional lines while still asserting the lines the layout contract
 * depends on in their stated order; a null body means the file is missing
 * entirely. Returns one problem string per finding.
 */
export function verifyVaultPolicyFiles(gitattributes: string | null, gitignore: string | null): string[] {
  const problems: string[] = [];
  if (gitattributes === null) {
    problems.push(".gitattributes is missing from the Vault.");
  } else {
    const lines = gitattributes.split("\n");
    let previousIndex = -1;
    for (const line of REQUIRED_GITATTRIBUTES_LINES) {
      const index = lines.indexOf(line);
      if (index === -1) {
        problems.push(`.gitattributes is missing the required line '${line}'.`);
        continue;
      }
      if (index < previousIndex) {
        problems.push(`.gitattributes carries the required line '${line}' out of its stated order.`);
      }
      previousIndex = index;
    }
  }
  if (gitignore === null) {
    problems.push(".gitignore is missing from the Vault.");
  } else {
    for (const line of REQUIRED_GITIGNORE_LINES) {
      if (!gitignore.split("\n").includes(line)) {
        problems.push(`.gitignore is missing the required entry '${line}'.`);
      }
    }
  }
  return problems;
}
