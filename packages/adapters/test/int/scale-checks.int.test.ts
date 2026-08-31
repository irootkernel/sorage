import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { type HandoffListFilters, type ListingScope, ok } from "@sorage/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSqliteEventLedger } from "../../src/events";
import { createSqliteHandoffReadStore } from "../../src/handoff-read-store";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { migrate } from "../../src/sqlite/migrator";
import { insertHandoffSeed } from "../../src/testkit/seed";
import { makeTempDatabase, type TempDatabase } from "../../src/testkit/temp-database";

/**
 * The TASK-062 scale checks against the 10,000-Handoff seed (NFR-004, NFR-006):
 * every query on the inbox, outbox, and detail paths is proved to use an index
 * through EXPLAIN QUERY PLAN, the documented millisecond budgets hold on the
 * recorded hardware baseline, and the environment the numbers were measured on
 * is captured so a regression can be told apart from a slower machine.
 */
const cleanups: Array<() => void> = [];
let db: TempDatabase["db"];

afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

function plan(sql: string, params: unknown[]): string {
  const statement = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  const rows = statement.all(...(params as never[])) as Array<{ detail: string }>;
  return rows.map((row) => row.detail).join(" | ");
}

const INBOX_SQL =
  "SELECT * FROM handoffs WHERE recipient_project_id = ? AND archived_at IS NULL AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?";
const OUTBOX_PROJECT_SQL =
  "SELECT * FROM handoffs WHERE sender_project_id = ? AND archived_at IS NULL AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?";
const OUTBOX_WORKSPACE_SQL =
  "SELECT * FROM handoffs WHERE sender_workspace_key = ? AND archived_at IS NULL AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?";
const DETAIL_SQL = "SELECT * FROM handoffs WHERE id = ?";

describe("the 10,000-Handoff scale checks", () => {
  beforeAll(() => {
    const temp = makeTempDatabase();
    cleanups.push(temp.cleanup);
    db = temp.db;
    migrate(db, MIGRATIONS);
    insertHandoffSeed(db, 10_000);
  });

  it("uses an index for every query on the inbox, outbox, and detail paths", () => {
    const projectId = (db.prepare("SELECT id FROM projects WHERE slug = ?").get("recipient-00") as { id: string }).id;
    const cases: Array<{ name: string; sql: string; params: unknown[] }> = [
      { name: "inbox first page", sql: INBOX_SQL, params: [projectId, 50] },
      {
        name: "inbox with the state filter",
        sql: `${INBOX_SQL.replace("archived_at IS NULL AND ", "review_state = ? AND archived_at IS NULL AND ")}`,
        params: [projectId, "awaiting_recipient", 50],
      },
      {
        // The seed registers only recipients as Projects, and the plan does not
        // depend on which id binds, so the recipient id proves the outbox shape.
        name: "outbox first page",
        sql: OUTBOX_PROJECT_SQL,
        params: [projectId, 50],
      },
      {
        name: "workspace outbox first page",
        sql: OUTBOX_WORKSPACE_SQL,
        params: [createHash("sha256").update("sorage-seed-workspace-sender-00").digest("hex"), 50],
      },
      { name: "detail read", sql: DETAIL_SQL, params: ["00000000-0000-4000-8000-000000000001"] },
    ];
    const committed: Array<{ name: string; plan: string }> = [];
    for (const item of cases) {
      const detail = plan(item.sql, item.params);
      committed.push({ name: item.name, plan: detail });
      expect(detail, `${item.name} must not full-scan: ${detail}`).not.toMatch(/\bSCAN\b/);
      expect(detail, `${item.name} must use an index: ${detail}`).toMatch(/USING (COVERING )?INDEX/);
    }
    // The committed proof: the exact plans this suite pins, for the task record.
    console.info("EXPLAIN QUERY PLAN evidence:", JSON.stringify(committed, null, 2));
  });

  it("holds the documented budgets for the first listing page and a detail read", () => {
    const store = createSqliteHandoffReadStore(db, createSqliteEventLedger(db));
    const projectId = (db.prepare("SELECT id FROM projects WHERE slug = ?").get("recipient-00") as { id: string }).id;
    const oneId = (
      db.prepare("SELECT id FROM handoffs WHERE recipient_project_id = ? LIMIT 1").get(projectId) as { id: string }
    ).id;
    const scope = { kind: "inbox", recipientProjectId: projectId } as const;
    const warmupWorkspaceKey = createHash("sha256").update("sorage-seed-workspace-sender-00").digest("hex");
    const emptyFilters: HandoffListFilters = { includeArchived: false, includeDeleted: false };

    const listing = (listScope: ListingScope) => store.listPage(listScope, emptyFilters, 50, null);
    const measure = (call: () => unknown): number => {
      const started = performance.now();
      void call();
      return performance.now() - started;
    };

    // The measured calls return Results rather than throwing, so a broken path
    // would measure as instant: prove each shape answers first.
    const firstInbox = listing(scope);
    expect(firstInbox.ok && firstInbox.value.items.length).toBe(50);
    const firstOutbox = listing({ kind: "outbox_workspace", workspaceKey: warmupWorkspaceKey });
    expect(firstOutbox.ok && firstOutbox.value.items.length).toBe(50);
    const firstDetail = store.findHandoffView(oneId);
    expect(firstDetail.ok && firstDetail.value !== null).toBe(true);

    // One discarded warm-up per measured shape, then the median of twenty.
    measure(() => listing(scope));
    measure(() => listing({ kind: "outbox_workspace", workspaceKey: warmupWorkspaceKey }));
    measure(() => store.findHandoffView(oneId));

    const workspaceKey = createHash("sha256").update("sorage-seed-workspace-sender-00").digest("hex");
    const samples = { inbox: [] as number[], outbox: [] as number[], detail: [] as number[] };
    for (let index = 0; index < 20; index += 1) {
      samples.inbox.push(measure(() => listing(scope)));
      samples.outbox.push(measure(() => listing({ kind: "outbox_workspace", workspaceKey })));
      samples.detail.push(measure(() => store.findHandoffView(oneId)));
    }
    const median = (values: number[]): number =>
      ([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number) ?? 0;

    // NFR-004 is a SHOULD: a missed budget on the recorded hardware is a P2
    // defect, asserted here so the scale story cannot silently rot.
    expect(median(samples.inbox)).toBeLessThan(500);
    expect(median(samples.outbox)).toBeLessThan(500);
    expect(median(samples.detail)).toBeLessThan(250);
    console.info("scale medians ms:", {
      inbox: median(samples.inbox),
      outbox: median(samples.outbox),
      detail: median(samples.detail),
    });
  });

  it.skipIf(process.platform !== "darwin")("records the hardware baseline the budgets were measured on", () => {
    const hardware =
      process.platform === "darwin"
        ? execFileSync("system_profiler", ["SPHardwareDataType"], { encoding: "utf8" })
        : "";
    const model = /Model Name:\s*(.+)/.exec(hardware)?.[1]?.trim() ?? "unknown";
    const chip = /Chip:\s*(.+)/.exec(hardware)?.[1]?.trim() ?? "unknown";
    const memory = /Memory:\s*(.+)/.exec(hardware)?.[1]?.trim() ?? "unknown";
    const os = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
    const record = `model=${model}; chip=${chip}; memory=${memory}; macOS=${os}; bun=${process.versions.bun ?? "node"}; fs=${tmpdir()}`;
    console.info("hardware baseline:", record);
    expect(model).not.toBe("unknown");
    expect(record.length).toBeGreaterThan(0);
    void ok;
  });
});
