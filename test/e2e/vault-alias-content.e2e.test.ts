import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir, runCleanups, sorage } from "./helpers";

afterEach(runCleanups);

describe("compiled content producers through a selected Vault alias", () => {
  it.each(["directory", "ancestor"])("preserves file-backed content through a %s alias", (kind) => {
    const root = makeTempDir("sorage-vault-alias-");
    const home = join(root, "installation");
    const physical = join(root, "physical");
    const alias = join(root, "selected");
    const sender = join(root, "sender");
    const recipient = join(root, "recipient");
    for (const path of [physical, sender, recipient]) mkdirSync(path);
    symlinkSync(physical, alias, "dir");
    const vault = kind === "directory" ? alias : join(alias, "vault");
    const run = (args: string[], cwd = sender) => {
      const result = sorage([...args, "--json"], { home, cwd });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout).data;
    };
    run(["init", "--vault", vault, "--non-interactive"]);
    expect(run(["config", "show"]).vault.path).toBe(vault);
    run(["project", "add", "--name", "Sender", "--dir", sender]);
    run(["project", "add", "--name", "Recipient", "--dir", recipient]);
    const body = `\uFEFF한글\r\n${"large shared content\n".repeat(3500)}tail`;
    const bytes = Buffer.from(body);
    expect(bytes.length).toBeGreaterThan(65_536);
    const file = join(sender, "body.md");
    writeFileSync(file, bytes);

    const memoArgs = [
      "memo",
      "add",
      "--project",
      "sender",
      "--title",
      "Alias Memo",
      "--body-file",
      file,
      "--idempotency-key",
      randomUUID(),
    ];
    const memo = run(memoArgs);
    expect(run(["memo", "show", memo.memo.id]).body).toBe(body);
    expect(run([...memoArgs, "--replay-only"])).toEqual({ ...memo, replayed: true });

    const _channel = run(["channel", "create", "alias"]).channel;
    run(["channel", "add", "alias", "worker", "--role", "worker"]);
    const submitted = run(["channel", "post", "alias", "--from", "worker", "--kind", "report", "--body-file", file]);
    expect(run(["channel", "messages", "alias"]).items[0].body).toBe(body);
    void submitted;

    // Handoff deliberately reports staging paths under the selected root.
    const sendArgs = [
      "send",
      "--to",
      "recipient",
      "--title",
      "Alias Handoff",
      "--file",
      file,
      "--idempotency-key",
      randomUUID(),
    ];
    const sent = run(sendArgs);
    expect(sent.handoffs[0].storageKey).not.toBeNull();
    expect(readFileSync(run(["fetch", sent.handoffs[0].handoffId], recipient).localPath)).toEqual(bytes);
    expect(run([...sendArgs, "--replay-only"])).toEqual({ ...sent, replayed: true });

    const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      const records = db.prepare("SELECT storage_key, materialized FROM content_records").all() as Array<{
        storage_key: string | null;
        materialized: number;
      }>;
      expect(records).toHaveLength(3);
      for (const record of records) {
        expect(record.materialized).toBe(1);
        expect(record.storage_key).not.toBeNull();
        expect(readFileSync(join(vault, record.storage_key as string))).toEqual(bytes);
      }
      expect(db.prepare("SELECT COUNT(*) AS n FROM pending_fs_ops").get()).toEqual({ n: 0 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
    expect(run(["config", "show"]).vault.path).toBe(vault);
  });
});
