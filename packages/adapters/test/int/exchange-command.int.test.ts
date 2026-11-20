import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupRestore,
  backupVerify,
  canonicalJson,
  type ExchangeActionFor,
  exportSnapshot,
  type ExchangeBusinessInput,
  type ExchangeInput,
  initializeInstallation,
  type Result,
  snapshotFilesV5,
} from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { admitExchangeJoin, executeExchange } from "../../src/exchange-command-ports";
import { readExchangeRecords } from "../../src/exchange-records";
import { createExchangeWorkingStore } from "../../src/exchange-working-store";
import { createNodeInitPorts } from "../../src/init-ports";
import { openSorageDatabase, type SorageSqlite } from "../../src/sqlite/connection";
import { productionMigrationPlan } from "../../src/sqlite/migrations";
import { openAndMigrate } from "../../src/sqlite/migrator";

const alphaId = "11111111-1111-4111-8111-111111111111";
const betaId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const now = "2026-11-20T00:00:00.000Z";
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function unwrap<T>(result: Result<T>): T {
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function materialPage(result: Result<ExchangeActionFor<"material-read">>) {
  const value = unwrap(result);
  if (!("encoding" in value)) throw new Error("Expected a byte range from a local material.");
  return value;
}

function seedProjects(
  db: SorageSqlite,
  projects: Array<{ id: string; slug: string; path: string }>,
  installationId: string,
) {
  for (const { id, slug, path } of projects) {
    db.prepare(
      "INSERT INTO projects (id,slug,display_name,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)",
    ).run(id, slug, slug, now, now);
    db.prepare("INSERT INTO project_bindings VALUES (?,?,?,?,?,?,?)").run(
      id,
      id,
      installationId,
      path,
      "directory",
      now,
      now,
    );
  }
}

function fixture(seed = true) {
  const parent = mkdtempSync(join(tmpdir(), "sorage-exchange-command-"));
  homes.push(parent);
  const home = join(parent, "home");
  const vault = join(home, "vault");
  const database = join(home, "state", "sorage.sqlite3");
  const alpha = join(parent, "alpha");
  const beta = join(parent, "beta");
  const other = join(parent, "other");
  for (const path of [alpha, beta, other]) mkdirSync(path);
  const env = { SORAGE_HOME: home };
  const setup = { env, userHome: parent };
  unwrap(initializeInstallation(createNodeInitPorts(setup), { vaultPath: vault }));
  let time = new Date(now);
  const projects = [
    { id: alphaId, slug: "alpha", path: alpha },
    { id: betaId, slug: "beta", path: beta },
    { id: otherId, slug: "other", path: other },
  ];
  function usingDb<T>(work: (db: SorageSqlite) => T): T {
    const db = openSorageDatabase(database);
    try {
      return work(db);
    } finally {
      db.close();
    }
  }
  if (seed) {
    const marker = JSON.parse(readFileSync(join(vault, ".sorage-vault.json"), "utf8"));
    usingDb((db) => seedProjects(db, projects, marker.installationId));
  }
  return {
    parent,
    home,
    vault,
    database,
    alpha,
    beta,
    other,
    setup,
    projects,
    usingDb,
    ports: createNodeBackupCommandPorts(setup),
    later: (seconds: number) => {
      time = new Date(time.getTime() + seconds * 1_000);
    },
    run: <Input extends ExchangeInput>(input: Input, cwd = alpha, project?: string, onFreshWrite?: () => void) =>
      executeExchange(input, { ...setup, cwd, project, now: () => time, onFreshWrite }),
  };
}

const creation = {
  kind: "create",
  peers: ["beta"],
  goal: "Find any missing rows",
  criteria: ["Check the complete range"],
  operationId: "create-1",
  replayOnly: false,
} as const;
function create(f: ReturnType<typeof fixture>, operationId = "create-1"): string {
  return String(
    unwrap(f.run({ ...creation, peers: [...creation.peers], criteria: [...creation.criteria], operationId }))
      .exchangeId,
  );
}

function joinExchange(f: ReturnType<typeof fixture>, exchangeId: string, cwd = f.alpha): string {
  return String(unwrap(f.run({ kind: "join", exchangeId, confirmed: false }, cwd)).claimId);
}

function send(
  exchangeId: string,
  claim: string | undefined,
  operationId: string,
  text = "Identical text",
): Extract<ExchangeBusinessInput, { kind: "send" }> {
  return {
    kind: "send",
    exchangeId,
    claim,
    operationId,
    replayOnly: false,
    messageKind: "information",
    body: { text },
    accept: [],
  };
}

function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(dir: string, prefix: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(path, `${key}/`);
      else if (entry.isFile()) result[key] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  visit(root, "");
  return result;
}

function error(code: string) {
  return { ok: false, error: { code } };
}

function bindRestored(f: ReturnType<typeof fixture>) {
  const marker = JSON.parse(readFileSync(join(f.vault, ".sorage-vault.json"), "utf8"));
  f.usingDb((db) => {
    for (const project of f.projects) {
      db.prepare("INSERT INTO project_bindings VALUES (?,?,?,?,?,?,?)").run(
        project.id,
        project.id,
        marker.installationId,
        project.path,
        "directory",
        now,
        now,
      );
    }
  });
}

function collaborationFixture() {
  const f = fixture();
  const exchangeId = create(f);
  const alphaClaim = joinExchange(f, exchangeId);
  const betaClaim = joinExchange(f, exchangeId, f.beta);
  const first = unwrap(f.run({ ...send(exchangeId, alphaClaim, "original"), recipient: "beta" }));
  const requestInput = {
    kind: "request",
    exchangeId,
    claim: alphaClaim,
    operationId: "request-followup",
    replayOnly: false,
    assignee: "beta",
    condition: "Verify two pages",
    criteria: ["Show observed rows"],
    replyTo: first.seq,
  } satisfies ExchangeBusinessInput;
  expect(f.run({ ...send(exchangeId, alphaClaim, "outsider-recipient"), recipient: "other" })).toMatchObject(
    error("EXCHANGE_INVALID_INPUT"),
  );
  expect(f.run({ ...requestInput, operationId: "outsider-assignee", assignee: otherId })).toMatchObject(
    error("EXCHANGE_INVALID_INPUT"),
  );
  expect(f.run({ ...requestInput, operationId: "bad-reply", replyTo: 999 })).toMatchObject(
    error("EXCHANGE_INVALID_INPUT"),
  );
  const request = unwrap(f.run(requestInput));
  const path = join(f.beta, "named-evidence.txt");
  writeFileSync(path, "actual observed row evidence");
  const materialInput = {
    kind: "material-register",
    exchangeId,
    claim: betaClaim,
    operationId: "named-evidence",
    replayOnly: false,
    material: { kind: "copy", path, offset: 0, length: 8 },
  } satisfies ExchangeBusinessInput;
  const evidence = unwrap(f.run(materialInput, f.beta));
  const reportInput = {
    kind: "report",
    exchangeId,
    claim: betaClaim,
    operationId: "named-report",
    replayOnly: false,
    requestId: request.requestId,
    assignmentVersion: 1,
    body: { text: "Checked and found no gaps." },
    evidence: [evidence.materialId],
    accept: [],
  } satisfies ExchangeBusinessInput;
  expect(f.run({ ...reportInput, operationId: "foreign-evidence", evidence: [alphaId] }, f.beta)).toMatchObject(
    error("EXCHANGE_INVALID_INPUT"),
  );
  const report = unwrap(f.run(reportInput, f.beta));
  const acceptInput = {
    kind: "accept",
    exchangeId,
    claim: alphaClaim,
    operationId: "named-acceptance",
    replayOnly: false,
    accept: [{ requestId: request.requestId, reportVersion: 1 }],
  } satisfies ExchangeBusinessInput;
  expect(f.run({ ...acceptInput, claim: betaClaim }, f.beta)).toMatchObject(error("FORBIDDEN_ACTOR"));
  expect(f.run({ ...acceptInput, accept: [...acceptInput.accept, ...acceptInput.accept] })).toMatchObject(
    error("EXCHANGE_INVALID_INPUT"),
  );
  return {
    f,
    exchangeId,
    alphaClaim,
    betaClaim,
    first,
    request,
    report,
    reportInput,
    evidence,
    acceptInput,
    materialInput,
  };
}

describe("Exchange SQLite and working storage through the application entrypoint", () => {
  it("resolves one authoritative join pair across aliases and refuses changed binding before writing", () => {
    const f = fixture();
    const exchangeId = create(f);
    const nested = join(f.alpha, "child");
    mkdirSync(nested);
    const input = { kind: "join", exchangeId, confirmed: false } as const;
    const top = unwrap(admitExchangeJoin(input, { ...f.setup, cwd: f.alpha, project: "alpha" }));
    const alias = unwrap(admitExchangeJoin(input, { ...f.setup, cwd: nested, project: alphaId }));
    expect(alias).toEqual(top);
    expect(admitExchangeJoin(input, { ...f.setup, cwd: f.alpha, project: "beta" })).toMatchObject(
      error("FORBIDDEN_ACTOR"),
    );
    f.usingDb((db) =>
      db
        .prepare("UPDATE project_bindings SET updated_at = ? WHERE project_id = ?")
        .run("2026-11-20T01:00:00.000Z", alphaId),
    );
    expect(executeExchange(input, { ...f.setup, cwd: nested, joinAdmission: alias })).toMatchObject(
      error("FORBIDDEN_ACTOR"),
    );
    expect(f.usingDb((db) => db.prepare("SELECT * FROM exchange_claims").all())).toEqual([]);
    expect(executeExchange(input, { ...f.setup, cwd: nested })).toMatchObject({
      ok: true,
      value: { exchangeId, projectId: alphaId },
    });
  });

  it("renews and releases only the exact current lease without advancing durable work", () => {
    const f = fixture();
    const exchangeId = create(f);
    const opened = unwrap(f.run({ kind: "join", exchangeId, confirmed: false }));
    const claim = opened.claimId;
    const stored = () => f.usingDb((db) => db.prepare("SELECT claim_id, expires_at FROM exchange_claims").all());
    const durable = () =>
      f.usingDb((db) =>
        ["events", "exchanges", "exchange_operation_outcomes", "exchange_messages"].map((table) =>
          db.prepare(`SELECT * FROM ${table}`).all(),
        ),
      );
    const before = durable();
    f.later(10);
    const renewed = unwrap(f.run({ kind: "renew", exchangeId, claim }));
    expect(renewed).toEqual({
      exchangeId,
      projectId: alphaId,
      claimId: claim,
      expiresAt: new Date(Date.parse(opened.expiresAt) + 10_000).toISOString(),
    });
    expect(f.run({ kind: "release", exchangeId, claim }, f.beta)).toMatchObject(error("EXCHANGE_CLAIM_CONFLICT"));
    const live = f.run({ kind: "join", exchangeId, confirmed: false });
    if (live.ok) throw new Error("Expected a competing live claim");
    const successor = unwrap(
      f.run({ kind: "join", exchangeId, confirmed: true, replaceClaim: String(live.error.details?.observedClaim) }),
    );
    for (const kind of ["renew", "release"] as const) {
      expect(f.run({ kind, exchangeId, claim })).toMatchObject(error("EXCHANGE_CLAIM_CONFLICT"));
    }
    let ownerChecks = 0;
    const lost = executeExchange(
      { kind: "renew", exchangeId, claim: successor.claimId },
      {
        ...f.setup,
        cwd: f.alpha,
        now: () => new Date(Date.parse(now) + 11_000),
        leaseOwnerAlive: () => ownerChecks++ === 0,
      },
    );
    expect(lost).toMatchObject(error("EXCHANGE_CLAIM_CONFLICT"));
    expect(ownerChecks).toBe(2);
    expect(stored()).toEqual([{ claim_id: successor.claimId, expires_at: successor.expiresAt }]);
    f.later(40);
    for (const kind of ["renew", "release"] as const) {
      expect(f.run({ kind, exchangeId, claim: successor.claimId })).toMatchObject(error("EXCHANGE_CLAIM_CONFLICT"));
    }
    expect(stored()).toEqual([{ claim_id: successor.claimId, expires_at: successor.expiresAt }]);
    const reclaimed = unwrap(f.run({ kind: "join", exchangeId, confirmed: false }));
    expect(unwrap(f.run({ kind: "release", exchangeId, claim: reclaimed.claimId }))).toEqual({
      exchangeId,
      projectId: alphaId,
      claimId: reclaimed.claimId,
      expiresAt: reclaimed.expiresAt,
    });
    expect(stored()).toEqual([]);
    expect(durable()).toEqual(before);
  });

  it("waits without writes for newly relevant messages and membership changes", () => {
    const f = fixture();
    const { exchangeId } = unwrap(f.run({ ...creation, peers: ["beta", "other"], criteria: [...creation.criteria] }));
    const claim = joinExchange(f, exchangeId);
    const ask = unwrap(
      f.run({
        kind: "request",
        exchangeId,
        claim,
        operationId: "check",
        replayOnly: false,
        assignee: "beta",
        condition: "Pending condition",
        criteria: ["Observe it"],
      }),
    );
    unwrap(f.run({ ...send(exchangeId, claim, "private"), recipient: "other" }));
    const broadcast = unwrap(f.run(send(exchangeId, claim, "broadcast")));
    const wait = (cursor?: string, cwd = f.beta) =>
      f.run(
        {
          kind: "wait",
          exchangeId,
          cursor,
          limit: 1,
          timeout: 1,
          interval: 1,
        },
        cwd,
      );
    const before = tree(f.home);
    const first = unwrap(wait());
    expect(first).toMatchObject({ messages: [{ seq: ask.seq }], timedOut: false, stateChanged: false });
    const next = unwrap(wait(first.cursor));
    expect(next).toMatchObject({ messages: [{ seq: broadcast.seq }], timedOut: false, stateChanged: false });
    expect(unwrap(wait(next.cursor))).toEqual({ ...next, messages: [], timedOut: true });
    expect(unwrap(f.run({ kind: "inspect", exchangeId }, f.beta)).requests).toHaveLength(1);
    expect(wait(next.cursor, f.alpha)).toMatchObject(error("EXCHANGE_INVALID_INPUT"));
    const history = unwrap(f.run({ kind: "history", exchangeId, limit: 1 }, f.beta));
    const continued = unwrap(f.run({ kind: "history", exchangeId, cursor: history.cursor, limit: 1 }, f.beta));
    expect(continued.messages).toMatchObject([{ seq: 2 }]);
    expect(f.run({ kind: "history", exchangeId, cursor: history.cursor, afterSeq: 1 }, f.beta)).toMatchObject(
      error("EXCHANGE_INVALID_INPUT"),
    );
    expect(tree(f.home)).toEqual(before);
    // TASK-143 owns the durable membership transition. Exercise the projection on an existing row.
    f.usingDb((db) =>
      db.prepare("DELETE FROM exchange_members WHERE exchange_id = ? AND project_id = ?").run(exchangeId, otherId),
    );
    const afterMembership = tree(f.home);
    const afterTransition = unwrap(f.run({ kind: "history", exchangeId, cursor: history.cursor, limit: 1 }, f.beta));
    expect(afterTransition.messages).toMatchObject([{ seq: 2 }]);
    const changed = unwrap(wait(afterTransition.cursor));
    expect(changed).toMatchObject({ messages: [{ seq: broadcast.seq }], stateChanged: true, timedOut: false });
    expect(unwrap(wait(changed.cursor))).toMatchObject({ messages: [], stateChanged: false, timedOut: true });
    expect(wait(undefined, f.other)).toMatchObject(error("FORBIDDEN_ACTOR"));
    expect(tree(f.home)).toEqual(afterMembership);
  });

  it("fences claim replacement and performs coherent read-only exact replay, conflict, denial and miss", () => {
    const f = fixture();
    const exchangeId = create(f);
    expect(f.usingDb((db) => db.prepare("SELECT * FROM exchange_claims").all())).toEqual([]);
    expect(unwrap(f.run({ kind: "recover", operationId: "create-1" })).operations).toEqual([
      { operationId: "create-1", outcome: { kind: "create", exchangeId } },
    ]);
    const claim = joinExchange(f, exchangeId);
    const refused = f.run({ kind: "join", exchangeId, confirmed: false });
    expect(refused).toMatchObject(error("EXCHANGE_CLAIM_CONFLICT"));
    if (refused.ok) throw new Error("The competing join unexpectedly succeeded.");
    const observed = String(refused.error.details?.observedClaim);
    expect(observed).not.toBe(claim);
    expect(f.run(send(exchangeId, observed, "public-observation"))).toMatchObject(error("EXCHANGE_CLAIM_CONFLICT"));
    const replacement = String(
      unwrap(f.run({ kind: "join", exchangeId, confirmed: true, replaceClaim: observed })).claimId,
    );
    expect(f.run(send(exchangeId, claim, "wrong-claim"))).toMatchObject(error("EXCHANGE_CLAIM_CONFLICT"));
    expect(f.run({ kind: "join", exchangeId, confirmed: true, replaceClaim: observed })).toMatchObject(
      error("EXCHANGE_CLAIM_CONFLICT"),
    );
    const first = unwrap(f.run(send(exchangeId, replacement, "first")));
    const second = unwrap(f.run(send(exchangeId, replacement, "second")));
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(first.materialId).not.toBe(second.materialId);
    f.later(40);
    expect(f.run(send(exchangeId, replacement, "expired"))).toMatchObject(error("EXCHANGE_CLAIM_CONFLICT"));
    const before = tree(f.home);
    for (const replayOnly of [false, true]) {
      for (const [operationId, previous] of [
        ["first", first],
        ["second", second],
      ] as const) {
        expect(unwrap(f.run({ ...send(exchangeId, undefined, operationId), replayOnly }))).toEqual({
          ...previous,
          replayed: true,
        });
        expect(f.run({ ...send(exchangeId, undefined, operationId, "different"), replayOnly })).toMatchObject(
          error("IDEMPOTENCY_CONFLICT"),
        );
        for (const body of ["Identical text", "different"]) {
          expect(f.run({ ...send(exchangeId, undefined, operationId, body), replayOnly }, f.other)).toEqual({
            ok: false,
            error: {
              code: "FORBIDDEN_ACTOR",
              message: "The current bound Project has no access to this Exchange operation.",
            },
          });
        }
        expect(f.run({ ...send(exchangeId, undefined, operationId), replayOnly }, f.alpha, "beta")).toMatchObject(
          error("FORBIDDEN_ACTOR"),
        );
      }
    }
    expect(f.run({ ...send(exchangeId, undefined, "unknown"), replayOnly: true })).toMatchObject(
      error("EXCHANGE_REPLAY_UNAVAILABLE"),
    );
    expect(unwrap(f.run({ kind: "history", exchangeId, afterSeq: 0, limit: 10 })).messages).toHaveLength(2);
    expect(f.run({ kind: "inspect", exchangeId })).toMatchObject({ ok: true });
    expect(tree(f.home)).toEqual(before);
    expect(f.usingDb((db) => db.prepare("SELECT * FROM exchange_operation_outcomes").all())).toHaveLength(2);
    f.usingDb((db) =>
      db.prepare("DELETE FROM exchange_members WHERE exchange_id = ? AND project_id = ?").run(exchangeId, alphaId),
    );
    const removed = tree(f.home);
    for (const replayOnly of [false, true]) {
      for (const goal of [creation.goal, "Changed goal"]) {
        expect(
          f.run({ ...creation, peers: ["beta"], criteria: [...creation.criteria], goal, replayOnly }),
        ).toMatchObject(error("FORBIDDEN_ACTOR"));
      }
      expect(f.run({ ...send(exchangeId, undefined, "first"), replayOnly })).toMatchObject(error("FORBIDDEN_ACTOR"));
    }
    expect(unwrap(f.run({ kind: "recover", operationId: "create-1" })).operations).toEqual([]);
    expect(tree(f.home)).toEqual(removed);
  });

  it("rechecks claims and exact receipts after capture and rejects changes before staging", () => {
    const f = fixture();
    const exchangeId = create(f);
    const claim = joinExchange(f, exchangeId);
    const source = join(f.alpha, "captured.txt");
    writeFileSync(source, "a".repeat(65_537));
    const candidate = (operationId: string, currentClaim: string) => ({
      ...send(exchangeId, currentClaim, operationId),
      body: { file: source },
    });
    const afterCapture = (input: ReturnType<typeof candidate>, mutate: () => void) =>
      f.run(input, f.alpha, undefined, mutate);
    const businessRows = () =>
      f.usingDb((db) =>
        [
          "exchange_working_content",
          "exchange_materials",
          "exchange_messages",
          "exchange_operation_outcomes",
          "events",
        ].map((name) => db.prepare(`SELECT COUNT(*) count FROM ${name}`).get()),
      );
    const stagePath = join(f.home, "state", "exchange-working", "staging");
    const stageFiles = () => (existsSync(stagePath) ? readdirSync(stagePath) : []);
    const initial = businessRows();
    const observing = f.run({ kind: "join", exchangeId, confirmed: false });
    if (observing.ok) throw new Error("Expected a live competing claim.");
    const observedClaim = String(observing.error.details?.observedClaim);
    let successor = "";
    expect(
      afterCapture(candidate("replaced-during-admission", claim), () => {
        successor = String(
          unwrap(f.run({ kind: "join", exchangeId, confirmed: true, replaceClaim: observedClaim })).claimId,
        );
      }),
    ).toMatchObject(error("EXCHANGE_CLAIM_CONFLICT"));
    expect(successor).not.toBe(claim);
    let elapsed = false;
    expect(
      afterCapture(candidate("expired-during-admission", successor), () => {
        f.later(40);
        elapsed = true;
      }),
    ).toMatchObject(error("EXCHANGE_CLAIM_CONFLICT"));
    expect(elapsed).toBe(true);
    const current = joinExchange(f, exchangeId);
    expect(
      afterCapture(candidate("changed-after-capture", current), () => {
        writeFileSync(source, "b".repeat(65_537));
      }),
    ).toMatchObject(error("ROW_VERSION_CONFLICT"));
    expect(readFileSync(source, "utf8")).toBe("b".repeat(65_537));
    expect(businessRows()).toEqual(initial);
    expect(stageFiles()).toEqual([]);
    const duplicate = candidate("committed-during-admission", current);
    let match: ExchangeActionFor<"send"> | undefined;
    let expectedRows: ReturnType<typeof businessRows> | undefined;
    const replay = unwrap(
      afterCapture(duplicate, () => {
        match = unwrap(f.run(duplicate));
        expectedRows = businessRows();
      }),
    );
    expect(match).toMatchObject({ replayed: false, seq: 1, availability: "available" });
    expect(replay).toEqual({ ...match, replayed: true });
    expect(businessRows()).toEqual(expectedRows);
    expect(unwrap(f.run({ kind: "history", exchangeId, afterSeq: 0 })).messages).toHaveLength(1);
    expect(stageFiles()).toEqual([]);
  });

  it("version-fences named evidence acceptances and preserves pending work and exact progress across new connections", () => {
    const f = fixture();
    const exchangeId = create(f);
    const alphaClaim = joinExchange(f, exchangeId);
    const request = (id: string, condition = `Condition ${id}`, criteria = ["Checked"]) =>
      f.run({
        kind: "request",
        exchangeId,
        claim: alphaClaim,
        operationId: id,
        replayOnly: false,
        assignee: "beta",
        condition,
        criteria,
      });
    expect(request("too-long", "x".repeat(8_190), ["ab", "c"])).toMatchObject(error("EXCHANGE_INVALID_INPUT"));
    expect(
      f.run({ ...creation, peers: ["beta"], criteria: ["a".repeat(8_192)], operationId: "oversized" }),
    ).toMatchObject(error("EXCHANGE_INVALID_INPUT"));
    const requests = ["req1", "req2", "req3"].map((id) => String(unwrap(request(id)).requestId));
    expect(unwrap(f.run({ kind: "inspect", exchangeId }, f.beta)).requests).toHaveLength(3);
    const betaClaim = joinExchange(f, exchangeId, f.beta);
    const report = (index: number, operationId: string, version = 1, cwd = f.beta) =>
      f.run(
        {
          kind: "report",
          exchangeId,
          claim: cwd === f.beta ? betaClaim : alphaClaim,
          operationId,
          replayOnly: false,
          requestId: requests[index] as string,
          assignmentVersion: version,
          body: { text: "actual result" },
          evidence: [],
          accept: [],
        },
        cwd,
      );
    expect(report(0, "wrong-assignment", 2)).toMatchObject(error("ROW_VERSION_CONFLICT"));
    expect(report(0, "wrong-assignee", 1, f.alpha)).toMatchObject(error("FORBIDDEN_ACTOR"));
    expect(unwrap(report(0, "report-a1")).reportVersion).toBe(1);
    const current = unwrap(report(0, "report-a2"));
    expect(current.reportVersion).toBe(2);
    unwrap(report(1, "report-b1"));
    unwrap(report(2, "report-c1"));
    expect(
      f.run({
        ...send(exchangeId, alphaClaim, "invalid-bundle"),
        kind: "send",
        messageKind: "progress",
        body: { text: "The requester's verified response" },
        accept: [
          { requestId: requests[0] as string, reportVersion: 1 },
          { requestId: requests[1] as string, reportVersion: 1 },
        ],
      }),
    ).toMatchObject(error("ROW_VERSION_CONFLICT"));
    expect(unwrap(f.run({ kind: "inspect", exchangeId })).acceptances).toEqual([]);
    const bundle = {
      kind: "send",
      exchangeId,
      claim: alphaClaim,
      operationId: "bundle",
      replayOnly: false,
      messageKind: "progress",
      body: { text: "The requester's verified response" },
      replyTo: Number(current.seq),
      accept: [
        { requestId: requests[0] as string, reportVersion: 2 },
        { requestId: requests[1] as string, reportVersion: 1 },
      ],
    } satisfies ExchangeBusinessInput;
    const accepted = unwrap(f.run(bundle));
    expect(accepted.seq).toBe(10);
    const beforeReplay = tree(f.home);
    for (const replayOnly of [true, false])
      expect(
        unwrap(
          f.run({
            ...bundle,
            replayOnly,
            claim: undefined,
            accept: [...bundle.accept].reverse(),
          }),
        ),
      ).toEqual({ ...accepted, replayed: true });
    expect(tree(f.home)).toEqual(beforeReplay);
    expect(
      (unwrap(f.run({ kind: "inspect", exchangeId })).requests as Array<{ state: string }>).map((r) => r.state).sort(),
    ).toEqual(["completion-reported", "resolved", "resolved"]);
    const tables = () =>
      f.usingDb((db) =>
        ["exchange_operation_outcomes", "exchange_messages", "events"].map((name) =>
          db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get(),
        ),
      );
    const before = tables();
    const progress = {
      kind: "confirm-read",
      exchangeId,
      claim: betaClaim,
      ranges: [
        { firstSeq: 1, lastSeq: 1 },
        { firstSeq: 3, lastSeq: 4 },
      ],
    } as const;
    expect(unwrap(f.run({ ...progress, ranges: [...progress.ranges] }, f.beta))).toMatchObject({
      changed: true,
      readRanges: progress.ranges,
    });
    expect(unwrap(f.run({ ...progress, ranges: [...progress.ranges] }, f.beta))).toMatchObject({
      changed: false,
      readRanges: progress.ranges,
    });
    expect(tables()).toEqual(before);
    const opposite = unwrap(
      f.run(
        {
          kind: "request",
          exchangeId,
          claim: betaClaim,
          operationId: "opposite-request",
          replayOnly: false,
          assignee: "alpha",
          condition: "Verify the reverse direction",
          criteria: ["Report back"],
        },
        f.beta,
      ),
    );
    const reportBundle = {
      kind: "report",
      exchangeId,
      claim: alphaClaim,
      operationId: "report-bundle",
      replayOnly: false,
      requestId: opposite.requestId,
      assignmentVersion: 1,
      body: { text: "Verified the reverse direction" },
      evidence: [],
      accept: [{ requestId: requests[2] as string, reportVersion: 1 }],
    } satisfies ExchangeBusinessInput;
    const reported = unwrap(f.run(reportBundle));
    unwrap(exportSnapshot(unwrap(f.ports.exportPorts())));
    const retained = JSON.parse(readFileSync(join(f.vault, "snapshots", "exchanges.json"), "utf8"));
    expect(retained.records[0].collaboration.acceptances).toEqual(
      expect.arrayContaining([
        ...bundle.accept.map((choice) =>
          expect.objectContaining({ ...choice, receipt: { operationId: "bundle", kind: "send" } }),
        ),
        expect.objectContaining({
          ...reportBundle.accept[0],
          receipt: { operationId: "report-bundle", kind: "report" },
        }),
      ]),
    );
    const target = fixture(false);
    unwrap(
      backupRestore(unwrap(createNodeBackupCommandPorts({ ...target.setup, sourcePath: f.vault }).restorePorts()), {
        dryRun: false,
      }),
    );
    bindRestored(target);
    expect(unwrap(target.run({ kind: "inspect", exchangeId })).acceptances).toEqual(
      unwrap(f.run({ kind: "inspect", exchangeId })).acceptances,
    );
    const restoredBeforeReplay = tree(target.home);
    expect(unwrap(target.run({ ...bundle, claim: undefined, replayOnly: true }))).toEqual({
      ...accepted,
      availability: "omitted",
      replayed: true,
    });
    expect(unwrap(target.run({ ...reportBundle, claim: undefined, replayOnly: true }))).toEqual({
      ...reported,
      availability: "omitted",
      replayed: true,
    });
    expect(tree(target.home)).toEqual(restoredBeforeReplay);
  });

  it("carries named working evidence across a reopened view and restores exact typed work and outcomes", () => {
    const { f, exchangeId, alphaClaim, first, request, report, reportInput, evidence, acceptInput } =
      collaborationFixture();
    const reportView = unwrap(f.run({ kind: "inspect", exchangeId }));
    expect(reportView.reports).toMatchObject([{ materialId: report.materialId, evidence: [evidence.materialId] }]);
    expect(reportView.requests[0]).toMatchObject({
      state: "completion-reported",
      condition: "Verify two pages",
      criteria: ["Show observed rows"],
    });
    const history = unwrap(f.run({ kind: "history", exchangeId, afterSeq: 0 }));
    expect(history.messages.slice(0, 2)).toMatchObject([
      { recipientId: betaId },
      { kind: "request", replyTo: first.seq, recipientId: betaId },
    ]);
    const protectedFiles = tree(f.home);
    const materialBytes = materialPage(
      f.run({ kind: "material-read", exchangeId, materialId: evidence.materialId, offset: 0, limit: 8 }),
    );
    expect(Buffer.from(materialBytes.bytes, "base64").toString()).toBe("actual o");
    expect(unwrap(f.run({ kind: "recover", exchangeId, operationId: "named-report" }, f.beta)).operations).toEqual([
      {
        operationId: "named-report",
        outcome: {
          kind: "report",
          exchangeId,
          seq: report.seq,
          requestId: report.requestId,
          reportVersion: report.reportVersion,
          materialId: report.materialId,
        },
      },
    ]);
    expect(unwrap(f.run({ kind: "recover", exchangeId, operationId: "named-report" })).operations).toEqual([]);
    expect(tree(f.home)).toEqual(protectedFiles);
    const firstJoin = f.run({ kind: "join", exchangeId, confirmed: false });
    if (firstJoin.ok) throw new Error("Expected a live competing claim.");
    const observation = String(firstJoin.error.details?.observedClaim);
    expect(f.run({ kind: "join", exchangeId, replaceClaim: observation, confirmed: false })).toMatchObject(
      error("CONFIRMATION_REQUIRED"),
    );
    const successor = String(
      unwrap(f.run({ kind: "join", exchangeId, replaceClaim: observation, confirmed: true })).claimId,
    );
    expect(successor).not.toBe(alphaClaim);
    const creationReceipt = { operationId: "create-1", outcome: { kind: "create", exchangeId } };
    const ownerReceipts = [
      creationReceipt,
      { operationId: "original", outcome: { kind: "send", exchangeId, seq: first.seq, materialId: first.materialId } },
      {
        operationId: "request-followup",
        outcome: {
          kind: "request",
          exchangeId,
          seq: request.seq,
          requestId: request.requestId,
          assignmentVersion: 1,
        },
      },
    ];
    const peerReceipts = [
      {
        operationId: "named-evidence",
        outcome: { kind: "material-register", exchangeId, materialId: evidence.materialId },
      },
      {
        operationId: "named-report",
        outcome: {
          kind: "report",
          exchangeId,
          seq: report.seq,
          requestId: report.requestId,
          reportVersion: report.reportVersion,
          materialId: report.materialId,
        },
      },
    ];
    const replaced = tree(f.home);
    const replacedPaths = readdirSync(f.home, { recursive: true }).sort();
    expect(unwrap(f.run({ kind: "recover", exchangeId })).operations).toEqual(ownerReceipts);
    expect(unwrap(f.run({ kind: "recover", exchangeId }, f.beta)).operations).toEqual(peerReceipts);
    expect(unwrap(f.run({ kind: "recover", exchangeId, operationId: "original" })).operations).toEqual([
      ownerReceipts[1],
    ]);
    expect(unwrap(f.run({ kind: "recover", exchangeId, operationId: "original" }, f.beta)).operations).toEqual([]);
    expect(unwrap(f.run({ kind: "recover", exchangeId, operationId: "named-report" }, f.beta)).operations).toEqual([
      peerReceipts[1],
    ]);
    expect(unwrap(f.run({ kind: "recover", exchangeId, operationId: "named-report" })).operations).toEqual([]);
    expect(unwrap(f.run({ kind: "recover" })).operations).toEqual([creationReceipt]);
    expect(unwrap(f.run({ kind: "recover" }, f.beta)).operations).toEqual([]);
    expect(tree(f.home)).toEqual(replaced);
    expect(readdirSync(f.home, { recursive: true }).sort()).toEqual(replacedPaths);
    const standalone = unwrap(f.run({ ...acceptInput, claim: successor }));
    const unrelated = unwrap(f.run(send(exchangeId, successor, "unrelated-after-accept")));
    expect(unrelated.seq).toBe(Number(standalone.sequences[0]) + 1);
    expect(unwrap(f.run({ kind: "inspect", exchangeId })).requests[0]).toMatchObject({
      state: "resolved",
      acceptance: { requesterId: alphaId, reportVersion: 1 },
    });
    const later = unwrap(
      f.run(
        {
          ...reportInput,
          operationId: "later-report",
          evidence: [evidence.materialId, first.materialId],
        },
        f.beta,
      ),
    );
    expect(later.reportVersion).toBe(2);
    const active = unwrap(f.run({ kind: "inspect", exchangeId }));
    expect(active.requests[0]).toMatchObject({ state: "completion-reported", acceptance: null });
    expect(active.acceptances).toMatchObject([{ requesterId: alphaId, reportVersion: 1 }]);
    expect(active.acceptances[0]).not.toHaveProperty("receipt");
    unwrap(exportSnapshot(unwrap(f.ports.exportPorts())));
    const target = fixture(false);
    unwrap(
      backupRestore(unwrap(createNodeBackupCommandPorts({ ...target.setup, sourcePath: f.vault }).restorePorts()), {
        dryRun: false,
      }),
    );
    bindRestored(target);
    expect(unwrap(target.run({ kind: "inspect", exchangeId }))).toEqual(active);
    expect(unwrap(target.run({ kind: "recover", exchangeId }, target.beta))).toEqual(
      unwrap(f.run({ kind: "recover", exchangeId }, f.beta)),
    );
    expect(unwrap(target.run({ ...acceptInput, claim: undefined, replayOnly: true }))).toEqual({
      ...standalone,
      replayed: true,
    });
    expect(
      target.run({ kind: "material-read", exchangeId, materialId: evidence.materialId, offset: 0, limit: 8 }),
    ).toMatchObject({ ok: false, error: { code: "EXCHANGE_MATERIAL_UNAVAILABLE", details: { reason: "omitted" } } });
  });

  it("replays the same registered relative source after a new physical workspace binding", () => {
    const { f, materialInput, evidence } = collaborationFixture();
    const replacement = join(f.parent, "beta-rebound");
    mkdirSync(replacement);
    const path = join(replacement, "named-evidence.txt");
    writeFileSync(path, "actual observed row evidence");
    f.usingDb((db) =>
      db
        .prepare("UPDATE project_bindings SET id = ?, directory = ?, updated_at = ? WHERE project_id = ?")
        .run("55555555-5555-4555-8555-555555555555", replacement, "2026-11-20T00:00:01.000Z", betaId),
    );
    const before = tree(f.home);
    const same = { ...materialInput, claim: undefined, material: { ...materialInput.material, path } };
    for (const replayOnly of [true, false])
      expect(unwrap(f.run({ ...same, replayOnly }, replacement))).toEqual({ ...evidence, replayed: true });
    writeFileSync(path, "changed observed row evidence");
    expect(f.run({ ...same, replayOnly: true }, replacement)).toMatchObject(error("IDEMPOTENCY_CONFLICT"));
    expect(tree(f.home)).toEqual(before);
  });

  it("continues scoped activation recovery after a missing earlier stage", () => {
    const f = fixture();
    const exchangeId = create(f);
    const claim = joinExchange(f, exchangeId);
    const stages = join(f.home, "state", "exchange-working", "staging");
    mkdirSync(stages, { recursive: true });
    const first = "44444444-4444-4444-8444-444444444444";
    const second = "55555555-5555-4555-8555-555555555555";
    const bytes = "available verified later intent";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    f.usingDb((db) => {
      for (const id of [first, second]) {
        db.prepare("INSERT INTO exchange_working_content VALUES (?,?,NULL,?,?,?,0)").run(
          id,
          exchangeId,
          `content/${id}`,
          bytes.length,
          sha256,
        );
        db.prepare("INSERT INTO exchange_activation_intents (content_id, staging_key) VALUES (?,?)").run(
          id,
          `staging/${id}`,
        );
      }
    });
    writeFileSync(join(stages, second), bytes, { mode: 0o600 });
    const posted = unwrap(f.run(send(exchangeId, claim, "recover-two")));
    expect(posted.warnings).toMatchObject([
      {
        code: "STORAGE_INTEGRITY_ERROR",
        recovery: {
          suggestedCommand: "Run an authorized Exchange write or join for this Exchange to retry pending material",
        },
      },
    ]);
    expect(f.usingDb((db) => db.prepare("SELECT content_id, attempts FROM exchange_activation_intents").all())).toEqual(
      [{ content_id: first, attempts: 1 }],
    );
    expect(readFileSync(join(f.home, "state", "exchange-working", "content", second), "utf8")).toBe(bytes);
  });

  it("rejects malformed collaboration associations and payloads before verify or restore has effects", () => {
    const { f, exchangeId, alphaClaim, betaClaim, first, reportInput, acceptInput } = collaborationFixture();
    const acceptance = unwrap(f.run(acceptInput));
    const later = unwrap(f.run({ ...reportInput, operationId: "later-report" }, f.beta));
    unwrap(f.run(send(exchangeId, alphaClaim, "unrelated-after-accept")));
    const bundledRequest = unwrap(
      f.run({
        kind: "request",
        exchangeId,
        claim: alphaClaim,
        operationId: "request-for-bundle",
        replayOnly: false,
        assignee: "beta",
        condition: "Recheck all rows",
        criteria: ["Verify exact count"],
      }),
    );
    unwrap(
      f.run(
        {
          kind: "report",
          exchangeId,
          claim: betaClaim,
          operationId: "report-for-bundle",
          replayOnly: false,
          requestId: bundledRequest.requestId,
          assignmentVersion: 1,
          body: { text: "Rechecked all rows" },
          evidence: [],
          accept: [],
        },
        f.beta,
      ),
    );
    unwrap(
      f.run({
        ...send(exchangeId, alphaClaim, "owning-bundle"),
        accept: [{ requestId: bundledRequest.requestId, reportVersion: 1 }],
      }),
    );
    const last = unwrap(f.run(send(exchangeId, alphaClaim, "unrelated-after-bundle")));
    const configPath = join(f.home, "config.yaml");
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(/redactWorkspacePaths: true/, "redactWorkspacePaths: false"),
    );
    unwrap(exportSnapshot(unwrap(f.ports.exportPorts())));
    const inventoryPath = join(f.vault, "snapshots", "exchanges.json");
    const clean = readFileSync(inventoryPath, "utf8");
    unwrap(backupVerify(unwrap(f.ports.verifyPorts()), { now: new Date(now) }));
    const target = fixture(false);
    const restore = unwrap(createNodeBackupCommandPorts({ ...target.setup, sourcePath: f.vault }).restorePorts());
    const before = tree(target.home);
    const beforePaths = readdirSync(target.home, { recursive: true }).sort();
    const cases = [
      "outsider",
      "wrong requester",
      "wrong request actor",
      "wrong report recipient",
      "orphan report",
      "acceptance after supersession",
      "orphan body",
      "shared primary body",
      "wrong receipt",
      "missing receipt",
      "duplicate receipt effect",
      "missing standalone receipt",
      "missing bundle receipt",
      "missing bundle association",
      "duplicate bundle association",
      "mismatched bundle actor",
      "mismatched bundle kind",
      "mismatched bundle order",
      "copy range",
      "escaping path",
      "content identity",
      "binding identity",
      "foundation in frame",
      "digest",
    ] as const;
    for (const defect of cases) {
      const frame = JSON.parse(clean);
      const record = frame.records[0];
      const work = record.collaboration;
      const copy = work.materials.find((material: { kind: string }) => material.kind === "copy");
      const bundled = work.acceptances.find((row: { requestId: string }) => row.requestId === bundledRequest.requestId);
      switch (defect) {
        case "outsider":
          work.operations[0].projectId = otherId;
          break;
        case "wrong requester":
          work.acceptances[0].requesterId = betaId;
          break;
        case "wrong request actor":
          work.messages.find((m: { kind: string }) => m.kind === "request").senderId = betaId;
          break;
        case "wrong report recipient":
          work.messages.find((m: { kind: string }) => m.kind === "report").recipientId = betaId;
          break;
        case "orphan report":
          work.messages = work.messages.filter((m: { kind: string }) => m.kind !== "report");
          break;
        case "acceptance after supersession": {
          const acceptedSeq = acceptance.sequences[0];
          const laterMessage = work.messages.find((m: { seq: number }) => m.seq === later.seq);
          const acceptedMessage = work.messages.find((m: { seq: number }) => m.seq === acceptedSeq);
          acceptedMessage.seq = later.seq;
          laterMessage.seq = acceptedSeq;
          work.messages.sort((a: { seq: number }, b: { seq: number }) => a.seq - b.seq);
          work.operations.find((o: { operationId: string }) => o.operationId === "later-report").outcome.seq =
            acceptedSeq;
          work.operations.find(
            (o: { operationId: string }) => o.operationId === acceptInput.operationId,
          ).outcome.sequences = [later.seq];
          break;
        }
        case "orphan body": {
          const body = work.materials.find((row: { id: string }) => row.id === first.materialId);
          work.materials.push({ ...body, id: otherId });
          work.materials.sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
          break;
        }
        case "shared primary body":
          work.messages.find((m: { seq: number }) => m.seq === last.seq).materialId = first.materialId;
          work.operations.find(
            (o: { operationId: string }) => o.operationId === "unrelated-after-bundle",
          ).outcome.materialId = first.materialId;
          work.materials = work.materials.filter((row: { id: string }) => row.id !== last.materialId);
          break;
        case "wrong receipt":
          work.operations.find(
            (o: { outcome: { kind: string } }) => o.outcome.kind === "request",
          ).outcome.assignmentVersion = 2;
          break;
        case "missing receipt":
          work.operations = work.operations.filter((o: { outcome: { kind: string } }) => o.outcome.kind !== "report");
          break;
        case "duplicate receipt effect": {
          const prefix = "zzz-";
          work.operations.push({ ...work.operations[0], operationId: `${prefix}${work.operations[0].operationId}` });
          work.operations.sort(
            (a: { projectId: string; operationId: string }, b: { projectId: string; operationId: string }) =>
              a.projectId.localeCompare(b.projectId) || a.operationId.localeCompare(b.operationId),
          );
          break;
        }
        case "missing standalone receipt":
          work.operations = work.operations.filter(
            (o: { operationId: string }) => o.operationId !== acceptInput.operationId,
          );
          break;
        case "missing bundle receipt":
          work.operations = work.operations.filter((o: { operationId: string }) => o.operationId !== "owning-bundle");
          break;
        case "missing bundle association":
          delete bundled.receipt;
          break;
        case "duplicate bundle association": {
          const owning = work.operations.find((o: { operationId: string }) => o.operationId === "owning-bundle");
          work.operations.splice(work.operations.indexOf(owning) + 1, 0, {
            ...owning,
            operationId: "owning-bundle-duplicate",
            outcome: { kind: "accept", exchangeId, sequences: [owning.outcome.seq - 1] },
          });
          break;
        }
        case "mismatched bundle actor":
          bundled.receipt.operationId = "report-for-bundle";
          bundled.receipt.kind = "report";
          break;
        case "mismatched bundle kind":
          bundled.receipt.kind = "accept";
          break;
        case "mismatched bundle order":
          bundled.receipt.operationId = "unrelated-after-bundle";
          break;
        case "copy range":
          copy.sizeBytes = copy.scope.length + 1;
          break;
        case "escaping path":
          copy.scope.relativePath = "../escape";
          break;
        case "content identity":
          copy.contentId = alphaId;
          break;
        case "binding identity":
          copy.scope.bindingId = betaId;
          break;
        case "foundation in frame":
          delete record.collaboration;
          break;
        case "digest":
          break;
      }
      frame.recordsSha256 =
        defect === "digest" ? "0".repeat(64) : createHash("sha256").update(canonicalJson(frame.records)).digest("hex");
      writeFileSync(inventoryPath, canonicalJson(frame));
      expect(backupVerify(unwrap(f.ports.verifyPorts()), { now: new Date(now) }), defect).toMatchObject(
        error("VAULT_INTEGRITY_ERROR"),
      );
      for (const dryRun of [true, false]) {
        expect(backupRestore(restore, { dryRun }), defect).toMatchObject(error("VAULT_INTEGRITY_ERROR"));
        expect(tree(target.home), defect).toEqual(before);
        expect(readdirSync(target.home, { recursive: true }).sort(), defect).toEqual(beforePaths);
      }
    }
  }, 20_000);

  it("retains exact large bodies and copies, scopes original access, and redacts typed snapshots", () => {
    const f = fixture();
    const exchangeId = create(f);
    const claim = joinExchange(f, exchangeId);
    const source = join(f.alpha, "evidence.txt");
    const large = Buffer.from(`\uFEFFPRIVATE_PAYLOAD_ONLY_IN_WORKING_STATE\r\n${"나".repeat(22_000)}\n`);
    writeFileSync(source, large);
    const body = unwrap(
      f.run({
        kind: "send",
        exchangeId,
        claim,
        operationId: "large",
        replayOnly: false,
        messageKind: "clarification",
        body: { file: source },
        accept: [],
      }),
    );
    const register = (kind: "copy" | "live" | "versioned", path = source) =>
      f.run({
        kind: "material-register",
        exchangeId,
        claim,
        operationId: `material:${kind}`,
        replayOnly: false,
        material: { kind, path, offset: 0, length: null },
      });
    const copy = unwrap(register("copy"));
    const live = unwrap(register("live"));
    const versioned = unwrap(register("versioned"));
    const read = (materialId: unknown, offset = 0, limit = 65_536) =>
      f.run(
        {
          kind: "material-read",
          exchangeId,
          materialId: String(materialId),
          offset,
          limit,
        },
        f.beta,
      );
    for (const item of [body, copy]) {
      const first = materialPage(read(item.materialId));
      const last = materialPage(read(item.materialId, Number(first.nextOffset)));
      expect([first.end, last.end]).toEqual([false, true]);
      expect(
        Buffer.concat([Buffer.from(String(first.bytes), "base64"), Buffer.from(String(last.bytes), "base64")]),
      ).toEqual(large);
    }
    expect(materialPage(read(versioned.materialId, 5, 20)).observedVersion).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(source, "changed");
    expect(materialPage(read(live.materialId, 0, 20)).bytes).toBe(Buffer.from("changed").toString("base64"));
    expect(read(versioned.materialId, 0, 20)).toMatchObject({
      ...error("EXCHANGE_MATERIAL_UNAVAILABLE"),
      error: { code: "EXCHANGE_MATERIAL_UNAVAILABLE", details: { reason: "changed" } },
    });
    rmSync(source);
    expect(read(live.materialId)).toMatchObject(error("EXCHANGE_MATERIAL_UNAVAILABLE"));
    const outside = join(f.other, "escape.txt");
    writeFileSync(outside, "other");
    symlinkSync(outside, source);
    expect(read(live.materialId)).toMatchObject(error("SOURCE_OUTSIDE_WORKSPACE"));
    expect(register("live", outside)).toMatchObject(error("SOURCE_OUTSIDE_WORKSPACE"));
    const config = join(f.home, "config.yaml");
    const initial = readFileSync(config, "utf8");
    writeFileSync(config, initial.replace(/maxBytes: \d+/, "maxBytes: 1024"));
    expect(f.run(send(exchangeId, claim, "too-large", "x".repeat(1_025)))).toMatchObject(error("ARTIFACT_TOO_LARGE"));
    rmSync(source);
    writeFileSync(source, large);
    const refused = tree(f.home);
    expect(f.run({ ...send(exchangeId, claim, "large-file-too-many"), body: { file: source } })).toMatchObject(
      error("ARTIFACT_TOO_LARGE"),
    );
    expect(
      f.run({
        kind: "material-register",
        exchangeId,
        claim,
        operationId: "large-copy-too-many",
        replayOnly: false,
        material: { kind: "copy", path: source, offset: 0, length: null },
      }),
    ).toMatchObject(error("ARTIFACT_TOO_LARGE"));
    expect(tree(f.home)).toEqual(refused);
    const beforeReplay = tree(f.home);
    expect(
      unwrap(
        f.run({
          kind: "send",
          exchangeId,
          claim: undefined,
          operationId: "large",
          replayOnly: false,
          messageKind: "clarification",
          body: { file: source },
          accept: [],
        }),
      ),
    ).toEqual({ ...body, replayed: true });
    expect(tree(f.home)).toEqual(beforeReplay);
    for (const redact of [true, false]) {
      writeFileSync(config, initial.replace(/redactWorkspacePaths: (true|false)/, `redactWorkspacePaths: ${redact}`));
      unwrap(exportSnapshot(unwrap(f.ports.exportPorts())));
      const raw = readFileSync(join(f.vault, "snapshots", "exchanges.json"), "utf8");
      expect(JSON.parse(raw).representation).toBe("collaboration");
      expect(raw.includes("evidence.txt")).toBe(!redact);
      expect(raw.includes(f.alpha)).toBe(!redact);
      expect(raw).not.toContain("PRIVATE_PAYLOAD_ONLY_IN_WORKING_STATE");
    }
    expect(
      JSON.stringify(f.usingDb((db) => db.prepare("SELECT * FROM exchange_operation_outcomes").all())),
    ).not.toContain("PRIVATE_PAYLOAD_ONLY_IN_WORKING_STATE");
    const target = fixture(false);
    const restore = unwrap(createNodeBackupCommandPorts({ ...target.setup, sourcePath: f.vault }).restorePorts());
    unwrap(backupRestore(restore, { dryRun: false }));
    expect(target.usingDb((db) => db.prepare("SELECT * FROM exchange_claims").all())).toEqual([]);
    expect(target.usingDb((db) => db.prepare("SELECT * FROM project_bindings").all())).toEqual([]);
    expect(target.usingDb((db) => db.prepare("SELECT * FROM exchange_working_content").all())).toEqual([]);
    target.usingDb((db) => {
      const installationId = JSON.parse(readFileSync(join(target.vault, ".sorage-vault.json"), "utf8")).installationId;
      db.prepare("INSERT INTO project_bindings VALUES (?,?,?,?,?,?,?)").run(
        alphaId,
        alphaId,
        installationId,
        target.alpha,
        "directory",
        now,
        now,
      );
    });
    expect(
      target.run({ kind: "material-read", exchangeId, materialId: String(live.materialId), offset: 0, limit: 20 }),
    ).toMatchObject({
      ok: false,
      error: { code: "EXCHANGE_MATERIAL_UNAVAILABLE", details: { reason: "revalidation-required" } },
    });
    expect(
      target.run({ kind: "material-read", exchangeId, materialId: String(body.materialId), offset: 0, limit: 20 }),
    ).toMatchObject({ ok: false, error: { code: "EXCHANGE_MATERIAL_UNAVAILABLE", details: { reason: "omitted" } } });
  });

  it("uses configured history page size and reads a genuinely read-only workspace without touching home files", () => {
    const f = fixture();
    const exchangeId = create(f);
    const claim = joinExchange(f, exchangeId);
    const config = join(f.home, "config.yaml");
    writeFileSync(config, readFileSync(config, "utf8").replace(/defaultPageSize: \d+/, "defaultPageSize: 10"));
    expect(
      f.run({
        kind: "create",
        peers: ["missing"],
        goal: "Goal",
        criteria: ["Criteria"],
        operationId: "invalid-peer",
        replayOnly: false,
      }),
    ).toMatchObject(error("PROJECT_NOT_FOUND"));
    for (let i = 0; i < 11; i++) unwrap(f.run(send(exchangeId, claim, `history-${i}`, i === 0 ? "" : "page")));
    f.later(40);
    expect(joinExchange(f, exchangeId)).not.toBe(claim);
    chmodSync(f.beta, 0o500);
    try {
      expect(() => writeFileSync(join(f.beta, "write-test"), "must be denied")).toThrow();
      const before = tree(f.home);
      const page = unwrap(f.run({ kind: "history", exchangeId, afterSeq: 0 }, f.beta));
      expect(page.messages).toHaveLength(10);
      expect(page.hasMore).toBe(true);
      const emptyId = String(page.messages[0]?.materialId);
      expect(
        materialPage(f.run({ kind: "material-read", exchangeId, materialId: emptyId, offset: 0, limit: 1 }, f.beta)),
      ).toMatchObject({ bytes: "", sizeBytes: 0, end: true, nextOffset: null });
      expect(f.run({ kind: "history", exchangeId, afterSeq: 0, limit: 201 }, f.beta)).toMatchObject(
        error("EXCHANGE_INVALID_INPUT"),
      );
      expect(
        f.run({ kind: "material-read", exchangeId, materialId: emptyId, offset: 0, limit: 65_537 }, f.beta),
      ).toMatchObject(error("EXCHANGE_INVALID_INPUT"));
      expect(tree(f.home)).toEqual(before);
    } finally {
      chmodSync(f.beta, 0o700);
    }
    rmSync(join(f.vault, ".sorage-vault.json"));
    expect(f.run({ kind: "inspect", exchangeId }, f.beta)).toMatchObject(error("VAULT_INTEGRITY_ERROR"));
  });

  it("rolls back failed body creators and retains a committed result through interrupted activation", () => {
    const f = fixture();
    const exchangeId = create(f);
    const claim = joinExchange(f, exchangeId);
    const text = "a".repeat(65_537);
    f.usingDb((db) =>
      db.exec(`CREATE TRIGGER abort_receipt BEFORE INSERT ON exchange_operation_outcomes
      BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`),
    );
    expect(f.run(send(exchangeId, claim, "commit-rolled-back", text))).toMatchObject(error("INTERNAL_ERROR"));
    f.usingDb((db) => {
      for (const name of [
        "exchange_working_content",
        "exchange_activation_intents",
        "exchange_messages",
        "exchange_operation_outcomes",
      ]) {
        expect(db.prepare(`SELECT * FROM ${name}`).all()).toEqual([]);
      }
      db.exec(`DROP TRIGGER abort_receipt;
        CREATE TRIGGER fail_activation BEFORE UPDATE ON exchange_working_content WHEN NEW.materialized = 1
        BEGIN SELECT RAISE(ABORT, 'injected activation failure'); END`);
    });
    const stages = join(f.home, "state", "exchange-working", "staging");
    expect(existsSync(stages) ? readdirSync(stages) : []).toEqual([]);
    const committed = unwrap(f.run(send(exchangeId, claim, "committed", text)));
    expect(committed).toMatchObject({ seq: 1, availability: "pending", warnings: [{ code: "INTERNAL_ERROR" }] });
    const before = tree(f.home);
    expect(unwrap(f.run(send(exchangeId, undefined, "committed", text)))).toMatchObject({
      seq: 1,
      replayed: true,
      availability: "pending",
    });
    expect(
      f.run({ kind: "material-read", exchangeId, materialId: String(committed.materialId), offset: 0, limit: 1 }),
    ).toMatchObject(error("CONTENT_MATERIALIZING"));
    expect(tree(f.home)).toEqual(before);
    f.usingDb((db) => db.exec("DROP TRIGGER fail_activation"));
    const separate = create(f, "other-exchange");
    joinExchange(f, separate);
    expect(f.usingDb((db) => db.prepare("SELECT * FROM exchange_activation_intents").all())).toHaveLength(1);
    unwrap(f.run(send(exchangeId, claim, "authorized-fresh")));
    expect(f.usingDb((db) => db.prepare("SELECT * FROM exchange_activation_intents").all())).toEqual([]);
    expect(unwrap(f.run(send(exchangeId, undefined, "committed", text)))).toMatchObject({
      seq: 1,
      availability: "available",
    });
  });

  it("reclaims only the exact file-backed stage after a deferred constraint rejects COMMIT", () => {
    const f = fixture();
    const exchangeId = create(f);
    const claim = joinExchange(f, exchangeId);
    const stages = join(f.home, "state", "exchange-working", "staging");
    mkdirSync(stages, { recursive: true });
    const unrelatedStage = join(stages, otherId);
    writeFileSync(unrelatedStage, "unrelated private stage");
    f.usingDb((db) =>
      db.exec(`
      CREATE TABLE test_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE test_child (id INTEGER NOT NULL REFERENCES test_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER reject_deferred_commit AFTER INSERT ON exchange_operation_outcomes
      BEGIN INSERT INTO test_child VALUES (1); END;
    `),
    );
    const census = () =>
      f.usingDb((db) =>
        [
          "exchange_working_content",
          "exchange_activation_intents",
          "exchange_materials",
          "exchange_messages",
          "exchange_operation_outcomes",
          "events",
          "test_child",
        ].map((name) => db.prepare(`SELECT COUNT(*) count FROM ${name}`).get()),
      );
    const before = census();
    const source = join(f.alpha, "deferred-commit.txt");
    writeFileSync(source, "a".repeat(65_537));
    const input = { ...send(exchangeId, claim, "deferred-commit"), body: { file: source } };
    expect(f.run(input)).toMatchObject(error("INTERNAL_ERROR"));
    expect(census()).toEqual(before);
    expect(readdirSync(stages)).toEqual([otherId]);
    expect(readFileSync(unrelatedStage, "utf8")).toBe("unrelated private stage");
    f.usingDb((db) => db.exec("DROP TRIGGER reject_deferred_commit"));
    const result = unwrap(f.run(input));
    expect(result).toMatchObject({ seq: 1, replayed: false, availability: "available" });
    expect(unwrap(f.run({ ...input, claim: undefined, replayOnly: true }))).toEqual({ ...result, replayed: true });
    expect(readdirSync(stages)).toEqual([otherId]);
    expect(readFileSync(unrelatedStage, "utf8")).toBe("unrelated private stage");
  });

  it("preserves a stage when its committed ownership cannot be disproved", () => {
    const f = fixture();
    const exchangeId = create(f);
    f.usingDb((db) => {
      const stateDir = join(f.home, "state");
      const store = createExchangeWorkingStore({ db, stateDir, vaultPath: f.vault });
      const body = unwrap(
        store.prepare({
          exchangeId,
          classification: "binary",
          maxBytes: 1,
          chunks: [Buffer.of(42)],
        }),
      );
      const stage = join(stateDir, "exchange-working", "staging", body.id);
      db.exec("BEGIN");
      store.discardAfterFailedCommit(body);
      expect(readFileSync(stage)).toEqual(Buffer.of(42));
      db.exec("ROLLBACK");
      db.exec("ALTER TABLE exchange_activation_intents RENAME TO test_hidden_intents");
      store.discardAfterFailedCommit(body);
      expect(readFileSync(stage)).toEqual(Buffer.of(42));
      db.exec("ALTER TABLE test_hidden_intents RENAME TO exchange_activation_intents");
      db.exec("BEGIN");
      store.record(body);
      db.exec("COMMIT");
      store.discardAfterFailedCommit(body);
      expect(readFileSync(stage)).toEqual(Buffer.of(42));
    });
  });

  it.each(["schema-13 upgrade", "format-5 foundation restore"])(
    "preserves pre-ledger progress through %s",
    (transition) => {
      const target = fixture(false);
      function seedProgress(db: SorageSqlite, exchangeId: string) {
        const insert = db.prepare("INSERT INTO exchange_read_ranges VALUES (?,?,?,?)");
        insert.run(exchangeId, alphaId, 1, 2);
        insert.run(exchangeId, alphaId, 5, 5);
      }
      let exchangeId: string;
      if (transition === "schema-13 upgrade") {
        exchangeId = "44444444-4444-4444-8444-444444444444";
        for (const suffix of ["-shm", "-wal", ""]) rmSync(`${target.database}${suffix}`, { force: true });
        const plan = productionMigrationPlan();
        const { db } = openAndMigrate(
          target.database,
          plan.migrations.filter((step) => step.version <= 13),
          {
            rebuilds: plan.rebuilds,
          },
        );
        try {
          const marker = JSON.parse(readFileSync(join(target.vault, ".sorage-vault.json"), "utf8"));
          seedProjects(db, target.projects, marker.installationId);
          db.prepare("INSERT INTO exchanges VALUES (?,?,?,?,?)").run(
            exchangeId,
            alphaId,
            creation.goal,
            JSON.stringify(creation.criteria),
            now,
          );
          for (const member of [alphaId, betaId])
            db.prepare("INSERT INTO exchange_members VALUES (?,?)").run(exchangeId, member);
          seedProgress(db, exchangeId);
        } finally {
          db.close();
        }
      } else {
        const source = fixture();
        exchangeId = create(source);
        source.usingDb((db) => seedProgress(db, exchangeId));
        const ports = unwrap(source.ports.exportPorts());
        const data = unwrap(ports.readSnapshotData());
        if (!("exchanges" in data)) throw new Error("Expected format 5 from the current production adapter.");
        const exchanges = source.usingDb(readExchangeRecords);
        unwrap(
          ports.writeSnapshotTree(
            unwrap(snapshotFilesV5({ ...data, exchanges, exchangeRepresentation: "foundation" })).files,
          ),
        );
        unwrap(
          backupRestore(
            unwrap(createNodeBackupCommandPorts({ ...target.setup, sourcePath: source.vault }).restorePorts()),
            {
              dryRun: false,
            },
          ),
        );
        target.usingDb((db) => {
          const marker = JSON.parse(readFileSync(join(target.vault, ".sorage-vault.json"), "utf8"));
          db.prepare("INSERT INTO project_bindings VALUES (?,?,?,?,?,?,?)").run(
            alphaId,
            alphaId,
            marker.installationId,
            target.alpha,
            "directory",
            now,
            now,
          );
        });
      }
      const joinInput = { kind: "join", exchangeId, confirmed: false } as const;
      const actorOptions = { ...target.setup, cwd: target.alpha, now: () => new Date(now) };
      if (transition === "schema-13 upgrade") {
        expect(target.run({ kind: "inspect", exchangeId })).toMatchObject(error("STORAGE_MIGRATION_REQUIRED"));
      }
      const admission = unwrap(admitExchangeJoin(joinInput, actorOptions));
      expect(admission).toMatchObject({ exchangeId, projectId: alphaId });
      expect(target.usingDb((db) => db.prepare("SELECT * FROM exchange_claims").all())).toEqual([]);
      const claim = unwrap(executeExchange(joinInput, { ...actorOptions, joinAdmission: admission })).claimId;
      expect(unwrap(target.run(send(exchangeId, claim, "first-after-foundation"))).seq).toBe(6);
      const observed = [
        { firstSeq: 1, lastSeq: 2 },
        { firstSeq: 5, lastSeq: 5 },
      ];
      const updated = [
        { firstSeq: 1, lastSeq: 2 },
        { firstSeq: 5, lastSeq: 6 },
      ];
      const counts = () =>
        target.usingDb((db) =>
          ["exchange_creation_outcomes", "exchange_operation_outcomes", "exchange_messages", "events"].map((table) =>
            db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
          ),
        );
      const before = counts();
      const confirm = (firstSeq: number, lastSeq: number, observedClaim = claim) =>
        target.run({ kind: "confirm-read", exchangeId, claim: observedClaim, ranges: [{ firstSeq, lastSeq }] });
      expect(confirm(1, 2, "stale-claim")).toMatchObject(error("EXCHANGE_CLAIM_CONFLICT"));
      expect(unwrap(confirm(1, 2))).toMatchObject({ changed: false, readRanges: observed });
      expect(confirm(4, 6)).toMatchObject(error("EXCHANGE_INVALID_INPUT"));
      expect(unwrap(target.run({ kind: "inspect", exchangeId })).readRanges).toEqual(observed);
      expect(unwrap(confirm(5, 6))).toMatchObject({ changed: true, readRanges: updated });
      expect(unwrap(confirm(5, 6))).toMatchObject({ changed: false, readRanges: updated });
      expect(confirm(4, 6)).toMatchObject(error("EXCHANGE_INVALID_INPUT"));
      expect(unwrap(target.run({ kind: "inspect", exchangeId })).readRanges).toEqual(updated);
      expect(counts()).toEqual(before);
      unwrap(exportSnapshot(unwrap(target.ports.exportPorts())));
    },
  );
});
