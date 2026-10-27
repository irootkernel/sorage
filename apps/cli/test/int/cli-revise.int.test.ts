import { observedHandoffFlags } from "../fixtures/handoff-observations";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The TASK-032 sender revision through the real CLI: content revision resolving the
 * Note atomically, the same-content refusal, the proactive correction, the bounded
 * no-change resolution, and the durability of the current Artifact across the swap.
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  return home;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ports: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
    outText(): string {
      return out.join("");
    },
    errText(): string {
      return err.join("");
    },
  };
}

function setup(physical = false): { home: string; workA: string; workB: string; handoffId: string } {
  const home = tempHome("sorage-revise-cli-");
  expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
  const workA = join(home, "work-a");
  const workB = join(home, "work-b");
  mkdirSync(workA, { recursive: true });
  mkdirSync(workB, { recursive: true });
  expect(runCli(["project", "add", "--name", "Alpha", "--dir", workA], capture().ports)).toBe(0);
  expect(runCli(["project", "add", "--name", "Beta", "--dir", workB], capture().ports)).toBe(0);
  const document = join(home, physical ? "brief.bin" : "brief.md");
  writeFileSync(document, "# Shared\n");
  const send = capture();
  const exit = runCli(
    [
      "send",
      "--as",
      "alpha",
      "--to",
      "beta",
      "--title",
      "Brief",
      "--file",
      document,
      "--allow-external-source",
      "--json",
    ],
    send.ports,
  );
  if (exit !== 0) throw new Error(`fixture send failed: ${send.errText()}`);
  const handoffId = (JSON.parse(send.outText()) as { data: { handoffs: Array<{ handoffId: string }> } }).data
    .handoffs[0]?.handoffId as string;
  return { home, workA, workB, handoffId };
}

describe("sorage revise", () => {
  it("revises content with atomic Note resolution and durable current Artifact", () => {
    const original = process.cwd();
    const { home, workA, workB, handoffId } = setup(true);

    process.chdir(workB);
    expect(
      runCli(
        [
          "review",
          "set",
          handoffId,
          "--text",
          "tighten the intro",
          "--json",
          ...observedHandoffFlags(handoffId, "both"),
        ],
        capture().ports,
      ),
    ).toBe(0);

    const replacement = join(home, "brief-v2.bin");
    writeFileSync(replacement, "# Shared, revised\n");
    process.chdir(workA);
    const revised = capture();
    const reviseExit = runCli(
      [
        "revise",
        handoffId,
        "--file",
        replacement,
        "--allow-external-source",
        "--json",
        ...observedHandoffFlags(handoffId, "row"),
      ],
      revised.ports,
    );
    if (reviseExit !== 0) throw new Error(`revise failed (${reviseExit}): ${revised.errText()}`);
    expect(reviseExit).toBe(0);
    const report = JSON.parse(revised.outText()) as {
      data: { revision: number; rowVersion: number; reviewState: string };
    };
    expect(report.data.revision).toBe(2);
    expect(report.data.rowVersion).toBe(3);
    expect(report.data.reviewState).toBe("awaiting_recipient");

    const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      const handoff = database
        .prepare("SELECT revision, row_version, review_state, current_artifact_id FROM handoffs WHERE id = ?")
        .get(handoffId) as { revision: number; row_version: number; review_state: string; current_artifact_id: string };
      expect(handoff.revision).toBe(2);
      expect(handoff.review_state).toBe("awaiting_recipient");
      const artifacts = database
        .prepare(
          "SELECT a.id AS id, c.materialized AS materialized, c.storage_key AS storage_key FROM artifacts a JOIN content_records c ON c.id = a.content_record_id WHERE a.handoff_id = ?",
        )
        .all(handoffId) as Array<{
        id: string;
        materialized: number;
        storage_key: string;
      }>;
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.id).toBe(handoff.current_artifact_id);
      expect(artifacts[0]?.materialized).toBe(1);
      expect(existsSync(join(home, "vault", artifacts[0]?.storage_key ?? ""))).toBe(true);
      const notes = database.prepare("SELECT COUNT(*) AS c FROM review_notes WHERE handoff_id = ?").get(handoffId) as {
        c: number;
      };
      expect(notes.c).toBe(1);
      expect(database.prepare("SELECT active FROM review_notes WHERE handoff_id = ?").get(handoffId)).toEqual({
        active: 0,
      });
      const intents = database.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get() as { c: number };
      expect(intents.c).toBe(0);
      const eventTypes = (
        database.prepare("SELECT event_type FROM events ORDER BY rowid").all() as Array<{ event_type: string }>
      ).map((row) => row.event_type);
      expect(eventTypes).toContain("HANDOFF_REVISED");
      expect(eventTypes).toContain("REVIEW_NOTE_RESOLVED");
      expect(eventTypes).toContain("ARTIFACT_ACTIVATED");
      expect(eventTypes).toContain("ARTIFACT_UNLINKED");
    } finally {
      database.close();
    }

    // The same content refuses and changes nothing.
    const same = capture();
    expect(
      runCli(
        [
          "revise",
          handoffId,
          "--file",
          replacement,
          "--allow-external-source",
          "--json",
          ...observedHandoffFlags(handoffId, "row"),
        ],
        same.ports,
      ),
    ).toBe(65);
    const refused = JSON.parse(same.errText()) as { error: { code: string } };
    expect(refused.error.code).toBe("NO_CONTENT_CHANGE");

    // Proactive correction keeps the state and increments the Revision.
    const replacement2 = join(home, "brief-v3.bin");
    writeFileSync(replacement2, "# Shared, proactively fixed\n");
    const proactive = capture();
    expect(
      runCli(
        [
          "revise",
          handoffId,
          "--file",
          replacement2,
          "--allow-external-source",
          "--json",
          ...observedHandoffFlags(handoffId, "row"),
        ],
        proactive.ports,
      ),
    ).toBe(0);
    const proactiveReport = JSON.parse(proactive.outText()) as { data: { revision: number; reviewState: string } };
    expect(proactiveReport.data.revision).toBe(3);
    expect(proactiveReport.data.reviewState).toBe("awaiting_recipient");
    process.chdir(original);
  });

  it("bounds the no-change resolution and refuses it without a Note", () => {
    const original = process.cwd();
    const { home, workA, workB, handoffId } = setup();

    process.chdir(workA);
    const withoutNote = capture();
    const noNoteExit = runCli(
      [
        "revise",
        handoffId,
        "--no-change",
        "--reason",
        "nothing to change",
        "--json",
        ...observedHandoffFlags(handoffId, "row"),
      ],
      withoutNote.ports,
    );
    if (noNoteExit !== 65) throw new Error(`no-note revise: ${noNoteExit}: ${withoutNote.errText()}`);
    expect(noNoteExit).toBe(65);
    expect((JSON.parse(withoutNote.errText()) as { error: { code: string } }).error.code).toBe("NO_REVIEW_NOTE");

    process.chdir(workB);
    expect(
      runCli(
        [
          "review",
          "set",
          handoffId,
          "--text",
          "please reconsider",
          "--json",
          ...observedHandoffFlags(handoffId, "both"),
        ],
        capture().ports,
      ),
    ).toBe(0);
    process.chdir(workA);
    const first = capture();
    expect(
      runCli(
        [
          "revise",
          handoffId,
          "--no-change",
          "--reason",
          "content already correct",
          "--json",
          ...observedHandoffFlags(handoffId, "row"),
        ],
        first.ports,
      ),
    ).toBe(0);
    const firstReport = JSON.parse(first.outText()) as { data: { reviewState: string; revision: number } };
    expect(firstReport.data.reviewState).toBe("awaiting_recipient");
    expect(firstReport.data.revision).toBe(1);

    // A second consecutive no-change resolution is impossible.
    process.chdir(workB);
    expect(
      runCli(
        ["review", "set", handoffId, "--text", "still wrong", "--json", ...observedHandoffFlags(handoffId, "both")],
        capture().ports,
      ),
    ).toBe(0);
    process.chdir(workA);
    const second = capture();
    expect(
      runCli(
        ["revise", handoffId, "--no-change", "--reason", "again", "--json", ...observedHandoffFlags(handoffId, "row")],
        second.ports,
      ),
    ).toBe(65);
    expect((JSON.parse(second.errText()) as { error: { code: string } }).error.code).toBe("NO_CHANGE_LIMIT");

    // A content revision after a no-change resolution resets the bound.
    const replacement = join(home, "brief-final.md");
    writeFileSync(replacement, "# Final content\n");
    expect(
      runCli(
        [
          "revise",
          handoffId,
          "--file",
          replacement,
          "--allow-external-source",
          "--json",
          ...observedHandoffFlags(handoffId, "row"),
        ],
        capture().ports,
      ),
    ).toBe(0);
    process.chdir(workB);
    expect(
      runCli(
        ["review", "set", handoffId, "--text", "one more look", "--json", ...observedHandoffFlags(handoffId, "both")],
        capture().ports,
      ),
    ).toBe(0);
    process.chdir(workA);
    const reset = capture();
    expect(
      runCli(
        [
          "revise",
          handoffId,
          "--no-change",
          "--reason",
          "correct after all",
          "--json",
          ...observedHandoffFlags(handoffId, "row"),
        ],
        reset.ports,
      ),
    ).toBe(0);
    process.chdir(original);
  });
});

function handoffIdOf(output: string): string {
  return (JSON.parse(output) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]
    ?.handoffId as string;
}

describe("the round-2 remediation regressions", () => {
  it("F001: a revise from outside the workspace refuses without the override and passes with it", () => {
    const original = process.cwd();
    const home = tempHome("sorage-revise-ext-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const work = join(home, "work");
    const outsider = mkdtempSync(join(tmpdir(), "sorage-revise-out-"));
    homes.push(outsider);
    mkdirSync(work, { recursive: true });
    mkdirSync(outsider, { recursive: true });
    expect(runCli(["project", "add", "--name", "Alpha", "--dir", work], capture().ports)).toBe(0);
    const document = join(home, "brief.md");
    writeFileSync(document, "# Shared\n");
    const send = capture();
    const exit = runCli(
      [
        "send",
        "--as",
        "alpha",
        "--to",
        "alpha",
        "--title",
        "Brief",
        "--file",
        document,
        "--allow-external-source",
        "--json",
      ],
      send.ports,
    );
    if (exit !== 0) throw new Error(`fixture send failed: ${send.errText()}`);
    const handoffId = handoffIdOf(send.outText());

    const replacement = join(home, "brief-v9.md");
    writeFileSync(replacement, "# From outside the workspace\n");
    process.chdir(work);
    const refused = capture();
    expect(
      runCli(
        ["revise", handoffId, "--file", replacement, "--json", ...observedHandoffFlags(handoffId, "row")],
        refused.ports,
      ),
    ).toBe(77);
    const report = JSON.parse(refused.errText()) as { error: { code: string } };
    expect(report.error.code).toBe("SOURCE_OUTSIDE_WORKSPACE");
    const allowed = capture();
    expect(
      runCli(
        [
          "revise",
          handoffId,
          "--file",
          replacement,
          "--allow-external-source",
          "--json",
          ...observedHandoffFlags(handoffId, "row"),
        ],
        allowed.ports,
      ),
    ).toBe(0);
    process.chdir(original);
  });

  it("the round-3 finding: a refused revise never copies bytes into Vault staging", () => {
    const original = process.cwd();
    const home = tempHome("sorage-revise-order-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    expect(runCli(["project", "add", "--name", "Alpha", "--dir", work], capture().ports)).toBe(0);
    const document = join(home, "brief.md");
    writeFileSync(document, "# Shared\n");
    const send = capture();
    const exit = runCli(
      [
        "send",
        "--as",
        "alpha",
        "--to",
        "alpha",
        "--title",
        "Brief",
        "--file",
        document,
        "--allow-external-source",
        "--json",
      ],
      send.ports,
    );
    if (exit !== 0) throw new Error(`fixture send failed: ${send.errText()}`);
    const handoffId = handoffIdOf(send.outText());

    // A same-content revise is refused and leaves staging empty: the digest answered
    // before any copy ran (the section 19 coordination order).
    process.chdir(work);
    const same = capture();
    expect(
      runCli(
        [
          "revise",
          handoffId,
          "--file",
          document,
          "--allow-external-source",
          "--json",
          ...observedHandoffFlags(handoffId, "row"),
        ],
        same.ports,
      ),
    ).toBe(65);
    const staging = join(home, "vault", "staging");
    expect(existsSync(staging) ? readdirSync(staging) : []).toHaveLength(0);

    // The same refused request under an idempotency key also stages nothing.
    const stale = capture();
    expect(
      runCli(
        [
          "revise",
          handoffId,
          "--file",
          document,
          "--allow-external-source",
          "--idempotency-key",
          "k-x",
          "--json",
          ...observedHandoffFlags(handoffId, "row"),
        ],
        stale.ports,
      ),
    ).toBe(65);
    expect(existsSync(staging) ? readdirSync(staging) : []).toHaveLength(0);
    process.chdir(original);
  });

  it("replays an identical revise under an idempotency key instead of failing on content or Row Version (AJ-08 step 4)", () => {
    const original = process.cwd();
    const home = tempHome("sorage-revise-replay-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    expect(runCli(["project", "add", "--name", "Alpha", "--dir", work], capture().ports)).toBe(0);
    const document = join(home, "brief.md");
    writeFileSync(document, "# Shared\n");
    const send = capture();
    const sendExit = runCli(
      [
        "send",
        "--as",
        "alpha",
        "--to",
        "alpha",
        "--title",
        "Brief",
        "--file",
        document,
        "--allow-external-source",
        "--json",
      ],
      send.ports,
    );
    if (sendExit !== 0) throw new Error(`fixture send failed: ${send.errText()}`);
    const handoffId = handoffIdOf(send.outText());

    process.chdir(work);
    const replacement = join(home, "brief-v2.md");
    writeFileSync(replacement, "# Shared, revised\n");
    const first = capture();
    const originalRequest = [
      "revise",
      handoffId,
      "--file",
      replacement,
      "--allow-external-source",
      "--idempotency-key",
      "k-rev-1",
      "--json",
      ...observedHandoffFlags(handoffId, "row"),
    ];
    expect(runCli(originalRequest, first.ports)).toBe(0);
    const firstReport = JSON.parse(first.outText()) as { data: { revision: number; replayed: boolean } };
    expect(firstReport.data.revision).toBe(2);
    expect(firstReport.data.replayed).toBe(false);

    // The identical retry would otherwise fail on NO_CONTENT_CHANGE; replay answers first.
    const second = capture();
    expect(runCli(originalRequest, second.ports)).toBe(0);
    const replayReport = JSON.parse(second.outText()) as { data: { revision: number; replayed: boolean } };
    expect(replayReport.data.replayed).toBe(true);
    expect(replayReport.data.revision).toBe(2);
    process.chdir(original);
  });
});

describe("sorage revise --body (CLI-012, HND-023)", () => {
  it("creates a Revision from inline text with the inline authoritative body and the HND-023 name", () => {
    const original = process.cwd();
    const { home, workA, handoffId } = setup();

    const body = "# Shared, revised inline\n";
    process.chdir(workA);
    const revised = capture();
    const exit = runCli(
      ["revise", handoffId, "--body", body, "--json", ...observedHandoffFlags(handoffId, "row")],
      revised.ports,
    );
    if (exit !== 0) throw new Error(`inline revise failed (${exit}): ${revised.errText()}`);
    const report = JSON.parse(revised.outText()) as { data: { revision: number; reviewState: string } };
    expect(report.data.revision).toBe(2);
    expect(report.data.reviewState).toBe("awaiting_recipient");

    const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      const artifact = database
        .prepare(
          "SELECT a.original_name AS originalName, a.stored_name AS storedName, a.mime_type AS mimeType, a.imported_from_path AS importedFromPath, c.inline_text AS inlineText, c.storage_key AS storageKey, c.materialized AS materialized, c.size_bytes AS sizeBytes, c.sha256 AS sha256 FROM artifacts a JOIN content_records c ON c.id = a.content_record_id WHERE a.handoff_id = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1",
        )
        .get(handoffId) as {
        originalName: string;
        storedName: string;
        mimeType: string;
        importedFromPath: string | null;
        inlineText: string;
        storageKey: string | null;
        materialized: number;
        sizeBytes: number;
        sha256: string;
      };
      // The staged-name contract of section 4: the title slug plus the revision
      // being created, indistinguishable in metadata from a file-backed body.
      expect(artifact.originalName).toBe("brief-2.md");
      expect(artifact.storedName).toBe("brief-2.md");
      expect(artifact.mimeType).toBe("text/markdown");
      expect(artifact.importedFromPath).toBeNull();
      expect(artifact.inlineText).toBe(body);
      expect(artifact.storageKey).toBeNull();
      expect(artifact.materialized).toBe(1);
      expect(artifact.sizeBytes).toBe(Buffer.byteLength(body, "utf8"));
      expect(artifact.sha256).toBe(createHash("sha256").update(body, "utf8").digest("hex"));
      const intents = database.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get() as { c: number };
      expect(intents.c).toBe(0);
    } finally {
      database.close();
    }
    process.chdir(original);
  });

  it("a second inline revise names the next revision, and identical content refuses with the body wording", () => {
    const original = process.cwd();
    const { workA, handoffId } = setup();

    process.chdir(workA);
    expect(
      runCli(
        ["revise", handoffId, "--body", "# Second take\n", "--json", ...observedHandoffFlags(handoffId, "row")],
        capture().ports,
      ),
    ).toBe(0);
    const third = capture();
    expect(
      runCli(
        ["revise", handoffId, "--body", "# Third take\n", "--json", ...observedHandoffFlags(handoffId, "row")],
        third.ports,
      ),
    ).toBe(0);
    const thirdReport = JSON.parse(third.outText()) as { data: { revision: number } };
    expect(thirdReport.data.revision).toBe(3);

    // The identical retry is refused before anything mutates, with the
    // parameterized first word of HND-015's message.
    const same = capture();
    expect(
      runCli(
        ["revise", handoffId, "--body", "# Third take\n", "--json", ...observedHandoffFlags(handoffId, "row")],
        same.ports,
      ),
    ).toBe(65);
    const refused = JSON.parse(same.errText()) as { error: { code: string; message: string } };
    expect(refused.error.code).toBe("NO_CONTENT_CHANGE");
    expect(refused.error.message).toContain("the supplied body carries the current Artifact's SHA-256");
    process.chdir(original);
  });

  it("refuses a lone-surrogate body with send's coded CONFIG_INVALID, staging nothing", () => {
    const original = process.cwd();
    const { home, workA, handoffId } = setup();

    process.chdir(workA);
    const refused = capture();
    // The argv boundary cannot carry this text; through the in-process CLI the
    // core guard answers with send's exact refusal (SHR-003).
    expect(
      runCli(
        ["revise", handoffId, "--body", "broken \uD800 surrogate", "--json", ...observedHandoffFlags(handoffId, "row")],
        refused.ports,
      ),
    ).toBe(78);
    const report = JSON.parse(refused.errText()) as { error: { code: string; message: string } };
    expect(report.error.code).toBe("CONFIG_INVALID");
    expect(report.error.message).toBe(
      "the --body text cannot be stored byte-exactly; it contains an unpaired surrogate",
    );
    const staging = join(home, "vault", "staging");
    expect(existsSync(staging) ? readdirSync(staging) : []).toHaveLength(0);
    process.chdir(original);
  });

  it("stages an above-threshold body as a Vault copy with an activate intent and a storageKey", () => {
    const original = process.cwd();
    const { home, workA, handoffId } = setup();

    const body = `${"x".repeat(69_999)}\n`;
    process.chdir(workA);
    const revised = capture();
    const exit = runCli(
      ["revise", handoffId, "--body", body, "--json", ...observedHandoffFlags(handoffId, "row")],
      revised.ports,
    );
    if (exit !== 0) throw new Error(`above-threshold revise failed (${exit}): ${revised.errText()}`);
    const report = JSON.parse(revised.outText()) as { data: { revision: number; storageKey: string | null } };
    expect(report.data.revision).toBe(2);
    expect(report.data.storageKey).not.toBeNull();

    const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      const record = database
        .prepare(
          "SELECT c.inline_text AS inlineText, c.storage_key AS storageKey, c.materialized AS materialized FROM artifacts a JOIN content_records c ON c.id = a.content_record_id WHERE a.handoff_id = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1",
        )
        .get(handoffId) as { inlineText: string | null; storageKey: string | null; materialized: number };
      expect(record.inlineText).toBeNull();
      expect(record.storageKey).not.toBeNull();
      expect(existsSync(join(home, "vault", record.storageKey ?? ""))).toBe(true);
      expect(record.materialized).toBe(1);
      const intents = database.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get() as { c: number };
      expect(intents.c).toBe(0);
      const eventTypes = (
        database.prepare("SELECT event_type FROM events ORDER BY rowid").all() as Array<{ event_type: string }>
      ).map((row) => row.event_type);
      expect(eventTypes).toContain("ARTIFACT_ACTIVATED");
    } finally {
      database.close();
    }
    process.chdir(original);
  });

  it("refuses every non-exactly-one source combination and a blank body with usage errors", () => {
    const original = process.cwd();
    const { home, workA, handoffId } = setup();
    const bothFile = join(home, "brief-both.md");
    writeFileSync(bothFile, "# Both\n");

    process.chdir(workA);
    for (const argv of [
      ["revise", handoffId, "--body", "text", "--file", bothFile],
      ["revise", handoffId, "--body", "text", "--no-change"],
      ["revise", handoffId, "--file", bothFile, "--no-change"],
      ["revise", handoffId],
    ]) {
      const usage = capture();
      expect(runCli(argv, usage.ports)).toBe(2);
      expect(usage.errText()).toBe(
        "sorage: revise takes exactly one of --body, --file or --no-change\nRun 'sorage --help' for usage.\n",
      );
    }
    const blank = capture();
    expect(runCli(["revise", handoffId, "--body", "   ", ...observedHandoffFlags(handoffId, "row")], blank.ports)).toBe(
      2,
    );
    expect(blank.errText()).toBe("sorage: the --body text must not be empty\nRun 'sorage --help' for usage.\n");
    process.chdir(original);
  });

  it("replays an identical inline revise under an idempotency key", () => {
    const original = process.cwd();
    const { workA, handoffId } = setup();

    process.chdir(workA);
    const first = capture();
    const originalRequest = [
      "revise",
      handoffId,
      "--body",
      "# Keyed inline\n",
      "--idempotency-key",
      "k-body-1",
      "--json",
      ...observedHandoffFlags(handoffId, "row"),
    ];
    expect(runCli(originalRequest, first.ports)).toBe(0);
    const firstReport = JSON.parse(first.outText()) as { data: { revision: number; replayed: boolean } };
    expect(firstReport.data.revision).toBe(2);
    expect(firstReport.data.replayed).toBe(false);

    // The identical retry would otherwise be NO_CONTENT_CHANGE; the replay answers first.
    const second = capture();
    expect(runCli(originalRequest, second.ports)).toBe(0);
    const replayReport = JSON.parse(second.outText()) as { data: { revision: number; replayed: boolean } };
    expect(replayReport.data.replayed).toBe(true);
    expect(replayReport.data.revision).toBe(2);
    process.chdir(original);
  });

  it("answers a no-change resolution without --reason with the CLI's CONFIG_INVALID envelope", () => {
    const original = process.cwd();
    const { workA, workB, handoffId } = setup();

    process.chdir(workB);
    expect(
      runCli(
        [
          "review",
          "set",
          handoffId,
          "--text",
          "please reconsider",
          "--json",
          ...observedHandoffFlags(handoffId, "both"),
        ],
        capture().ports,
      ),
    ).toBe(0);
    process.chdir(workA);
    const refused = capture();
    expect(
      runCli(["revise", handoffId, "--no-change", "--json", ...observedHandoffFlags(handoffId, "row")], refused.ports),
    ).toBe(78);
    const report = JSON.parse(refused.errText()) as { error: { code: string; message: string } };
    expect(report.error.code).toBe("CONFIG_INVALID");
    expect(report.error.message).toBe("the no-change resolution requires a --reason");
    process.chdir(original);
  });
});
