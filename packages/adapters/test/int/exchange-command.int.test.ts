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
  archiveProject,
  backupRestore,
  backupVerify,
  bindProject,
  canonicalJson,
  type ExchangeActionFor,
  exportSnapshot,
  type ExchangeBusinessInput,
  type ExchangeInput,
  initializeInstallation,
  type Result,
  runBackupCommand,
  snapshotFilesV5,
  unarchiveProject,
  unbindProject,
  USER_ACTOR,
} from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { admitExchangeJoin, executeExchange } from "../../src/exchange-command-ports";
import { readExchangeRecords } from "../../src/exchange-records";
import { createExchangeWorkingStore } from "../../src/exchange-working-store";
import { createNodeInitPorts } from "../../src/init-ports";
import { createNodeProjectPorts } from "../../src/project-command-ports";
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
  it("replays a revalidated source through equivalent supplier paths without reading source bytes", () => {
    const f = fixture();
    const exchangeId = create(f);
    const claim = joinExchange(f, exchangeId);
    const path = join(f.alpha, "original.txt");
    writeFileSync(path, "unchanged original");
    const registered = unwrap(
      f.run({
        kind: "material-register",
        exchangeId,
        claim,
        operationId: "register",
        replayOnly: false,
        material: { kind: "versioned", path, offset: 0, length: null },
      }),
    );
    const revalidate = {
      kind: "material-revalidate" as const,
      exchangeId,
      claim,
      operationId: "validate",
      replayOnly: false,
      materialId: registered.materialId,
      source: "original.txt",
    };
    const committed = unwrap(f.run(revalidate));
    rmSync(path);
    const before = tree(f.home);
    const replay = { ...revalidate, claim: undefined, replayOnly: true };
    expect(unwrap(f.run({ ...replay, source: path }))).toEqual({ ...committed, replayed: true });
    expect(unwrap(f.run({ ...replay, source: "./original.txt" }))).toEqual({ ...committed, replayed: true });
    expect(f.run({ ...replay, source: "different.txt" })).toMatchObject(error("IDEMPOTENCY_CONFLICT"));
    expect(f.run({ ...replay, source: "../outside", operationId: "unrecorded" })).toMatchObject(
      error("EXCHANGE_REPLAY_UNAVAILABLE"),
    );
    expect(tree(f.home)).toEqual(before);
  });

  it.each(["requester", "assignee"] as const)(
    "transfers a removed %s responsibility without rewriting attribution",
    (removed) => {
      const f = fixture();
      const { exchangeId } = unwrap(f.run({ ...creation, peers: ["beta", "other"], criteria: [...creation.criteria] }));
      const alpha = joinExchange(f, exchangeId);
      const beta = joinExchange(f, exchangeId, f.beta);
      const other = joinExchange(f, exchangeId, f.other);
      const identity = { exchangeId, replayOnly: false };
      const first = unwrap(
        f.run({
          ...identity,
          kind: "request",
          claim: alpha,
          operationId: "request",
          assignee: "beta",
          condition: "Check the prior result",
          criteria: ["Evidence"],
        }),
      );
      const report = (claim: string, assignmentVersion: number, operationId: string) => ({
        ...identity,
        kind: "report" as const,
        claim,
        operationId,
        requestId: first.requestId,
        assignmentVersion,
        body: { text: "Author attribution" },
        evidence: [],
        accept: [],
      });
      const accept = (claim: string, reportVersion: number) => ({
        ...identity,
        kind: "accept" as const,
        claim,
        operationId: "accept",
        accept: [{ requestId: first.requestId, reportVersion }],
      });
      unwrap(f.run(report(beta, 1, "first-report"), f.beta));
      unwrap(
        f.run(
          {
            ...identity,
            kind: "roster",
            rosterVersion: 1,
            add: [],
            remove: [removed === "requester" ? "alpha" : "beta"],
            operationId: "remove",
            reason: "Remove entrusted participant",
            confirmed: true,
          },
          f.other,
        ),
      );
      const pending = unwrap(f.run({ kind: "inspect", exchangeId }, f.other)).requests[0];
      expect(pending).toMatchObject({
        requesterId: alphaId,
        assigneeId: betaId,
        ownership:
          removed === "requester"
            ? { version: 2, acceptanceOwnerId: null, assignedProjectId: betaId }
            : { version: 2, acceptanceOwnerId: alphaId, assignedProjectId: null },
      });
      expect(f.run({ kind: "inspect", exchangeId }, removed === "requester" ? f.alpha : f.beta)).toMatchObject(
        error("FORBIDDEN_ACTOR"),
      );
      const correction = {
        ...identity,
        kind: "owner-correct" as const,
        requestId: first.requestId,
        ownershipVersion: 2,
        rosterVersion: 2,
        operationId: "transfer",
        reason: "Entrust remaining participant",
        confirmed: true,
      };
      const beforeCorrection = tree(f.home);
      expect(f.run({ ...correction, acceptanceOwner: "other", assignee: "other" }, f.other)).toMatchObject(
        error("EXCHANGE_INVALID_INPUT"),
      );
      expect(tree(f.home)).toEqual(beforeCorrection);
      unwrap(
        f.run(
          { ...correction, ...(removed === "requester" ? { acceptanceOwner: "other" } : { assignee: "other" }) },
          f.other,
        ),
      );
      if (removed === "requester") {
        expect(f.run(accept(alpha, 1), f.alpha)).toMatchObject(error("FORBIDDEN_ACTOR"));
        expect(unwrap(f.run(accept(other, 1), f.other))).toMatchObject({ kind: "accept" });
      } else {
        expect(f.run(report(beta, 1, "late-report"), f.beta)).toMatchObject(error("FORBIDDEN_ACTOR"));
        expect(f.run(report(other, 1, "stale-assignment"), f.other)).toMatchObject(error("ROW_VERSION_CONFLICT"));
        expect(f.run(accept(alpha, 1), f.alpha)).toMatchObject(error("ROW_VERSION_CONFLICT"));
        const newer = unwrap(f.run(report(other, 3, "replacement-report"), f.other));
        expect(newer.reportVersion).toBe(2);
        unwrap(f.run(accept(alpha, 2), f.alpha));
      }
      const settled = unwrap(f.run({ kind: "inspect", exchangeId }, f.other));
      expect(settled.reports[0]).toMatchObject({ authorId: betaId, assignmentVersion: 1 });
      expect(settled.requests[0]).toMatchObject({ requesterId: alphaId, assigneeId: betaId, state: "resolved" });
      unwrap(exportSnapshot(unwrap(f.ports.exportPorts())));
    },
  );

  it("keeps earlier acceptance through requester departure, reports to the vacancy, and restores current responsibility", () => {
    const source = fixture();
    const { exchangeId } = unwrap(
      source.run({ ...creation, peers: ["beta", "other"], criteria: [...creation.criteria] }),
    );
    const alpha = joinExchange(source, exchangeId);
    const beta = joinExchange(source, exchangeId, source.beta);
    const other = joinExchange(source, exchangeId, source.other);
    const identity = { exchangeId, replayOnly: false };
    const request = (claim: string, assignee: string, cwd: string) =>
      unwrap(
        source.run(
          {
            ...identity,
            kind: "request",
            claim,
            assignee,
            operationId: "request",
            condition: "Check the result",
            criteria: ["Supply evidence"],
          },
          cwd,
        ),
      );
    const publish = (claim: string, requestId: string, operationId: string) => ({
      ...identity,
      kind: "report" as const,
      claim,
      requestId,
      operationId,
      assignmentVersion: 1,
      evidence: [],
      accept: [],
      body: { text: "Checked result" },
    });
    const accept = (claim: string, requestId: string, reportVersion: number, operationId: string) => ({
      ...identity,
      kind: "accept" as const,
      claim,
      operationId,
      accept: [{ requestId, reportVersion }],
    });
    const departingRequester = request(alpha, "beta", source.alpha);
    const departingAssignee = request(other, "alpha", source.other);
    const initial = unwrap(source.run(publish(beta, departingRequester.requestId, "initial"), source.beta));
    const resolved = unwrap(source.run(publish(alpha, departingAssignee.requestId, "resolved"), source.alpha));
    unwrap(source.run(accept(alpha, departingRequester.requestId, initial.reportVersion, "accept-initial")));
    unwrap(
      source.run(accept(other, departingAssignee.requestId, resolved.reportVersion, "accept-resolved"), source.other),
    );
    const pause = unwrap(
      source.run(
        {
          ...identity,
          kind: "stop",
          rosterVersion: 1,
          reason: "Review membership",
          confirmed: true,
          operationId: "pause",
        },
        source.other,
      ),
    );
    const roster = {
      ...identity,
      kind: "roster" as const,
      rosterVersion: 1,
      pauseVersion: 1,
      add: [],
      remove: ["alpha"],
      reason: "The original participant is leaving",
      operationId: "departure",
      confirmed: true,
    };
    expect(source.run({ ...roster, pauseVersion: 0 }, source.other)).toMatchObject(error("ROW_VERSION_CONFLICT"));
    unwrap(source.run(roster, source.other));
    const expectedVacancy = { acceptanceOwnerId: null, assignedProjectId: betaId, version: 2, assignmentVersion: 1 };
    const paused = unwrap(source.run({ kind: "inspect", exchangeId }, source.other));
    expect(paused).toMatchObject({ state: "paused", rosterVersion: 2 });
    expect(paused.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: departingRequester.requestId,
          requesterId: alphaId,
          assigneeId: betaId,
          state: "resolved",
          ownership: expect.objectContaining(expectedVacancy),
        }),
        expect.objectContaining({
          id: departingAssignee.requestId,
          requesterId: otherId,
          assigneeId: alphaId,
          state: "resolved",
          ownership: expect.objectContaining({ acceptanceOwnerId: otherId, assignedProjectId: alphaId, version: 1 }),
        }),
      ]),
    );
    if (pause.kind !== "stop") throw new Error("Expected a stopped Exchange.");
    const resumed = unwrap(
      source.run(
        {
          kind: "join",
          exchangeId,
          confirmed: true,
          resume: {
            ...identity,
            kind: "resume",
            pauseVersion: pause.pauseVersion,
            confirmed: true,
            operationId: "resume",
          },
        },
        source.beta,
      ),
    );
    const followUp = unwrap(
      source.run(publish(String(resumed.claimId), departingRequester.requestId, "follow-up"), source.beta),
    );
    expect(
      unwrap(source.run({ kind: "history", exchangeId }, source.other)).messages.find(
        (message) => message.seq === followUp.seq,
      ),
    ).toMatchObject({ senderId: betaId, recipientId: null, reportVersion: 2 });
    expect(followUp.reportVersion).toBe(initial.reportVersion + 1);
    unwrap(exportSnapshot(unwrap(source.ports.exportPorts())));
    unwrap(backupVerify(unwrap(source.ports.verifyPorts()), { now: new Date(now) }));

    const restored = fixture(false);
    const restore = unwrap(
      createNodeBackupCommandPorts({ ...restored.setup, sourcePath: source.vault }).restorePorts(),
    );
    unwrap(backupRestore(restore, { dryRun: false }));
    bindRestored(restored);
    const restoredView = unwrap(restored.run({ kind: "inspect", exchangeId }, restored.other));
    expect(restoredView.requests.find((entry) => entry.id === departingRequester.requestId)).toMatchObject({
      requesterId: alphaId,
      state: "completion-reported",
      ownership: expectedVacancy,
      report: { version: 2 },
      acceptance: null,
    });
    expect(restoredView.acceptances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: departingRequester.requestId, reportVersion: 1, requesterId: alphaId }),
        expect.objectContaining({ requestId: departingAssignee.requestId, reportVersion: 1, requesterId: otherId }),
      ]),
    );
    expect(
      unwrap(restored.run({ kind: "history", exchangeId }, restored.other)).messages.find(
        (message) => message.seq === followUp.seq,
      ),
    ).toMatchObject({ recipientId: null, reportVersion: 2 });
    unwrap(
      restored.run(
        {
          ...identity,
          kind: "owner-correct",
          requestId: departingRequester.requestId,
          ownershipVersion: 2,
          rosterVersion: 2,
          pauseVersion: 1,
          acceptanceOwner: "other",
          operationId: "take-over",
          reason: "Take responsibility for the outstanding acceptance",
          confirmed: true,
        },
        restored.other,
      ),
    );
    const restoredBeta = joinExchange(restored, exchangeId, restored.beta);
    const newest = unwrap(
      restored.run(publish(restoredBeta, departingRequester.requestId, "owner-follow-up"), restored.beta),
    );
    expect(
      unwrap(restored.run({ kind: "history", exchangeId }, restored.other)).messages.find(
        (message) => message.seq === newest.seq,
      ),
    ).toMatchObject({ senderId: betaId, recipientId: otherId, reportVersion: 3 });
    const restoredOther = joinExchange(restored, exchangeId, restored.other);
    unwrap(
      restored.run(
        accept(restoredOther, departingRequester.requestId, newest.reportVersion, "accept-latest"),
        restored.other,
      ),
    );
    const final = unwrap(restored.run({ kind: "inspect", exchangeId }, restored.other));
    expect(final.requests.find((entry) => entry.id === departingRequester.requestId)).toMatchObject({
      requesterId: alphaId,
      state: "resolved",
      ownership: { acceptanceOwnerId: otherId, assignmentVersion: 1 },
      acceptance: { requesterId: otherId, reportVersion: 3 },
    });
    expect(final.acceptances).toEqual(expect.arrayContaining(restoredView.acceptances));
    unwrap(exportSnapshot(unwrap(restored.ports.exportPorts())));
  });

  it("retains notice issue receipts, preserves separate clocks and recovers a new episode after reconnect", () => {
    const f = fixture();
    const { exchangeId } = unwrap(f.run({ ...creation, peers: ["beta", "other"], criteria: [...creation.criteria] }));
    const pair = { exchangeId };
    const opener = joinExchange(f, exchangeId);
    const affected = joinExchange(f, exchangeId, f.beta);
    const issueRequest = (operationId: string) =>
      unwrap(
        f.run({
          ...pair,
          kind: "request",
          claim: opener,
          operationId,
          replayOnly: false,
          assignee: "beta",
          condition: "Check the result",
          criteria: ["Supply evidence"],
        }),
      );
    const pending = issueRequest("notice-first");
    const separate = issueRequest("notice-second");
    unwrap(f.run(send(exchangeId, opener, "information-is-not-work")));
    const list = (claim?: string, cwd = f.alpha) => unwrap(f.run({ ...pair, kind: "notice-list", claim }, cwd)).notices;
    f.later(20);
    unwrap(f.run({ ...pair, kind: "renew", claim: affected }, f.beta));
    unwrap(f.run({ ...pair, kind: "release", claim: affected }, f.beta));
    f.later(20);
    expect(list()).toEqual([]);
    f.later(279.999);
    expect(list()).toEqual([]);
    f.later(0.001);
    const waiting = joinExchange(f, exchangeId, f.other);
    const beforeRead = tree(f.home);
    const due = list(waiting, f.other).find((notice) => notice.obligation.requestId === pending.requestId);
    expect(due).toMatchObject({
      noticeKind: "connection-check",
      canAcquire: true,
      eligibleAt: "2026-11-20T00:05:20.000Z",
    });
    expect(list(waiting, f.other)).toHaveLength(2);
    expect(tree(f.home)).toEqual(beforeRead);
    if (!due) throw new Error("Expected the first due notice.");
    const backup = unwrap(f.ports.runPorts());
    unwrap(runBackupCommand(backup, {}));
    const snapshot = join(f.vault, "snapshots", "exchanges.json");
    const canonical = readFileSync(snapshot, "utf8");
    const acquire = { ...pair, kind: "notice-acquire" as const, claim: waiting, incidentId: due.incidentId };
    const slot = unwrap(f.run(acquire, f.other));
    expect(unwrap(f.run(acquire, f.other))).toEqual(slot);
    const activeOpener = joinExchange(f, exchangeId);
    expect(f.run({ ...acquire, claim: activeOpener })).toMatchObject(error("ROW_VERSION_CONFLICT"));
    f.later(29.999);
    unwrap(f.run({ ...pair, kind: "renew", claim: activeOpener }));
    expect(unwrap(runBackupCommand(backup, {}))).toMatchObject({ outcome: "no-change" });
    expect(readFileSync(snapshot, "utf8")).toBe(canonical);
    expect(f.run({ ...acquire, claim: activeOpener })).toMatchObject(error("ROW_VERSION_CONFLICT"));
    f.later(0.001);
    const successor = unwrap(f.run({ ...acquire, claim: activeOpener }));
    expect(successor.reportingClaimId).not.toBe(slot.reportingClaimId);
    const ack = {
      ...pair,
      kind: "notice-ack" as const,
      incidentId: due.incidentId,
      claim: activeOpener,
      reportingClaim: successor.reportingClaimId,
      operationId: "issued",
      replayOnly: false,
    };
    expect(f.run({ ...ack, claim: waiting, reportingClaim: slot.reportingClaimId }, f.other)).toMatchObject(
      error("ROW_VERSION_CONFLICT"),
    );
    const issued = unwrap(f.run(ack));
    expect(issued).toMatchObject({
      ...pair,
      incidentId: due.incidentId,
      noticeKind: "connection-check",
      replayed: false,
    });
    expect(list(activeOpener).map(({ obligation }) => obligation.requestId)).toEqual([separate.requestId]);
    const next = list(activeOpener)[0];
    if (!next) throw new Error("Expected the second obligation.");
    unwrap(f.run({ ...acquire, claim: activeOpener, incidentId: next.incidentId }));
    unwrap(exportSnapshot(unwrap(f.ports.exportPorts())));
    const retained = readFileSync(snapshot, "utf8");
    for (const runtime of [activeOpener, waiting, successor.reportingClaimId, slot.reportingClaimId])
      expect(retained).not.toContain(runtime);
    unwrap(backupVerify(unwrap(f.ports.verifyPorts()), { now: new Date(now) }));

    const restored = fixture(false);
    const ports = unwrap(createNodeBackupCommandPorts({ ...restored.setup, sourcePath: f.vault }).restorePorts());
    unwrap(backupRestore(ports, { dryRun: false }));
    bindRestored(restored);
    restored.later(350);
    expect(
      restored.usingDb((db) =>
        ["exchange_claims", "exchange_notice_claims", "exchange_notice_presence"].map((table) =>
          db.prepare(`SELECT 1 FROM ${table}`).all(),
        ),
      ),
    ).toEqual([[], [], []]);
    const beforeReplay = tree(restored.home);
    const replay = { ...ack, claim: undefined, reportingClaim: undefined, replayOnly: true };
    expect(unwrap(restored.run(replay))).toEqual({ ...issued, replayed: true });
    expect(restored.run({ ...replay, incidentId: "f".repeat(64) })).toMatchObject(error("IDEMPOTENCY_CONFLICT"));
    expect(restored.run({ ...replay, operationId: "unknown" })).toMatchObject(error("EXCHANGE_REPLAY_UNAVAILABLE"));
    expect(tree(restored.home)).toEqual(beforeReplay);
    expect(
      unwrap(restored.run({ ...pair, kind: "notice-list" })).notices.map(({ obligation }) => obligation.requestId),
    ).toEqual([separate.requestId]);
    const reconnected = joinExchange(restored, exchangeId, restored.beta);
    const unread = () =>
      unwrap(restored.run({ ...pair, kind: "notice-list" })).notices.find(
        ({ obligation }) => obligation.requestId === pending.requestId,
      );
    const firstEpoch = unread();
    expect(firstEpoch).toMatchObject({
      noticeKind: "unread-delivery",
      eligibleAt: "2026-11-20T00:05:00.000Z",
      priorityUntil: "2026-11-20T00:06:50.000Z",
    });
    unwrap(restored.run({ ...pair, kind: "release", claim: reconnected }, restored.beta));
    const renewed = joinExchange(restored, exchangeId, restored.beta);
    expect(unread()?.incidentId).not.toBe(firstEpoch?.incidentId);
    unwrap(
      restored.run(
        {
          ...pair,
          kind: "confirm-read",
          claim: renewed,
          ranges: [{ firstSeq: pending.seq, lastSeq: pending.seq }],
        },
        restored.beta,
      ),
    );
    expect(unread()).toBeUndefined();
  });

  it("preserves an archived Project's pending response as a connection check without granting notice authority", () => {
    const f = fixture();
    const exchangeId = create(f);
    const claim = joinExchange(f, exchangeId);
    const request = unwrap(
      f.run({
        kind: "request",
        exchangeId,
        claim,
        operationId: "pending-archive",
        replayOnly: false,
        assignee: "beta",
        condition: "Check the result",
        criteria: ["Record the exact observation"],
      }),
    );
    const list = { kind: "notice-list", exchangeId } as const;
    f.later(290);
    const affected = joinExchange(f, exchangeId, f.beta);
    f.later(10);
    const [unread] = unwrap(f.run(list)).notices;
    expect(unread).toMatchObject({ noticeKind: "unread-delivery", affectedProjectId: betaId });
    if (!unread) throw new Error("Expected the pending response's unread notice before archive.");

    f.usingDb((database) => {
      const ports = createNodeProjectPorts({ ...f.setup, database });
      const archived = unwrap(
        archiveProject({ ...ports, clock: { now: () => new Date("2026-11-20T00:05:00.000Z") } }, { slug: "beta" }),
      );
      expect(archived).toMatchObject({ id: betaId, status: "archived" });
      expect(database.prepare("SELECT 1 FROM exchange_claims WHERE claim_id = ?").all(affected)).toEqual([]);
    });

    expect(unwrap(f.run(list)).notices).toEqual([]);
    expect(f.run({ ...list, claim: affected }, f.beta)).toMatchObject(error("FORBIDDEN_ACTOR"));
    expect(
      f.run({ kind: "notice-acquire", exchangeId, incidentId: unread.incidentId, claim: affected }, f.beta),
    ).toMatchObject(error("FORBIDDEN_ACTOR"));
    expect(unwrap(f.run({ kind: "inspect", exchangeId }))).toMatchObject({
      rosterVersion: 1,
      members: [alphaId, betaId],
      requests: [{ id: request.requestId, assignmentVersion: 1, state: "in-progress" }],
    });

    f.later(289.999);
    const reporter = joinExchange(f, exchangeId);
    expect(unwrap(f.run({ ...list, claim: reporter })).notices).toEqual([]);
    f.later(0.001);
    const notices = unwrap(f.run({ ...list, claim: reporter })).notices;
    expect(notices).toMatchObject([
      {
        noticeKind: "connection-check",
        affectedProjectId: betaId,
        availableAt: now,
        eligibleAt: "2026-11-20T00:09:50.000Z",
        canAcquire: true,
        obligation: { response: "report", requestId: request.requestId, version: 1, sourceSeq: request.seq },
      },
    ]);
    const [incident] = notices;
    if (!incident) throw new Error("Expected the archived Project's connection check.");
    expect(incident.incidentId).not.toBe(unread.incidentId);
    expect(
      unwrap(f.run({ kind: "notice-acquire", exchangeId, incidentId: incident.incidentId, claim: reporter })),
    ).toMatchObject({ incidentId: incident.incidentId, projectId: alphaId });
  });

  it.each(["archive", "unbind"] as const)(
    "starts a distinct unread episode after same-time Project %s and rejoin",
    (loss) => {
      const f = fixture();
      const exchangeId = create(f);
      const first = joinExchange(f, exchangeId);
      unwrap(
        f.run({
          kind: "request",
          exchangeId,
          claim: first,
          operationId: "pending-rejoin",
          replayOnly: false,
          assignee: "beta",
          condition: "Check the pending result",
          criteria: ["Record the observation"],
        }),
      );
      f.later(300);
      const reporter = joinExchange(f, exchangeId);
      const firstAffected = joinExchange(f, exchangeId, f.beta);
      const list = () => unwrap(f.run({ kind: "notice-list", exchangeId, claim: reporter })).notices;
      const [original] = list();
      if (!original) throw new Error("Expected the first unread episode.");
      expect(original.noticeKind).toBe("unread-delivery");
      const competing = f.run({ kind: "join", exchangeId, confirmed: false }, f.beta);
      if (competing.ok) throw new Error("Expected the still-live affected Project's comparison token.");
      const { claimId: affected } = unwrap(
        f.run(
          {
            kind: "join",
            exchangeId,
            confirmed: true,
            replaceClaim: String(competing.error.details?.observedClaim),
          },
          f.beta,
        ),
      );
      expect(affected).not.toBe(firstAffected);
      expect(list()).toEqual([original]);
      const originalSlot = unwrap(
        f.run({
          kind: "notice-acquire",
          exchangeId,
          incidentId: original.incidentId,
          claim: reporter,
        }),
      );

      const project = { slug: "beta", dir: f.beta, userHome: f.parent, actor: USER_ACTOR, confirm: true };
      const changeAuthority = (restore: boolean) =>
        f.usingDb((database) => {
          const ports = {
            ...createNodeProjectPorts({ ...f.setup, database }),
            clock: { now: () => new Date("2026-11-20T00:05:00.000Z") },
          };
          if (loss === "archive") unwrap(restore ? unarchiveProject(ports, project) : archiveProject(ports, project));
          else unwrap(restore ? bindProject(ports, project) : unbindProject(ports, project));
        });
      changeAuthority(false);
      expect(list()).toEqual([]);
      changeAuthority(true);
      expect(list()).toEqual([]);
      const rejoined = joinExchange(f, exchangeId, f.beta);
      expect(rejoined).not.toBe(affected);
      const [next] = list();
      if (!next) throw new Error("Expected the recovered Project's new unread episode.");
      expect(next).toMatchObject({ noticeKind: "unread-delivery", obligation: original.obligation });
      expect(next.incidentId).not.toBe(original.incidentId);
      expect(
        f.run({
          kind: "notice-ack",
          exchangeId,
          operationId: "outdated-reporting-slot",
          replayOnly: false,
          claim: reporter,
          incidentId: original.incidentId,
          reportingClaim: originalSlot.reportingClaimId,
        }),
      ).toMatchObject(error("ROW_VERSION_CONFLICT"));
      expect(
        unwrap(
          f.run({
            kind: "notice-acquire",
            exchangeId,
            incidentId: next.incidentId,
            claim: reporter,
          }),
        ).reportingClaimId,
      ).not.toBe(originalSlot.reportingClaimId);
    },
  );

  it("keeps priority through a partial unbind and allows fallback immediately on the opener's last unbind", () => {
    const f = fixture();
    const { exchangeId } = unwrap(f.run({ ...creation, peers: ["beta", "other"], criteria: [...creation.criteria] }));
    const first = joinExchange(f, exchangeId);
    unwrap(
      f.run({
        kind: "request",
        exchangeId,
        claim: first,
        operationId: "pending-opener-unbind",
        replayOnly: false,
        assignee: "beta",
        condition: "Check the result",
        criteria: ["Record the observation"],
      }),
    );
    const alternate = join(f.parent, "alpha-alternate");
    mkdirSync(alternate);
    const project = { slug: "alpha", userHome: f.parent, actor: USER_ACTOR, confirm: true };
    const bind = (dir: string) =>
      f.usingDb((database) =>
        unwrap(bindProject(createNodeProjectPorts({ ...f.setup, database }), { ...project, dir })),
      );
    const unbind = (dir: string) =>
      f.usingDb((database) =>
        unwrap(unbindProject(createNodeProjectPorts({ ...f.setup, database }), { ...project, dir })),
      );
    bind(alternate);
    f.later(300);
    const opener = joinExchange(f, exchangeId);
    const peer = joinExchange(f, exchangeId, f.other);
    const list = () => unwrap(f.run({ kind: "notice-list", exchangeId, claim: peer }, f.other)).notices;
    const [incident] = list();
    if (!incident) throw new Error("Expected a connection check for the absent Project.");
    expect(incident).toMatchObject({ noticeKind: "connection-check", canAcquire: false });
    const input = { kind: "notice-acquire", exchangeId, incidentId: incident.incidentId } as const;
    const openerSlot = unwrap(f.run({ ...input, claim: opener }));
    unbind(f.alpha);
    expect(list()[0]).toMatchObject({ canAcquire: false });
    expect(unwrap(f.run({ ...input, claim: opener }, alternate))).toEqual(openerSlot);
    unbind(alternate);
    expect(list()[0]).toMatchObject({ canAcquire: true, priorityUntil: incident.priorityUntil });
    const peerSlot = unwrap(f.run({ ...input, claim: peer }, f.other));
    expect(peerSlot.reportingClaimId).not.toBe(openerSlot.reportingClaimId);
    bind(f.alpha);
    const rejoined = joinExchange(f, exchangeId);
    expect(rejoined).not.toBe(opener);
    expect(unwrap(f.run({ ...input, claim: peer }, f.other))).toEqual(peerSlot);
    expect(f.run({ ...input, claim: rejoined })).toMatchObject(error("ROW_VERSION_CONFLICT"));
  });

  it("restores exact notice acknowledgements from committed acceptance batch boundaries", () => {
    const f = fixture();
    const { exchangeId } = unwrap(f.run({ ...creation, peers: ["beta", "other"], criteria: [...creation.criteria] }));
    const identity = { exchangeId, replayOnly: false };
    const initial = joinExchange(f, exchangeId);
    const beta = joinExchange(f, exchangeId, f.beta);
    const request = (operationId: string, assignee: string) =>
      unwrap(
        f.run({
          ...identity,
          kind: "request",
          claim: initial,
          operationId,
          assignee,
          condition: "Verify the result",
          criteria: ["Record the observation"],
        }),
      );
    const pending = request("pending", "other");
    const reports = ["a", "b", "c", "d", "e", "f"].map((label) => {
      const { requestId } = request(`request-${label}`, "beta");
      const { reportVersion } = unwrap(
        f.run(
          {
            ...identity,
            kind: "report",
            claim: beta,
            operationId: `report-${label}`,
            requestId,
            assignmentVersion: 1,
            body: { text: "Observed" },
            evidence: [],
            accept: [],
          },
          f.beta,
        ),
      );
      return { requestId, reportVersion };
    });
    const inspect = () => unwrap(f.run({ kind: "inspect", exchangeId }));
    const acknowledge = (operationId: string, claim: string, noticeKind: "connection-check" | "unread-delivery") => {
      const { notices } = unwrap(f.run({ kind: "notice-list", exchangeId, claim }));
      const notice = notices.find(({ obligation }) => obligation.requestId === pending.requestId);
      if (!notice) throw new Error("Expected a notice for the unresolved request.");
      expect(notice.noticeKind).toBe(noticeKind);
      const { incidentId } = notice;
      const slot = unwrap(f.run({ kind: "notice-acquire", exchangeId, claim, incidentId }));
      const outcome = unwrap(
        f.run({
          ...identity,
          kind: "notice-ack",
          claim,
          operationId,
          incidentId,
          reportingClaim: slot.reportingClaimId,
        }),
      );
      expect(outcome).toMatchObject({ noticeKind, observedThroughSeq: inspect().lastSeq });
      return { operationId, incidentId, outcome };
    };
    f.later(300);
    const alpha = joinExchange(f, exchangeId);
    const accepted = unwrap(
      f.run({
        ...identity,
        kind: "accept",
        claim: alpha,
        operationId: "standalone",
        accept: reports.slice(0, 2),
      }),
    );
    const connection = acknowledge("issue-after-standalone", alpha, "connection-check");
    expect(connection.outcome.observedThroughSeq).toBe(accepted.sequences.at(-1));

    const sent = unwrap(f.run({ ...send(exchangeId, alpha, "bundled"), accept: reports.slice(2, 4) }));
    const affected = joinExchange(f, exchangeId, f.other);
    const unread = acknowledge("issue-after-send", alpha, "unread-delivery");
    expect(unread.outcome.observedThroughSeq).toBe(sent.seq);
    expect(sent.seq).toBeGreaterThan(connection.outcome.observedThroughSeq);
    unwrap(f.run({ kind: "release", exchangeId, claim: affected }, f.other));
    joinExchange(f, exchangeId, f.other);

    const head = inspect();
    const proposal = unwrap(
      f.run({
        ...identity,
        kind: "propose",
        claim: alpha,
        operationId: "proposal",
        rosterVersion: head.rosterVersion ?? 0,
        workRevision: head.workRevision ?? 0,
        criterion: head.criteria,
        summary: "Check the reports",
        report: reports.slice(4),
        disposition: [],
      }),
    );
    if (proposal.kind !== "propose") throw new Error("Expected a proposal outcome.");
    expect(
      unwrap(
        f.run({
          ...identity,
          kind: "vote",
          claim: alpha,
          operationId: "vote",
          proposalVersion: proposal.proposalVersion,
          vote: "approve",
          accept: reports.slice(4),
        }),
      ),
    ).toMatchObject({ kind: "vote", state: "active" });
    const afterVote = acknowledge("issue-after-vote", alpha, "unread-delivery");
    expect(afterVote.outcome.observedThroughSeq).toBe(sent.seq + 4);

    const exportInventory = () => {
      unwrap(exportSnapshot(unwrap(f.ports.exportPorts())));
      return JSON.parse(readFileSync(join(f.vault, "snapshots", "exchanges.json"), "utf8")).records[0].notices;
    };
    expect(exportInventory().openConnectionIssues).toEqual([]);
    f.later(300);
    const fresh = acknowledge("issue-after-later-disconnection", joinExchange(f, exchangeId), "connection-check");
    expect(fresh.outcome.observedThroughSeq).toBe(afterVote.outcome.observedThroughSeq);
    f.usingDb((db) => {
      expect(
        db.prepare("SELECT 1 FROM exchange_claims WHERE exchange_id = ? AND project_id = ?").all(exchangeId, otherId),
      ).toEqual([]);
      expect(
        db
          .prepare("SELECT heartbeat_at FROM exchange_notice_presence WHERE exchange_id = ? AND project_id = ?")
          .get(exchangeId, otherId),
      ).toEqual({ heartbeat_at: "2026-11-20T00:05:00.000Z" });
    });
    expect(exportInventory().openConnectionIssues).toEqual([fresh.incidentId]);
    unwrap(backupVerify(unwrap(f.ports.verifyPorts()), { now: new Date(now) }));
    const restored = fixture(false);
    const restore = unwrap(createNodeBackupCommandPorts({ ...restored.setup, sourcePath: f.vault }).restorePorts());
    unwrap(backupRestore(restore, { dryRun: false }));
    bindRestored(restored);
    for (const { operationId, incidentId, outcome } of [connection, unread, afterVote, fresh]) {
      expect(
        unwrap(restored.run({ kind: "notice-ack", exchangeId, operationId, incidentId, replayOnly: true })),
      ).toEqual({ ...outcome, replayed: true });
    }
    restored.later(600);
    expect(unwrap(restored.run({ kind: "notice-list", exchangeId })).notices).toEqual([]);
  });

  it("starts a new connection incident after a marker-free restore while retaining both acknowledgement identities", () => {
    const original = fixture();
    const exchangeId = create(original);
    const claim = joinExchange(original, exchangeId);
    const pending = unwrap(
      original.run({
        kind: "request",
        exchangeId,
        claim,
        operationId: "no-initial-heartbeat",
        replayOnly: false,
        assignee: "beta",
        condition: "Check the result",
        criteria: ["Record the observation"],
      }),
    );
    type Fixture = ReturnType<typeof fixture>;
    const list = (f: Fixture, claim?: string, cwd = f.alpha) =>
      unwrap(f.run({ kind: "notice-list", exchangeId, claim }, cwd)).notices;
    const issue = (f: Fixture, operationId: string, claim: string, cwd = f.alpha) => {
      const notices = list(f, claim, cwd);
      const [notice] = notices;
      if (!notice) throw new Error("Expected the pending request's incident.");
      expect(notices).toHaveLength(1);
      expect(notice).toMatchObject({ canAcquire: true, obligation: { requestId: pending.requestId } });
      const { incidentId } = notice;
      const slot = unwrap(f.run({ kind: "notice-acquire", exchangeId, claim, incidentId }, cwd));
      const outcome = unwrap(
        f.run(
          {
            kind: "notice-ack",
            exchangeId,
            claim,
            incidentId,
            operationId,
            replayOnly: false,
            reportingClaim: slot.reportingClaimId,
          },
          cwd,
        ),
      );
      return { notice, operationId, incidentId, outcome };
    };
    const checkpoint = (f: Fixture, openConnectionIssues: string[]) => {
      unwrap(exportSnapshot(unwrap(f.ports.exportPorts())));
      const inventory = JSON.parse(readFileSync(join(f.vault, "snapshots", "exchanges.json"), "utf8"));
      expect(inventory.records[0].notices.openConnectionIssues).toEqual(openConnectionIssues);
      unwrap(backupVerify(unwrap(f.ports.verifyPorts()), { now: new Date(now) }));
    };
    const restoreFrom = (source: Fixture) => {
      const target = fixture(false);
      const ports = unwrap(createNodeBackupCommandPorts({ ...target.setup, sourcePath: source.vault }).restorePorts());
      unwrap(backupRestore(ports, { dryRun: false }));
      bindRestored(target);
      target.later(300);
      return target;
    };

    original.later(300);
    const first = issue(original, "first-connection-issue", joinExchange(original, exchangeId));
    expect(first.outcome).toMatchObject({
      noticeKind: "connection-check",
      observedThroughSeq: pending.seq,
      projectId: alphaId,
    });
    const beta = joinExchange(original, exchangeId, original.beta);
    const later = unwrap(
      original.run(send(exchangeId, beta, "affected-present", "I rejoined the Exchange."), original.beta),
    );
    expect(later.seq).toBeGreaterThan(first.outcome.observedThroughSeq);
    checkpoint(original, []);

    const recurrent = restoreFrom(original);
    const reportAgain = joinExchange(recurrent, exchangeId);
    const second = issue(recurrent, "second-connection-issue", reportAgain);
    expect(second.outcome).toMatchObject({
      noticeKind: "connection-check",
      observedThroughSeq: later.seq,
      projectId: alphaId,
    });
    expect(second.notice.eligibleAt).toBe(first.notice.eligibleAt);
    expect(second.incidentId).not.toBe(first.incidentId);
    checkpoint(recurrent, [second.incidentId]);

    const suppressed = restoreFrom(recurrent);
    expect(list(suppressed)).toEqual([]);
    for (const { incidentId, operationId, outcome } of [first, second]) {
      expect(
        unwrap(suppressed.run({ kind: "notice-ack", exchangeId, incidentId, operationId, replayOnly: true })),
      ).toEqual({ ...outcome, replayed: true });
    }
    const affected = joinExchange(suppressed, exchangeId, suppressed.beta);
    const ownUnread = issue(suppressed, "affected-reports-own-unread", affected, suppressed.beta);
    expect(ownUnread.outcome).toMatchObject({
      noticeKind: "unread-delivery",
      affectedProjectId: betaId,
      projectId: betaId,
      observedThroughSeq: later.seq,
    });
    checkpoint(suppressed, []);
    const final = restoreFrom(suppressed);
    expect(
      unwrap(
        final.run(
          {
            kind: "notice-ack",
            exchangeId,
            incidentId: ownUnread.incidentId,
            operationId: ownUnread.operationId,
            replayOnly: true,
          },
          final.beta,
        ),
      ),
    ).toEqual({ ...ownUnread.outcome, replayed: true });
    const [again] = list(final);
    expect(again).toMatchObject({ noticeKind: "connection-check", affectedProjectId: betaId });
    expect(again?.incidentId).not.toBe(first.incidentId);
    expect(again?.incidentId).not.toBe(second.incidentId);
  });

  it("opens fallback at the exact opener boundary and resets notice availability on resumption", () => {
    const f = fixture();
    const { exchangeId } = unwrap(f.run({ ...creation, peers: ["beta", "other"], criteria: [...creation.criteria] }));
    const pair = { exchangeId };
    const claim = joinExchange(f, exchangeId);
    unwrap(
      f.run({
        ...pair,
        kind: "request",
        operationId: "pending",
        replayOnly: false,
        claim,
        assignee: "beta",
        condition: "Verify the observed source",
        criteria: ["Exact result"],
      }),
    );
    f.later(300);
    const opener = joinExchange(f, exchangeId);
    const other = joinExchange(f, exchangeId, f.other);
    const list = () => unwrap(f.run({ ...pair, kind: "notice-list", claim: other }, f.other)).notices;
    const due = list()[0];
    expect(due).toMatchObject({ canAcquire: false, priorityUntil: "2026-11-20T00:06:00.000Z" });
    if (!due) throw new Error("Expected one due notice.");
    const acquire = { ...pair, kind: "notice-acquire" as const, claim: other, incidentId: due.incidentId };
    for (const wait of [30, 29.999]) {
      f.later(wait);
      unwrap(f.run({ ...pair, kind: "renew", claim: opener }));
      unwrap(f.run({ ...pair, kind: "renew", claim: other }, f.other));
    }
    expect(f.run(acquire, f.other)).toMatchObject(error("ROW_VERSION_CONFLICT"));
    f.later(0.001);
    expect(list()[0]).toMatchObject({ canAcquire: true });
    const slot = unwrap(f.run(acquire, f.other));
    unwrap(
      f.run({
        ...pair,
        kind: "stop",
        operationId: "stop",
        replayOnly: false,
        confirmed: true,
        rosterVersion: 1,
        reason: "Pause verification",
      }),
    );
    expect(list()).toEqual([]);
    expect(f.usingDb((db) => db.prepare("SELECT 1 FROM exchange_notice_claims").all())).toEqual([]);
    f.later(80);
    const resumed = unwrap(
      f.run({
        ...pair,
        kind: "join",
        confirmed: true,
        resume: {
          ...pair,
          kind: "resume",
          pauseVersion: 1,
          operationId: "resume",
          confirmed: true,
          replayOnly: false,
        },
      }),
    );
    const current = String(resumed.claimId);
    f.later(299.999);
    expect(list()).toEqual([]);
    f.later(0.001);
    const refreshed = list()[0];
    expect(refreshed).toMatchObject({
      availableAt: "2026-11-20T00:07:20.000Z",
      eligibleAt: "2026-11-20T00:12:20.000Z",
    });
    expect(refreshed?.incidentId).not.toBe(due.incidentId);
    const newOpener = joinExchange(f, exchangeId);
    expect(
      f.run({
        ...pair,
        kind: "notice-ack",
        replayOnly: false,
        operationId: "stale",
        incidentId: due.incidentId,
        claim: newOpener,
        reportingClaim: slot.reportingClaimId,
      }),
    ).toMatchObject(error("ROW_VERSION_CONFLICT"));
    expect(newOpener).not.toBe(current);
  });

  it("tracks the exact unaccepted report through turnover, vacancy and acceptance-owner correction", () => {
    const f = fixture();
    const { exchangeId } = unwrap(f.run({ ...creation, peers: ["beta", "other"], criteria: [...creation.criteria] }));
    const identity = { exchangeId, replayOnly: false };
    const beta = joinExchange(f, exchangeId, f.beta);
    const other = joinExchange(f, exchangeId, f.other);
    const request = unwrap(
      f.run(
        {
          ...identity,
          kind: "request",
          claim: beta,
          operationId: "verify",
          assignee: "other",
          condition: "Verify a result",
          criteria: ["Provide exact observations"],
        },
        f.beta,
      ),
    );
    const report = (operationId: string) =>
      unwrap(
        f.run(
          {
            ...identity,
            kind: "report",
            claim: other,
            operationId,
            requestId: request.requestId,
            assignmentVersion: 1,
            body: { text: "Observed the result" },
            evidence: [],
            accept: [],
          },
          f.other,
        ),
      );
    report("report-one");
    f.later(20);
    const second = report("report-two");
    const list = () => unwrap(f.run({ kind: "notice-list", exchangeId })).notices;
    f.later(299.999);
    expect(list()).toEqual([]);
    f.later(0.001);
    const old = list()[0];
    expect(old).toMatchObject({
      noticeKind: "connection-check",
      affectedProjectId: betaId,
      obligation: { response: "acceptance", requestId: request.requestId, version: 2, sourceSeq: second.seq },
    });
    unwrap(
      f.run({
        ...identity,
        kind: "roster",
        operationId: "owner-departs",
        rosterVersion: 1,
        confirmed: true,
        reason: "Requester leaves",
        add: [],
        remove: ["beta"],
      }),
    );
    expect(list()).toEqual([]);
    unwrap(
      f.run({
        ...identity,
        kind: "owner-correct",
        operationId: "replace-owner",
        rosterVersion: 2,
        requestId: request.requestId,
        ownershipVersion: 2,
        acceptanceOwner: "alpha",
        assignee: undefined,
        confirmed: true,
        reason: "Fill the acceptance-owner vacancy",
      }),
    );
    f.later(299.999);
    expect(list()).toEqual([]);
    f.later(0.001);
    const revised = list()[0];
    expect(revised).toMatchObject({
      affectedProjectId: alphaId,
      availableAt: "2026-11-20T00:05:20.000Z",
      obligation: { response: "acceptance", requestId: request.requestId, version: 2, sourceSeq: second.seq },
    });
    expect(revised?.incidentId).not.toBe(old?.incidentId);

    unwrap(exportSnapshot(unwrap(f.ports.exportPorts())));
    const path = join(f.vault, "snapshots", "exchanges.json");
    const frame = JSON.parse(readFileSync(path, "utf8"));
    frame.representation = "lifecycle";
    delete frame.records[0].notices;
    for (const entry of frame.records[0].lifecycle.transitions) delete entry.recordedAt;
    frame.recordsSha256 = createHash("sha256").update(canonicalJson(frame.records)).digest("hex");
    writeFileSync(path, canonicalJson(frame));
    const restored = fixture(false);
    const compatibilityAt = "2026-11-20T00:12:00.000Z";
    const restore = unwrap(
      createNodeBackupCommandPorts({
        ...restored.setup,
        sourcePath: f.vault,
        clock: { now: () => new Date(compatibilityAt) },
      }).restorePorts(),
    );
    unwrap(backupRestore(restore, { dryRun: false }));
    bindRestored(restored);
    const restoredList = () => unwrap(restored.run({ kind: "notice-list", exchangeId })).notices;
    restored.later(1019.999);
    expect(restoredList()).toEqual([]);
    restored.later(0.001);
    expect(restoredList()[0]).toMatchObject({
      affectedProjectId: alphaId,
      availableAt: compatibilityAt,
      eligibleAt: "2026-11-20T00:17:00.000Z",
      obligation: revised?.obligation,
    });

    const owner = joinExchange(f, exchangeId);
    unwrap(
      f.run({
        ...identity,
        kind: "accept",
        claim: owner,
        operationId: "accept-current",
        accept: [{ requestId: request.requestId, reportVersion: 2 }],
      }),
    );
    expect(list()).toEqual([]);
  });

  it("preserves the exact pause, allows only observed ownership corrections, and replays resumption without a new claim", () => {
    const f = fixture();
    const exchangeId = create(f);
    const alpha = joinExchange(f, exchangeId);
    const beta = joinExchange(f, exchangeId, f.beta);
    const identity = { exchangeId, replayOnly: false };
    const activity = unwrap(f.run(send(exchangeId, alpha, "prior-activity")));
    const ranges = [{ firstSeq: activity.seq, lastSeq: activity.seq }];
    unwrap(f.run({ kind: "confirm-read", exchangeId, claim: alpha, ranges }));
    const stop = {
      ...identity,
      kind: "pause" as const,
      claim: alpha,
      reason: "Await decision",
      question: "May work resume?",
      operationId: "pause",
    };
    unwrap(f.run(stop));
    expect(f.run({ kind: "renew", exchangeId, claim: beta }, f.beta)).toMatchObject(error("EXCHANGE_CLAIM_CONFLICT"));
    const frozen = tree(f.home);
    const view = unwrap(f.run({ kind: "join", exchangeId, confirmed: false }));
    expect(view).toMatchObject({ state: "paused", pause: { version: 1, question: stop.question }, readRanges: ranges });
    expect(view.claimId).toBeUndefined();
    expect(tree(f.home)).toEqual(frozen);
    const correction = {
      ...identity,
      kind: "roster" as const,
      rosterVersion: 1,
      pauseVersion: 1,
      add: ["other"],
      remove: [],
      confirmed: true,
      reason: "Include a verifier",
      operationId: "correction",
    };
    expect(f.run({ ...correction, pauseVersion: 0 })).toMatchObject(error("ROW_VERSION_CONFLICT"));
    unwrap(f.run(correction));
    const resume = {
      ...identity,
      kind: "resume" as const,
      pauseVersion: 1,
      confirmed: true,
      operationId: "resume",
      decision: "Resume now",
    };
    expect(f.run({ kind: "join", exchangeId, confirmed: true, resume: { ...resume, decision: "" } })).toMatchObject(
      error("EXCHANGE_INVALID_INPUT"),
    );
    const reopened = unwrap(f.run({ kind: "join", exchangeId, confirmed: true, resume }));
    expect(reopened).toMatchObject({ state: "active", replayed: false, claimId: expect.any(String), requests: [] });
    expect(reopened.claimId).not.toBe(alpha);
    const after = tree(f.home);
    const replay = unwrap(f.run({ kind: "join", exchangeId, confirmed: true, resume }));
    expect(replay).toMatchObject({
      kind: "resume",
      replayed: true,
      state: "active",
      decision: resume.decision,
    });
    expect(replay.claimId).toBeUndefined();
    expect(tree(f.home)).toEqual(after);
    expect(f.run({ ...stop, operationId: "stale-agent" })).toMatchObject(error("EXCHANGE_CLAIM_CONFLICT"));
    if (reopened.claimId === undefined) throw new Error("Resumption didn't acquire the claim.");
    unwrap(f.run({ ...stop, claim: reopened.claimId, operationId: "second-pause" }));
    expect(
      f.run({ kind: "join", exchangeId, confirmed: true, resume: { ...resume, operationId: "stale-resume" } }),
    ).toMatchObject(error("ROW_VERSION_CONFLICT"));
    unwrap(exportSnapshot(unwrap(f.ports.exportPorts())));
    const restored = fixture(false);
    const restore = unwrap(createNodeBackupCommandPorts({ ...restored.setup, sourcePath: f.vault }).restorePorts());
    unwrap(backupRestore(restore, { dryRun: false }));
    bindRestored(restored);
    expect(unwrap(restored.run({ kind: "inspect", exchangeId }))).toMatchObject({
      state: "paused",
      pause: { version: 2 },
      readRanges: ranges,
    });
    const beforeReplay = tree(restored.home);
    expect(
      unwrap(restored.run({ kind: "join", exchangeId, confirmed: true, resume: { ...resume, replayOnly: true } })),
    ).toEqual(replay);
    expect(tree(restored.home)).toEqual(beforeReplay);
  });

  it("preserves explicit objections and earlier votes, rejects incomplete agreement, and resumes exact retirement", () => {
    const f = fixture();
    const exchangeId = create(f);
    const alpha = joinExchange(f, exchangeId);
    const beta = joinExchange(f, exchangeId, f.beta);
    const identity = { exchangeId, replayOnly: false };
    const request = unwrap(
      f.run({
        ...identity,
        kind: "request",
        claim: alpha,
        operationId: "request",
        assignee: "beta",
        condition: "Verify the large body",
        criteria: ["Exact bytes"],
      }),
    );
    const bytes = "x".repeat(65_537);
    const largeReport = (operationId: string) =>
      unwrap(
        f.run(
          {
            ...identity,
            kind: "report",
            claim: beta,
            operationId,
            requestId: request.requestId,
            assignmentVersion: 1,
            body: { text: bytes },
            evidence: [],
            accept: [],
          },
          f.beta,
        ),
      );
    largeReport("first-report");
    const propose = (
      operationId: string,
      summary: string,
      report: { requestId: string; reportVersion: number }[] = [],
    ) => {
      const view = unwrap(f.run({ kind: "inspect", exchangeId }));
      return f.run({
        ...identity,
        kind: "propose",
        claim: alpha,
        operationId,
        rosterVersion: view.rosterVersion ?? 0,
        workRevision: view.workRevision ?? 0,
        criterion: view.criteria,
        summary,
        report,
        disposition: [],
      });
    };
    const vote = (operationId: string, proposalVersion: number, claim: string, cwd = f.alpha, reportVersion?: number) =>
      f.run(
        {
          ...identity,
          kind: "vote",
          claim,
          operationId,
          proposalVersion,
          vote: "approve",
          accept: reportVersion === undefined ? [] : [{ requestId: request.requestId, reportVersion }],
        },
        cwd,
      );
    expect(propose("too-long", `${"é".repeat(32_768)}x`)).toMatchObject(error("EXCHANGE_INVALID_INPUT"));
    expect(unwrap(propose("incomplete", "Omitted evidence"))).toMatchObject({ proposalVersion: 1 });
    unwrap(vote("initial-approval", 1, alpha));
    expect(vote("incomplete-attempt", 1, beta, f.beta)).toMatchObject(error("ROW_VERSION_CONFLICT"));
    const objection = {
      ...identity,
      kind: "vote" as const,
      claim: beta,
      operationId: "objection",
      proposalVersion: 1,
      vote: "object" as const,
      accept: [],
    };
    expect(f.run({ ...objection, objection: "é".repeat(4097) }, f.beta)).toMatchObject(error("EXCHANGE_INVALID_INPUT"));
    unwrap(f.run({ ...objection, objection: "Need a newer verified result" }, f.beta));
    const revised = largeReport("revised-report");
    expect(vote("stale-vote", 1, alpha)).toMatchObject(error("ROW_VERSION_CONFLICT"));
    const summary = "é".repeat(32_768);
    expect(
      unwrap(
        propose("new-proposal", summary, [{ requestId: request.requestId, reportVersion: revised.reportVersion }]),
      ),
    ).toMatchObject({ proposalVersion: 2 });
    unwrap(vote("approved-beta", 2, beta, f.beta));
    const routine = unwrap(f.run(send(exchangeId, alpha, "routine")));
    const ranges = [{ firstSeq: routine.seq, lastSeq: routine.seq }];
    unwrap(f.run({ kind: "confirm-read", exchangeId, claim: alpha, ranges }));
    const storedRanges = (installation: ReturnType<typeof fixture>) =>
      installation.usingDb((db) =>
        db.prepare("SELECT 1 FROM exchange_read_ranges WHERE exchange_id = ?").all(exchangeId),
      );
    expect(storedRanges(f)).toHaveLength(1);
    const physical = f.usingDb((db) =>
      db
        .prepare(
          `SELECT storage_key key FROM exchange_working_content c JOIN exchange_materials m ON c.id = m.content_id WHERE m.id = ?`,
        )
        .get(revised.materialId),
    ) as { key: string };
    const managed = join(f.home, "state", "exchange-working", physical.key);
    writeFileSync(managed, "corrupt placeholder");
    const finalVote = unwrap(vote("final", 2, alpha, f.alpha, revised.reportVersion));
    expect(finalVote).toMatchObject({
      state: "completed",
      acceptanceSequences: [expect.any(Number)],
      warnings: [{ code: "STORAGE_INTEGRITY_ERROR" }],
    });
    expect(storedRanges(f)).toEqual([]);
    expect(readFileSync(managed, "utf8")).toBe("corrupt placeholder");
    const retained = tree(f.home);
    expect(unwrap(f.run({ kind: "join", exchangeId, confirmed: false }))).toMatchObject({
      state: "completed",
      cleanup: "failed",
      final: { summary },
    });
    expect(
      f.run({ kind: "material-read", exchangeId, materialId: revised.materialId, offset: 0, limit: 1 }),
    ).toMatchObject({ ok: false, error: { details: { reason: "retired" } } });
    expect(unwrap(vote("final", 2, alpha, f.alpha, revised.reportVersion))).toMatchObject({
      replayed: true,
      state: "completed",
    });
    expect(tree(f.home)).toEqual(retained);
    expect(f.run({ kind: "cleanup", exchangeId }, f.other)).toMatchObject(error("FORBIDDEN_ACTOR"));
    writeFileSync(managed, bytes);
    expect(unwrap(f.run({ kind: "cleanup", exchangeId }))).toMatchObject({ cleanup: "complete" });
    expect(existsSync(managed)).toBe(false);
    expect(unwrap(f.run({ kind: "cleanup", exchangeId }))).toMatchObject({ cleanup: "complete", reclaimedStages: 0 });
    unwrap(exportSnapshot(unwrap(f.ports.exportPorts())));
    const snapshotPath = join(f.vault, "snapshots", "exchanges.json");
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    expect(snapshot.records[0].readRanges).toEqual([]);
    // Earlier lifecycle backups may still contain valid read ranges for Completed Exchanges.
    snapshot.records[0].readRanges = ranges.map((range) => ({ ...range, projectId: alphaId }));
    snapshot.recordsSha256 = createHash("sha256").update(canonicalJson(snapshot.records)).digest("hex");
    writeFileSync(snapshotPath, canonicalJson(snapshot));
    const restored = fixture(false);
    unwrap(
      backupRestore(unwrap(createNodeBackupCommandPorts({ ...restored.setup, sourcePath: f.vault }).restorePorts()), {
        dryRun: false,
      }),
    );
    expect(storedRanges(restored)).toEqual([]);
    bindRestored(restored);
    expect(unwrap(restored.run({ kind: "join", exchangeId, confirmed: false }))).toMatchObject({
      state: "completed",
      final: { summary },
    });
    const final = snapshot.records[0].lifecycle.transitions.at(-1);
    expect(final).toMatchObject({ transition: { kind: "vote", completed: true } });
    // A freshly recomputed digest cannot legitimize stale observations at the final vote.
    final.workRevision--;
    snapshot.recordsSha256 = createHash("sha256").update(canonicalJson(snapshot.records)).digest("hex");
    writeFileSync(snapshotPath, canonicalJson(snapshot));
    expect(backupVerify(unwrap(f.ports.verifyPorts()), { now: new Date(now) })).toMatchObject(
      error("VAULT_INTEGRITY_ERROR"),
    );
    const target = fixture(false);
    const targetBefore = tree(target.home);
    const restore = unwrap(createNodeBackupCommandPorts({ ...target.setup, sourcePath: f.vault }).restorePorts());
    expect(backupRestore(restore, { dryRun: false })).toMatchObject(error("VAULT_INTEGRITY_ERROR"));
    expect(tree(target.home)).toEqual(targetBefore);
  });

  it("keeps older approvals ineligible after retained material changes and refuses a forged work revision before import", () => {
    const source = fixture();
    const exchangeId = create(source);
    const alpha = joinExchange(source, exchangeId);
    const beta = joinExchange(source, exchangeId, source.beta);
    const view = unwrap(source.run({ kind: "inspect", exchangeId }));
    const identity = { exchangeId, replayOnly: false };
    const first = unwrap(
      source.run({
        ...identity,
        kind: "propose",
        claim: alpha,
        operationId: "original-proposal",
        rosterVersion: view.rosterVersion ?? 0,
        workRevision: view.workRevision ?? 0,
        criterion: view.criteria,
        summary: "Review agreed by both Projects",
        report: [],
        disposition: [],
      }),
    );
    const approve = {
      ...identity,
      kind: "vote" as const,
      vote: "approve" as const,
      accept: [],
      proposalVersion: first.kind === "propose" ? first.proposalVersion : 0,
    };
    unwrap(source.run({ ...approve, claim: alpha, operationId: "approved-before-evidence" }));
    for (const name of ["finding", "another-finding"]) {
      unwrap(
        source.run(
          {
            ...identity,
            kind: "material-register",
            claim: beta,
            operationId: name,
            material: { kind: "external", access: "run-id", value: name },
          },
          source.beta,
        ),
      );
    }
    expect(unwrap(source.run({ kind: "inspect", exchangeId }))).toMatchObject({
      workRevision: (view.workRevision ?? 0) + 2,
      proposal: null,
      votes: [],
    });
    expect(source.run({ ...approve, claim: beta, operationId: "late-approval" }, source.beta)).toMatchObject(
      error("ROW_VERSION_CONFLICT"),
    );
    unwrap(exportSnapshot(unwrap(source.ports.exportPorts())));

    const restoreFromSource = (target: ReturnType<typeof fixture>) =>
      unwrap(createNodeBackupCommandPorts({ ...target.setup, sourcePath: source.vault }).restorePorts());
    const restored = fixture(false);
    unwrap(backupRestore(restoreFromSource(restored), { dryRun: false }));
    bindRestored(restored);
    const restoredClaim = joinExchange(restored, exchangeId, restored.beta);
    const restoredBefore = tree(restored.home);
    expect(
      restored.run({ ...approve, claim: restoredClaim, operationId: "late-approval" }, restored.beta),
    ).toMatchObject(error("ROW_VERSION_CONFLICT"));
    expect(tree(restored.home)).toEqual(restoredBefore);

    const path = join(source.vault, "snapshots", "exchanges.json");
    const snapshot = JSON.parse(readFileSync(path, "utf8"));
    const registrations = (frame: typeof snapshot) =>
      frame.records[0].collaboration.operations.filter(
        (row: { outcome: { kind: string } }) => row.outcome.kind === "material-register",
      );
    expect(registrations(snapshot)).toMatchObject([{ registrationAfterSeq: 2 }, { registrationAfterSeq: 2 }]);
    const discovery = unwrap(source.run({ kind: "recover", exchangeId }, source.beta));
    expect(discovery.operations).toHaveLength(2);
    expect(discovery.operations.every(({ outcome }) => !Object.hasOwn(outcome, "registrationAfterSeq"))).toBe(true);
    const empty = fixture(false);
    const populated = fixture();
    create(populated, "preserved-target");
    const targets = [empty, populated].map((target) => ({ target, before: tree(target.home) }));
    const refused = error("VAULT_INTEGRITY_ERROR");
    const defects = [
      (frame: typeof snapshot) => {
        frame.records[0].lifecycle.workRevision = view.workRevision;
      },
      (frame: typeof snapshot) => {
        delete registrations(frame)[0].registrationAfterSeq;
      },
      (frame: typeof snapshot) => {
        registrations(frame)[0].registrationAfterSeq = 1;
      },
      (frame: typeof snapshot) => {
        registrations(frame)[0].registrationAfterSeq = 3;
      },
    ];
    for (const damage of defects) {
      const frame = structuredClone(snapshot);
      damage(frame);
      frame.recordsSha256 = createHash("sha256").update(canonicalJson(frame.records)).digest("hex");
      writeFileSync(path, canonicalJson(frame));
      const result = {
        verify: backupVerify(unwrap(source.ports.verifyPorts()), { now: new Date(now) }),
        dryRestore: targets.map(({ target }) => backupRestore(restoreFromSource(target), { dryRun: true })),
        confirmedRestore: targets.map(({ target }) => backupRestore(restoreFromSource(target), { dryRun: false })),
      };
      expect(result).toMatchObject({
        verify: refused,
        dryRestore: [refused, refused],
        confirmedRestore: [refused, refused],
      });
      for (const { target, before } of targets) expect(tree(target.home)).toEqual(before);
    }
  });

  it.each(["standalone", "bundled"] as const)(
    "reconstructs %s grouped acceptance once and preserves approvals only for already-covered reports",
    (kind) => {
      const f = fixture();
      const exchangeId = create(f);
      const alpha = joinExchange(f, exchangeId);
      const beta = joinExchange(f, exchangeId, f.beta);
      const identity = { exchangeId, replayOnly: false };
      const state = () => unwrap(f.run({ kind: "inspect", exchangeId }));
      const reports = ["A", "B", "C", "D", "E"].map((name) => {
        const request = unwrap(
          f.run({
            ...identity,
            claim: alpha,
            kind: "request",
            operationId: `request-${name}`,
            assignee: "beta",
            condition: `Verify ${name}`,
            criteria: ["exact"],
          }),
        );
        const report = unwrap(
          f.run(
            {
              ...identity,
              claim: beta,
              kind: "report",
              operationId: `report-${name}`,
              requestId: request.requestId,
              assignmentVersion: 1,
              evidence: [],
              accept: [],
              body: { text: `Verified ${name}` },
            },
            f.beta,
          ),
        );
        return { requestId: report.requestId, reportVersion: report.reportVersion };
      });
      const propose = (operationId: string, coverage: typeof reports) => {
        const head = state();
        const result = unwrap(
          f.run({
            ...identity,
            claim: alpha,
            kind: "propose",
            operationId,
            rosterVersion: head.rosterVersion ?? 0,
            workRevision: head.workRevision ?? 0,
            criterion: head.criteria,
            summary: "Verified report versions",
            report: coverage,
            disposition: [],
          }),
        );
        if (result.kind !== "propose") throw new Error("Expected an Exchange proposal outcome.");
        return result.proposalVersion;
      };
      const vote = (claim: string, proposalVersion: number, operationId: string, cwd = f.alpha) =>
        f.run({ ...identity, claim, kind: "vote", proposalVersion, vote: "approve", operationId, accept: [] }, cwd);
      const baseRevision = state().workRevision ?? 0;
      expect(baseRevision).toBe(11);
      const old = propose("original", reports.slice(0, 3));
      unwrap(vote(beta, old, "first-vote", f.beta));
      unwrap(
        f.run({ ...identity, claim: alpha, kind: "accept", operationId: "covered-group", accept: reports.slice(0, 2) }),
      );
      expect(state()).toMatchObject({ workRevision: baseRevision, votes: [{ projectId: betaId, vote: "approve" }] });
      if (kind === "bundled")
        unwrap(f.run({ ...send(exchangeId, alpha, "noncovered-group"), accept: reports.slice(2) }));
      else
        unwrap(
          f.run({
            ...identity,
            claim: alpha,
            kind: "accept",
            operationId: "noncovered-group",
            accept: reports.slice(2),
          }),
        );
      expect(state()).toMatchObject({ workRevision: baseRevision + 1, proposal: null, votes: [] });
      expect(vote(alpha, old, "older-approval")).toMatchObject(error("ROW_VERSION_CONFLICT"));
      const next = propose("revised", reports);
      unwrap(vote(beta, next, "revised-first-vote", f.beta));
      expect(unwrap(vote(alpha, next, "final-vote"))).toMatchObject({ state: "completed" });
      unwrap(exportSnapshot(unwrap(f.ports.exportPorts())));
      const restored = fixture(false);
      const restore = unwrap(createNodeBackupCommandPorts({ ...restored.setup, sourcePath: f.vault }).restorePorts());
      unwrap(backupRestore(restore, { dryRun: false }));
      bindRestored(restored);
      expect(unwrap(restored.run({ kind: "inspect", exchangeId }))).toMatchObject({
        state: "completed",
        workRevision: baseRevision + 1,
        final: { version: next },
        acceptances: expect.arrayContaining(reports.map((report) => expect.objectContaining(report))),
      });
    },
  );

  it("imports predecessor collaboration receipts into a reproducible pre-proposal work baseline", () => {
    const { f, exchangeId, alphaClaim, acceptInput } = collaborationFixture();
    unwrap(f.run({ ...send(exchangeId, alphaClaim, "legacy-group"), accept: acceptInput.accept }));
    const live = unwrap(f.run({ kind: "inspect", exchangeId }));
    expect(live).toMatchObject({ workRevision: 5, proposal: null });
    unwrap(exportSnapshot(unwrap(f.ports.exportPorts())));
    const path = join(f.vault, "snapshots", "exchanges.json");
    const frame = JSON.parse(readFileSync(path, "utf8"));
    frame.representation = "collaboration";
    delete frame.records[0].lifecycle;
    delete frame.records[0].notices;
    for (const row of frame.records[0].collaboration.operations) delete row.registrationAfterSeq;
    frame.recordsSha256 = createHash("sha256").update(canonicalJson(frame.records)).digest("hex");
    writeFileSync(path, canonicalJson(frame));
    const restored = fixture(false);
    const restore = unwrap(createNodeBackupCommandPorts({ ...restored.setup, sourcePath: f.vault }).restorePorts());
    unwrap(backupRestore(restore, { dryRun: false }));
    bindRestored(restored);
    expect(unwrap(restored.run({ kind: "inspect", exchangeId }))).toMatchObject({
      workRevision: 5,
      proposal: null,
      lastSeq: live.lastSeq,
      acceptances: live.acceptances,
    });
    unwrap(exportSnapshot(unwrap(restored.ports.exportPorts())));
    const upgraded = JSON.parse(readFileSync(join(restored.vault, "snapshots", "exchanges.json"), "utf8"));
    expect(upgraded).toMatchObject({
      representation: "notices",
      records: [
        {
          lifecycle: { workRevision: 5, transitions: [] },
          collaboration: {
            operations: expect.arrayContaining([
              expect.objectContaining({
                registrationAfterSeq: 0,
                outcome: { kind: "material-register", exchangeId, materialId: expect.any(String) },
              }),
            ]),
          },
        },
      ],
    });
  });

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
    if (claim === undefined || opened.expiresAt === undefined) throw new Error("Expected an Active lease");
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
    if (successor.claimId === undefined) throw new Error("Expected a replacement lease");
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
    if (reclaimed.claimId === undefined) throw new Error("Expected the reclaimed lease");
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
    unwrap(
      f.run({
        kind: "roster",
        exchangeId,
        rosterVersion: 1,
        add: [],
        remove: [otherId],
        reason: "Remove the peer",
        confirmed: true,
        operationId: "remove",
        replayOnly: false,
      }),
    );
    expect(wait(undefined, f.other)).toMatchObject(error("FORBIDDEN_ACTOR"));
    unwrap(
      f.run({
        kind: "roster",
        exchangeId,
        rosterVersion: 2,
        add: [otherId],
        remove: [],
        reason: "Add the same peer",
        confirmed: true,
        operationId: "readd",
        replayOnly: false,
      }),
    );
    const afterMembership = tree(f.home);
    const afterTransition = unwrap(f.run({ kind: "history", exchangeId, cursor: history.cursor, limit: 1 }, f.beta));
    expect(afterTransition.messages).toMatchObject([{ seq: 2 }]);
    const changed = unwrap(wait(afterTransition.cursor));
    expect(changed).toMatchObject({ messages: [{ seq: broadcast.seq }], stateChanged: true, timedOut: false });
    expect(unwrap(wait(changed.cursor))).toMatchObject({ messages: [], stateChanged: false, timedOut: true });
    expect(unwrap(f.run({ kind: "inspect", exchangeId }, f.other)).members).toContain(otherId);
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
      expect(JSON.parse(raw).representation).toBe("notices");
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
            db.prepare("INSERT INTO exchange_members (exchange_id,project_id) VALUES (?,?)").run(exchangeId, member);
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
