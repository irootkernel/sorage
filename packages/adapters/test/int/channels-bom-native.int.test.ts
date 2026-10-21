import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

/**
 * The real-engine BOM round-trip regression (R8): a directly bound string
 * parameter loses its leading U+FEFF under the pinned Bun's text binding, so
 * every verbatim Channel field — handles, the three context columns, the
 * handling note, and the opaque idempotency key — binds its exact UTF-8 bytes
 * with `CAST(? AS TEXT)` on both sides of every statement. The alias-node
 * vitest path does not reproduce the defect, so this suite spawns the actual
 * Bun runtime against the actual sources with an isolated installation, closes
 * and reopens the ports, and compares the exact values end to end, including
 * handle uniqueness and both receipt lookup surfaces.
 */
describe("channel verbatim BOM binding under the real Bun engine", () => {
  it("preserves leading byte-order marks across write, reopen, lookup, and replay", () => {
    const script = `
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { initializeInstallation } = await import("./packages/core/src/init.ts");
const { createChannel, addParticipant, submitMessage, handleChannelMessage, showChannel, readChannelMessage, submitMessageReplayOnly, projectActor } = await import("./packages/core/src/index.ts");
const { createNodeChannelPorts, createNodeChannelRecoveryPorts, captureChannelBodyText } = await import("./packages/adapters/src/channels.ts");
const { createNodeInitPorts } = await import("./packages/adapters/src/init-ports.ts");
const { FakeClock } = await import("./packages/adapters/src/testkit/fakes.ts");
// Anchored one hour in the past so the retained receipt stays unexpired for the
// replay-only surface that reads with the real system clock; a fixed calendar
// date crossed its own 24-hour receipt expiry on 2026-10-21.
const BASE = Date.parse(${JSON.stringify(new Date(Date.now() - 3_600_000).toISOString())});
const BOM = "\\uFEFF";
const tail = String.fromCharCode(9, 0) + "tail";
const session = BOM + "session" + tail;
const node = BOM + "node" + tail;
const attempt = BOM + "attempt" + tail;
const note = BOM + "decision" + tail;
const provenance = [BOM + "native", "", "tab" + String.fromCharCode(9) + "value", "nul" + String.fromCharCode(0) + "value"];
const ok = (value) => value !== null && typeof value === "object" && value.ok === true;
const fail = (code, detail) => { throw new Error(String(code) + ": " + detail); };
const unwrap = (value, code, what) => { if (!ok(value)) fail(code, what + ": " + JSON.stringify(value)); return value.value; };
const home = mkdtempSync(join(tmpdir(), "sorage-channel-bom-"));
try {
  const init = initializeInstallation(createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() }), { vaultPath: join(home, "vault") });
  if (!ok(init)) fail(10, "initialization failed");
  const actor = projectActor("11111111-2222-4333-8444-555555555555");
  const first = createNodeChannelPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock(BASE) });
  try {
    const created = unwrap(createChannel(first, { creator: actor, mainHandle: BOM + "main", title: null, idempotencyKey: BOM + "create-key" }), 11, "create");
    const mainId = created.channel.mainParticipantId;
    const worker = unwrap(addParticipant(first, { channelId: created.channel.id, assertion: { actor, asParticipant: mainId }, role: "worker", handle: BOM + "worker", nativeProvenance: provenance }), 12, "worker registration");
    const body = captureChannelBodyText("bom report body", { maxBytes: first.maxBytes, stateDir: first.stateDir, spoolId: "bom-native" });
    if (!ok(body)) fail(13, "capture failed");
    const submitted = unwrap(submitMessage(first, { channelId: created.channel.id, senderParticipantId: worker.id, kind: "report", accepted: body.value, contextSession: session, contextNode: node, contextAttempt: attempt, actor, idempotencyKey: BOM + "key-1" }), 14, "submit");
    unwrap(handleChannelMessage(first, { channelId: created.channel.id, messageId: submitted.message.id, assertion: { actor, asParticipant: mainId }, expectedRowVersion: 1, note: note }), 15, "handle");
    // Distinctness under byte-exact uniqueness: the plain handle is a second
    // valid registration, and the BOM handle collides only with itself.
    unwrap(addParticipant(first, { channelId: created.channel.id, assertion: { actor, asParticipant: mainId }, role: "worker", handle: "worker" }), 16, "plain handle registration");
    const duplicate = addParticipant(first, { channelId: created.channel.id, assertion: { actor, asParticipant: mainId }, role: "worker", handle: BOM + "worker" });
    if (ok(duplicate) || duplicate.error.code !== "CHN_INVALID_INPUT") fail(17, "duplicate BOM handle accepted");
  } finally {
    first.close();
  }
  const reopened = createNodeChannelPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock(BASE + 1000) });
  try {
    const channels = await import("./packages/core/src/channels.ts");
    const listing = unwrap(channels.listChannels(reopened, {}), 18, "list");
    const channel = listing.items.find((item) => item.mainHandle === BOM + "main");
    if (channel === undefined) fail(19, "BOM main handle lost on reread: " + JSON.stringify(listing.items.map((i) => i.mainHandle)));
    const view = unwrap(channels.showChannel(reopened, channel.id), 20, "show");
    const creationReplay = unwrap(createChannel(reopened, { creator: actor, mainHandle: BOM + "main", title: null, idempotencyKey: BOM + "create-key" }), 35, "creation-key replay");
    if (!creationReplay.replayed || creationReplay.channel.id !== channel.id || creationReplay.channel.participantCount !== 1) fail(36, "original creation receipt changed");
    const main = view.participants.find((p) => p.role === "main");
    const worker = view.participants.find((p) => p.handle === BOM + "worker");
    if (!main || main.handle !== BOM + "main") fail(21, "main handle mismatch: " + JSON.stringify(main));
    if (!worker || JSON.stringify(worker.nativeProvenance) !== JSON.stringify(provenance)) fail(22, "worker provenance mismatch: " + JSON.stringify(worker));
    const page = unwrap(channels.listChannelMessages(reopened, channel.id, { handling: "all" }), 23, "messages");
    const summary = page.items[0];
    if (!summary || summary.senderHandle !== BOM + "worker") fail(24, "sender handle mismatch: " + JSON.stringify(summary));
    if (summary.contextSession !== session || summary.contextNode !== node || summary.contextAttempt !== attempt) fail(25, "context mismatch: " + JSON.stringify(summary));
    if (summary.handleNote !== note) fail(26, "handle note mismatch: " + JSON.stringify(summary));
    const detail = unwrap(channels.readChannelMessage(reopened, channel.id, summary.id), 27, "read");
    if (detail.contextSession !== session || detail.handleNote !== note) fail(28, "detail mismatch: " + JSON.stringify(detail));
    const body2 = captureChannelBodyText("bom report body", { maxBytes: reopened.maxBytes, stateDir: reopened.stateDir, spoolId: "bom-native-2" });
    if (!ok(body2)) fail(29, "recapture failed");
    const replay = unwrap(submitMessage(reopened, { channelId: channel.id, senderParticipantId: detail.senderParticipantId, kind: "report", accepted: body2.value, contextSession: session, contextNode: node, contextAttempt: attempt, actor, idempotencyKey: BOM + "key-1" }), 30, "normal replay");
    if (replay.replayed !== true || replay.message.id !== summary.id) fail(31, "normal BOM-key replay missed: " + JSON.stringify(replay));
    const recovery = createNodeChannelRecoveryPorts({ env: { SORAGE_HOME: home }, userHome: home });
    const readonly = unwrap(submitMessageReplayOnly(recovery, { installationId: reopened.installationId, maxBytes: reopened.maxBytes, channelId: channel.id, senderParticipantId: detail.senderParticipantId, kind: "report", accepted: body2.value, contextSession: session, contextNode: node, contextAttempt: attempt, idempotencyKey: BOM + "key-1" }), 32, "readonly replay");
    if (readonly.id !== summary.id) fail(33, "readonly BOM-key replay mismatch");
    const collision = submitMessageReplayOnly(recovery, { installationId: reopened.installationId, maxBytes: reopened.maxBytes, channelId: channel.id, senderParticipantId: detail.senderParticipantId, kind: "report", accepted: body2.value, contextSession: session, contextNode: node, contextAttempt: attempt, idempotencyKey: "key-1" });
    if (ok(collision) || collision.error.code !== "CHN_REPLAY_UNAVAILABLE") fail(34, "plain key collided with the BOM key receipt");
    const { openSorageDatabase } = await import("./packages/adapters/src/sqlite/connection.ts");
    const expiry = new Date(BASE + 2000).toISOString();
    const db = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    try {
      db.prepare("UPDATE idempotency_keys SET expires_at = ? WHERE key = CAST(? AS TEXT)").run(expiry, Buffer.from(BOM + "key-1", "utf8"));
      const equality = { ...recovery, clock: new FakeClock(Date.parse(expiry)) };
      const expired = submitMessageReplayOnly(equality, { installationId: reopened.installationId, maxBytes: reopened.maxBytes, channelId: channel.id, senderParticipantId: detail.senderParticipantId, kind: "report", accepted: body2.value, contextSession: session, contextNode: node, contextAttempt: attempt, idempotencyKey: BOM + "key-1" });
      if (ok(expired) || expired.error.code !== "CHN_REPLAY_UNAVAILABLE") fail(37, "expiry equality replayed an expired original");
      if (db.prepare("SELECT expires_at FROM idempotency_keys WHERE key = CAST(? AS TEXT)").get(Buffer.from(BOM + "key-1", "utf8")).expires_at !== expiry) fail(38, "readonly expiry lookup changed the receipt");
      if (db.prepare("SELECT COUNT(*) AS count FROM channel_messages").get().count !== 1) fail(39, "replay duplicated the message");
    } finally { db.close(); }
    console.log("bom-roundtrip-ok");
  } finally {
    reopened.close();
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
`;
    const run = spawnSync("bun", ["-e", script], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("bom-roundtrip-ok");
  });
});
