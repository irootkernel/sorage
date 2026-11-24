import type { SorageSqlite } from "./sqlite/connection";

/**
 * Revokes every active Exchange participant and reporting-notice claim owned by
 * `projectId` inside the caller's open SQLite transaction. Throws on SQLite
 * failure so the enclosing Project mutation rolls back atomically.
 */
export function revokeExchangeClaimsInTx(db: SorageSqlite, projectId: string): void {
  // The Project repository can also open historical schemas that predate Exchange notices.
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'exchange_notice_claims'").get()) return;
  db.prepare("DELETE FROM exchange_notice_claims WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM exchange_claims WHERE project_id = ?").run(projectId);
}
