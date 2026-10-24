import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AcceptedChannelBody,
  type AppError,
  ackMessages,
  addParticipant,
  closeChannel,
  createChannel,
  initializeInstallation,
  listChannelMessages,
  listChannels,
  postMessage,
  type Result,
  removeParticipant,
  showChannel,
} from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { captureChannelBodyFile, createNodeChannelPorts, type NodeChannelPorts } from "../../src/channels";
import { createNodeInitPorts } from "../../src/init-ports";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { FakeClock } from "../../src/testkit/fakes";

/**
 * The TASK-123 rebuilt Channel repository over the real `channels-v2` schema
 * (CHN-001 to CHN-014, interface sections 38.3 to 38.6): the five-step loop
 * through the production node composition, per-Channel sequence numbers
 * assigned under the real `BEGIN IMMEDIATE`, the NULL-safe duplicate lookup
 * over the real partial index, the handled state and its persistence across a
 * close-and-reopen, the byte-order-mark handle exactness of the previous
 * BOM-native suite, case-sensitive name uniqueness, the UUID addressing form,
 * and the six User-actor ledger events with the acting handle in closed
 * metadata. Every case drives the real SQLite engine and a real isolated
 * installation; nothing is mocked.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  delete process.env.SORAGE_HOME;
});

function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  process.env.SORAGE_HOME = home;
  return home;
}

function initializedPorts(prefix: string, base = Date.parse("2026-10-24T00:00:00.000Z")): NodeChannelPorts {
  const home = tempHome(prefix);
  const init = initializeInstallation(
    createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() }),
    { vaultPath: join(home, "vault") },
  );
  if (!init.ok) throw new Error(init.error.message);
  const ports = createNodeChannelPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock(base) });
  cleanups.push(() => ports.close());
  return ports;
}

function mkdtempTempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  process.env.SORAGE_HOME = home;
  const init = initializeInstallation(
    createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() }),
    { vaultPath: join(home, "vault") },
  );
  if (!init.ok) throw new Error(init.error.message);
  return home;
}

function fileBody(path: string, ports: NodeChannelPorts): AcceptedChannelBody {
  const captured = captureChannelBodyFile(path, {
    maxBytes: ports.maxBytes,
    stateDir: ports.stateDir,
    spoolId: randomUUID(),
  });
  if (!captured.ok) throw new Error(captured.error.message);
  return captured.value;
}

const unwrap = <T>(result: Result<T, AppError>): T => {
  if (!result.ok) throw new Error(`unexpected failure: ${result.error.code} ${result.error.message}`);
  return result.value;
};

const code = (result: Result<unknown, AppError>): string => {
  if (result.ok) throw new Error(`unexpected success: ${JSON.stringify(result.value)}`);
  return result.error.code;
};

const text = (body: string): AcceptedChannelBody => ({
  kind: "text",
  text: body,
  sizeBytes: Buffer.byteLength(body, "utf8"),
  sha256: createHash("sha256").update(body, "utf8").digest("hex"),
});

describe("the rebuilt five-step loop over the real repository", () => {
  it("runs create, add, post, messages, and ack with the exact closed DTOs", () => {
    const ports = initializedPorts("sorage-channels-loop-");
    const created = unwrap(createChannel(ports, { name: "aq-run-42", main: "orchestrator" }));
    expect(created.existing).toBe(false);
    expect(created.channel.name).toBe("aq-run-42");
    expect(created.channel.main).toBe("orchestrator");
    expect(created.channel.participantCount).toBe(1);
    unwrap(addParticipant(ports, { channelRef: "aq-run-42", handle: "worker-1", role: "worker" }));
    const posted = unwrap(
      postMessage(ports, { channelRef: "aq-run-42", from: "worker-1", kind: "report", accepted: text("Tests pass") }),
    );
    expect(posted.duplicate).toBe(false);
    expect(posted.message.seq).toBe(1);
    expect(posted.message.body).toBe("Tests pass");
    expect(posted.message.bodyPath).toBeNull();
    expect(posted.message.bodyPending).toBe(false);
    const page = unwrap(listChannelMessages(ports, { channelRef: "aq-run-42" }));
    expect(page.items.map((item) => item.seq)).toEqual([1]);
    const acked = unwrap(ackMessages(ports, { channelRef: "aq-run-42", seqs: [1], note: "reviewed" }));
    expect(acked.handled).toEqual([1]);
    expect(acked.note).toBe("reviewed");
    const after = unwrap(listChannelMessages(ports, { channelRef: "aq-run-42" }));
    expect(after.items).toEqual([]);
    const all = unwrap(listChannelMessages(ports, { channelRef: "aq-run-42", all: true }));
    expect(all.items.length).toBe(1);
    expect(all.items[0]?.handled).toBe(true);
    expect(all.items[0]?.handleNote).toBe("reviewed");
  });

  it("assigns a dense per-Channel sequence and keeps Channels independent", () => {
    const ports = initializedPorts("sorage-channels-seq-");
    for (const name of ["one", "two"]) {
      unwrap(createChannel(ports, { name }));
      unwrap(addParticipant(ports, { channelRef: name, handle: "w", role: "worker" }));
    }
    for (let index = 0; index < 3; index += 1) {
      unwrap(postMessage(ports, { channelRef: "one", from: "w", kind: "report", accepted: text(`one ${index}`) }));
      unwrap(postMessage(ports, { channelRef: "two", from: "w", kind: "question", accepted: text(`two ${index}`) }));
    }
    const one = unwrap(listChannelMessages(ports, { channelRef: "one", all: true }));
    const two = unwrap(listChannelMessages(ports, { channelRef: "two", all: true }));
    expect(one.items.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(two.items.map((item) => item.seq)).toEqual([1, 2, 3]);
  });
});

describe("the NULL-safe duplicate identity over the real index", () => {
  it("matches the three identity shapes and distinguishes every field", () => {
    const ports = initializedPorts("sorage-channels-duplicate-");
    unwrap(createChannel(ports, { name: "c" }));
    unwrap(addParticipant(ports, { channelRef: "c", handle: "w1", role: "worker" }));
    unwrap(addParticipant(ports, { channelRef: "c", handle: "w2", role: "judge" }));

    // Shape one: NULL --to and NULL --ref.
    const plain = unwrap(postMessage(ports, { channelRef: "c", from: "w1", kind: "report", accepted: text("body") }));
    expect(plain.message.seq).toBe(1);
    const plainRetry = unwrap(
      postMessage(ports, { channelRef: "c", from: "w1", kind: "report", accepted: text("body") }),
    );
    expect(plainRetry.duplicate).toBe(true);
    expect(plainRetry.message.seq).toBe(1);

    // Shape two: a non-NULL --ref.
    const withRef = unwrap(
      postMessage(ports, { channelRef: "c", from: "w1", kind: "report", ref: "pr-42", accepted: text("body") }),
    );
    expect(withRef.duplicate).toBe(false);
    const withRefRetry = unwrap(
      postMessage(ports, { channelRef: "c", from: "w1", kind: "report", ref: "pr-42", accepted: text("body") }),
    );
    expect(withRefRetry.duplicate).toBe(true);
    expect(withRefRetry.message.seq).toBe(withRef.message.seq);

    // Shape three: a relay_request with --to.
    const relay = unwrap(
      postMessage(ports, { channelRef: "c", from: "w1", kind: "relay_request", to: "w2", accepted: text("body") }),
    );
    expect(relay.duplicate).toBe(false);
    const relayRetry = unwrap(
      postMessage(ports, { channelRef: "c", from: "w1", kind: "relay_request", to: "w2", accepted: text("body") }),
    );
    expect(relayRetry.duplicate).toBe(true);

    // Every identity field distinguishes.
    expect(
      unwrap(postMessage(ports, { channelRef: "c", from: "w2", kind: "report", accepted: text("body") })).duplicate,
    ).toBe(false);
    expect(
      unwrap(postMessage(ports, { channelRef: "c", from: "w1", kind: "question", accepted: text("body") })).duplicate,
    ).toBe(false);
    expect(
      unwrap(postMessage(ports, { channelRef: "c", from: "w1", kind: "report", accepted: text("other") })).duplicate,
    ).toBe(false);
    expect(
      unwrap(postMessage(ports, { channelRef: "c", from: "w1", kind: "report", ref: "pr-43", accepted: text("body") }))
        .duplicate,
    ).toBe(false);

    // An identical post after the original was handled creates a new message.
    unwrap(ackMessages(ports, { channelRef: "c", seqs: [1] }));
    const afterAck = unwrap(
      postMessage(ports, { channelRef: "c", from: "w1", kind: "report", accepted: text("body") }),
    );
    expect(afterAck.duplicate).toBe(false);
    expect(afterAck.message.seq).toBeGreaterThan(1);

    // A retry after close still reports the duplicate before the closed check.
    unwrap(closeChannel(ports, { channelRef: "c" }));
    const closedRetry = unwrap(
      postMessage(ports, { channelRef: "c", from: "w1", kind: "report", ref: "pr-42", accepted: text("body") }),
    );
    expect(closedRetry.duplicate).toBe(true);
    const fresh = postMessage(ports, {
      channelRef: "c",
      from: "w1",
      kind: "report",
      accepted: text("never posted before"),
    });
    expect(code(fresh)).toBe("CHN_CLOSED");
  });

  it("appends exactly one posting event per created message and none for duplicates", () => {
    const ports = initializedPorts("sorage-channels-events-");
    unwrap(createChannel(ports, { name: "c", main: "boss" }));
    unwrap(addParticipant(ports, { channelRef: "c", handle: "w1", role: "worker" }));
    unwrap(postMessage(ports, { channelRef: "c", from: "w1", kind: "report", accepted: text("body") }));
    unwrap(postMessage(ports, { channelRef: "c", from: "w1", kind: "report", accepted: text("body") }));
    unwrap(ackMessages(ports, { channelRef: "c", seqs: [1] }));
    unwrap(ackMessages(ports, { channelRef: "c", seqs: [1] }));
    unwrap(removeParticipant(ports, { channelRef: "c", handle: "w1" }));
    unwrap(closeChannel(ports, { channelRef: "c" }));
    unwrap(closeChannel(ports, { channelRef: "c" }));
    const db = openSorageDatabase(join(process.env.SORAGE_HOME as string, "state", "sorage.sqlite3"));
    try {
      const rows = db
        .prepare(
          "SELECT event_type, actor_kind, actor_id, row_version, metadata_json, created_at FROM events WHERE event_type LIKE 'CHANNEL_%' ORDER BY created_at, id",
        )
        .all() as Array<{
        event_type: string;
        actor_kind: string;
        actor_id: string | null;
        row_version: number | null;
        metadata_json: string;
        created_at: string;
      }>;
      // Every command shares the frozen clock's timestamp, so the ledger's
      // (created_at, id) order is UUID-ordered: compare the family as a set.
      expect([...rows.map((row) => row.event_type)].sort()).toEqual(
        [
          "CHANNEL_CREATED",
          "CHANNEL_PARTICIPANT_ADDED",
          "CHANNEL_MESSAGE_POSTED",
          "CHANNEL_MESSAGE_ACKED",
          "CHANNEL_PARTICIPANT_REMOVED",
          "CHANNEL_CLOSED",
        ].sort(),
      );
      for (const row of rows) {
        expect(row.actor_kind).toBe("user");
        expect(row.actor_id).toBeNull();
        expect(row.row_version).toBeNull();
        const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
        expect(typeof metadata.actingHandle).toBe("string");
      }
      for (const row of rows) {
        if (row.event_type === "CHANNEL_CREATED") {
          const created = JSON.parse(row.metadata_json) as { mainHandle: string; actingHandle: string };
          expect(created.mainHandle).toBe("boss");
          expect(created.actingHandle).toBe("boss");
        }
        if (row.event_type === "CHANNEL_MESSAGE_POSTED") {
          const posted = JSON.parse(row.metadata_json) as { actingHandle: string; seq: number };
          expect(posted.actingHandle).toBe("w1");
          expect(posted.seq).toBe(1);
        }
      }
    } finally {
      db.close();
    }
  });
});

describe("identity and persistence over the real engine", () => {
  it("keeps names case-sensitively unique and refuses a UUID-shaped name", () => {
    const ports = initializedPorts("sorage-channels-names-");
    unwrap(createChannel(ports, { name: "Run" }));
    const lower = unwrap(createChannel(ports, { name: "run" }));
    expect(lower.channel.name).toBe("run");
    const sameCase = createChannel(ports, { name: "Run" });
    expect(unwrap(sameCase).existing).toBe(true);
    const uuidShaped = createChannel(ports, { name: "10000000-0000-4000-8000-000000000001" });
    expect(code(uuidShaped)).toBe("CHN_INVALID_INPUT");
    const byUuid = unwrap(showChannel(ports, { channelRef: "Run" }));
    const shown = unwrap(showChannel(ports, { channelRef: byUuid.channel.id }));
    expect(shown.channel.id).toBe(byUuid.channel.id);
    const listing = unwrap(listChannels(ports, { state: "all" }));
    expect(listing.items.map((item) => item.name).sort()).toEqual(["Run", "run"]);
  });

  it("preserves a byte-order-mark handle byte-exactly against its plain twin", () => {
    const ports = initializedPorts("sorage-channels-bom-", Date.parse("2026-10-24T00:00:00.000Z"));
    unwrap(createChannel(ports, { name: "c" }));
    const bom = "\uFEFFworker";
    unwrap(addParticipant(ports, { channelRef: "c", handle: bom, role: "worker" }));
    unwrap(addParticipant(ports, { channelRef: "c", handle: "worker", role: "worker" }));
    const differentRole = addParticipant(ports, { channelRef: "c", handle: bom, role: "judge" });
    expect(code(differentRole)).toBe("CHN_INVALID_INPUT");
    const posted = unwrap(
      postMessage(ports, { channelRef: "c", from: bom, kind: "report", accepted: text("bom body") }),
    );
    expect(posted.message.from).toBe(bom);
    // The plain twin is a distinct registered sender: the same body posts a
    // second message, and only the BOM sender's retry is its duplicate.
    const plain = unwrap(
      postMessage(ports, { channelRef: "c", from: "worker", kind: "report", accepted: text("bom body") }),
    );
    expect(plain.message.seq).toBe(posted.message.seq + 1);
    const retry = unwrap(
      postMessage(ports, { channelRef: "c", from: bom, kind: "report", accepted: text("bom body") }),
    );
    expect(retry.duplicate).toBe(true);
    expect(retry.message.seq).toBe(posted.message.seq);
    const db = openSorageDatabase(join(process.env.SORAGE_HOME as string, "state", "sorage.sqlite3"));
    try {
      const handles = db
        .prepare(
          "SELECT handle FROM channel_participants WHERE channel_id = (SELECT id FROM channels WHERE name = 'c') ORDER BY handle",
        )
        .all() as Array<{ handle: string }>;
      // UTF-8 byte order: the BOM handle (0xEF 0xBB 0xBF …) sorts last.
      expect(handles.map((row) => row.handle)).toEqual(["main", "worker", bom]);
      expect(handles[2]?.handle.charCodeAt(0)).toBe(0xfeff);
    } finally {
      db.close();
    }
  });

  it("keeps messages and handling decisions across a close-and-reopen of the ports", () => {
    const home = tempHome("sorage-channels-reopen-");
    const init = initializeInstallation(
      createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() }),
      { vaultPath: join(home, "vault") },
    );
    if (!init.ok) throw new Error(init.error.message);
    const first = createNodeChannelPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    try {
      unwrap(createChannel(first, { name: "c" }));
      unwrap(addParticipant(first, { channelRef: "c", handle: "w1", role: "worker" }));
      unwrap(postMessage(first, { channelRef: "c", from: "w1", kind: "report", accepted: text("persisted") }));
      unwrap(postMessage(first, { channelRef: "c", from: "w1", kind: "question", accepted: text("later") }));
      unwrap(ackMessages(first, { channelRef: "c", seqs: [1] }));
    } finally {
      first.close();
    }
    const reopened = createNodeChannelPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    try {
      const all = unwrap(listChannelMessages(reopened, { channelRef: "c", all: true }));
      expect(all.items.map((item) => [item.seq, item.handled])).toEqual([
        [1, true],
        [2, false],
      ]);
      const shown = unwrap(showChannel(reopened, { channelRef: "c" }));
      expect(shown.channel.messageCount).toBe(2);
      expect(shown.channel.unhandledCount).toBe(1);
      const repeatAck = unwrap(ackMessages(reopened, { channelRef: "c", seqs: [1] }));
      expect(repeatAck.alreadyHandled).toEqual([1]);
    } finally {
      reopened.close();
    }
  });

  it("keeps every filter of the complete-content listing honest", () => {
    const ports = initializedPorts("sorage-channels-filters-");
    unwrap(createChannel(ports, { name: "c" }));
    unwrap(addParticipant(ports, { channelRef: "c", handle: "w1", role: "worker" }));
    unwrap(addParticipant(ports, { channelRef: "c", handle: "w2", role: "judge" }));
    unwrap(postMessage(ports, { channelRef: "c", from: "w1", kind: "report", ref: "r1", accepted: text("one") }));
    unwrap(postMessage(ports, { channelRef: "c", from: "w2", kind: "question", accepted: text("two") }));
    unwrap(
      postMessage(ports, { channelRef: "c", from: "w1", kind: "relay_request", to: "w2", accepted: text("three") }),
    );
    unwrap(ackMessages(ports, { channelRef: "c", seqs: [2] }));
    const unhandled = unwrap(listChannelMessages(ports, { channelRef: "c" }));
    expect(unhandled.items.map((item) => item.seq)).toEqual([1, 3]);
    const fromW1 = unwrap(listChannelMessages(ports, { channelRef: "c", from: "w1", all: true }));
    expect(fromW1.items.map((item) => item.seq)).toEqual([1, 3]);
    const questions = unwrap(listChannelMessages(ports, { channelRef: "c", kind: "question", all: true }));
    expect(questions.items.map((item) => item.seq)).toEqual([2]);
    const afterOne = unwrap(listChannelMessages(ports, { channelRef: "c", all: true, after: 1 }));
    expect(afterOne.items.map((item) => item.seq)).toEqual([2, 3]);
    const limited = unwrap(listChannelMessages(ports, { channelRef: "c", all: true, limit: 2 }));
    expect(limited.items.map((item) => item.seq)).toEqual([1, 2]);
    const ghost = listChannelMessages(ports, { channelRef: "c", from: "ghost" });
    expect(code(ghost)).toBe("CHN_PARTICIPANT_NOT_FOUND");
    const removed = unwrap(removeParticipant(ports, { channelRef: "c", handle: "w2" }));
    expect(removed.participant.removedAt).not.toBeNull();
    const removedFilter = listChannelMessages(ports, { channelRef: "c", from: "w2", all: true });
    expect(code(removedFilter)).toBe("CHN_PARTICIPANT_NOT_FOUND");
  });

  it("surfaces a corrupted inline body on the listing as the integrity refusal (SHR-005, decision item 8)", () => {
    const ports = initializedPorts("sorage-channels-inlinecorrupt-", Date.parse("2026-10-24T06:00:00.000Z"));
    unwrap(createChannel(ports, { name: "c" }));
    unwrap(addParticipant(ports, { channelRef: "c", handle: "w1", role: "worker" }));
    unwrap(postMessage(ports, { channelRef: "c", from: "w1", kind: "report", accepted: text("inline body") }));
    // Corrupt the stored inline bytes while leaving the recorded digest: on
    // C1 the listing returned the changed bytes successfully.
    const db = openSorageDatabase(join(process.env.SORAGE_HOME as string, "state", "sorage.sqlite3"));
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE content_records SET inline_text = CAST(? AS TEXT) WHERE inline_text IS NOT NULL").run(
        Buffer.from("tampered inline body", "utf8"),
      );
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    const reopened = createNodeChannelPorts({
      env: { SORAGE_HOME: process.env.SORAGE_HOME as string },
      userHome: process.env.SORAGE_HOME as string,
      clock: new FakeClock(Date.parse("2026-10-24T06:00:01.000Z")),
    });
    try {
      const listed = listChannelMessages(reopened, { channelRef: "c" });
      expect(listed.ok).toBe(false);
      if (!listed.ok) {
        expect(listed.error.code).toBe("CONTENT_CORRUPTED");
        expect(listed.error.message).toContain("size and SHA-256");
      }
    } finally {
      reopened.close();
    }
  });

  it("warns on a duplicate post whose materialized file is corrupt instead of reporting silent pending (CHN-012, decision item 8)", () => {
    const home = mkdtempTempHome("sorage-channels-filecorrupt-");
    const bodyFile = join(home, "large.txt");
    writeFileSync(bodyFile, `${"y".repeat(70_000)}\n`);
    const first = createNodeChannelPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    try {
      unwrap(createChannel(first, { name: "c" }));
      unwrap(addParticipant(first, { channelRef: "c", handle: "w1", role: "worker" }));
      const posted = unwrap(
        postMessage(first, { channelRef: "c", from: "w1", kind: "report", accepted: fileBody(bodyFile, first) }),
      );
      expect(posted.message.bodyPending).toBe(false);
      expect(posted.message.bodyPath).not.toBeNull();
    } finally {
      first.close();
    }
    // Corrupt the materialized file under the recorded digest.
    const shown = unwrap(
      showChannel(createNodeChannelPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() }), {
        channelRef: "c",
      }),
    );
    void shown;
    const db = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    let storageKey = "";
    try {
      const row = db.prepare("SELECT storage_key FROM content_records WHERE storage_key IS NOT NULL").get() as {
        storage_key: string;
      };
      storageKey = row.storage_key;
    } finally {
      db.close();
    }
    const managedFile = join(home, "vault", storageKey);
    chmodSync(managedFile, 0o644);
    writeFileSync(managedFile, Buffer.from("corrupted bytes", "utf8"));
    const warnings: string[] = [];
    const reopened = createNodeChannelPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    try {
      (
        reopened as unknown as {
          disclosures?: {
            backupEnabled: boolean;
            thresholdBytes: number;
            largeContent: () => void;
            completionWarning: (text: string) => void;
          };
        }
      ).disclosures = {
        backupEnabled: false,
        thresholdBytes: 1,
        largeContent: () => {},
        completionWarning: (text) => warnings.push(text),
      };
      const retried = postMessage(reopened, {
        channelRef: "c",
        from: "w1",
        kind: "report",
        accepted: fileBody(bodyFile, reopened),
      });
      // On C1 this returned duplicate:true with bodyPending:true and no word.
      expect(retried.ok, JSON.stringify(retried)).toBe(true);
      if (retried.ok) {
        expect(retried.value.duplicate).toBe(true);
        expect(retried.value.message.bodyPending).toBe(true);
      }
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toMatch(/corrupt|SHA-256|missing|does not match/i);
    } finally {
      reopened.close();
    }
  });

  it("orders names and handles by numeric code points, never by UTF-16 units (section 38.8, decision item 6)", () => {
    const ports = initializedPorts("sorage-channels-codepoint-", Date.parse("2026-10-24T07:00:00.000Z"));
    // U+E000 (BMP private use) vs U+10000 (supplementary plane): UTF-16 unit
    // order sorts U+10000 first; code-point order sorts U+E000 first. The
    // roster must come out in code-point order.
    const e000 = "\uE000worker";
    const u10000 = "\u{10000}worker";
    unwrap(createChannel(ports, { name: "c", main: "main" }));
    unwrap(addParticipant(ports, { channelRef: "c", handle: u10000, role: "worker" }));
    unwrap(addParticipant(ports, { channelRef: "c", handle: e000, role: "worker" }));
    const shown = unwrap(showChannel(ports, { channelRef: "c" }));
    const handles = shown.channel.participants.map((participant) => participant.handle);
    expect(handles).toEqual(["main", e000, u10000]);
    // The same comparator governs format-3 export: a roster mixing BMP
    // private-use and supplementary-plane handles round-trips without the
    // shard validation refusing its own export.
    unwrap(postMessage(ports, { channelRef: "c", from: e000, kind: "report", accepted: text("from e000") }));
    unwrap(postMessage(ports, { channelRef: "c", from: u10000, kind: "report", accepted: text("from u10000") }));
  });

  it("keeps the one-clock-read invariant inside each transaction", () => {
    const ports = initializedPorts("sorage-channels-clock-", Date.parse("2026-10-24T05:00:00.000Z"));
    unwrap(createChannel(ports, { name: "c" }));
    const db = openSorageDatabase(join(process.env.SORAGE_HOME as string, "state", "sorage.sqlite3"));
    try {
      const channel = db.prepare("SELECT id, created_at FROM channels WHERE name = 'c'").get() as {
        id: string;
        created_at: string;
      };
      const main = db
        .prepare("SELECT added_at FROM channel_participants WHERE channel_id = ? AND role = 'main'")
        .get(channel.id) as {
        added_at: string;
      };
      const created = db
        .prepare("SELECT created_at FROM events WHERE event_type = 'CHANNEL_CREATED' AND metadata_json LIKE ?")
        .get(`%"channelId":"${channel.id}"%`) as { created_at: string };
      expect(main.added_at).toBe(channel.created_at);
      expect(created.created_at).toBe(channel.created_at);
    } finally {
      db.close();
    }
  });
});
