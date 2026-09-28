import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotFiles, type Memo, type MemoReceipt } from "../../packages/core/src/index";
import { envelopeOf, errorEnvelopeOf, makeTempDir, runCleanups, sorage, twoProjectFixture } from "./helpers";

afterEach(runCleanups);
function data<T = Record<string, unknown>>(home: string, args: string[]): T {
  const result = sorage([...args, "--json"], { home });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return envelopeOf(result).data as T;
}
function rows(home: string) {
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  try {
    return Object.fromEntries(
      ["projects", "project_memos", "handoffs", "artifacts", "review_notes", "events", "idempotency_keys"].map(
        (table) => [
          table,
          db
            .prepare(
              `SELECT * FROM ${table} ORDER BY ${table === "idempotency_keys" ? "scope, key" : table === "review_notes" ? "handoff_id" : "id"}`,
            )
            .all()
            .map(
              (row): Record<string, unknown> =>
                typeof row.metadata_json === "string" ? { ...row, metadata_json: JSON.parse(row.metadata_json) } : row,
            ),
        ],
      ),
    );
  } finally {
    db.close();
  }
}
function files(root: string, prefix = ""): Record<string, Buffer> {
  return Object.fromEntries(
    readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry): Array<[string, Buffer]> => {
      const path = join(prefix, entry.name);
      return entry.isDirectory() ? Object.entries(files(root, path)) : [[path, readFileSync(join(root, path))]];
    }),
  );
}
function emptyHome() {
  const home = makeTempDir("aj23-target-");
  data(home, ["init", "--non-interactive"]);
  return home;
}

describe("AJ-23: compiled Memo backup and restore qualification", () => {
  it("round-trips exact lifecycle rows across process invocations and excludes operational receipts", () => {
    const f = twoProjectFixture("aj23-lifecycle");
    const memos: Memo[] = [];
    for (const title of ["Open", "Done", "Dismissed", "Edited", "Reopened"]) {
      memos.push(
        data<MemoReceipt>(f.home, [
          "memo",
          "add",
          "--project",
          title === "Dismissed" ? "beta" : "alpha",
          "--title",
          title,
          "--body",
          `Private ${title} 한글 😀\r\nExact body\r\n`,
          "--idempotency-key",
          randomUUID(),
        ]).memo,
      );
    }
    function change(index: number, operation: string, fields: string[] = []) {
      const memo = memos[index] as Memo;
      memos[index] = data<MemoReceipt>(f.home, [
        "memo",
        operation,
        memo.id,
        "--expected-row-version",
        String(memo.rowVersion),
        "--idempotency-key",
        randomUUID(),
        ...fields,
      ]).memo;
    }
    change(1, "done");
    change(2, "dismiss");
    change(3, "update", ["--title", "Edited title"]);
    change(4, "done");
    change(4, "reopen");
    data(f.home, ["project", "archive", "beta", "--as-user"]);
    data(f.home, ["project", "unbind", "alpha", "--dir", f.workA, "--confirm"]);
    const original = rows(f.home);
    const identity = data(f.home, ["config", "show"]).installationId;
    data(f.home, ["backup", "run"]);
    const root = join(f.home, "vault", "snapshots");
    const first = files(root);
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    expect(manifest.formatVersion).toBe(2);
    expect(manifest.counts.memos).toBe(5);
    expect(Object.keys(manifest.memoDigests)).toHaveLength(5);
    for (const memo of memos) {
      const path = `memos/${memo.id.slice(0, 2)}/${memo.id}.json`;
      const bytes = readFileSync(join(root, path));
      expect(bytes.at(-1)).toBe(10);
      expect(JSON.parse(bytes.toString("utf8"))).toEqual(memo);
      expect(manifest.memoDigests[path]).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(readFileSync(join(root, "events.jsonl"), "utf8")).not.toContain(memo.body.split("\r\n")[0]);
    }
    data(f.home, ["backup", "run"]);
    expect(files(root)).toEqual(first);
    data(f.home, ["backup", "verify"]);
    const target = emptyHome();
    const before = rows(target);
    const restore = ["backup", "restore", "--from", join(f.home, "vault"), "--as-user"];
    data(target, [...restore, "--dry-run"]);
    expect(rows(target)).toEqual(before);
    data(target, [...restore, "--confirm"]);
    expect(data(target, ["config", "show"]).installationId).toBe(identity);
    for (const memo of memos) expect(data<Memo>(target, ["memo", "show", memo.id])).toEqual(memo);
    const restored = rows(target);
    expect(restored.project_memos).toEqual(original.project_memos);
    expect(restored.events?.filter((row) => row.memo_id !== null)).toEqual(
      original.events?.filter((row) => row.memo_id !== null),
    );
    expect(original.idempotency_keys?.length).toBeGreaterThan(0);
    expect(restored.idempotency_keys).toEqual([]);
    expect(restored.projects?.map((row) => [row.id, row.status])).toEqual(
      original.projects?.map((row) => [row.id, row.status]),
    );
    const repeated = sorage([...restore, "--confirm", "--json"], { home: target });
    expect(errorEnvelopeOf(repeated).error.code).toBe("RESTORE_TARGET_NOT_EMPTY");
    expect(rows(target)).toEqual(restored);
  });

  it("reads a frozen format-1 fixture as zero Memos without rewriting the legacy bytes", () => {
    const source = emptyHome();
    const root = join(source, "vault", "snapshots");
    const projectId = "ab000000-0000-4000-8000-000000000001";
    // Use the retained format-1 serializer, not the current format-2 writer.
    const legacy = snapshotFiles({
      projects: [
        {
          id: projectId,
          slug: "legacy",
          displayName: "Legacy",
          description: null,
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          bindings: [],
        },
      ],
      handoffs: [],
      events: [],
    });
    for (const file of legacy) {
      const path = join(root, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    }
    const original = files(root);
    expect(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))).toEqual({
      formatVersion: 1,
      counts: { projects: 1, handoffs: 0, events: 0, artifacts: 0 },
    });
    const target = emptyHome();
    const restore = ["backup", "restore", "--from", join(source, "vault"), "--as-user"];
    data(target, [...restore, "--dry-run"]);
    data(target, [...restore, "--confirm"]);
    expect(rows(target).projects?.map((row) => row.id)).toEqual([projectId]);
    expect(rows(target).project_memos).toEqual([]);
    expect(data<{ items: Memo[] }>(target, ["memo", "list", "--all-projects", "--state", "all"]).items).toEqual([]);
    expect(data(target, ["config", "show"]).installationId).toBe(data(source, ["config", "show"]).installationId);
    expect(files(root)).toEqual(original);
  });

  it.each(["changed bytes", "missing final LF", "rehash noncanonical JSON", "missing digest", "path alias", "symlink"])(
    "rejects %s through verify, dry-run and real restore before changing the target",
    (corruption) => {
      const f = twoProjectFixture("aj23-corrupt");
      const memo = data<MemoReceipt>(f.home, [
        "memo",
        "add",
        "--project",
        "alpha",
        "--title",
        "Corruption",
        "--body",
        "Exact\r\n한글",
      ]).memo;
      data(f.home, ["backup", "run"]);
      const root = join(f.home, "vault", "snapshots");
      const path = `memos/${memo.id.slice(0, 2)}/${memo.id}.json`;
      const file = join(root, path);
      const bytes = readFileSync(file);
      const manifestPath = join(root, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (corruption === "changed bytes") writeFileSync(file, bytes.toString().replace("Corruption", "Tampered"));
      if (corruption === "missing final LF") writeFileSync(file, bytes.subarray(0, -1));
      if (corruption === "rehash noncanonical JSON") {
        const changed = `${JSON.stringify(JSON.parse(bytes.toString()))}\n`;
        writeFileSync(file, changed);
        manifest.memoDigests[path] = createHash("sha256").update(changed).digest("hex");
      }
      if (corruption === "missing digest") delete manifest.memoDigests[path];
      if (corruption === "path alias") {
        manifest.memoDigests[`../${path}`] = manifest.memoDigests[path];
        delete manifest.memoDigests[path];
      }
      if (corruption === "symlink") {
        const outside = join(f.home, "outside-memo.json");
        renameSync(file, outside);
        symlinkSync(outside, file);
      }
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const target = emptyHome();
      const before = rows(target);
      const config = readFileSync(join(target, "config.yaml"));
      const marker = readFileSync(join(target, "vault", ".sorage-vault.json"));
      const verify = sorage(["backup", "verify", "--json"], { home: f.home });
      expect(errorEnvelopeOf(verify).error.code).toBe("VAULT_INTEGRITY_ERROR");
      for (const mode of ["--dry-run", "--confirm"]) {
        const result = sorage(["backup", "restore", "--from", join(f.home, "vault"), "--as-user", mode, "--json"], {
          home: target,
        });
        expect(errorEnvelopeOf(result).error.code).toBe("VAULT_INTEGRITY_ERROR");
        expect(rows(target)).toEqual(before);
        expect(readFileSync(join(target, "config.yaml"))).toEqual(config);
        expect(readFileSync(join(target, "vault", ".sorage-vault.json"))).toEqual(marker);
      }
    },
  );
});
