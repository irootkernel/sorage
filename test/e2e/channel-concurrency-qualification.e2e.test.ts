import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { BINARY, envelopeOf, makeTempDir, runCleanups, sorage } from "./helpers";

afterEach(runCleanups);

/**
 * TASK-114 multi-process Channel concurrency qualification (EPIC-017 plan r2,
 * as corrected by the Supervisor's binding decision P1 to P3).
 *
 * The permanent 2 x 5 case inside `make test` is regression evidence: it drives
 * five compiled submitters released together, an unfiltered waiting
 * Coordinator, and concurrent handling against one temporary installation. The
 * 6 x 8 case behind SORAGE_CHANNEL_QUALIFICATION=1 is the Supervisor-run matrix
 * and the sole backoff trigger; it is skipped by default so `make test` never
 * inherits its runtime. Both cases use the same start-gate fixture, exec
 * instants, contention witness, closed refusal set, retry bounds, independent
 * SQLite reconciliation, Vault byte checks, public reads, and attempt
 * attribution. Every Sorage process runs with SORAGE_HOME pointing at a fresh
 * temporary home; no developer home is read or written.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const START_GATE = join(FIXTURES, "start-gate");
const EXEC_INSTANT = join(FIXTURES, "exec-instant.ts");
const RUNTIME = process.execPath;

const CHILD_TIMEOUT_MS = 45_000;
const RUN_HARD_BOUND_MS = 60_000;
const READINESS_DEADLINE_MS = 15_000;
const WAIT_ALIVE_WINDOW_MS = 2_000;
const WAIT_TIMEOUT_SECONDS = 20;
const COORDINATOR_WINDOW_MS = 22_000;
const HANDLER_WINDOW_MS = 25_000;
const RETRY_DELAYS_MS = [500, 1_000] as const;
const MAX_CLIENT_RETRIES = 2;
const INLINE_MAX_BYTES = 65_536;
const PREVIEW_BYTES = 512;
const COORDINATOR_RESTART_PAUSE_MS = 1_000;

const EXHAUSTION_MESSAGE =
  "A coherent storage state could not be established while this Channel operation was being prepared; this invocation committed nothing";

interface Envelope {
  ok?: boolean;
  data?: unknown;
  meta?: { requestId?: string; timedOut?: boolean };
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
    recovery?: { suggestedCommand?: string };
  };
}

interface LoadProcess {
  kind: "submit" | "wait" | "handle" | "replay";
  label: string;
  argv: string[];
  pid: number | null;
  spawnAt: number;
  execAt: number | null;
  exitAt: number | null;
  status: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  envelope: Envelope | null;
  parseFailure: string | null;
}

interface Spawned {
  child: ChildProcess;
  record: LoadProcess;
  done: Promise<LoadProcess>;
}

interface SlotSpec {
  slot: string;
  sender: "worker-a" | "worker-b" | "worker-c" | "judge-a";
  senderId: string;
  kind: "report" | "question" | "relay_request";
  body: string;
  bodyPath: string | null;
  assignmentId: string | null;
  assignmentLate: boolean;
  relayTo: string | null;
  contextSession: string | null;
  contextNode: string | null;
  contextAttempt: string | null;
  sha256: string;
  bodyBytes: number;
  preview: string;
  previewTruncated: boolean;
  tail: boolean;
}

interface Fixture {
  home: string;
  work: string;
  channelId: string;
  mainId: string;
  participants: Map<string, string>;
  openAssignmentId: string;
  closedAssignmentId: string;
  execLog: string;
  submitGate: string;
  openGate: string;
  submitReady: string;
  tailGate: string;
  tailReady: string;
  slots: SlotSpec[];
}

interface MessageRow {
  id: string;
  channel_id: string;
  sender_participant_id: string;
  sender_handle: string;
  kind: string;
  content_record_id: string;
  assignment_id: string | null;
  assignment_late: number;
  relay_to_participant_id: string | null;
  context_session: string | null;
  context_node: string | null;
  context_attempt: string | null;
  handled: number;
  handled_at: string | null;
  handled_by_participant_id: string | null;
  handled_by_kind: string | null;
  handle_note: string | null;
  processing_row_version: number;
  created_at: string;
  content_inline_text: string | null;
  content_storage_key: string | null;
  content_size_bytes: number;
  content_sha256: string;
  materialized: number;
}

interface EventRow {
  id: string;
  event_type: string;
  actor_kind: string;
  actor_id: string | null;
  metadata_json: string;
  created_at: string;
}

interface ReceiptRow {
  key: string;
  scope: string;
  request_hash: string;
  response_json: string;
  created_at: string;
  expires_at: string;
}

interface PendingRow {
  id: string;
  op: string;
  from_path: string | null;
  to_path: string;
  owner_domain: string | null;
  owner_id: string | null;
  content_id: string | null;
}

interface SubmitResult {
  slot: string;
  key: string;
  mode: "execute";
  attempts: LoadProcess[];
  success: LoadProcess | null;
  failure: string | null;
}

interface ReplayRunRecord {
  status: number | null;
  replayed: boolean | null;
  contentActivating: boolean | null;
  messageId: string | null;
  attempts: number;
  failure: string | null;
}

interface ReplayRecord {
  slot: string;
  replayOnly: ReplayRunRecord | null;
  identicalReplay: ReplayRunRecord | null;
}

type SubmitOutcome = Omit<SubmitResult, "key" | "mode">;

interface HandleAttempt {
  process: LoadProcess;
  note: string;
  afterRefusal: {
    handled: number;
    version: number;
    note: string | null;
    handledBy: string | null;
    handledKind: string | null;
    handledEvents: number;
    eventMetadata: Record<string, unknown>[];
  } | null;
}

interface LogicalHandle {
  id: string;
  messageId: string;
  slot: string;
  note: string;
  pair: boolean;
  attempts: HandleAttempt[];
  outcome: "success" | "conflict" | "superseded" | "failed";
  failure: string | null;
}

interface WaitRecord {
  process: LoadProcess;
  startedAt: number;
  deadline: number;
  returnedIds: string[];
  timedOut: boolean;
  first: boolean;
}

interface Metrics {
  submitCount: number;
  initialSubmitterCount: number;
  tailSubmitCount: number;
  submitterOverlapPairs: number;
  allSubmitOverlap: boolean;
  handleSubmitOverlap: boolean;
  waitCommitOverlap: boolean;
  witnessCount: number;
  samplerSamples: number;
  samplerTransitions: number;
  wallMs: number;
  contentionRefusals: number;
  coherenceExhaustions: number;
  rowVersionConflicts: number;
  clientRetries: number;
}

interface RunResult {
  run: string;
  strict: boolean;
  verdict: "pass" | "fail" | "invalid";
  failures: string[];
  invalidReasons: string[];
  metrics: Metrics;
  processes: LoadProcess[];
  submits: SubmitResult[];
  handles: LogicalHandle[];
  waits: WaitRecord[];
  overlap: Record<string, boolean | number>;
  witness: { samples: number; transitions: number; otherMessagesInSubmitWindows: number };
  reconciliation: Record<string, unknown>;
}

interface RunOptions {
  run: string;
  iteration: number;
  submitterCount: 5 | 8;
  strict: boolean;
  evidenceDir: string | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function previewOf(body: string): { preview: string; truncated: boolean } {
  let preview = "";
  let size = 0;
  for (const scalar of body) {
    size += Buffer.byteLength(scalar, "utf8");
    if (size > PREVIEW_BYTES) break;
    preview += scalar;
  }
  return {
    preview,
    truncated: Buffer.byteLength(preview, "utf8") < Buffer.byteLength(body, "utf8"),
  };
}

function sizedBody(prefix: string, size: number): string {
  const head = `${prefix} `;
  return head.length >= size ? head.slice(0, size) : `${head}${"x".repeat(size - head.length)}`;
}

function openInspection(home: string): DatabaseSync {
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function dataOf(run: ReturnType<typeof sorage>): Record<string, unknown> {
  const envelope = envelopeOf(run) as Envelope;
  return (envelope.data ?? {}) as Record<string, unknown>;
}

/** A compiled run whose stdout can exceed Node's 1 MiB spawnSync default (the full-body read). */
function sorageLarge(args: string[], home: string, cwd: string): ReturnType<typeof sorage> {
  const env: NodeJS.ProcessEnv = { ...process.env, SORAGE_HOME: home };
  delete env.SORAGE_TEST_REQUEST_ID;
  const result = spawnSync(BINARY, args, { encoding: "utf8", cwd, env, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function readExecLog(path: string): Map<number, number> {
  const values = new Map<number, number>();
  if (!existsSync(path)) return values;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const match = /^(\d+) (\d+)$/.exec(line.trim());
    if (match === null) continue;
    const pid = Number.parseInt(match[1] as string, 10);
    const instant = Number.parseInt(match[2] as string, 10);
    values.set(pid, instant);
  }
  return values;
}

async function waitForExecLine(pid: number | null, logPath: string, deadline: number): Promise<number | null> {
  if (pid === null) return null;
  while (Date.now() < deadline) {
    const instant = readExecLog(logPath).get(pid);
    if (instant !== undefined) return instant;
    await delay(10);
  }
  return null;
}

function spawnGated(options: {
  kind: LoadProcess["kind"];
  label: string;
  args: string[];
  home: string;
  cwd: string;
  gateFile: string;
  readyFile: string | null;
  execLog: string;
  binary?: string;
  onSpawn: (spawned: Spawned) => void;
}): Spawned {
  const argv = [START_GATE, options.binary ?? BINARY, ...options.args];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SORAGE_HOME: options.home,
    SORAGE_START_GATE_GATE: options.gateFile,
    SORAGE_START_GATE_EXEC_LOG: options.execLog,
    SORAGE_START_GATE_RUNTIME: RUNTIME,
    SORAGE_START_GATE_INSTANT: EXEC_INSTANT,
  };
  delete env.SORAGE_TEST_REQUEST_ID;
  if (options.readyFile === null) delete env.SORAGE_START_GATE_READY;
  else env.SORAGE_START_GATE_READY = options.readyFile;
  const child = spawn("/bin/sh", argv, {
    cwd: options.cwd,
    env,
  });
  const record: LoadProcess = {
    kind: options.kind,
    label: options.label,
    argv: options.args,
    pid: child.pid ?? null,
    spawnAt: Date.now(),
    execAt: null,
    exitAt: null,
    status: null,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    envelope: null,
    parseFailure: null,
  };
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString("utf8")}`.slice(-65_536);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-65_536);
  });
  const timer = setTimeout(() => {
    record.timedOut = true;
    child.kill("SIGKILL");
  }, CHILD_TIMEOUT_MS);
  const done = new Promise<LoadProcess>((resolve) => {
    const settle = (status: number | null, signal: string | null): void => {
      clearTimeout(timer);
      record.stdout = stdout;
      record.stderr = stderr;
      record.status = status;
      record.signal = signal;
      record.exitAt = Date.now();
      record.execAt = record.pid === null ? null : (readExecLog(options.execLog).get(record.pid) ?? null);
      if (record.status === 0) {
        try {
          record.envelope = JSON.parse(stdout) as Envelope;
        } catch {
          record.parseFailure = "expected a JSON success envelope on stdout";
        }
      } else {
        try {
          record.envelope = JSON.parse(stderr) as Envelope;
        } catch {
          record.parseFailure = "expected a JSON error envelope on stderr";
        }
      }
      resolve(record);
    };
    child.once("close", (status, signal) => {
      settle(status, signal);
    });
    child.once("error", () => {
      record.parseFailure = "the process could not be spawned";
      settle(null, null);
    });
  });
  const spawned: Spawned = { child, record, done };
  options.onSpawn(spawned);
  return spawned;
}

/**
 * Cleanup reuses the completion promise created at spawn (H2): a child killed
 * by a signal has `exitCode === null` after `close`, so waiting for a second
 * close would hang forever. The already-settled promise and the recorded
 * signal state make cleanup prompt for every exit path.
 */
async function cleanupSpawned(spawned: Spawned[]): Promise<void> {
  for (const item of spawned) {
    if (item.child.exitCode !== null || item.child.signalCode !== null) continue;
    try {
      item.child.kill("SIGKILL");
    } catch {
      // A child that never started still resolves through its completion promise.
    }
  }
  await Promise.all(spawned.map((item) => item.done));
}

function waitLineCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

function writeGate(path: string): void {
  writeFileSync(path, "open\n", "utf8");
}

function messageRows(db: DatabaseSync, channelId: string): MessageRow[] {
  return db
    .prepare(
      `SELECT m.*, c.inline_text AS content_inline_text, c.storage_key AS content_storage_key,
              c.size_bytes AS content_size_bytes, c.sha256 AS content_sha256, c.materialized AS materialized
         FROM channel_messages m
         JOIN content_records c ON c.id = m.content_record_id
        WHERE m.channel_id = ?
        ORDER BY m.created_at, m.id`,
    )
    .all(channelId) as unknown as MessageRow[];
}

function eventRows(db: DatabaseSync): EventRow[] {
  return db
    .prepare(
      "SELECT id, event_type, actor_kind, actor_id, metadata_json, created_at FROM events ORDER BY created_at, id",
    )
    .all() as unknown as EventRow[];
}

function receiptRows(db: DatabaseSync): ReceiptRow[] {
  return db
    .prepare(
      "SELECT key, scope, request_hash, response_json, created_at, expires_at FROM idempotency_keys ORDER BY key",
    )
    .all() as unknown as ReceiptRow[];
}

function pendingRows(db: DatabaseSync): PendingRow[] {
  return db
    .prepare("SELECT id, op, from_path, to_path, owner_domain, owner_id, content_id FROM pending_fs_ops ORDER BY id")
    .all() as unknown as PendingRow[];
}

function installationIdOf(home: string): string {
  try {
    const text = readFileSync(join(home, "config.yaml"), "utf8");
    const match = /^installationId:\s*"?([0-9a-fA-F-]{36})"?\s*$/m.exec(text);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

function metadataOf(event: EventRow): Record<string, unknown> {
  return JSON.parse(event.metadata_json) as Record<string, unknown>;
}

function channelEvents(events: EventRow[], channelId: string): EventRow[] {
  return events.filter((event) => {
    if (!event.event_type.startsWith("CHANNEL_")) return false;
    const metadata = metadataOf(event);
    return metadata.channelId === channelId;
  });
}

function expectedSubmitSummary(row: MessageRow, slot: SlotSpec): Record<string, unknown> {
  return {
    id: row.id,
    channelId: row.channel_id,
    kind: row.kind,
    senderParticipantId: row.sender_participant_id,
    senderHandle: row.sender_handle,
    assignmentId: row.assignment_id,
    assignmentLate: row.assignment_late === 1,
    relayToParticipantId: row.relay_to_participant_id,
    contextSession: row.context_session,
    contextNode: row.context_node,
    contextAttempt: row.context_attempt,
    handled: false,
    handledAt: null,
    handledByParticipantId: null,
    handledByKind: null,
    handleNote: null,
    processingRowVersion: 1,
    createdAt: row.created_at,
    bodyBytes: slot.bodyBytes,
    bodyPreview: slot.preview,
    bodyPreviewTruncated: slot.previewTruncated,
  };
}

function expectedHandledSummary(row: MessageRow, slot: SlotSpec, note: string): Record<string, unknown> {
  return {
    ...expectedSubmitSummary(row, slot),
    handled: true,
    handledAt: row.handled_at,
    handledByParticipantId: row.handled_by_participant_id,
    handledByKind: row.handled_by_kind,
    handleNote: note,
    processingRowVersion: 2,
  };
}

function setupFixture(run: string, iteration: number, submitterCount: 5 | 8): Fixture {
  const home = makeTempDir(`t114-${run}-home-`);
  const work = makeTempDir(`t114-${run}-work-`);
  expect(sorage(["init", "--non-interactive"], { home, cwd: work }).status).toBe(0);
  const created = sorage(["channel", "create", "--main-handle", "main", "--json"], { home, cwd: work });
  expect(created.status, created.stderr).toBe(0);
  const channel = envelopeOf(created).data as { channel: { id: string; mainParticipantId: string } };
  const channelId = channel.channel.id;
  const mainId = channel.channel.mainParticipantId;
  const participants = new Map<string, string>([["main", mainId]]);
  const addParticipant = (role: "worker" | "judge", handle: string): void => {
    const added = sorage(
      [
        "channel",
        "participant",
        "add",
        channelId,
        "--role",
        role,
        "--handle",
        handle,
        "--as-participant",
        mainId,
        "--json",
      ],
      { home, cwd: work },
    );
    expect(added.status, added.stderr).toBe(0);
    participants.set(handle, (envelopeOf(added).data as { participant: { id: string } }).participant.id);
  };
  addParticipant("worker", "worker-a");
  addParticipant("worker", "worker-b");
  if (submitterCount === 8) {
    addParticipant("worker", "worker-c");
    addParticipant("judge", "judge-a");
  }
  const addAssignment = (label: string, participant: string): string => {
    const added = sorage(
      [
        "channel",
        "assignment",
        "add",
        channelId,
        "--label",
        label,
        "--participant",
        participants.get(participant) as string,
        "--as-participant",
        mainId,
        "--json",
      ],
      { home, cwd: work },
    );
    expect(added.status, added.stderr).toBe(0);
    return (envelopeOf(added).data as { assignment: { id: string } }).assignment.id;
  };
  const openAssignmentId = addAssignment("open assignment", "worker-a");
  const closedAssignmentId = addAssignment("closed assignment", "worker-b");
  const closed = sorage(
    ["channel", "assignment", "close", channelId, closedAssignmentId, "--as-participant", mainId, "--json"],
    { home, cwd: work },
  );
  expect(closed.status, closed.stderr).toBe(0);

  const execLog = join(work, "exec.log");
  const submitGate = join(work, "submit.gate");
  const openGate = join(work, "open.gate");
  const submitReady = join(work, "submit.ready");
  const tailGate = join(work, "tail.gate");
  const tailReady = join(work, "tail.ready");
  writeGate(openGate);

  const bodyDir = join(work, "bodies");
  mkdirSync(bodyDir, { recursive: true });
  const bodyFile = (slot: string, body: string): string => {
    const path = join(bodyDir, `${slot}.txt`);
    writeFileSync(path, body, "utf8");
    return path;
  };

  const slots: SlotSpec[] = [];
  const addSlot = (input: {
    slot: string;
    sender: SlotSpec["sender"];
    kind: SlotSpec["kind"];
    body: string;
    fileRouted: boolean;
    assignmentId: string | null;
    assignmentLate: boolean;
    relayTo: string | null;
    contextSession: string | null;
    contextNode: string | null;
    contextAttempt: string | null;
    tail?: boolean;
  }): void => {
    const preview = previewOf(input.body);
    slots.push({
      slot: input.slot,
      sender: input.sender,
      senderId: participants.get(input.sender) as string,
      kind: input.kind,
      body: input.body,
      bodyPath: input.fileRouted ? bodyFile(input.slot, input.body) : null,
      assignmentId: input.assignmentId,
      assignmentLate: input.assignmentLate,
      relayTo: input.relayTo,
      contextSession: input.contextSession,
      contextNode: input.contextNode,
      contextAttempt: input.contextAttempt,
      sha256: hashOf(input.body),
      bodyBytes: Buffer.byteLength(input.body, "utf8"),
      preview: preview.preview,
      previewTruncated: preview.truncated,
      tail: input.tail === true,
    });
  };

  addSlot({
    slot: "s1",
    sender: "worker-a",
    kind: "report",
    body: `t114-${run}-s1\n${"m".repeat(128)}`,
    fileRouted: false,
    assignmentId: openAssignmentId,
    assignmentLate: false,
    relayTo: null,
    contextSession: `session-${iteration}`,
    contextNode: "node-s1",
    contextAttempt: null,
  });
  addSlot({
    slot: "s2",
    sender: "worker-a",
    kind: "question",
    body: sizedBody(`t114-${run}-s2`, INLINE_MAX_BYTES),
    fileRouted: false,
    assignmentId: null,
    assignmentLate: false,
    relayTo: null,
    contextSession: `session-${iteration}`,
    contextNode: "node-s2",
    contextAttempt: null,
  });
  addSlot({
    slot: "s3",
    sender: "worker-b",
    kind: "report",
    body: sizedBody(`t114-${run}-s3`, INLINE_MAX_BYTES + 1),
    fileRouted: true,
    assignmentId: closedAssignmentId,
    assignmentLate: true,
    relayTo: null,
    contextSession: null,
    contextNode: null,
    contextAttempt: null,
  });
  addSlot({
    slot: "s4",
    sender: "worker-b",
    kind: "report",
    body: sizedBody(`t114-${run}-s4`, 1_048_576),
    fileRouted: true,
    assignmentId: null,
    assignmentLate: false,
    relayTo: null,
    contextSession: null,
    contextNode: "node-s4",
    contextAttempt: null,
  });
  addSlot({
    slot: "s5",
    sender: "worker-a",
    kind: "relay_request",
    body: sizedBody(`t114-${run}-s5`, 4_096),
    fileRouted: false,
    assignmentId: openAssignmentId,
    assignmentLate: false,
    relayTo: mainId,
    contextSession: null,
    contextNode: null,
    contextAttempt: null,
  });
  if (submitterCount === 8) {
    addSlot({
      slot: "s6",
      sender: "worker-c",
      kind: "report",
      body: sizedBody(`t114-${run}-s6`, 2_097_152),
      fileRouted: true,
      assignmentId: null,
      assignmentLate: false,
      relayTo: null,
      contextSession: null,
      contextNode: null,
      contextAttempt: `attempt-${iteration}-s6`,
    });
    addSlot({
      slot: "s7",
      sender: "judge-a",
      kind: "question",
      body: sizedBody(`t114-${run}-s7`, 8_192),
      fileRouted: false,
      assignmentId: null,
      assignmentLate: false,
      relayTo: null,
      contextSession: `session-${iteration}`,
      contextNode: "node-s7",
      contextAttempt: `attempt-${iteration}-s7`,
    });
    addSlot({
      slot: "s8",
      sender: "worker-c",
      kind: "report",
      body: sizedBody(`t114-${run}-s8`, 131_072),
      fileRouted: true,
      assignmentId: null,
      assignmentLate: false,
      relayTo: null,
      contextSession: null,
      contextNode: null,
      contextAttempt: null,
    });
  }
  // The event-driven tail submission (TASK-114 correction): a worker-a
  // report, never a handling target, file-backed and reconciled like every
  // other slot. Its own gate is opened by the handler driver when it spawns
  // its first handle attempt, so a submit process is active during that
  // handle by construction. It does not count toward the initial N.
  addSlot({
    slot: "tail",
    sender: "worker-a",
    kind: "report",
    body: sizedBody(`t114-${run}-tail`, 2_097_152),
    fileRouted: true,
    assignmentId: null,
    assignmentLate: false,
    relayTo: null,
    contextSession: null,
    contextNode: null,
    contextAttempt: null,
    tail: true,
  });
  return {
    home,
    work,
    channelId,
    mainId,
    participants,
    openAssignmentId,
    closedAssignmentId,
    execLog,
    submitGate,
    openGate,
    submitReady,
    tailGate,
    tailReady,
    slots,
  };
}

function submitKey(fixture: Fixture, slot: SlotSpec): string {
  return `t114-${fixture.channelId}-${slot.slot}`;
}

function submitArgv(fixture: Fixture, slot: SlotSpec, replayOnly: boolean): string[] {
  const args = ["channel", "submit", fixture.channelId, "--as-participant", slot.senderId, "--kind", slot.kind];
  if (slot.bodyPath === null) {
    args.push("--body", slot.body);
  } else {
    args.push("--body-file", slot.bodyPath);
  }
  if (slot.assignmentId !== null) args.push("--assignment", slot.assignmentId);
  if (slot.relayTo !== null) args.push("--relay-to", slot.relayTo);
  if (slot.contextSession !== null) args.push("--context-session", slot.contextSession);
  if (slot.contextNode !== null) args.push("--context-node", slot.contextNode);
  if (slot.contextAttempt !== null) args.push("--context-attempt", slot.contextAttempt);
  args.push("--idempotency-key", submitKey(fixture, slot));
  if (replayOnly) args.push("--replay-only");
  args.push("--json");
  return args;
}

function handleArgv(fixture: Fixture, messageId: string, note: string): string[] {
  return [
    "channel",
    "handle",
    fixture.channelId,
    messageId,
    "--as-participant",
    fixture.mainId,
    "--expected-row-version",
    "1",
    "--note",
    note,
    "--json",
  ];
}

function waitArgv(fixture: Fixture): string[] {
  return [
    "channel",
    "messages",
    fixture.channelId,
    "--unhandled",
    "--wait",
    "--interval",
    "1",
    "--timeout",
    String(WAIT_TIMEOUT_SECONDS),
    "--limit",
    "200",
    "--json",
  ];
}

function classifyRefusal(process: LoadProcess): "contention" | "coherence" | "row-version" | "other" {
  if (process.status === 0) return "other";
  // A permitted refusal is exactly the retryable exit-75 category with no
  // signal and a valid typed envelope. A code that merely appears in a
  // nonzero output is not enough (H1).
  if (process.status !== 75 || process.signal !== null) return "other";
  if (process.parseFailure !== null || !hasValidErrorEnvelope(process)) return "other";
  const error = process.envelope?.error;
  if (error?.code === "STORAGE_INSPECTION_UNAVAILABLE") {
    if (error.details?.storageContention === true) return "contention";
    if (error.message === EXHAUSTION_MESSAGE) return "coherence";
  }
  if (error?.code === "ROW_VERSION_CONFLICT") return "row-version";
  return "other";
}

function hasValidErrorEnvelope(process: LoadProcess): boolean {
  const error = process.envelope?.error;
  return (
    process.envelope?.ok === false &&
    typeof error?.code === "string" &&
    error.code.length > 0 &&
    typeof error.message === "string" &&
    error.message.length > 0 &&
    typeof error.recovery?.suggestedCommand === "string" &&
    error.recovery.suggestedCommand.length > 0
  );
}

function noSubmitRowsForKey(home: string, key: string, sha256: string): string | null {
  const db = openInspection(home);
  try {
    const receipt = db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = ?").get(key) as { n: number };
    if (receipt.n !== 0) return "a receipt already exists for the refused submission key";
    const content = db.prepare("SELECT COUNT(*) AS n FROM content_records WHERE sha256 = ?").get(sha256) as {
      n: number;
    };
    if (content.n !== 0) return "a content record already exists for the refused submission body";
    const message = db
      .prepare(
        "SELECT COUNT(*) AS n FROM channel_messages m JOIN content_records c ON c.id = m.content_record_id WHERE c.sha256 = ?",
      )
      .get(sha256) as { n: number };
    if (message.n !== 0) return "a message already exists for the refused submission body";
    return null;
  } finally {
    db.close();
  }
}

function handleState(
  home: string,
  messageId: string,
): {
  handled: number;
  version: number;
  note: string | null;
  handledBy: string | null;
  handledKind: string | null;
  handledEvents: number;
  eventMetadata: Record<string, unknown>[];
} {
  const db = openInspection(home);
  try {
    const row = db
      .prepare(
        "SELECT handled, processing_row_version, handle_note, handled_by_participant_id, handled_by_kind FROM channel_messages WHERE id = ?",
      )
      .get(messageId) as
      | {
          handled: number;
          processing_row_version: number;
          handle_note: string | null;
          handled_by_participant_id: string | null;
          handled_by_kind: string | null;
        }
      | undefined;
    const events = eventRows(db)
      .filter((event) => event.event_type === "CHANNEL_MESSAGE_HANDLED")
      .map((event) => metadataOf(event))
      .filter((metadata) => metadata.messageId === messageId);
    return {
      handled: row?.handled ?? 0,
      version: row?.processing_row_version ?? 0,
      note: row?.handle_note ?? null,
      handledBy: row?.handled_by_participant_id ?? null,
      handledKind: row?.handled_by_kind ?? null,
      handledEvents: events.length,
      eventMetadata: events,
    };
  } finally {
    db.close();
  }
}

function workerWaitSnapshot(home: string, channelId: string, workerIds: Set<string>): Record<string, unknown> {
  const db = openInspection(home);
  try {
    const ids = [...workerIds];
    if (ids.length === 0) return { rows: [], events: [], receipts: [] };
    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT * FROM channel_messages WHERE channel_id = ? AND sender_participant_id IN (${placeholders})`)
      .all(channelId, ...ids) as unknown as MessageRow[];
    const rowIds = new Set(rows.map((row) => row.id));
    const events = eventRows(db).filter((event) => {
      if (!event.event_type.startsWith("CHANNEL_")) return false;
      const metadata = metadataOf(event);
      return typeof metadata.messageId === "string" && rowIds.has(metadata.messageId);
    });
    const receipts = receiptRows(db).filter((receipt) => {
      try {
        const parsed = JSON.parse(receipt.response_json) as { message?: { id?: string } };
        return parsed.message?.id !== undefined && rowIds.has(parsed.message.id);
      } catch {
        return false;
      }
    });
    return { rows, events, receipts };
  } finally {
    db.close();
  }
}

function compareSnapshot(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  label: string,
): string | null {
  for (const key of ["rows", "events", "receipts"] as const) {
    const beforeItems = before[key] as Array<Record<string, unknown>>;
    const afterItems = after[key] as Array<Record<string, unknown>>;
    const afterById = new Map(afterItems.map((item) => [String(item.id ?? item.key), item]));
    for (const item of beforeItems) {
      const id = String(item.id ?? item.key);
      if (!isDeepStrictEqual(item, afterById.get(id))) {
        return `${label}: a wait changed a pre-existing ${key.slice(0, -1)} ${id}`;
      }
    }
  }
  return null;
}

class VersionSampler {
  readonly samples: Array<{ at: number; version: number }> = [];
  readonly transitions: Array<{ at: number; from: number; to: number }> = [];
  private readonly db: DatabaseSync;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(home: string) {
    this.db = openInspection(home);
  }

  start(): void {
    let previous: number | null = null;
    this.timer = setInterval(() => {
      try {
        const row = this.db.prepare("PRAGMA data_version").get() as { data_version: number };
        const at = Date.now();
        this.samples.push({ at, version: row.data_version });
        if (previous !== null && previous !== row.data_version) {
          this.transitions.push({ at, from: previous, to: row.data_version });
        }
        previous = row.data_version;
      } catch {
        // A transient sampler read failure is supporting evidence only.
      }
    }, 10);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.db.close();
  }
}

async function runSubmit(
  fixture: Fixture,
  slot: SlotSpec,
  initial: Spawned,
  onRetry: () => void,
  spawnedList: Spawned[],
  all: LoadProcess[],
): Promise<SubmitOutcome> {
  const attempts: LoadProcess[] = [];
  let current: Spawned | null = initial;
  for (let attempt = 0; attempt <= MAX_CLIENT_RETRIES; attempt += 1) {
    if (current === null) {
      current = spawnGated({
        kind: "submit",
        label: `submit-${slot.slot}-a${attempt + 1}`,
        args: submitArgv(fixture, slot, false),
        home: fixture.home,
        cwd: fixture.work,
        gateFile: fixture.submitGate,
        readyFile: null,
        execLog: fixture.execLog,
        onSpawn: (spawned) => spawnedList.push(spawned),
      });
    }
    const process = await current.done;
    current = null;
    attempts.push(process);
    all.push(process);
    if (process.status === 0) {
      const data = process.envelope?.data as
        | { message?: Record<string, unknown>; replayed?: boolean; contentActivating?: boolean }
        | undefined;
      if (data?.message === undefined || typeof data.replayed !== "boolean") {
        return { slot: slot.slot, attempts, success: null, failure: "submit success envelope lacks its closed fields" };
      }
      if (attempt > 0 && data.replayed === true) {
        return {
          slot: slot.slot,
          attempts,
          success: null,
          failure: "an identical retry after a refusal reported replayed=true, a post-commit-reporting defect",
        };
      }
      if (data.replayed !== false) {
        return { slot: slot.slot, attempts, success: null, failure: "a first execute submit reported replayed=true" };
      }
      return { slot: slot.slot, attempts, success: process, failure: null };
    }
    const classification = classifyRefusal(process);
    if (classification !== "contention" && classification !== "coherence") {
      const code = process.envelope?.error?.code ?? "untyped";
      return {
        slot: slot.slot,
        attempts,
        success: null,
        failure: `submit refused with ${code} (${process.parseFailure ?? "not a storage-preparation refusal"})`,
      };
    }
    if (!hasValidErrorEnvelope(process)) {
      return {
        slot: slot.slot,
        attempts,
        success: null,
        failure: "a typed refusal lacks a symbolic code, message, or recovery",
      };
    }
    const dirty = noSubmitRowsForKey(fixture.home, submitKey(fixture, slot), slot.sha256);
    if (dirty !== null) {
      return {
        slot: slot.slot,
        attempts,
        success: null,
        failure: `refused submit committed a partial outcome: ${dirty}`,
      };
    }
    if (attempt === MAX_CLIENT_RETRIES) {
      return {
        slot: slot.slot,
        attempts,
        success: null,
        failure: `submit exhausted ${MAX_CLIENT_RETRIES} identical client retries with ${classification} refusals`,
      };
    }
    onRetry();
    await delay(RETRY_DELAYS_MS[attempt] as number);
  }
  return { slot: slot.slot, attempts, success: null, failure: "submit retry loop ended without an outcome" };
}

async function runLogicalHandle(
  logical: LogicalHandle,
  fixture: Fixture,
  spawnedList: Spawned[],
  all: LoadProcess[],
  onRetry: () => void,
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_CLIENT_RETRIES; attempt += 1) {
    if (attempt > 0) await delay(RETRY_DELAYS_MS[attempt - 1] as number);
    const spawned = spawnGated({
      kind: "handle",
      label: `${logical.id}-a${attempt + 1}`,
      args: handleArgv(fixture, logical.messageId, logical.note),
      home: fixture.home,
      cwd: fixture.work,
      gateFile: fixture.openGate,
      readyFile: null,
      execLog: fixture.execLog,
      onSpawn: (childSpawned) => spawnedList.push(childSpawned),
    });
    const process = await spawned.done;
    all.push(process);
    const attemptRecord: HandleAttempt = { process, note: logical.note, afterRefusal: null };
    logical.attempts.push(attemptRecord);
    if (process.status === 0) {
      const data = process.envelope?.data as
        | { message?: Record<string, unknown>; bodyPreviewUnavailable?: boolean }
        | undefined;
      if (data?.message === undefined || typeof data.bodyPreviewUnavailable !== "boolean") {
        logical.outcome = "failed";
        logical.failure = "handle success envelope lacks its closed fields";
        return;
      }
      if (data.message.id !== logical.messageId || data.message.handleNote !== logical.note) {
        logical.outcome = "failed";
        logical.failure = "the handle success response does not name this attempt's message and note";
        return;
      }
      logical.outcome = "success";
      return;
    }
    const classification = classifyRefusal(process);
    if (classification === "row-version") {
      logical.outcome = "conflict";
      return;
    }
    if (classification !== "contention" && classification !== "coherence") {
      logical.outcome = "failed";
      logical.failure = `handle refused with ${process.envelope?.error?.code ?? "untyped"}`;
      return;
    }
    if (!hasValidErrorEnvelope(process)) {
      logical.outcome = "failed";
      logical.failure = "a typed handle refusal lacks a symbolic code, message, or recovery";
      return;
    }
    const state = handleState(fixture.home, logical.messageId);
    attemptRecord.afterRefusal = {
      handled: state.handled,
      version: state.version,
      note: state.note,
      handledBy: state.handledBy,
      handledKind: state.handledKind,
      handledEvents: state.handledEvents,
      eventMetadata: state.eventMetadata,
    };
    if (logical.pair && state.handled === 1 && state.version === 2) {
      // Decision P1: inside the deliberate pair a storage-refused member may
      // find the message handled by the other member's exit-0 attempt; it then
      // does not retry, and the pair is reconciled later.
      logical.outcome = "superseded";
      return;
    }
    if (state.handled !== 0 || state.version !== 1 || state.handledEvents !== 0) {
      logical.outcome = "failed";
      logical.failure = "a refused handle left the message handled or emitted a handling event";
      return;
    }
    if (attempt === MAX_CLIENT_RETRIES) {
      logical.outcome = "failed";
      logical.failure = `handle exhausted ${MAX_CLIENT_RETRIES} identical client retries with ${classification} refusals`;
      return;
    }
    onRetry();
  }
}

async function readUnhandledCandidates(db: DatabaseSync, channelId: string): Promise<MessageRow[]> {
  return db
    .prepare(
      `SELECT m.*, c.inline_text AS content_inline_text, c.storage_key AS content_storage_key,
              c.size_bytes AS content_size_bytes, c.sha256 AS content_sha256, c.materialized AS materialized
         FROM channel_messages m
         JOIN content_records c ON c.id = m.content_record_id
        WHERE m.channel_id = ? AND m.handled = 0
        ORDER BY m.created_at, m.id`,
    )
    .all(channelId) as unknown as MessageRow[];
}

async function runHandlerDriver(options: {
  fixture: Fixture;
  expectedBySha: Map<string, SlotSpec>;
  workerAIds: Set<string>;
  tailGate: string;
  submitsSettled: () => boolean;
  aborted: () => boolean;
  spawned: Spawned[];
  all: LoadProcess[];
  logicals: LogicalHandle[];
  handles: { retries: number };
}): Promise<string[]> {
  const failures: string[] = [];
  const db = openInspection(options.fixture.home);
  const scheduled = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const deadline = Date.now() + HANDLER_WINDOW_MS;
  let pairStarted = false;
  let tailGateOpened = false;
  const openTailGate = (): void => {
    if (tailGateOpened) return;
    tailGateOpened = true;
    writeGate(options.tailGate);
  };
  try {
    while (!options.aborted() && Date.now() < deadline) {
      let rows: MessageRow[];
      try {
        rows = await readUnhandledCandidates(db, options.fixture.channelId);
      } catch {
        await delay(10);
        continue;
      }
      const candidates = rows.filter(
        (row) => !options.workerAIds.has(row.sender_participant_id) && options.expectedBySha.has(row.content_sha256),
      );
      if (options.submitsSettled() && candidates.length === 0) break;
      const next = candidates.find((row) => !scheduled.has(row.id));
      if (next === undefined) {
        await delay(10);
        continue;
      }
      if (!pairStarted) {
        pairStarted = true;
        scheduled.add(next.id);
        // The event-driven tail is released at the moment the first handle
        // attempt is spawned, so a submit process is active during that
        // handle by construction.
        openTailGate();
        const slot = options.expectedBySha.get(next.content_sha256) as SlotSpec;
        for (const suffix of ["a", "b"] as const) {
          const logical: LogicalHandle = {
            id: `handle-${slot.slot}-pair-${suffix}`,
            messageId: next.id,
            slot: slot.slot,
            note: `t114-${options.fixture.channelId}-${slot.slot}-pair-${suffix}`,
            pair: true,
            attempts: [],
            outcome: "failed",
            failure: null,
          };
          options.logicals.push(logical);
          const promise = runLogicalHandle(logical, options.fixture, options.spawned, options.all, () => {
            options.handles.retries += 1;
          }).finally(() => {
            inFlight.delete(logical.id);
          });
          inFlight.set(logical.id, promise);
        }
        continue;
      }
      if (inFlight.size >= 2) {
        await delay(10);
        continue;
      }
      scheduled.add(next.id);
      const slot = options.expectedBySha.get(next.content_sha256) as SlotSpec;
      const logical: LogicalHandle = {
        id: `handle-${slot.slot}`,
        messageId: next.id,
        slot: slot.slot,
        note: `t114-${options.fixture.channelId}-${slot.slot}`,
        pair: false,
        attempts: [],
        outcome: "failed",
        failure: null,
      };
      options.logicals.push(logical);
      const promise = runLogicalHandle(logical, options.fixture, options.spawned, options.all, () => {
        options.handles.retries += 1;
      }).finally(() => {
        inFlight.delete(logical.id);
      });
      inFlight.set(logical.id, promise);
    }
  } finally {
    // A run that never reaches a first handle still releases the tail before
    // the wrapper's bounded gate wait expires, so cleanup stays bounded; such
    // a run cannot pass the strict overlap rule in any case.
    openTailGate();
    db.close();
    await Promise.all([...inFlight.values()]);
  }
  for (const logical of options.logicals) {
    if (logical.outcome === "failed") {
      failures.push(`${logical.id}: ${logical.failure ?? "the handling attempt did not settle"}`);
    }
  }
  return failures;
}

async function runWaitLoop(options: {
  fixture: Fixture;
  first: Spawned;
  workerAIds: Set<string>;
  submitsSettled: () => boolean;
  spawned: Spawned[];
  all: LoadProcess[];
  records: WaitRecord[];
  failures: string[];
}): Promise<void> {
  const deadline = Date.now() + COORDINATOR_WINDOW_MS;
  const workerSlots = options.fixture.slots.filter((slot) => slot.sender === "worker-a");
  let current: Spawned = options.first;
  let first = true;
  let allObserved = false;
  while (true) {
    const startedAt = Date.now();
    const before = workerWaitSnapshot(options.fixture.home, options.fixture.channelId, options.workerAIds);
    const process = await current.done;
    options.all.push(process);
    const returnedIds: string[] = [];
    let timedOut = false;
    if (process.status !== 0) {
      options.failures.push(
        `wait ${process.label} exited ${String(process.status)} (${process.envelope?.error?.code ?? "untyped"}); the wait contract requires exit 0`,
      );
    } else {
      const data = process.envelope?.data as { items?: Array<{ id?: unknown }>; nextCursor?: unknown } | undefined;
      if (process.envelope?.ok !== true || !Array.isArray(data?.items)) {
        options.failures.push(`wait ${process.label} did not return the messages data wrapper`);
      } else {
        for (const item of data.items) {
          if (typeof item.id === "string") returnedIds.push(item.id);
        }
        if (new Set(returnedIds).size !== returnedIds.length) {
          options.failures.push(`wait ${process.label} returned a duplicate message ID in one page`);
        }
      }
      timedOut = process.envelope?.meta?.timedOut === true;
      if (timedOut && returnedIds.length > 0) {
        options.failures.push(`wait ${process.label} reported timedOut with returned messages`);
      }
    }
    const after = workerWaitSnapshot(options.fixture.home, options.fixture.channelId, options.workerAIds);
    const changed = compareSnapshot(before, after, `wait ${process.label}`);
    if (changed !== null) options.failures.push(changed);
    const execAt = process.execAt ?? process.exitAt ?? startedAt;
    options.records.push({
      process,
      startedAt,
      deadline: execAt + WAIT_TIMEOUT_SECONDS * 1_000,
      returnedIds,
      timedOut,
      first,
    });
    const previouslyReturned = new Set(options.records.slice(0, -1).flatMap((record) => record.returnedIds));
    const newIds = returnedIds.filter((id) => !previouslyReturned.has(id));
    const observed = new Set(options.records.flatMap((record) => record.returnedIds));
    const rowBySha = new Map<string, string>();
    const db = openInspection(options.fixture.home);
    try {
      for (const row of messageRows(db, options.fixture.channelId)) rowBySha.set(row.content_sha256, row.id);
    } finally {
      db.close();
    }
    allObserved = workerSlots.every((slot) => {
      const id = rowBySha.get(slot.sha256);
      return id !== undefined && observed.has(id);
    });
    first = false;
    if (options.submitsSettled() && allObserved) break;
    if (Date.now() >= deadline || Date.now() + 3_000 >= deadline) break;
    await delay(newIds.length > 0 ? 0 : COORDINATOR_RESTART_PAUSE_MS);
    current = spawnGated({
      kind: "wait",
      label: `wait-${options.records.length + 1}`,
      args: waitArgv(options.fixture),
      home: options.fixture.home,
      cwd: options.fixture.work,
      gateFile: options.fixture.openGate,
      readyFile: null,
      execLog: options.fixture.execLog,
      onSpawn: (spawned) => options.spawned.push(spawned),
    });
  }
  if (!allObserved) {
    options.failures.push("the Coordinator did not observe every expected worker-a message in its window");
  }
}

async function executeRun(options: RunOptions): Promise<RunResult> {
  const fixture = setupFixture(options.run, options.iteration, options.submitterCount);
  const spawned: Spawned[] = [];
  const processes: LoadProcess[] = [];
  const failures: string[] = [];
  const invalidReasons: string[] = [];
  const submitResults: SubmitResult[] = [];
  const logicals: LogicalHandle[] = [];
  const waits: WaitRecord[] = [];
  const handleStats = { retries: 0 };
  let submitRetries = 0;
  const workerAIds = new Set<string>([fixture.participants.get("worker-a") as string]);
  const tailSlot = fixture.slots.find((slot) => slot.tail) as SlotSpec;
  const initialSlots = fixture.slots.filter((slot) => !slot.tail);
  const expectedBySha = new Map<string, SlotSpec>(
    fixture.slots.filter((slot) => slot.sender !== "worker-a").map((slot) => [slot.sha256, slot]),
  );
  let settled = false;
  const submitsSettled = (): boolean => settled;
  const sampler = new VersionSampler(fixture.home);
  sampler.start();
  let gateReleasedAt = 0;
  let firstWait: Spawned | null = null;
  let aborted = false;

  try {
    // The first Coordinator wait starts before the gate and must still be
    // running after a full two-second polling window (a proxy for active
    // polling; the later commit-and-return evidence is the real proof).
    firstWait = spawnGated({
      kind: "wait",
      label: "wait-1",
      args: waitArgv(fixture),
      home: fixture.home,
      cwd: fixture.work,
      gateFile: fixture.openGate,
      readyFile: null,
      execLog: fixture.execLog,
      onSpawn: (item) => spawned.push(item),
    });
    const firstExec = await waitForExecLine(firstWait.record.pid, fixture.execLog, Date.now() + 10_000);
    if (firstExec === null) invalidReasons.push("the first wait never recorded an exec instant");
    await delay(WAIT_ALIVE_WINDOW_MS);
    if (firstWait.record.exitAt !== null) {
      invalidReasons.push("the first wait exited before the submit gate was released");
    }

    // The event-driven tail submitter waits on its own gate, which the handler
    // opens when it spawns its first handle attempt. It is spawned before the
    // shared submit release but does not count toward the initial N.
    const tailSpawned = spawnGated({
      kind: "submit",
      label: "submit-tail",
      args: submitArgv(fixture, tailSlot, false),
      home: fixture.home,
      cwd: fixture.work,
      gateFile: fixture.tailGate,
      readyFile: fixture.tailReady,
      execLog: fixture.execLog,
      onSpawn: (item) => spawned.push(item),
    });
    const tailReadyDeadline = Date.now() + 5_000;
    while (waitLineCount(fixture.tailReady) < 1 && Date.now() < tailReadyDeadline) {
      await delay(10);
    }
    if (waitLineCount(fixture.tailReady) < 1) {
      invalidReasons.push("the tail wrapper did not signal readiness before the submit gate was released");
    }

    // The handler driver watches committed rows before load and handles only
    // non-worker-a senders; its first decision deliberately starts the
    // duplicate pair and opens the tail gate.
    const handlerPromise = runHandlerDriver({
      fixture,
      expectedBySha,
      workerAIds,
      tailGate: fixture.tailGate,
      submitsSettled,
      aborted: () => aborted,
      spawned,
      all: processes,
      logicals,
      handles: handleStats,
    });

    // Spawn every initial submitter through the shared readiness gate. Only
    // submitters share the readiness file; waits and handlers use the open
    // gate.
    const initial = new Map<string, Spawned>();
    for (const slot of initialSlots) {
      const spawnedProcess = spawnGated({
        kind: "submit",
        label: `submit-${slot.slot}`,
        args: submitArgv(fixture, slot, false),
        home: fixture.home,
        cwd: fixture.work,
        gateFile: fixture.submitGate,
        readyFile: fixture.submitReady,
        execLog: fixture.execLog,
        onSpawn: (item) => spawned.push(item),
      });
      initial.set(slot.slot, spawnedProcess);
    }
    const readinessDeadline = Date.now() + READINESS_DEADLINE_MS;
    while (waitLineCount(fixture.submitReady) < options.submitterCount && Date.now() < readinessDeadline) {
      await delay(10);
    }
    if (waitLineCount(fixture.submitReady) < options.submitterCount) {
      invalidReasons.push("the submit readiness deadline expired before every wrapper signalled");
      aborted = true;
      settled = true;
      failures.push(...(await handlerPromise));
    } else {
      gateReleasedAt = Date.now();
      writeGate(fixture.submitGate);
      const coordinatorPromise = runWaitLoop({
        fixture,
        first: firstWait,
        workerAIds,
        submitsSettled,
        spawned,
        all: processes,
        records: waits,
        failures,
      });
      const runners = initialSlots.map((slot) =>
        runSubmit(
          fixture,
          slot,
          initial.get(slot.slot) as Spawned,
          () => {
            submitRetries += 1;
          },
          spawned,
          processes,
        ),
      );
      runners.push(
        runSubmit(
          fixture,
          tailSlot,
          tailSpawned,
          () => {
            submitRetries += 1;
          },
          spawned,
          processes,
        ),
      );
      const outcomes = await Promise.all(runners);
      outcomes.forEach((outcome) => {
        const slot = fixture.slots.find((candidate) => candidate.slot === outcome.slot) as SlotSpec;
        submitResults.push({ ...outcome, key: submitKey(fixture, slot), mode: "execute" });
      });
      settled = true;
      await coordinatorPromise;
      failures.push(...(await handlerPromise));
    }
  } finally {
    await cleanupSpawned(spawned);
    sampler.stop();
  }

  for (const process of processes) {
    if (process.execAt === null) invalidReasons.push(`${process.label} has no matching exec-instant line`);
    if (process.timedOut) failures.push(`${process.label} exceeded the ${CHILD_TIMEOUT_MS} ms child timeout`);
    if (process.status !== 0 && !hasValidErrorEnvelope(process)) {
      failures.push(`${process.label} produced no typed error envelope (${process.parseFailure ?? "untyped"})`);
    }
  }

  const metrics = computeMetrics(processes, submitResults, sampler, gateReleasedAt, submitRetries, handleStats.retries);

  const reconciled = reconcileRun({
    fixture,
    processes,
    submitResults,
    logicals,
    waits,
    expectedBySha,
    workerAIds,
    metrics,
    gateReleasedAt,
    failures,
    invalidReasons,
    strict: options.strict,
  });
  let replay: ReplayRecord[] = [];
  try {
    replay = await runReplayChecks({
      fixture,
      messages: reconciled.messages,
      submitResults,
      spawned,
      processes,
      failures,
      onRetry: () => {
        submitRetries += 1;
      },
    });
  } finally {
    // Replay processes are spawned after the load cleanup; reuse the same
    // completion promises so a signalled replay child cannot hang the run.
    await cleanupSpawned(spawned);
  }
  const reconciliation: Record<string, unknown> = { ...reconciled.summary, replay };
  reconciliation.failures = failures.length;
  reconciliation.invalidReasons = invalidReasons.length;

  // H5: one source for every overlap value, built only after reconciliation
  // has computed the wait/commit value used by the pass rule.
  const overlap = {
    allSubmitOverlap: metrics.allSubmitOverlap,
    submitterOverlapPairs: metrics.submitterOverlapPairs,
    handleSubmitOverlap: metrics.handleSubmitOverlap,
    waitCommitOverlap: metrics.waitCommitOverlap,
  };
  if (
    overlap.allSubmitOverlap !== metrics.allSubmitOverlap ||
    overlap.submitterOverlapPairs !== metrics.submitterOverlapPairs ||
    overlap.handleSubmitOverlap !== metrics.handleSubmitOverlap ||
    overlap.waitCommitOverlap !== metrics.waitCommitOverlap
  ) {
    failures.push("the recorded overlap object disagrees with the pass-rule metrics");
  }

  const runResult: RunResult = {
    run: options.run,
    strict: options.strict,
    verdict: invalidReasons.length > 0 ? "invalid" : failures.length > 0 ? "fail" : "pass",
    failures,
    invalidReasons,
    metrics,
    processes,
    submits: submitResults,
    handles: logicals,
    waits,
    overlap,
    witness: {
      samples: sampler.samples.length,
      transitions: sampler.transitions.length,
      otherMessagesInSubmitWindows: metrics.witnessCount,
    },
    reconciliation,
  };
  if (options.evidenceDir !== null) {
    mkdirSync(options.evidenceDir, { recursive: true });
    const match = /^qualification-(\d+)$/.exec(options.run);
    const fileName = match === null ? `${options.run}.json` : `run-${String(match[1]).padStart(2, "0")}.json`;
    writeFileSync(join(options.evidenceDir, fileName), `${JSON.stringify(runResult, null, 2)}\n`, "utf8");
  }
  return runResult;
}

function computeMetrics(
  processes: LoadProcess[],
  submits: SubmitResult[],
  sampler: VersionSampler,
  gateReleasedAt: number,
  submitRetries: number,
  handleRetries: number,
): Metrics {
  const submitProcesses = processes.filter((process) => process.kind === "submit");
  const initialSubmitProcesses = submitProcesses.filter((process) => /^submit-s\d+$/.test(process.label));
  const handleProcesses = processes.filter((process) => process.kind === "handle");
  const intervals = initialSubmitProcesses
    .filter((process) => process.execAt !== null && process.exitAt !== null)
    .map((process) => ({ execAt: process.execAt as number, exitAt: process.exitAt as number }));
  const allSubmitIntervals = submitProcesses
    .filter((process) => process.execAt !== null && process.exitAt !== null)
    .map((process) => ({ execAt: process.execAt as number, exitAt: process.exitAt as number }));
  let submitterOverlapPairs = 0;
  for (let i = 0; i < intervals.length; i += 1) {
    for (let j = i + 1; j < intervals.length; j += 1) {
      const a = intervals[i] as { execAt: number; exitAt: number };
      const b = intervals[j] as { execAt: number; exitAt: number };
      if (Math.max(a.execAt, b.execAt) < Math.min(a.exitAt, b.exitAt)) submitterOverlapPairs += 1;
    }
  }
  const allSubmitOverlap =
    intervals.length > 0 &&
    Math.max(...intervals.map((interval) => interval.execAt)) <
      Math.min(...intervals.map((interval) => interval.exitAt));
  const handleSubmitOverlap = handleProcesses.some((handle) => {
    if (handle.execAt === null || handle.exitAt === null) return false;
    return allSubmitIntervals.some((submit) => {
      const start = Math.max(handle.execAt as number, submit.execAt);
      const end = Math.min(handle.exitAt as number, submit.exitAt);
      return start < end;
    });
  });
  const waitCommitOverlap = false;
  const contentionRefusals = processes.filter((process) => classifyRefusal(process) === "contention").length;
  const coherenceExhaustions = processes.filter((process) => classifyRefusal(process) === "coherence").length;
  const rowVersionConflicts = processes.filter((process) => classifyRefusal(process) === "row-version").length;
  const lastExit = Math.max(0, ...processes.map((process) => process.exitAt ?? 0));
  return {
    submitCount: submits.length,
    initialSubmitterCount: submits.filter((submit) => submit.slot !== "tail").length,
    tailSubmitCount: submits.filter((submit) => submit.slot === "tail").length,
    submitterOverlapPairs,
    allSubmitOverlap,
    handleSubmitOverlap,
    waitCommitOverlap,
    witnessCount: 0,
    samplerSamples: sampler.samples.length,
    samplerTransitions: sampler.transitions.length,
    wallMs: gateReleasedAt === 0 ? 0 : Math.max(0, lastExit - gateReleasedAt),
    contentionRefusals,
    coherenceExhaustions,
    rowVersionConflicts,
    clientRetries: submitRetries + handleRetries,
  };
}

interface StoredHandlingDecision {
  id: string;
  handledAt: string | null;
  handledByParticipantId: string | null;
  handledByKind: string | null;
  handleNote: string | null;
}

/**
 * G1: reconcile each physical attempt's post-refusal read on its own. Decision
 * P1 allows an unhandled version-1 read followed by a retry and a later
 * version-2 read of the other pair member's decision; only the version-2 read
 * is compared with that stored decision and its event. A version-1 read must
 * be the uncommitted state, and a superseded logical handle must have exactly
 * one or more handled reads that all match the stored decision.
 */
function reconcileSupersededAttempts(options: {
  logicalId: string;
  attempts: HandleAttempt[];
  decision: StoredHandlingDecision | undefined;
  channelId: string;
  failures: string[];
}): void {
  const { logicalId, attempts, decision, channelId, failures } = options;
  if (
    decision === undefined ||
    decision.handledAt === null ||
    decision.handledByParticipantId === null ||
    decision.handledByKind === null
  ) {
    failures.push(`${logicalId} is superseded without a stored handling decision`);
    return;
  }
  const expectedEvent = {
    channelId,
    actingParticipantId: decision.handledByParticipantId,
    messageId: decision.id,
    processingRowVersion: 2,
  };
  let compared = 0;
  for (const attempt of attempts) {
    const state = attempt.afterRefusal;
    if (state === null) continue;
    if (state.handled === 0) {
      // The legitimate pre-win read: still unhandled at version 1 with no
      // CHANNEL_MESSAGE_HANDLED event.
      if (
        state.version !== 1 ||
        state.handledEvents !== 0 ||
        state.note !== null ||
        state.handledBy !== null ||
        state.handledKind !== null
      ) {
        failures.push(`${logicalId} has a post-refusal read that is not the uncommitted version-1 state`);
      }
      continue;
    }
    if (state.handled !== 1 || state.version !== 2) {
      failures.push(`${logicalId} has a handled post-refusal read that is not version 2`);
      continue;
    }
    compared += 1;
    if (state.handledEvents !== 1) {
      failures.push(`${logicalId} superseded read has ${state.handledEvents} handling events`);
    }
    if (
      state.note !== decision.handleNote ||
      state.handledBy !== decision.handledByParticipantId ||
      state.handledKind !== decision.handledByKind
    ) {
      failures.push(`${logicalId} superseded decision fields differ from the stored decision`);
    }
    if (!isDeepStrictEqual(state.eventMetadata, [expectedEvent])) {
      failures.push(`${logicalId} superseded event metadata differs from the stored handling event`);
    }
  }
  if (compared === 0) {
    failures.push(`${logicalId} has no version-2 post-refusal read that made it superseded`);
  }
}

function reconcileRun(options: {
  fixture: Fixture;
  processes: LoadProcess[];
  submitResults: SubmitResult[];
  logicals: LogicalHandle[];
  waits: WaitRecord[];
  expectedBySha: Map<string, SlotSpec>;
  workerAIds: Set<string>;
  metrics: Metrics;
  gateReleasedAt: number;
  failures: string[];
  invalidReasons: string[];
  strict: boolean;
}): { summary: Record<string, unknown>; messages: MessageRow[] } {
  const { fixture, failures } = options;
  const slotBySha = new Map(fixture.slots.map((slot) => [slot.sha256, slot]));
  const db = openInspection(fixture.home);
  let messages = messageRows(db, fixture.channelId);
  const installationId = installationIdOf(fixture.home);
  const events = channelEvents(eventRows(db), fixture.channelId);
  const receipts = receiptRows(db).filter((receipt) => {
    try {
      const parsed = JSON.parse(receipt.response_json) as { message?: { channelId?: string } };
      return parsed.message?.channelId === fixture.channelId;
    } catch {
      return false;
    }
  });
  let pending = pendingRows(db).filter(
    (row) =>
      row.owner_id === fixture.channelId ||
      row.to_path.startsWith(`content/channel/${fixture.channelId}/`) ||
      row.from_path?.startsWith(`content/channel/${fixture.channelId}/`) === true,
  );
  db.close();

  // Converge file-backed activation through one normal startup drain, then
  // reconcile with the record state the database actually shows.
  const unmaterialized = messages.filter((row) => row.content_storage_key !== null && row.materialized === 0);
  if (unmaterialized.length > 0) {
    const convergence = sorage(["channel", "show", fixture.channelId, "--json"], {
      home: fixture.home,
      cwd: fixture.work,
    });
    if (convergence.status !== 0) {
      failures.push(`the convergence channel show failed: ${convergence.stderr.slice(0, 200)}`);
    } else {
      const recheck = openInspection(fixture.home);
      messages = messageRows(recheck, fixture.channelId);
      pending = pendingRows(recheck).filter(
        (row) =>
          row.owner_id === fixture.channelId ||
          row.to_path.startsWith(`content/channel/${fixture.channelId}/`) ||
          row.from_path?.startsWith(`content/channel/${fixture.channelId}/`) === true,
      );
      recheck.close();
    }
  }

  const bySha = new Map<string, MessageRow>();
  if (installationId === "") failures.push("the installation id could not be read from config.yaml");
  const rowById = new Map<string, MessageRow>();
  for (const row of messages) {
    if (bySha.has(row.content_sha256)) failures.push(`two messages share content digest ${row.content_sha256}`);
    bySha.set(row.content_sha256, row);
    rowById.set(row.id, row);
  }
  const expectedSlots = new Set(fixture.slots.map((slot) => slot.sha256));
  for (const slot of fixture.slots) {
    if (!bySha.has(slot.sha256)) failures.push(`slot ${slot.slot} has no persisted message`);
  }
  for (const row of messages) {
    if (!expectedSlots.has(row.content_sha256)) {
      failures.push(`message ${row.id} has an unexpected content digest`);
    }
  }
  if (messages.length !== fixture.slots.length) {
    failures.push(`expected ${fixture.slots.length} message rows, found ${messages.length}`);
  }

  for (const row of messages) {
    const slot = slotBySha.get(row.content_sha256);
    if (slot === undefined) continue;
    if (row.sender_participant_id !== slot.senderId) failures.push(`slot ${slot.slot} has the wrong sender`);
    if (row.sender_handle !== slot.sender) failures.push(`slot ${slot.slot} has the wrong sender handle`);
    if (row.kind !== slot.kind) failures.push(`slot ${slot.slot} has the wrong kind`);
    if (row.assignment_id !== slot.assignmentId) failures.push(`slot ${slot.slot} has the wrong assignment`);
    if ((row.assignment_late === 1) !== slot.assignmentLate)
      failures.push(`slot ${slot.slot} has the wrong assignmentLate`);
    if (row.relay_to_participant_id !== slot.relayTo) failures.push(`slot ${slot.slot} has the wrong relay target`);
    if (row.context_session !== slot.contextSession) failures.push(`slot ${slot.slot} has the wrong context session`);
    if (row.context_node !== slot.contextNode) failures.push(`slot ${slot.slot} has the wrong context node`);
    if (row.context_attempt !== slot.contextAttempt) failures.push(`slot ${slot.slot} has the wrong context attempt`);
    if (row.content_size_bytes !== slot.bodyBytes) failures.push(`slot ${slot.slot} has the wrong body size`);
    if (row.content_sha256 !== slot.sha256) failures.push(`slot ${slot.slot} has the wrong body digest`);
    if (row.materialized !== 1) failures.push(`slot ${slot.slot} content is not materialized after convergence`);
    if (row.content_storage_key === null) {
      if (row.content_inline_text !== slot.body) failures.push(`slot ${slot.slot} inline body differs`);
      if (slot.bodyBytes > INLINE_MAX_BYTES) failures.push(`slot ${slot.slot} was inline above the threshold`);
    } else {
      if (slot.bodyBytes <= INLINE_MAX_BYTES)
        failures.push(`slot ${slot.slot} was file-backed at or below the threshold`);
      const expectedKey = `content/channel/${fixture.channelId}/${row.content_record_id}`;
      if (row.content_storage_key !== expectedKey) failures.push(`slot ${slot.slot} has an unmanaged storage key`);
      try {
        const bytes = readFileSync(join(fixture.home, "vault", row.content_storage_key));
        if (hashOf(bytes.toString("utf8")) !== slot.sha256) failures.push(`slot ${slot.slot} Vault bytes differ`);
        if (bytes.byteLength !== slot.bodyBytes) failures.push(`slot ${slot.slot} Vault size differs`);
      } catch {
        failures.push(`slot ${slot.slot} Vault bytes are unreadable`);
      }
    }
  }
  if (new Set(messages.map((row) => row.content_record_id)).size !== messages.length) {
    failures.push("a content record is shared by two messages");
  }
  if (pending.length > 0) failures.push(`${pending.length} Channel activation intent(s) survived the run`);

  // Receipts: one per logical key, each pointing at its own message and
  // carrying the immutable submission-time summary.
  const expectedKeys = new Set(fixture.slots.map((slot) => submitKey(fixture, slot)));
  if (receipts.length !== fixture.slots.length) {
    failures.push(`expected ${fixture.slots.length} submission receipts, found ${receipts.length}`);
  }
  const receiptByKey = new Map(receipts.map((receipt) => [receipt.key, receipt]));
  for (const slot of fixture.slots) {
    const key = submitKey(fixture, slot);
    const receipt = receiptByKey.get(key);
    const row = bySha.get(slot.sha256);
    if (receipt === undefined) {
      failures.push(`slot ${slot.slot} has no retained receipt`);
      continue;
    }
    if (receipt.scope !== `channel-submit:${installationId}:${fixture.channelId}`) {
      failures.push(
        `slot ${slot.slot} has receipt scope ${receipt.scope} instead of channel-submit:${installationId}:${fixture.channelId}`,
      );
    }
    if (row === undefined) continue;
    let stored: { message?: Record<string, unknown> } | null = null;
    try {
      stored = JSON.parse(receipt.response_json) as { message?: Record<string, unknown> };
    } catch {
      failures.push(`slot ${slot.slot} has an unparsable receipt`);
      continue;
    }
    if (stored.message?.id !== row.id) failures.push(`slot ${slot.slot} receipt names another message`);
    if (!isDeepStrictEqual(stored.message, expectedSubmitSummary(row, slot))) {
      failures.push(`slot ${slot.slot} receipt summary differs from the immutable row`);
    }
  }
  for (const receipt of receipts) {
    if (!expectedKeys.has(receipt.key)) failures.push(`unexpected submission receipt ${receipt.key}`);
  }

  // Events: one submission event per message and one handling event per
  // handled message, with the closed metadata the product defines.
  const submittedEvents = events.filter((event) => event.event_type === "CHANNEL_MESSAGE_SUBMITTED");
  const handledEvents = events.filter((event) => event.event_type === "CHANNEL_MESSAGE_HANDLED");
  const submittedByMessage = new Map<string, EventRow[]>();
  for (const event of submittedEvents) {
    const messageId = metadataOf(event).messageId;
    if (typeof messageId !== "string") continue;
    submittedByMessage.set(messageId, [...(submittedByMessage.get(messageId) ?? []), event]);
  }
  const handledByMessage = new Map<string, EventRow[]>();
  for (const event of handledEvents) {
    const messageId = metadataOf(event).messageId;
    if (typeof messageId !== "string") continue;
    handledByMessage.set(messageId, [...(handledByMessage.get(messageId) ?? []), event]);
  }
  for (const row of messages) {
    const slot = slotBySha.get(row.content_sha256) as SlotSpec;
    const submitted = submittedByMessage.get(row.id) ?? [];
    if (submitted.length !== 1) {
      failures.push(`slot ${slot.slot} has ${submitted.length} submission events`);
    } else {
      const expected = {
        channelId: fixture.channelId,
        participantId: slot.senderId,
        messageId: row.id,
        kind: slot.kind,
        assignmentId: slot.assignmentId,
        assignmentLate: slot.assignmentLate,
        relayToParticipantId: slot.relayTo,
        processingRowVersion: 1,
      };
      if (!isDeepStrictEqual(metadataOf(submitted[0] as EventRow), expected)) {
        failures.push(`slot ${slot.slot} submission event metadata differs`);
      }
    }
    const handled = handledByMessage.get(row.id) ?? [];
    if (row.handled === 1) {
      if (handled.length !== 1) failures.push(`slot ${slot.slot} has ${handled.length} handling events`);
      else if (
        !isDeepStrictEqual(metadataOf(handled[0] as EventRow), {
          channelId: fixture.channelId,
          actingParticipantId: fixture.mainId,
          messageId: row.id,
          processingRowVersion: 2,
        })
      ) {
        failures.push(`slot ${slot.slot} handling event metadata differs`);
      }
    } else if (handled.length !== 0) {
      failures.push(`slot ${slot.slot} has a handling event while unhandled`);
    }
  }

  // Handling state and response-to-attempt attribution (decision P1).
  const exitZeroByMessage = new Map<string, HandleAttempt[]>();
  for (const logical of options.logicals) {
    for (const attempt of logical.attempts) {
      if (attempt.process.status === 0) {
        const messageId = (attempt.process.envelope?.data as { message?: { id?: string } } | undefined)?.message?.id;
        if (messageId !== undefined) {
          exitZeroByMessage.set(messageId, [...(exitZeroByMessage.get(messageId) ?? []), attempt]);
        }
      }
    }
  }
  const pairLogicals = options.logicals.filter((logical) => logical.pair);
  const pairMessageId = pairLogicals[0]?.messageId ?? null;
  for (const row of messages) {
    const slot = slotBySha.get(row.content_sha256) as SlotSpec;
    if (options.workerAIds.has(row.sender_participant_id)) {
      if (row.handled !== 0 || row.processing_row_version !== 1) {
        failures.push(`worker-a slot ${slot.slot} was handled or its version advanced`);
      }
      if (
        row.handled_at !== null ||
        row.handled_by_participant_id !== null ||
        row.handled_by_kind !== null ||
        row.handle_note !== null
      ) {
        failures.push(`worker-a slot ${slot.slot} carries handling fields`);
      }
      continue;
    }
    if (row.handled !== 1 || row.processing_row_version !== 2) {
      failures.push(`slot ${slot.slot} is not handled at version 2`);
      continue;
    }
    if (row.handled_by_participant_id !== fixture.mainId || row.handled_by_kind !== "participant") {
      failures.push(`slot ${slot.slot} has the wrong handling actor`);
    }
    const winners = exitZeroByMessage.get(row.id) ?? [];
    if (winners.length !== 1) {
      failures.push(`slot ${slot.slot} has ${winners.length} exit-0 handling attempts`);
      continue;
    }
    const winner = winners[0] as HandleAttempt;
    if (winner.note !== row.handle_note) {
      failures.push(`slot ${slot.slot} recorded a note no exit-0 attempt reported`);
    }
    const preview = winner.process.envelope?.data as
      | { message?: Record<string, unknown>; bodyPreviewUnavailable?: boolean }
      | undefined;
    const unavailable = preview?.bodyPreviewUnavailable === true;
    const expectedResponse = unavailable
      ? { ...expectedHandledSummary(row, slot, winner.note), bodyPreview: "", bodyPreviewTruncated: false }
      : expectedHandledSummary(row, slot, winner.note);
    if (!isDeepStrictEqual(preview?.message, expectedResponse)) {
      failures.push(`slot ${slot.slot} handle response differs from the stored decision`);
    }
    if (row.id === pairMessageId) {
      const pairOutcomes = pairLogicals.map((logical) => logical.outcome).sort();
      if (pairOutcomes.filter((outcome) => outcome === "success").length !== 1) {
        failures.push(`the duplicate pair has ${pairOutcomes.filter((value) => value === "success").length} winners`);
      }
      if (
        !pairOutcomes.every((outcome) => outcome === "success" || outcome === "conflict" || outcome === "superseded")
      ) {
        failures.push(`the duplicate pair settled as ${pairOutcomes.join(", ")}`);
      }
    }
  }
  for (const logical of options.logicals) {
    if (logical.outcome === "conflict" && !logical.pair) {
      failures.push(`${logical.id} received a ROW_VERSION_CONFLICT outside the deliberate pair`);
    }
    if (logical.outcome === "success") {
      const data = logical.attempts.find((attempt) => attempt.process.status === 0)?.process.envelope?.data as
        | Record<string, unknown>
        | undefined;
      if (data !== undefined && !isDeepStrictEqual(Object.keys(data).sort(), ["bodyPreviewUnavailable", "message"])) {
        failures.push(`${logical.id} returned a non-closed handle data wrapper`);
      }
    }
  }
  // H6: reconcile every duplicate-pair loser and superseded attempt with the
  // stored decision and its CHANNEL_MESSAGE_HANDLED event, not only counts.
  for (const logical of options.logicals) {
    const row = rowById.get(logical.messageId);
    if (logical.outcome === "conflict") {
      if (row === undefined || row.handled !== 1) {
        failures.push(`${logical.id} has a conflict without a stored handling decision`);
      } else {
        const conflictAttempts = logical.attempts.filter(
          (attempt) =>
            attempt.process.status === 75 && attempt.process.envelope?.error?.code === "ROW_VERSION_CONFLICT",
        );
        if (conflictAttempts.length === 0) {
          failures.push(`${logical.id} has no exit-75 ROW_VERSION_CONFLICT attempt`);
        }
        for (const attempt of conflictAttempts) {
          const details = attempt.process.envelope?.error?.details ?? {};
          const expected = {
            handledAt: row.handled_at,
            handledByParticipantId: row.handled_by_participant_id,
            handledByKind: row.handled_by_kind,
          };
          if (
            !isDeepStrictEqual(Object.keys(details).sort(), ["handledAt", "handledByKind", "handledByParticipantId"]) ||
            !isDeepStrictEqual(details, expected)
          ) {
            failures.push(`${logical.id} conflict details differ from the stored decision`);
          }
        }
      }
    }
    if (logical.outcome === "superseded") {
      reconcileSupersededAttempts({
        logicalId: logical.id,
        attempts: logical.attempts,
        decision:
          row === undefined
            ? undefined
            : {
                id: row.id,
                handledAt: row.handled_at,
                handledByParticipantId: row.handled_by_participant_id,
                handledByKind: row.handled_by_kind,
                handleNote: row.handle_note,
              },
        channelId: fixture.channelId,
        failures,
      });
    }
    for (const attempt of logical.attempts) {
      const afterRefusal = attempt.afterRefusal;
      if (afterRefusal === null) continue;
      if (logical.pair && logical.outcome === "superseded") continue;
      if (
        afterRefusal.handled !== 0 ||
        afterRefusal.version !== 1 ||
        afterRefusal.handledEvents !== 0 ||
        afterRefusal.note !== null ||
        afterRefusal.handledBy !== null ||
        afterRefusal.handledKind !== null
      ) {
        failures.push(`${logical.id} recorded a post-refusal state that is not unhandled version 1`);
      }
    }
  }
  if (failures.some((failure) => failure.includes("exit-0 handling attempts"))) {
    failures.push("a recorded handling decision was not reported by an exit-0 attempt");
  }

  // Submit responses must link to their slots, the receipt, and the row.
  for (const result of options.submitResults) {
    const slot = fixture.slots.find((candidate) => candidate.slot === result.slot) as SlotSpec;
    const row = bySha.get(slot.sha256);
    if (result.failure !== null) {
      failures.push(`slot ${slot.slot}: ${result.failure}`);
      continue;
    }
    if (result.success === null) {
      failures.push(`slot ${slot.slot} has no successful submit attempt`);
      continue;
    }
    if (row === undefined) continue;
    const envelope = result.success.envelope;
    const data = envelope?.data as
      | { message?: Record<string, unknown>; replayed?: boolean; contentActivating?: boolean }
      | undefined;
    if (envelope?.ok !== true || data === undefined) {
      failures.push(`slot ${slot.slot} submit success envelope is malformed`);
      continue;
    }
    if (!isDeepStrictEqual(Object.keys(data).sort(), ["contentActivating", "message", "replayed"])) {
      failures.push(`slot ${slot.slot} returned a non-closed submit data wrapper`);
    }
    if (data.replayed !== false) failures.push(`slot ${slot.slot} first success reported replayed=true`);
    if (!isDeepStrictEqual(data.message, expectedSubmitSummary(row, slot))) {
      failures.push(`slot ${slot.slot} submit response differs from the stored submit-time summary`);
    }
    if (typeof data.contentActivating !== "boolean") {
      failures.push(`slot ${slot.slot} has no boolean contentActivating`);
    } else if (slot.bodyBytes <= INLINE_MAX_BYTES && data.contentActivating !== false) {
      failures.push(`slot ${slot.slot} reports contentActivating=true for inline content`);
    } else if (data.contentActivating === false && row.materialized !== 1) {
      failures.push(`slot ${slot.slot} reports contentActivating=false with an unmaterialized record`);
    }
  }

  // The public listing and per-message reads must agree with the direct read.
  const listed: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const args = ["channel", "messages", fixture.channelId, "--all", "--limit", "200", "--json"];
    if (cursor !== null) args.push("--cursor", cursor);
    const page = sorage(args, { home: fixture.home, cwd: fixture.work });
    if (page.status !== 0) {
      failures.push("the public messages listing failed");
      break;
    }
    const data = dataOf(page) as { items?: Array<{ id?: string }>; nextCursor?: string | null };
    for (const item of data.items ?? []) {
      if (typeof item.id === "string") listed.push(item.id);
    }
    cursor = data.nextCursor ?? null;
    pages += 1;
  } while (cursor !== null && pages < 20);
  if (new Set(listed).size !== listed.length) failures.push("the public listing returned a duplicate message ID");
  if (new Set(listed).size !== messages.length) failures.push("the public listing did not return every message once");
  for (const row of messages) {
    const read = sorageLarge(["channel", "read", fixture.channelId, row.id, "--json"], fixture.home, fixture.work);
    if (read.status !== 0) {
      failures.push(
        `the public read of slot ${slotBySha.get(row.content_sha256)?.slot ?? row.id} failed (${read.status}): ${read.stderr.slice(0, 300)}`,
      );
      continue;
    }
    const detail = dataOf(read) as { message?: { body?: string; handled?: boolean; processingRowVersion?: number } };
    const slot = slotBySha.get(row.content_sha256) as SlotSpec;
    if (detail.message?.body !== slot.body)
      failures.push(`the public read of slot ${slot.slot} returned different bytes`);
    if (detail.message?.handled !== (row.handled === 1)) {
      failures.push(`the public read of slot ${slot.slot} disagrees on handling state`);
    }
    if (detail.message?.processingRowVersion !== row.processing_row_version) {
      failures.push(`the public read of slot ${slot.slot} disagrees on the row version`);
    }
  }

  // Wait evidence: every wait exited 0, every returned ID maps to a stored
  // message, and each timeout is judged only by that wait's own deadline,
  // visibility and handling state (H4). An earlier wait's return never excuses
  // a later timeout.
  const storedIds = new Set(messages.map((row) => row.id));
  const returnedByAnyWait = new Set(options.waits.flatMap((wait) => wait.returnedIds));
  for (const wait of options.waits) {
    for (const id of wait.returnedIds) {
      if (!storedIds.has(id)) failures.push(`wait ${wait.process.label} returned unknown message ${id}`);
    }
    if (!wait.timedOut) continue;
    const waitStarted = wait.process.execAt ?? wait.startedAt;
    const ownReturned = new Set(wait.returnedIds);
    for (const result of options.submitResults) {
      if (result.success === null) continue;
      const slot = fixture.slots.find((candidate) => candidate.slot === result.slot) as SlotSpec;
      const row = bySha.get(slot.sha256);
      if (row === undefined) continue;
      // created_at is sampled inside the committing transaction; a 250 ms
      // visibility margin keeps a commit that lands just after the deadline
      // from making a legitimate timeout look unexpected.
      const visibleAt = Date.parse(row.created_at) + 250;
      if (visibleAt > wait.deadline) continue;
      if (row.handled === 1 && row.handled_at !== null && Date.parse(row.handled_at) <= waitStarted) {
        continue;
      }
      if (!ownReturned.has(row.id)) {
        failures.push(`wait ${wait.process.label} timed out while slot ${slot.slot} was visible and unhandled`);
      }
    }
  }

  // Contention witness: another logical message committed inside a submit
  // interval. Without it a no-exhaustion result cannot support the decision.
  let witnessCount = 0;
  for (const process of options.processes.filter((candidate) => candidate.kind === "submit")) {
    if (process.execAt === null || process.exitAt === null) continue;
    for (const row of messages) {
      const created = Date.parse(row.created_at);
      if (created >= (process.execAt as number) && created <= (process.exitAt as number)) {
        const data = process.envelope?.data as { message?: { id?: string } } | undefined;
        if (data?.message?.id !== row.id) witnessCount += 1;
      }
    }
  }
  options.metrics.witnessCount = witnessCount;

  // Overlap evidence. The permanent case is hard only for two concurrently
  // executing submitters (decision, reviewer A); the qualification matrix
  // enforces the full all-N overlap, handle overlap, wait/commit overlap and
  // witness validity.
  const waitCommitOverlap = options.waits.some((wait) => {
    if (wait.process.execAt === null || wait.process.exitAt === null) return false;
    return messages.some((row) => {
      const created = Date.parse(row.created_at);
      return (
        created >= (wait.process.execAt as number) &&
        created <= (wait.process.exitAt as number) &&
        returnedByAnyWait.has(row.id)
      );
    });
  });
  options.metrics.waitCommitOverlap = waitCommitOverlap;
  const allSubmitOverlap = options.metrics.allSubmitOverlap;
  const handleSubmitOverlap = options.metrics.handleSubmitOverlap;
  if (options.strict) {
    if (!allSubmitOverlap) options.invalidReasons.push("the initial submit processes never all overlapped");
    if (!handleSubmitOverlap) options.invalidReasons.push("no handle interval overlapped a submit interval");
    if (!waitCommitOverlap) options.invalidReasons.push("no message was committed during and then returned by a wait");
    if (witnessCount === 0) options.invalidReasons.push("no other message committed inside any submit interval");
  } else if (options.metrics.submitterOverlapPairs === 0) {
    failures.push("fewer than two submit processes executed concurrently");
  }
  if (options.metrics.wallMs > RUN_HARD_BOUND_MS) {
    failures.push(`the run exceeded the ${RUN_HARD_BOUND_MS} ms hard bound (${options.metrics.wallMs} ms)`);
  }

  return {
    summary: {
      messageCount: messages.length,
      expectedMessageCount: fixture.slots.length,
      receiptCount: receipts.length,
      submittedEventCount: submittedEvents.length,
      handledEventCount: handledEvents.length,
      pendingIntentCount: pending.length,
      listedCount: listed.length,
      waitCount: options.waits.length,
      handleAttemptCount: options.logicals.reduce((total, logical) => total + logical.attempts.length, 0),
      failures: failures.length,
      invalidReasons: options.invalidReasons.length,
      witnessCount,
      contentActivating: options.submitResults.map((result) => {
        const data = result.success?.envelope?.data as { contentActivating?: boolean } | undefined;
        return { slot: result.slot, contentActivating: data?.contentActivating };
      }),
      snapshot: {
        messages: messages.map((row) => ({
          id: row.id,
          channelId: row.channel_id,
          senderParticipantId: row.sender_participant_id,
          kind: row.kind,
          assignmentId: row.assignment_id,
          assignmentLate: row.assignment_late === 1,
          relayToParticipantId: row.relay_to_participant_id,
          contextSession: row.context_session,
          contextNode: row.context_node,
          contextAttempt: row.context_attempt,
          handled: row.handled === 1,
          handledAt: row.handled_at,
          handledByParticipantId: row.handled_by_participant_id,
          handledByKind: row.handled_by_kind,
          handleNote: row.handle_note,
          processingRowVersion: row.processing_row_version,
          createdAt: row.created_at,
          contentRecordId: row.content_record_id,
          bodyBytes: row.content_size_bytes,
          bodySha256: row.content_sha256,
          materialized: row.materialized === 1,
          storageKey: row.content_storage_key,
        })),
        events: events.map((event) => ({
          id: event.id,
          eventType: event.event_type,
          metadata: metadataOf(event),
          createdAt: event.created_at,
        })),
        receipts: receipts.map((receipt) => ({
          key: receipt.key,
          scope: receipt.scope,
          requestHash: receipt.request_hash,
          response: JSON.parse(receipt.response_json) as unknown,
          createdAt: receipt.created_at,
          expiresAt: receipt.expires_at,
        })),
        pendingIntents: pending,
      },
    },
    messages,
  };
}

function countRunRows(db: DatabaseSync, channelId: string): { messages: number; events: number; pending: number } {
  const messages = db.prepare("SELECT COUNT(*) AS n FROM channel_messages WHERE channel_id = ?").get(channelId) as {
    n: number;
  };
  const events = db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type LIKE 'CHANNEL_%'").get() as {
    n: number;
  };
  const pending = db.prepare("SELECT COUNT(*) AS n FROM pending_fs_ops").get() as { n: number };
  return { messages: messages.n, events: events.n, pending: pending.n };
}

async function runReplayCommand(options: {
  fixture: Fixture;
  label: string;
  args: string[];
  spawned: Spawned[];
  processes: LoadProcess[];
  onRetry: () => void;
}): Promise<{ process: LoadProcess | null; attempts: number; failure: string | null }> {
  for (let attempt = 0; attempt <= MAX_CLIENT_RETRIES; attempt += 1) {
    if (attempt > 0) await delay(RETRY_DELAYS_MS[attempt - 1] as number);
    const spawned = spawnGated({
      kind: "replay",
      label: `${options.label}-a${attempt + 1}`,
      args: options.args,
      home: options.fixture.home,
      cwd: options.fixture.work,
      gateFile: options.fixture.openGate,
      readyFile: null,
      execLog: options.fixture.execLog,
      onSpawn: (item) => options.spawned.push(item),
    });
    const process = await spawned.done;
    options.processes.push(process);
    if (process.execAt === null) {
      return { process, attempts: attempt + 1, failure: "the replay process has no exec instant" };
    }
    if (process.timedOut) {
      return { process, attempts: attempt + 1, failure: `the replay process exceeded ${CHILD_TIMEOUT_MS} ms` };
    }
    if (process.status === 0) {
      return { process, attempts: attempt + 1, failure: null };
    }
    const classification = classifyRefusal(process);
    if (classification !== "contention" && classification !== "coherence") {
      return {
        process,
        attempts: attempt + 1,
        failure: `the replay process exited ${String(process.status)} (${process.envelope?.error?.code ?? "untyped"})`,
      };
    }
    if (attempt === MAX_CLIENT_RETRIES) {
      return { process, attempts: attempt + 1, failure: "the replay process exhausted its client retries" };
    }
    options.onRetry();
  }
  return { process: null, attempts: 0, failure: "the replay retry loop ended without an outcome" };
}

function readReplayResponse(
  slot: SlotSpec,
  row: MessageRow,
  process: LoadProcess,
  attempts: number,
  mode: "replay-only" | "identical replay",
  failures: string[],
): ReplayRunRecord {
  const data = process.envelope?.data as
    | { message?: Record<string, unknown>; replayed?: boolean; contentActivating?: boolean }
    | undefined;
  const record: ReplayRunRecord = {
    status: process.status,
    replayed: data?.replayed ?? null,
    contentActivating: data?.contentActivating ?? null,
    messageId: typeof data?.message?.id === "string" ? data.message.id : null,
    attempts,
    failure: null,
  };
  if (process.status !== 0 || process.parseFailure !== null || process.envelope?.ok !== true) {
    record.failure = `${mode} did not return a success envelope`;
    failures.push(`slot ${slot.slot} ${record.failure}`);
    return record;
  }
  if (
    data === undefined ||
    !isDeepStrictEqual(Object.keys(data).sort(), ["contentActivating", "message", "replayed"])
  ) {
    record.failure = `${mode} returned a non-closed data wrapper`;
    failures.push(`slot ${slot.slot} ${record.failure}`);
    return record;
  }
  if (data.replayed !== true) {
    record.failure = `${mode} did not report replayed=true`;
    failures.push(`slot ${slot.slot} ${record.failure}`);
  }
  if (typeof data.contentActivating !== "boolean") {
    record.failure = `${mode} has no boolean contentActivating`;
    failures.push(`slot ${slot.slot} ${record.failure}`);
  }
  if (!isDeepStrictEqual(data.message, expectedSubmitSummary(row, slot))) {
    record.failure = `${mode} summary differs from the stored outcome`;
    failures.push(`slot ${slot.slot} ${record.failure}`);
  }
  if (slot.bodyBytes <= INLINE_MAX_BYTES && data.contentActivating !== false) {
    record.failure = `${mode} reports contentActivating=true for inline content`;
    failures.push(`slot ${slot.slot} ${record.failure}`);
  }
  if (data.contentActivating === false && row.materialized !== 1) {
    record.failure = `${mode} reports false with an unmaterialized record`;
    failures.push(`slot ${slot.slot} ${record.failure}`);
  }
  return record;
}

async function runReplayChecks(options: {
  fixture: Fixture;
  messages: MessageRow[];
  submitResults: SubmitResult[];
  spawned: Spawned[];
  processes: LoadProcess[];
  failures: string[];
  onRetry: () => void;
}): Promise<ReplayRecord[]> {
  const records: ReplayRecord[] = [];
  const before = new Map<string, ReceiptRow>();
  const snapshot = openInspection(options.fixture.home);
  let beforeCounts = { messages: 0, events: 0, pending: 0 };
  try {
    for (const receipt of receiptRows(snapshot)) before.set(receipt.key, receipt);
    beforeCounts = countRunRows(snapshot, options.fixture.channelId);
  } finally {
    snapshot.close();
  }
  for (const slot of options.fixture.slots) {
    const submit = options.submitResults.find((result) => result.slot === slot.slot);
    const row = options.messages.find((message) => message.content_sha256 === slot.sha256);
    if (submit === undefined || submit.success === null || row === undefined) {
      // The original submission failure is already recorded; there is no
      // retained outcome to replay.
      records.push({ slot: slot.slot, replayOnly: null, identicalReplay: null });
      continue;
    }
    const replayOnlyRun = await runReplayCommand({
      fixture: options.fixture,
      label: `replay-${slot.slot}`,
      args: submitArgv(options.fixture, slot, true),
      spawned: options.spawned,
      processes: options.processes,
      onRetry: options.onRetry,
    });
    let replayOnly: ReplayRunRecord;
    if (replayOnlyRun.failure !== null || replayOnlyRun.process === null) {
      options.failures.push(`slot ${slot.slot} replay-only failed: ${replayOnlyRun.failure ?? "no process"}`);
      replayOnly = {
        status: replayOnlyRun.process?.status ?? null,
        replayed: null,
        contentActivating: null,
        messageId: null,
        attempts: replayOnlyRun.attempts,
        failure: replayOnlyRun.failure,
      };
    } else {
      replayOnly = readReplayResponse(
        slot,
        row,
        replayOnlyRun.process,
        replayOnlyRun.attempts,
        "replay-only",
        options.failures,
      );
    }

    const identicalRun = await runReplayCommand({
      fixture: options.fixture,
      label: `replay-execute-${slot.slot}`,
      args: submitArgv(options.fixture, slot, false),
      spawned: options.spawned,
      processes: options.processes,
      onRetry: options.onRetry,
    });
    let identicalReplay: ReplayRunRecord;
    if (identicalRun.failure !== null || identicalRun.process === null) {
      options.failures.push(`slot ${slot.slot} identical replay failed: ${identicalRun.failure ?? "no process"}`);
      identicalReplay = {
        status: identicalRun.process?.status ?? null,
        replayed: null,
        contentActivating: null,
        messageId: null,
        attempts: identicalRun.attempts,
        failure: identicalRun.failure,
      };
    } else {
      identicalReplay = readReplayResponse(
        slot,
        row,
        identicalRun.process,
        identicalRun.attempts,
        "identical replay",
        options.failures,
      );
    }
    records.push({ slot: slot.slot, replayOnly, identicalReplay });
  }
  const db = openInspection(options.fixture.home);
  try {
    const after = receiptRows(db);
    for (const receipt of after) {
      const previous = before.get(receipt.key);
      if (previous === undefined) {
        options.failures.push(`replay created a receipt for ${receipt.key}`);
      } else if (
        previous.expires_at !== receipt.expires_at ||
        previous.response_json !== receipt.response_json ||
        previous.request_hash !== receipt.request_hash
      ) {
        options.failures.push(`replay changed the retained receipt for ${receipt.key}`);
      }
    }
    const afterCounts = countRunRows(db, options.fixture.channelId);
    if (!isDeepStrictEqual(afterCounts, beforeCounts)) {
      options.failures.push("replay changed the message, event, or pending-intent row counts");
    }
  } finally {
    db.close();
  }
  return records;
}

function qualificationEvidenceDir(): string {
  const configured = process.env.SORAGE_QUALIFICATION_EVIDENCE;
  if (configured !== undefined && configured.trim().length > 0) {
    mkdirSync(configured, { recursive: true });
    return configured;
  }
  return makeTempDir("t114-qualification-evidence-");
}

describe("TASK-114 multi-process Channel concurrency", () => {
  it("cleans up a signal-terminated child without waiting for a second close", async () => {
    const work = makeTempDir("t114-signal-");
    const gate = join(work, "open.gate");
    const execLog = join(work, "exec.log");
    writeGate(gate);
    const spawned = spawnGated({
      kind: "submit",
      label: "signal-check",
      binary: "/bin/sh",
      args: ["-c", "kill -TERM $$"],
      home: work,
      cwd: work,
      gateFile: gate,
      readyFile: null,
      execLog,
      onSpawn: () => undefined,
    });
    const record = await spawned.done;
    expect(record.signal).toBe("SIGTERM");
    expect(record.status).toBeNull();
    const started = Date.now();
    await cleanupSpawned([spawned]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("rejects a permitted-looking refusal at the wrong exit or with a signal", () => {
    const envelope: Envelope = {
      ok: false,
      error: {
        code: "STORAGE_INSPECTION_UNAVAILABLE",
        message: EXHAUSTION_MESSAGE,
        details: {},
        recovery: { suggestedCommand: "Retry the identical request" },
      },
    };
    const refusal = (status: number, signal: string | null): LoadProcess => ({
      kind: "submit",
      label: "refusal-check",
      argv: [],
      pid: null,
      spawnAt: 0,
      execAt: 0,
      exitAt: 0,
      status,
      signal,
      timedOut: false,
      stdout: "",
      stderr: "",
      envelope,
      parseFailure: null,
    });
    expect(classifyRefusal(refusal(2, null))).toBe("other");
    expect(classifyRefusal(refusal(75, "SIGTERM"))).toBe("other");
    expect(classifyRefusal(refusal(75, null))).toBe("coherence");
  });

  it("accepts an unhandled version-1 read followed by a version-2 superseded read", () => {
    const channelId = "aaaaaaaa-0000-4000-8000-000000000001";
    const messageId = "dddddddd-0000-4000-8000-000000000004";
    const decision: StoredHandlingDecision = {
      id: messageId,
      handledAt: "2026-01-01T00:00:00.000Z",
      handledByParticipantId: "bbbbbbbb-0000-4000-8000-000000000002",
      handledByKind: "participant",
      handleNote: "winner-note",
    };
    const event = {
      channelId,
      actingParticipantId: decision.handledByParticipantId,
      messageId,
      processingRowVersion: 2,
    };
    const refusalProcess = (): LoadProcess => ({
      kind: "handle",
      label: "pair-loser",
      argv: [],
      pid: null,
      spawnAt: 0,
      execAt: 0,
      exitAt: 0,
      status: 75,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      envelope: null,
      parseFailure: null,
    });
    const attemptWith = (state: NonNullable<HandleAttempt["afterRefusal"]>): HandleAttempt => ({
      process: refusalProcess(),
      note: "pair-loser-note",
      afterRefusal: state,
    });
    const attempts = [
      attemptWith({
        handled: 0,
        version: 1,
        note: null,
        handledBy: null,
        handledKind: null,
        handledEvents: 0,
        eventMetadata: [],
      }),
      attemptWith({
        handled: 1,
        version: 2,
        note: "winner-note",
        handledBy: "bbbbbbbb-0000-4000-8000-000000000002",
        handledKind: "participant",
        handledEvents: 1,
        eventMetadata: [event],
      }),
    ];
    const failures: string[] = [];
    reconcileSupersededAttempts({ logicalId: "pair-loser", attempts, decision, channelId, failures });
    expect(failures).toEqual([]);

    // The version-2 read is still compared with the stored event.
    const broken: HandleAttempt[] = [
      attempts[0] as HandleAttempt,
      attemptWith({
        handled: 1,
        version: 2,
        note: "winner-note",
        handledBy: "bbbbbbbb-0000-4000-8000-000000000002",
        handledKind: "participant",
        handledEvents: 1,
        eventMetadata: [],
      }),
    ];
    const brokenFailures: string[] = [];
    reconcileSupersededAttempts({
      logicalId: "pair-loser",
      attempts: broken,
      decision,
      channelId,
      failures: brokenFailures,
    });
    expect(brokenFailures.length).toBeGreaterThan(0);
  });

  it(
    "permanently regresses the 2 x 5 compiled submit, event-driven tail, wait, and handle load",
    { timeout: 150_000 },
    async () => {
      const failures: string[] = [];
      for (let iteration = 1; iteration <= 2; iteration += 1) {
        const result = await executeRun({
          run: `permanent-${iteration}`,
          iteration,
          submitterCount: 5,
          strict: false,
          evidenceDir: null,
        });
        if (result.verdict !== "pass") {
          failures.push(
            `${result.verdict} run '${result.run}': ${[...result.invalidReasons, ...result.failures].join("; ")}`,
          );
        }
        console.info(
          `TASK-114 permanent ${result.run}: ${result.verdict} allSubmitOverlap=${String(result.metrics.allSubmitOverlap)} submitterOverlapPairs=${result.metrics.submitterOverlapPairs} handleSubmitOverlap=${String(result.metrics.handleSubmitOverlap)} waitCommitOverlap=${String(result.metrics.waitCommitOverlap)} witness=${result.metrics.witnessCount} contention=${result.metrics.contentionRefusals} coherenceExhaustion=${result.metrics.coherenceExhaustions} wallMs=${result.metrics.wallMs}`,
        );
      }
      expect(failures.join("\n")).toBe("");
    },
  );

  const qualificationTest = process.env.SORAGE_CHANNEL_QUALIFICATION === "1" ? it : it.skip;
  qualificationTest("runs the Supervisor-controlled 6 x 8 qualification matrix", { timeout: 480_000 }, async () => {
    const evidenceDir = qualificationEvidenceDir();
    const results: RunResult[] = [];
    for (let run = 1; run <= 6; run += 1) {
      try {
        results.push(
          await executeRun({
            run: `qualification-${run}`,
            iteration: run,
            submitterCount: 8,
            strict: true,
            evidenceDir,
          }),
        );
      } catch (error) {
        const result: RunResult = {
          run: `qualification-${run}`,
          strict: true,
          verdict: "invalid",
          failures: [],
          invalidReasons: [`the harness threw: ${error instanceof Error ? error.message : String(error)}`],
          metrics: {
            submitCount: 0,
            initialSubmitterCount: 0,
            tailSubmitCount: 0,
            submitterOverlapPairs: 0,
            allSubmitOverlap: false,
            handleSubmitOverlap: false,
            waitCommitOverlap: false,
            witnessCount: 0,
            samplerSamples: 0,
            samplerTransitions: 0,
            wallMs: 0,
            contentionRefusals: 0,
            coherenceExhaustions: 0,
            rowVersionConflicts: 0,
            clientRetries: 0,
          },
          processes: [],
          submits: [],
          handles: [],
          waits: [],
          overlap: {},
          witness: { samples: 0, transitions: 0, otherMessagesInSubmitWindows: 0 },
          reconciliation: {},
        };
        results.push(result);
        writeFileSync(
          join(evidenceDir, `run-${String(run).padStart(2, "0")}.json`),
          `${JSON.stringify(result, null, 2)}\n`,
          "utf8",
        );
      }
    }
    const summary = {
      task: "TASK-114",
      matrix: "6 x 8",
      runs: results.map((result) => ({
        run: result.run,
        verdict: result.verdict,
        failures: result.failures,
        invalidReasons: result.invalidReasons,
        wallMs: result.metrics.wallMs,
        contentionRefusals: result.metrics.contentionRefusals,
        coherenceExhaustions: result.metrics.coherenceExhaustions,
        rowVersionConflicts: result.metrics.rowVersionConflicts,
        clientRetries: result.metrics.clientRetries,
        overlap: result.overlap,
        witness: result.witness,
      })),
      counts: {
        runs: results.length,
        passed: results.filter((result) => result.verdict === "pass").length,
        failed: results.filter((result) => result.verdict === "fail").length,
        invalid: results.filter((result) => result.verdict === "invalid").length,
      },
      wallMs: {
        min: Math.min(...results.map((result) => result.metrics.wallMs)),
        max: Math.max(...results.map((result) => result.metrics.wallMs)),
      },
      refusals: {
        contention: results.reduce((total, result) => total + result.metrics.contentionRefusals, 0),
        coherenceExhaustion: results.reduce((total, result) => total + result.metrics.coherenceExhaustions, 0),
        rowVersionConflict: results.reduce((total, result) => total + result.metrics.rowVersionConflicts, 0),
        clientRetries: results.reduce((total, result) => total + result.metrics.clientRetries, 0),
      },
    };
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.info(
      `TASK-114 qualification matrix: ${JSON.stringify(summary.counts)} refusals=${JSON.stringify(summary.refusals)} wallMs=${JSON.stringify(summary.wallMs)}`,
    );
    const bad = results.filter((result) => result.verdict !== "pass");
    if (bad.length > 0) {
      throw new Error(
        bad
          .map(
            (result) =>
              `${result.run}: ${result.verdict} (${[...result.invalidReasons, ...result.failures].join("; ")})`,
          )
          .join("\n"),
      );
    }
  });
});
