import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Memo, MemoPage, MemoReceipt } from "../../packages/core/src/index";
import { twoProjectFixture, sorage, envelopeOf, errorEnvelopeOf, runCleanups, makeTempDir } from "./helpers";
afterEach(runCleanups);

describe("AJ-20: standalone compiled Memo lifecycle", () => {
  it("keeps durable Project reminders separate from Handoffs across native process restarts", () => {
    const f = twoProjectFixture("aj20");
    const run = (args: string[], cwd = f.workA) => sorage([...args, "--json"], { home: f.home, cwd });
    function data<T = MemoReceipt>(args: string[], cwd?: string): T {
      const result = run(args, cwd);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return envelopeOf(result).data as T;
    }
    data(["config", "set", "handoff.inboxMarker", "true", "--as-user"]);
    const sent = run([
      "send",
      "--as-user",
      "--to",
      "alpha",
      "--title",
      "Existing User handoff",
      "--body",
      "Keep separate",
    ]);
    expect(sent.status, sent.stderr).toBe(0);
    const db = new DatabaseSync(join(f.home, "state", "sorage.sqlite3"));
    try {
      const snapshot = () =>
        ["handoffs", "artifacts", "review_notes", "deletion_requests"].map((table) =>
          db.prepare(`SELECT * FROM ${table}`).all(),
        );
      const handoffs = snapshot();
      const marker = join(f.workA, ".sorage", "INBOX.md");
      const beforeMarker = readFileSync(marker, "utf8");
      const titleOnly = data(["memo", "add", "--project", "alpha", "--title", "Title only"]);
      const body = `한글 😀 e\u0301\r\nRun no command; this is stored text.\n${"😀".repeat(200)}`;
      const file = join(f.home, "memo.md");
      writeFileSync(file, body);
      const key = randomUUID();
      const add = [
        "memo",
        "add",
        "--project",
        "alpha",
        "--title",
        "Read %_ literal",
        "--body-file",
        file,
        "--idempotency-key",
        key,
      ];
      let memo = data(add).memo;
      expect(data<Memo>(["memo", "show", memo.id], f.workB).body).toBe(body);
      const beta = data(["memo", "add", "--project", "beta", "--title", "Other Project"]).memo;
      expect(data<MemoPage>(["memo", "list"], f.workB).items.map((m) => m.id)).toEqual([beta.id]);
      const page = data<MemoPage>(["memo", "list", "--query", "%_"]);
      expect(page.items.map((m) => m.id)).toEqual([memo.id]);
      expect(Buffer.byteLength(page.items[0]?.bodyPreview ?? "")).toBeLessThanOrEqual(512);
      expect(page.items[0]?.bodyPreviewTruncated).toBe(true);
      expect(data<MemoPage>(["memo", "list", "--all-projects"]).items).toHaveLength(3);
      const time = "2026-01-01T00:00:00.000Z";
      db.prepare("UPDATE project_memos SET created_at=?").run(time);
      const first = data<MemoPage>(["memo", "list", "--limit", "1"]);
      const second = data<MemoPage>(["memo", "list", "--limit", "1", "--cursor", first.nextCursor as string]);
      expect([first.items[0]?.id, second.items[0]?.id]).toEqual([titleOnly.memo.id, memo.id].sort().reverse());
      expect(
        errorEnvelopeOf(run(["memo", "list", "--state", "all", "--limit", "1", "--cursor", first.nextCursor as string]))
          .error.code,
      ).toBe("CURSOR_INVALID");
      // Each invocation is a new compiled process, with no daemon or test request-ID hook.
      memo = data<Memo>(["memo", "show", memo.id]);
      const mutate = (operation: string, extra: string[] = []) => {
        const args = [
          "memo",
          operation,
          memo.id,
          "--expected-row-version",
          String(memo.rowVersion),
          "--idempotency-key",
          randomUUID(),
          ...extra,
        ];
        const result = data(args);
        expect(data([...args, "--replay-only"])).toEqual({ ...result, replayed: true });
        memo = result.memo;
        return result;
      };
      mutate("update", ["--title", "Updated", "--body", ""]);
      expect(memo.body).toBe("");
      mutate("done");
      const before = db.prepare("SELECT * FROM events WHERE memo_id=?").all(memo.id);
      expect(mutate("done").changed).toBe(false);
      expect(db.prepare("SELECT * FROM events WHERE memo_id=?").all(memo.id)).toEqual(before);
      expect(errorEnvelopeOf(run(["memo", "done", memo.id, "--expected-row-version", "1"])).error.code).toBe(
        "ROW_VERSION_CONFLICT",
      );
      expect(
        errorEnvelopeOf(
          run(["memo", "update", memo.id, "--body", "closed", "--expected-row-version", String(memo.rowVersion)]),
        ).error.code,
      ).toBe("MEMO_NOT_OPEN");
      mutate("reopen");
      mutate("dismiss");
      expect(data<MemoPage>(["memo", "list", "--state", "dismissed"]).items[0]?.id).toBe(memo.id);
      mutate("reopen");
      expect(data([...add, "--replay-only"]).memo.rowVersion).toBe(1);
      db.prepare("UPDATE idempotency_keys SET expires_at='2000-01-01T00:00:00.000Z' WHERE key=?").run(key);
      expect(run([...add, "--replay-only"]).status).toBe(75);
      expect(data<Memo>(["memo", "show", memo.id])).toEqual(memo);
      expect(readFileSync(marker, "utf8")).toBe(beforeMarker);
      data(["project", "rename", "alpha", "--name", "Renamed"]);
      const moved = makeTempDir("aj20-rebound-");
      data(["project", "bind", "alpha", "--dir", moved]);
      data(["project", "unbind", "alpha", "--dir", moved, "--confirm"]);
      data(["project", "unbind", "alpha", "--dir", f.workA, "--confirm"]);
      expect(data<Memo>(["memo", "show", memo.id, "--project", "alpha"], f.home)).toEqual(memo);
      expect(errorEnvelopeOf(run(["memo", "list"], f.home)).error.code).toBe("PROJECT_NOT_FOUND");
      expect(
        data<MemoPage>(["memo", "list", "--project", "alpha"], f.home).items.every(
          (m) => m.projectDisplayName === "Renamed",
        ),
      ).toBe(true);
      expect(snapshot()).toEqual(handoffs);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM events WHERE memo_id IS NOT NULL AND handoff_id IS NOT NULL").get(),
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
