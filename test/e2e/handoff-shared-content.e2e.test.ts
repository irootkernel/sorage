import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeTempDir, sorage } from "./helpers";

function fixture() {
  const home = makeTempDir("sorage-shared-handoff-");
  const dirs = { sender: join(home, "sender"), recipient: join(home, "recipient"), outsider: join(home, "outsider") };
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  type Actor = keyof typeof dirs;
  const run = (args: string[], actor: Actor = "sender") => {
    const result = sorage([...args, "--json"], { home, cwd: dirs[actor] });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const refuse = (args: string[], actor: Actor = "sender") => {
    const result = sorage([...args, "--json"], { home, cwd: dirs[actor] });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    return JSON.parse(result.stderr).error.code as string;
  };
  run(["init", "--vault", join(home, "vault"), "--non-interactive"]);
  for (const [name, dir] of Object.entries(dirs)) run(["project", "add", "--name", name, "--dir", dir]);
  const sql = <T>(read: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    db.exec("PRAGMA foreign_keys = ON");
    try {
      return read(db);
    } finally {
      db.close();
    }
  };
  const send = (bytes: Buffer, name: string) => {
    const path = join(dirs.sender, name);
    writeFileSync(path, bytes);
    return run(["send", "--to", "recipient", "--title", "Shared body", "--file", path]).data.handoffs[0];
  };
  const record = (id: string) =>
    sql(
      (db) =>
        db
          .prepare(
            "SELECT a.id AS artifact_id,c.* FROM handoffs h JOIN artifacts a ON a.id=h.current_artifact_id JOIN content_records c ON c.id=a.content_record_id WHERE h.id=?",
          )
          .get(id) as {
          id: string;
          artifact_id: string;
          inline_text: string | null;
          storage_key: string | null;
          size_bytes: number;
          sha256: string;
        },
    );
  const snapshot = () =>
    sql((db) =>
      ["handoffs", "artifacts", "content_records", "review_notes", "events", "pending_fs_ops", "idempotency_keys"].map(
        (table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ),
    );
  const events = (id: string) => run(["events", id]).data as Array<{ eventType: string }>;
  return { home, dirs, run, refuse, sql, send, record, snapshot, events };
}

function textBytes(size: number): Buffer {
  const prefix = Buffer.from("\uFEFF한글\r\n");
  return Buffer.concat([prefix, Buffer.alloc(size - prefix.length, 0x78)]);
}

const routing = [
  { name: "below threshold", file: "below.md", bytes: textBytes(65_535), inline: true },
  { name: "at threshold", file: "at.md", bytes: textBytes(65_536), inline: true },
  { name: "over threshold", file: "over.md", bytes: textBytes(65_537), inline: false },
  { name: "binary with UTF8 bytes", file: "image.png", bytes: Buffer.from("valid UTF8 stays binary"), inline: false },
  { name: "invalid UTF8 text file", file: "invalid.md", bytes: Buffer.from([0x61, 0xff, 0x00]), inline: false },
  { name: "direct body", file: null, bytes: Buffer.from("\uFEFF# Body\r\nno-final-newline"), inline: true },
];

describe("compiled Handoff producers and readable paths", () => {
  it.each(routing)(
    "preserves $name bytes through replay, cache repair and eligible fetch",
    ({ file, bytes, inline }) => {
      const f = fixture();
      const key = randomUUID();
      const args = ["send", "--to", "recipient", "--title", "Shared body", "--idempotency-key", key];
      if (file === null) args.push("--body", bytes.toString("utf8"));
      else {
        const path = join(f.dirs.sender, file);
        writeFileSync(path, bytes);
        args.push("--file", path);
      }
      const sent = f.run(args).data;
      const item = sent.handoffs[0];
      const row = f.record(item.handoffId);
      expect(Object.hasOwn(item, "storageKey")).toBe(true);
      expect(item.storageKey === null).toBe(inline);
      expect(row.id).not.toBe(row.artifact_id);
      expect(row.size_bytes).toBe(bytes.length);
      expect(row.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(row.inline_text === null).toBe(!inline);
      expect(f.run(args).data).toEqual({ ...sent, replayed: true });
      expect(
        f.events(item.handoffId).filter((event) => event.eventType === "ARTIFACT_FETCHED_FIRST_TIME"),
      ).toHaveLength(0);
      const sender = f.run(["fetch", item.handoffId]).data;
      expect(readFileSync(sender.localPath)).toEqual(bytes);
      if (inline) {
        expect(sender.localPath).toBe(join(f.home, "state", "fetch-cache", row.sha256));
        expect(statSync(sender.localPath).mode & 0o777).toBe(0o444);
        chmodSync(sender.localPath, 0o600);
        writeFileSync(sender.localPath, "damaged derived bytes");
        expect(f.run(["fetch", item.handoffId]).data.localPath).toBe(sender.localPath);
        expect(readFileSync(sender.localPath)).toEqual(bytes);
        unlinkSync(sender.localPath);
      }
      expect(
        f.events(item.handoffId).filter((event) => event.eventType === "ARTIFACT_FETCHED_FIRST_TIME"),
      ).toHaveLength(0);
      const fetched = f.run(["fetch", item.handoffId], "recipient").data;
      expect(readFileSync(fetched.localPath)).toEqual(bytes);
      expect(f.run(["fetch", item.handoffId], "recipient").data.localPath).toBe(fetched.localPath);
      expect(
        f.events(item.handoffId).filter((event) => event.eventType === "ARTIFACT_FETCHED_FIRST_TIME"),
      ).toHaveLength(1);
      expect(f.run(["get", item.handoffId], "recipient").data.rowVersion).toBe(1);
    },
  );

  it.each([
    { from: "inline", to: "inline" },
    { from: "inline", to: "file" },
    { from: "file", to: "inline" },
    { from: "file", to: "file" },
  ])("revises $from to $to and deletes logical content without manufactured file intents", ({ from, to }) => {
    const f = fixture();
    const initial = f.send(Buffer.from("# Initial\r\n"), from === "inline" ? "old.md" : "old.bin");
    const old = f.record(initial.handoffId);
    const replacement = Buffer.from("\uFEFF# Revised\r\nno-final-newline");
    const path = join(f.dirs.sender, to === "inline" ? "new.md" : "new.bin");
    writeFileSync(path, replacement);
    const revised = f.run(["revise", initial.handoffId, "--file", path, "--expected-row-version", "1"]).data;
    expect(revised).toMatchObject({ revision: 2, rowVersion: 2 });
    expect(revised.storageKey === null).toBe(to === "inline");
    const current = f.record(initial.handoffId);
    expect(current.id).not.toBe(old.id);
    expect(current.id).not.toBe(current.artifact_id);
    expect(current.artifact_id).not.toBe(old.artifact_id);
    expect(current.sha256).toBe(createHash("sha256").update(replacement).digest("hex"));
    f.sql((db) => {
      expect(db.prepare("SELECT id FROM content_records WHERE id=?").all(old.id)).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM artifacts").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM content_records").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM pending_fs_ops").get()).toEqual({ n: 0 });
    });
    if (old.storage_key !== null) expect(existsSync(join(f.home, "vault", old.storage_key))).toBe(false);
    const count = (type: string) => f.events(initial.handoffId).filter((event) => event.eventType === type).length;
    expect(count("ARTIFACT_ACTIVATED")).toBe(Number(from === "file") + Number(to === "file"));
    expect(count("ARTIFACT_UNLINKED")).toBe(Number(from === "file"));
    f.run(["review", "set", initial.handoffId, "--text", "Retained until deletion"], "recipient");
    f.run(["decline", initial.handoffId, "--reason", "Finished", "--expected-row-version", "3"], "recipient");
    f.run(["delete", "request", initial.handoffId, "--expected-row-version", "4"]);
    f.run(["delete", "approve", initial.handoffId, "--as-user", "--confirm", "--expected-row-version", "5"]);
    expect(f.run(["get", initial.handoffId, "--as-user"]).data.currentArtifact).toBeNull();
    f.sql((db) => {
      for (const table of ["artifacts", "content_records", "review_notes", "pending_fs_ops"]) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
    });
    expect(count("ARTIFACT_UNLINKED")).toBe(Number(from === "file") + Number(to === "file"));
  });

  it.each(["file", "inline-text", "inline-sha"] as const)(
    "refuses %s corruption across accept, both revise forms and deletion without mutation",
    (fault) => {
      const f = fixture();
      const original = "healthy body";
      const damaged = "damaged body";
      const item = f.send(Buffer.from(original), fault === "file" ? "old.bin" : "old.md");
      const record = f.record(item.handoffId);
      const leaf = fault === "file" ? join(f.home, "vault", item.storageKey) : null;
      if (leaf !== null) {
        expect(typeof item.storageKey).toBe("string");
        chmodSync(leaf, 0o600);
        writeFileSync(leaf, damaged);
      } else {
        expect(item.storageKey).toBeNull();
        f.sql((db) => {
          if (fault === "inline-text")
            db.prepare("UPDATE content_records SET inline_text=? WHERE id=?").run(damaged, record.id);
          else db.prepare("UPDATE content_records SET sha256=? WHERE id=?").run("0".repeat(64), record.id);
        });
      }
      let before = f.snapshot();
      expect(
        f.refuse(["accept", item.handoffId, "--expected-revision", "1", "--expected-row-version", "1"], "recipient"),
      ).toBe("ARTIFACT_CORRUPTED");
      expect(f.snapshot()).toEqual(before);
      const replacement = join(f.dirs.sender, "replacement.md");
      writeFileSync(replacement, "new body");
      expect(f.refuse(["revise", item.handoffId, "--file", replacement])).toBe("ARTIFACT_CORRUPTED");
      expect(f.snapshot()).toEqual(before);
      f.run(["review", "set", item.handoffId, "--text", "Needs review"], "recipient");
      before = f.snapshot();
      expect(f.refuse(["revise", item.handoffId, "--no-change", "--reason", "Keep it"])).toBe("ARTIFACT_CORRUPTED");
      expect(f.snapshot()).toEqual(before);
      f.run(["decline", item.handoffId, "--reason", "Finished", "--expected-row-version", "2"], "recipient");
      f.run(["delete", "request", item.handoffId, "--expected-row-version", "3"]);
      before = f.snapshot();
      expect(f.refuse(["delete", "approve", item.handoffId, "--as-user", "--confirm"])).toBe("ARTIFACT_CORRUPTED");
      expect(f.snapshot()).toEqual(before);
      if (leaf !== null) expect(readFileSync(leaf, "utf8")).toBe(damaged);
      else {
        const retained = f.record(item.handoffId);
        expect(retained.inline_text).toBe(fault === "inline-text" ? damaged : original);
        expect(retained.sha256).toBe(fault === "inline-sha" ? "0".repeat(64) : record.sha256);
      }
    },
  );

  it.each(["artifact", "record", "owner"] as const)(
    "resolves an invalid %s only after actor, filter and visible-page selection",
    (fault) => {
      const f = fixture();
      f.send(Buffer.from("first"), "one.md");
      f.send(Buffer.from("second"), "two.md");
      const ordered = f.run(["inbox", "--limit", "2"], "recipient").data.handoffs;
      const healthy = ordered[0].id as string;
      const damaged = ordered[1].id as string;
      const old = f.record(damaged);
      const healthyArtifact = f.record(healthy).artifact_id;
      // A separate fault connection breaks metadata; no operational connection
      // disables constraints, and the real CLI processes retain normal checks.
      f.sql((db) => {
        if (fault !== "owner") db.exec("PRAGMA foreign_keys = OFF");
        try {
          if (fault === "artifact") db.prepare("DELETE FROM artifacts WHERE id=?").run(old.artifact_id);
          else if (fault === "record") db.prepare("DELETE FROM content_records WHERE id=?").run(old.id);
          else db.prepare("UPDATE handoffs SET current_artifact_id=? WHERE id=?").run(healthyArtifact, damaged);
        } finally {
          db.exec("PRAGMA foreign_keys = ON");
        }
        expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
        if (fault === "owner") expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      });
      const before = f.snapshot();
      expect(f.refuse(["get", damaged], "outsider")).toBe("HANDOFF_NOT_FOUND");
      expect(f.run(["inbox"], "outsider").data.handoffs).toEqual([]);
      expect(f.run(["inbox", "--state", "accepted"], "recipient").data.handoffs).toEqual([]);
      const page = f.run(["inbox", "--limit", "1"], "recipient").data;
      expect(page.handoffs.map((row: { id: string }) => row.id)).toEqual([healthy]);
      expect(typeof page.nextCursor).toBe("string");
      expect(f.refuse(["inbox", "--cursor", page.nextCursor], "recipient")).toBe("ARTIFACT_CORRUPTED");
      expect(f.refuse(["get", damaged], "recipient")).toBe("ARTIFACT_CORRUPTED");
      expect(
        f.refuse(["accept", damaged, "--expected-revision", "99", "--expected-row-version", "99"], "recipient"),
      ).toBe("REVISION_CONFLICT");
      expect(
        f.refuse(["accept", damaged, "--expected-revision", "1", "--expected-row-version", "99"], "recipient"),
      ).toBe("ROW_VERSION_CONFLICT");
      expect(
        f.refuse(["accept", damaged, "--expected-revision", "1", "--expected-row-version", "1"], "recipient"),
      ).toBe("ARTIFACT_CORRUPTED");
      expect(f.snapshot()).toEqual(before);
    },
  );
});
