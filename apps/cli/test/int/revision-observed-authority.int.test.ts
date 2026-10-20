import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviseHandoff } from "@sorage/core";
import { createNodeRevisionPorts } from "@sorage/adapters/src/handoff-command-ports";
import { openSorageDatabase, type SorageSqlite } from "@sorage/adapters/src/sqlite/connection";
import { cliData, memoCliFixture } from "../fixtures/memo-cli";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// Only the interleaving is controlled: the winner runs the native CLI on a
// separate connection, and the loser uses real SQLite, body ports and core.
describe("revision verification against superseded authority", () => {
  it.each(["content", "no-change", "partial-read"] as const)(
    "reports a conflict without loser effects when a winner commits during %s",
    (phase) => {
      const f = memoCliFixture();
      cleanups.push(f.cleanup);
      const sent = cliData<{ handoffs: Array<{ handoffId: string }> }>(
        f.run(["send", "--as-user", "--to", "other", "--title", "Authority race", "--body", "Original", "--json"]),
      );
      const handoff = sent.handoffs[0];
      assert(handoff);
      const id = handoff.handoffId;
      if (phase === "no-change")
        cliData(f.run(["review", "set", id, "--as", "other", "--text", "Revise this", "--json"]));
      const beforeVersion = phase === "no-change" ? 2 : 1;
      const winnerFile = join(f.work, "winner.md");
      const loserFile = join(f.work, "loser.md");
      writeFileSync(winnerFile, "Winner bytes\n");
      writeFileSync(loserFile, "Loser bytes\n");
      function state() {
        const staging = join(f.home, "vault", "staging");
        return {
          tables: Object.fromEntries(
            [
              "handoffs",
              "artifacts",
              "content_records",
              "review_notes",
              "events",
              "idempotency_keys",
              "pending_fs_ops",
            ].map((table) => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
          ),
          staging: existsSync(staging) ? readdirSync(staging).sort() : [],
        };
      }
      let armed = false;
      let won = false;
      let afterWinner: ReturnType<typeof state> | undefined;
      function win() {
        if (!armed || won) return;
        won = true;
        const result = cliData<{ rowVersion: number; revision: number }>(
          f.run([
            "revise",
            id,
            "--as-user",
            "--file",
            winnerFile,
            "--expected-row-version",
            String(beforeVersion),
            "--json",
          ]),
        );
        expect(result.rowVersion).toBe(beforeVersion + 1);
        expect(result.revision).toBe(2);
        afterWinner = state();
      }
      const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
      cleanups.push(() => db.close());
      const scheduledDb: SorageSqlite = {
        exec: db.exec.bind(db),
        close: db.close.bind(db),
        prepare<Row>(sql: string) {
          const statement = db.prepare<Row>(sql);
          if (
            phase !== "partial-read" ||
            !sql.startsWith("SELECT id, handoff_id, original_name, mime_type, content_record_id FROM artifacts")
          )
            return statement;
          return {
            all: statement.all.bind(statement),
            run: statement.run.bind(statement),
            ...(statement.finalize ? { finalize: statement.finalize.bind(statement) } : {}),
            get(...params: unknown[]) {
              // The Handoff row was read, but its old Artifact has not been.
              win();
              return statement.get(...params);
            },
          };
        },
      };
      const ports = createNodeRevisionPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home, database: scheduledDb });
      const digest = ports.digestSource;
      const verify = ports.artifact.verifyArtifactBody;
      if (phase === "content")
        ports.digestSource = (path) => {
          win();
          return digest(path);
        };
      if (phase === "no-change")
        ports.artifact.verifyArtifactBody = (artifactId, policy) => {
          win();
          return verify(artifactId, policy);
        };
      armed = true;
      const result = reviseHandoff(ports, {
        handoffId: id,
        path: f.work,
        userHome: f.home,
        as: undefined,
        asUser: true,
        expectedRowVersion: beforeVersion,
        ...(phase === "no-change" ? { noChange: true, reason: "No change" } : { file: loserFile }),
      });
      expect(won).toBe(true);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("ROW_VERSION_CONFLICT");
      expect(state()).toEqual(afterWinner);
      const current = cliData<{ rowVersion: number; revision: number; currentArtifact: { sha256: string } }>(
        f.run(["get", id, "--as-user", "--json"]),
      );
      expect(current.rowVersion).toBe(beforeVersion + 1);
      expect(current.revision).toBe(2);
      expect(current.currentArtifact.sha256).toBe(createHash("sha256").update("Winner bytes\n").digest("hex"));
      expect(
        f.db
          .prepare(
            "SELECT inline_text FROM content_records WHERE id = (SELECT content_record_id FROM artifacts WHERE handoff_id = ?)",
          )
          .get(id)?.inline_text,
      ).toBe("Winner bytes\n");
    },
  );
});
