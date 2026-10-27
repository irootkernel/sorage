import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Capture an earlier-journey fixture's proposal once, before invoking a fresh writer.
 * Explicit stale/missing-observation tests and receipt retries bypass this overlay.
 * Never modifies supplied observations or reads the developer's default home.
 */
export function observedHandoffFlags(id: string, fields: "row" | "both", home = process.env.SORAGE_HOME): string[] {
  if (!home) throw new Error("the regression fixture must select an isolated SORAGE_HOME");
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"), { readOnly: true });
  try {
    const row = db.prepare("SELECT revision, row_version FROM handoffs WHERE id = ?").get(id) as
      | { revision: number; row_version: number }
      | undefined;
    if (!row) throw new Error("the regression fixture must capture an existing Handoff observation");
    return [
      ...(fields === "both" ? ["--target-revision", String(row.revision)] : []),
      "--expected-row-version",
      String(row.row_version),
    ];
  } finally {
    db.close();
  }
}
