import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Memo, MemoPage } from "@sorage/core";
import { memoCliFixture, cliData } from "../fixtures/memo-cli";
const fixtures: ReturnType<typeof memoCliFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});
function fixture(empty = false) {
  const value = memoCliFixture(empty);
  fixtures.push(value);
  return value;
}
function error(result: { stdout: string; stderr: string }) {
  expect(result.stdout).toBe("");
  return JSON.parse(result.stderr).error.code;
}
function inventory(f: ReturnType<typeof fixture>) {
  return ["project_memos", "events", "idempotency_keys"].map((table) =>
    f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  );
}

describe("native Memo CLI", () => {
  it("preserves file bytes, empty bodies and historical cross-input replay through separate processes", () => {
    const f = fixture();
    const body = "\uFEFF한글 😀 e\u0301\r\nline\n";
    const file = join(f.home, "body.md");
    writeFileSync(file, body);
    const key = randomUUID();
    const args = ["memo", "add", "--title", "  Reminder  ", "--body-file", file, "--idempotency-key", key, "--json"];
    const original = cliData(f.run(args));
    expect(original.memo.body).toBe(body);
    expect(original.memo.title).toBe("Reminder");
    const marker = join(f.work, ".sorage", "INBOX.md");
    let beforeMarker: string | undefined;
    try {
      beforeMarker = readFileSync(marker, "utf8");
    } catch {}
    const before = inventory(f);
    const replay = cliData(
      f.run(
        [
          "memo",
          "add",
          "--project",
          "memo",
          "--title",
          "Reminder",
          "--body",
          body,
          "--idempotency-key",
          key,
          "--replay-only",
          "--as-user",
          "--json",
        ],
        f.home,
      ),
    );
    expect(replay).toEqual({ ...original, replayed: true });
    expect(inventory(f)).toEqual(before);
    if (beforeMarker !== undefined) expect(readFileSync(marker, "utf8")).toBe(beforeMarker);
    expect(
      error(
        f.run([
          "memo",
          "add",
          "--title",
          "Reminder",
          "--body",
          body.replaceAll("\r\n", "\n"),
          "--idempotency-key",
          key,
          "--json",
        ]),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
    const cleared = cliData(
      f.run(["memo", "update", original.memo.id, "--body", "", "--expected-row-version", "1", "--json"]),
    );
    expect(cleared.memo.body).toBe("");
    const empty = join(f.home, "empty.md");
    writeFileSync(empty, "");
    expect(
      cliData(
        f.run(["memo", "update", original.memo.id, "--body-file", empty, "--expected-row-version", "2", "--json"]),
      ).changed,
    ).toBe(false);
    expect(cliData<Memo>(f.run(["memo", "show", original.memo.id, "--json"], f.home)).rowVersion).toBe(2);
  });
  it("rejects malformed sources without blocking on FIFO/device, consuming keys or emitting content", () => {
    const f = fixture();
    const file = join(f.home, "body.md");
    const key = randomUUID();
    const add = (more: string[]) =>
      f.run(["memo", "add", "--title", "safe", "--idempotency-key", key, ...more, "--json"]);
    const before = inventory(f);
    expect(error(add(["--body", "", "--body-file", file]))).toBe("MEMO_INVALID_INPUT");
    const missing = add(["--body-file", file]);
    expect(missing.status).toBe(73);
    expect(error(missing)).toBe("MEMO_FILE_READ_FAILED");
    writeFileSync(file, "private");
    chmodSync(file, 0);
    try {
      const denied = add(["--body-file", file]);
      expect(denied.status).toBe(73);
      expect(error(denied)).toBe("MEMO_FILE_READ_FAILED");
    } finally {
      chmodSync(file, 0o600);
    }
    writeFileSync(file, Buffer.from([0xff]));
    expect(error(add(["--body-file", file]))).toBe("MEMO_INVALID_INPUT");
    writeFileSync(file, "secret\0text");
    expect(error(add(["--body-file", file]))).toBe("MEMO_INVALID_INPUT");
    writeFileSync(file, "x".repeat(65537));
    const large = add(["--body-file", file]);
    expect(large.status).toBe(65);
    expect(error(large)).toBe("MEMO_TOO_LARGE");
    const fifo = join(f.home, "fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    for (const path of [fifo, f.home, "/dev/null"])
      expect(error(add(["--body-file", path]))).toBe("MEMO_INVALID_INPUT");
    expect(inventory(f)).toEqual(before);
    writeFileSync(file, "😀".repeat(16384));
    const link = join(f.home, "link.md");
    symlinkSync(file, link);
    expect(Buffer.byteLength(cliData(add(["--body-file", link])).memo.body)).toBe(65536);
    writeFileSync(file, Buffer.from([0xff]));
    expect(error(add(["--body-file", file, "--replay-only"]))).toBe("MEMO_INVALID_INPUT");
  });
  it("requires explicit expectations and rejects Handoff flags, invalid scopes and replay mode on reads", () => {
    const f = fixture();
    const memo = cliData(f.run(["memo", "add", "--title", "Memo", "--json"])).memo;
    for (const args of [
      ["memo", "add"],
      ["memo", "add", "--title", "bad\n"],
      ["memo", "add", "--title", "Memo", "--as", "memo"],
      ["memo", "list", "--project", "memo", "--all-projects"],
      ["memo", "list", "--replay-only"],
      ["memo", "show", memo.id, "--replay-only"],
      ["memo", "done", memo.id],
      ["memo", "update", memo.id, "--expected-row-version", "1"],
      ["memo", "done", memo.id, "--expected-row-version", "0"],
      ["memo", "done", memo.id, "--expected-row-version", "9007199254740992"],
      ["--expected-row-version", "9007199254740992", "memo", "done", memo.id],
      ["memo", "done", memo.id, "--expected-row-version", "1.5"],
      ["memo", "done", memo.id, "--expected-row-version", "nope"],
      ["memo", "list", "--limit", "9007199254740992"],
      ["memo", "add", "--title", "Memo", "--replay-only"],
      ["memo", "add", "--title", "Memo", "--idempotency-key", "bad"],
    ]) {
      const result = f.run([...args, "--json"]);
      expect(result.status).toBe(64);
      expect(error(result)).toBe("MEMO_INVALID_INPUT");
    }
    expect(f.run(["memo", "add", "--title", "Memo", "--to", "other"]).status).toBe(2);
    expect(f.run(["memo", "done", memo.id, "--expected-row-version"]).status).toBe(2);
    expect(f.run(["--as", "memo", "accept", memo.id, "--expected-row-version", "9007199254740992"]).status).toBe(2);
    expect(error(f.run(["memo", "show", memo.id, "--project", "other", "--json"]))).toBe("MEMO_NOT_FOUND");
    expect(error(f.run(["memo", "list", "--json"], f.home))).toBe("PROJECT_NOT_FOUND");
    expect(cliData<MemoPage>(f.run(["memo", "list", "--all-projects", "--json"], f.home)).items).toHaveLength(1);
    expect(cliData<MemoPage>(f.run(["memo", "list", "--query", "M_m%", "--json"])).items).toHaveLength(0);
  });
  it.each(["update", "done", "dismiss", "reopen"] as const)(
    "recovers %s only from the original receipt and expectation",
    (operation) => {
      const f = fixture();
      let memo = cliData(f.run(["memo", "add", "--title", "Memo", "--json"])).memo;
      if (operation === "reopen")
        memo = cliData(f.run(["memo", "done", memo.id, "--expected-row-version", "1", "--json"])).memo;
      const key = randomUUID();
      const args = [
        "memo",
        operation,
        memo.id,
        "--expected-row-version",
        String(memo.rowVersion),
        ...(operation === "update" ? ["--body", "new"] : []),
        "--idempotency-key",
        key,
        "--json",
      ];
      const first = cliData(f.run(args));
      const before = inventory(f);
      expect(cliData(f.run([...args, "--replay-only"]))).toEqual({ ...first, replayed: true });
      expect(inventory(f)).toEqual(before);
      f.db.prepare("UPDATE idempotency_keys SET expires_at='2000-01-01T00:00:00.000Z' WHERE key=?").run(key);
      const expired = inventory(f);
      const result = f.run([...args, "--replay-only"]);
      expect(result.status).toBe(75);
      expect(error(result)).toBe("MEMO_REPLAY_UNAVAILABLE");
      expect(inventory(f)).toEqual(expired);
    },
  );
  it("keeps identity after a directory move and supports explicit unbound Project selection", () => {
    const f = fixture();
    const original = cliData(f.run(["memo", "add", "--title", "Portable", "--json"])).memo;
    const moved = join(f.home, "moved");
    renameSync(f.work, moved);
    expect(cliData<Memo>(f.run(["memo", "show", original.id, "--project", "memo", "--json"], f.home)).id).toBe(
      original.id,
    );
    expect(f.run(["project", "unbind", "memo", "--dir", f.work, "--json"], f.home).status).toBe(0);
    expect(
      cliData(f.run(["memo", "add", "--project", "memo", "--title", "Unbound", "--json"], f.home)).memo.projectId,
    ).toBe(original.projectId);
    mkdirSync(f.work);
  });
  it("preserves unavailable unknown outcomes after real same-Installation backup restore", () => {
    const source = fixture();
    const key = randomUUID();
    const args = [
      "memo",
      "add",
      "--project",
      "memo",
      "--title",
      "Lost response",
      "--body",
      "exact\r\n",
      "--idempotency-key",
      key,
      "--json",
    ];
    const created = cliData(source.run(args));
    expect(source.run(["backup", "run", "--as-user", "--json"]).status).toBe(0);
    const target = fixture(true);
    const restored = target.run(
      ["backup", "restore", "--from", join(source.home, "vault"), "--confirm", "--as-user", "--json"],
      target.home,
    );
    expect(restored.status, restored.stderr).toBe(0);
    const before = inventory(target);
    const result = target.run([...args, "--replay-only"], target.home);
    expect(result.status).toBe(75);
    expect(error(result)).toBe("MEMO_REPLAY_UNAVAILABLE");
    expect(inventory(target)).toEqual(before);
    expect(cliData<Memo>(target.run(["memo", "show", created.memo.id, "--json"], target.home))).toEqual(created.memo);
  });
});
