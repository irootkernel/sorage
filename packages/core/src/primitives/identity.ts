import { createHash } from "node:crypto";

/**
 * The stable key of one unregistered Workspace: the Installation identity and the
 * normalized real path hashed together, so the same directory under another
 * Installation is a different Workspace (PRJ-014).
 */
export function workspaceKey(installationId: string, normalizedPath: string): string {
  return createHash("sha256").update(`${installationId}\n${normalizedPath}`).digest("hex");
}

/** Canonical lowercase hyphenated UUID shape shared across domains. */
export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

/** Clock values use the same canonical UTC representation as Date.toISOString(). */
export function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
